// The fourth step: publishing the reveal, and the gate that protects it.
//
// The customer journey has four steps — measure, order, transact, reveal — and
// the first three were already covered by tests/order.test.mjs and
// tests/provider.test.mjs. The fourth had nothing, and it is the one where
// being early is the entire risk. So this file asks one question three ways:
//
//   is it safe to publish this reveal YET?
//
// "Yet" is the operative word, and three outcomes have to stay distinct:
//
//   WRONG    the reveal does not open the order. Waiting does not help.
//   EARLY    it opens the order, but the window is still open. Waiting helps.
//   UNKNOWN  nobody can say what block we are at. Waiting is undefined.
//
// A design that merged these into one boolean would tell a buyer with a
// corrupted reveal to wait 4,000 blocks, and would tell a buyer with no RPC
// connection to go ahead. Both are worse than refusing.
//
// The rest of the file is the provider's side of the same step, because the
// provider has to refuse an early reveal too: the buyer's client is not the only
// thing standing between a rung and the party that benefits from having it.

import test from "node:test";
import assert from "node:assert/strict";

import { mulberry32 } from "../src/rng.mjs";
import { DENOMINATIONS } from "../src/cover.mjs";
import {
  buildOrder,
  serialiseOrder,
  serialiseReveal,
  serialiseWindowProof,
  parseWindowProof,
} from "../src/order.mjs";
import { providerTerms, acceptOrder, invoiceFor, markPaid, planDecoys, orderSeed } from "../src/provider.mjs";
import { quote } from "../src/quote.mjs";
import { UNIT } from "../src/pool.mjs";
import { blocksUntilReveal, checkReveal, windowHasClosed, admitReveal, resolveHeight, heightNoteFor, HEIGHT_SOURCE, SETTLEABLE_STATES } from "../src/reveal.mjs";
import { verifiedPayment } from "./support/paid-invoice.mjs";

const NETWORK = "sepolia";
const CELL = 1.93;
const BITS = 3;
const FROM = 14_865_231;
const WIDTH = 20;
const LADDER = DENOMINATIONS.length;
const RUNG = DENOMINATIONS[3];

// `emits: true`: the reveal path is downstream of acceptance, and a provider
// that cannot broadcast never accepts the order it would later reveal against.
const TERMS = providerTerms({ network: NETWORK, emits: true });

/** One buyer's order, ready to send. */
function buyer({ seed = 1, rung = RUNG, from = FROM, width = WIDTH, bits = BITS, mode = "window" } = {}) {
  const next = mulberry32(seed);
  const priced = quote({ targetCell: CELL, bits, mode, network: NETWORK, ladder: LADDER });
  const { order, reveal } = buildOrder({
    network: NETWORK,
    from,
    to: from + width,
    denomination: rung,
    decoys: priced.decoys,
    bits,
    next,
  });
  return { order, reveal, priced };
}

/**
 * The same order as the provider holds it at the moment the reveal arrives:
 * accepted, invoiced, paid, and planned. That is the state `paid` — which is
 * what it is. It used to be called `emitted`, and that name was a claim about a
 * chain nothing had touched: the response that said `planned, NOT broadcast` also
 * said `emitted`. See SETTLEABLE_STATES in src/reveal.mjs.
 */
function provider({ seed = 1, rung = RUNG, from = FROM, width = WIDTH, bits = BITS } = {}) {
  const b = buyer({ seed, rung, from, width, bits });
  const accepted = acceptOrder(b.order, parseWindowProof(serialiseWindowProof(b.reveal)), { terms: TERMS });
  assert.equal(accepted.ok, true, accepted.reason ?? "");
  const invoice = invoiceFor(b.order, TERMS);
  const paid = markPaid(invoice, verifiedPayment(invoice, { orderId: b.order.id, block: from - 1 }));
  const plan = planDecoys({
    window: accepted.window,
    decoys: b.order.decoys,
    next: mulberry32(orderSeed(7n, b.order.id)),
  });
  return { ...b, window: accepted.window, invoice: paid, plan };
}

/** The plan in the shape the chain hands back, which is what settlement reads. */
const asEmitted = (plan) =>
  plan.map((d, i) => ({ noteId: `0x${(i + 1).toString(16)}`, block: d.block, denomination: d.denomination }));

// --- the boundary, which is the whole rule --------------------------------

test("the window is still open on its own last block", () => {
  // Off by one here is the difference between protecting the buyer and not: a
  // decoy can land in the window's final block, so until that block is behind
  // us the window is open.
  const { reveal } = buyer();
  const { from, to } = reveal.window;

  assert.equal(windowHasClosed(reveal, from), false);
  assert.equal(windowHasClosed(reveal, to), false, "the last block of the window is still the window");
  assert.equal(windowHasClosed(reveal, to + 1), true);
  assert.equal(windowHasClosed(reveal, to + 10_000), true);
});

test("the wait counts down to the first safe block", () => {
  const { reveal } = buyer();
  const { from, to } = reveal.window;

  assert.equal(blocksUntilReveal(reveal, from), WIDTH + 1);
  assert.equal(blocksUntilReveal(reveal, to), 1);
  assert.equal(blocksUntilReveal(reveal, to + 1), 0);
  // Never negative: a window that closed long ago is not a window that owes
  // the buyer anything.
  assert.equal(blocksUntilReveal(reveal, to + 10_000), 0);
});

test("an unknown height is not the same answer as a window that has not closed", () => {
  const { reveal } = buyer();

  assert.equal(windowHasClosed(reveal, undefined), null);
  assert.equal(windowHasClosed(reveal, null), null);
  assert.equal(windowHasClosed(reveal, 14_865_231.5), null);
  assert.equal(windowHasClosed(reveal, "14865231"), null);

  // `null` is "nobody can say"; `false` is "not yet". Both refuse, but only one
  // of them is a wait, and only one of them has a number to give.
  assert.equal(windowHasClosed(reveal, reveal.window.to), false);
  assert.notEqual(windowHasClosed(reveal, undefined), windowHasClosed(reveal, reveal.window.to));
  assert.equal(blocksUntilReveal(reveal, undefined), null);
});

// --- validity and publishability are different questions -------------------

test("a valid reveal with the window still open is valid and unpublishable", () => {
  const { order, reveal } = buyer();
  const check = checkReveal(order, reveal, { network: NETWORK, atBlock: FROM });

  // Both facts at once. A single boolean here would force a caller to choose
  // which of them to throw away, and the buyer needs both.
  assert.equal(check.verdict.ok, true, "the reveal does open this order");
  assert.equal(check.publishable, false);
  assert.equal(check.closed, false);
  assert.equal(check.waitBlocks, WIDTH + 1);
  assert.match(check.reason, new RegExp(`still open at block ${FROM}`));
  assert.match(check.reason, new RegExp(`runs to ${reveal.window.to}`));
});

test("a valid reveal is publishable on the first block after the window", () => {
  const { order, reveal } = buyer();
  const check = checkReveal(order, reveal, { network: NETWORK, atBlock: reveal.window.to + 1 });

  assert.equal(check.publishable, true);
  assert.equal(check.closed, true);
  assert.equal(check.waitBlocks, 0);
  assert.equal(check.reason, null);
  assert.equal(check.verdict.ok, true);
});

test("an unanswerable height fails CLOSED, and the reason says so", () => {
  const { order, reveal } = buyer();
  const check = checkReveal(order, reveal, { network: NETWORK, atBlock: undefined });

  assert.equal(check.publishable, false);
  assert.equal(check.closed, null);
  assert.equal(check.waitBlocks, null);
  assert.match(check.reason, /height is unknown/);
  assert.equal(check.verdict.ok, true, "the reveal itself is fine — that is what makes this case dangerous");

  // The shortcut that this test exists to block is `atBlock ?? 0`, which turns
  // an unreachable RPC into "the window has not opened yet" — a silent refusal
  // that looks like a wait. Asserted so the shortcut cannot be taken without
  // deleting a line that names it.
  assert.equal(checkReveal(order, reveal, { network: NETWORK, atBlock: 0 }).publishable, false);
});

// --- waiting does not rescue a wrong reveal --------------------------------

test("waiting does not rescue a reveal that opens a different window", () => {
  const { order, reveal } = buyer();
  const wrong = { ...reveal, window: { from: reveal.window.from, to: reveal.window.to + 3 } };
  const check = checkReveal(order, wrong, { network: NETWORK, atBlock: reveal.window.to + 10_000 });

  assert.equal(check.publishable, false);
  assert.equal(check.verdict.windowOk, false);
  assert.match(check.reason, /window commitment/);

  // `null`, not `0`: the window question was never reached, so there is no wait
  // to report. A gate that answered "0 blocks to wait" here would be a gate that
  // opens on a clock alone, whatever the reveal says.
  assert.equal(check.closed, null);
  assert.equal(check.waitBlocks, null);
});

test("a reveal carrying the wrong rung is refused after the window closes", () => {
  const { order, reveal } = buyer();
  const other = DENOMINATIONS.find((d) => d !== RUNG);
  assert.ok(other !== undefined, "the ladder needs more than one rung for this test to mean anything");

  const check = checkReveal(order, { ...reveal, denomination: other }, { network: NETWORK, atBlock: reveal.window.to + 1 });

  assert.equal(check.publishable, false);
  assert.equal(check.verdict.denominationOk, false);
  assert.equal(check.verdict.windowOk, true, "only the rung was changed");
  assert.match(check.reason, /denomination commitment/);
});

test("a reveal presented to the wrong order is refused", () => {
  // Two orders on the same window and rung still have different commitments,
  // because the salts differ. This is what stops one buyer settling another's.
  const first = buyer({ seed: 1 });
  const second = buyer({ seed: 2 });
  assert.notEqual(first.order.id, second.order.id);

  const check = checkReveal(first.order, second.reveal, { network: NETWORK, atBlock: first.reveal.window.to + 1 });
  assert.equal(check.publishable, false);
  assert.equal(check.verdict.ok, false);
});

// --- the provider's side of the same step ----------------------------------

test("the reveal route refuses an unpaid order before it even reads the reveal", () => {
  const { order, reveal } = buyer();
  const admitted = admitReveal({
    order,
    state: "invoiced",
    body: { reveal: serialiseReveal(reveal), atBlock: FROM, cell: CELL },
    atBlock: FROM,
    network: NETWORK,
  });

  assert.equal(admitted.ok, false);
  assert.equal(admitted.status, 409);
  assert.equal(admitted.body.state, "invoiced");
  assert.equal(admitted.claimed.size, 0);
});

test("the provider refuses an early reveal and says how many blocks are left", () => {
  const p = provider();
  const at = FROM + 5;
  const admitted = admitReveal({
    order: p.order,
    state: "emitted",
    planned: p.plan.length,
    body: { reveal: serialiseReveal(p.reveal), atBlock: at, cell: CELL },
    atBlock: at,
    heightSource: "provider",
    network: NETWORK,
  });

  assert.equal(admitted.ok, false);
  assert.equal(admitted.status, 400);
  assert.equal(admitted.body.waitBlocks, p.window.to + 1 - at);
  assert.match(admitted.body.reason, /still open/);

  // A refused reveal leaves nothing behind. If it wrote a claim before checking
  // the window, the retry after the window closes would find its own decoys
  // already taken.
  assert.equal(admitted.claimed.size, 0);
});

test("the provider settles once the window has closed, and counts nothing that did not land", () => {
  const p = provider();
  const at = p.window.to + 1;
  const admitted = admitReveal({
    order: p.order,
    state: "emitted",
    planned: p.plan.length,
    body: { reveal: serialiseReveal(p.reveal), atBlock: at, cell: CELL },
    atBlock: at,
    network: NETWORK,
  });

  assert.equal(admitted.ok, true, admitted.body?.reason ?? "");
  assert.equal(admitted.status, 200);
  assert.equal(admitted.body.state, "revealed");
  assert.equal(admitted.body.planned, p.plan.length);

  // The plan exists and nothing has been emitted, so the honest answer is zero
  // bits — not the plan's worth. Counting the plan here is the failure this
  // asserts against: it would credit the buyer for the provider's intention.
  assert.equal(admitted.body.settlement.emitted, 0);
  assert.equal(admitted.body.settlement.inCell.length, 0);
  assert.equal(admitted.body.settlement.bits, 0);
  assert.equal(admitted.body.settlement.shortfall, p.order.bits);
  assert.match(admitted.body.emission, /nothing has been emitted/);
});

test("the settlement records where the height came from, in words", () => {
  const p = provider();
  const at = p.window.to + 1;
  const base = {
    order: p.order,
    state: "emitted",
    planned: p.plan.length,
    body: { reveal: serialiseReveal(p.reveal), atBlock: at, cell: CELL },
    atBlock: at,
    network: NETWORK,
  };

  const notes = {};
  for (const source of Object.values(HEIGHT_SOURCE)) {
    const admitted = admitReveal({ ...base, heightSource: source });
    assert.equal(admitted.body.heightSource, source);
    notes[source] = admitted.body.heightNote;
  }

  // The buyer's number is the weakest arrangement and has to admit it, because a
  // provider that quietly stopped verifying must not keep printing the
  // reassuring sentence.
  assert.match(notes.buyer, /NOT verified/);
  assert.match(notes.provider, /read from the chain/);
  assert.match(notes.pinned, /--at/);

  // Three sources, three sentences. A shared string would mean one of them was
  // describing a check it did not perform — and "pinned by a human" is not the
  // same claim as "read from the chain".
  assert.equal(new Set(Object.values(notes)).size, 3);
  assert.equal(heightNoteFor("pinned"), notes.pinned);
});

// --- where the height comes from, which is a question about trust -----------

test("a pinned height is used as given, and the chain is not consulted", async () => {
  let called = 0;
  const resolved = await resolveHeight({
    mode: HEIGHT_SOURCE.PINNED,
    pinned: 14_865_300,
    network: NETWORK,
    read: async () => {
      called += 1;
      return 1;
    },
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.atBlock, 14_865_300);
  assert.equal(resolved.heightSource, "pinned");
  assert.equal(called, 0, "a pinned height should not trigger a chain read");
});

test("a pinned height that is not a number is refused, not treated as unset", async () => {
  // The dangerous alternative is to fall through to the buyer's number, which
  // silently converts a typo in the operator's flag into an unverified
  // settlement — with no error and no note.
  const resolved = await resolveHeight({ mode: HEIGHT_SOURCE.PINNED, pinned: null, network: NETWORK });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.status, 500);
  assert.match(resolved.body.error, /--at/);
});

test("a verifying provider reads the height and ignores the buyer's", async () => {
  const resolved = await resolveHeight({
    mode: HEIGHT_SOURCE.PROVIDER,
    network: NETWORK,
    endpoints: ["stub"],
    read: async () => 14_865_400,
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.atBlock, 14_865_400);
  assert.equal(resolved.heightSource, "provider");
});

test("a verifying provider that cannot reach the chain REFUSES, and does not fall back", async () => {
  // The whole point of --verify. Falling back to the buyer's number here would
  // hand the settlement to the party that benefits from an early reveal, while
  // the operator believes a check ran.
  const resolved = await resolveHeight({
    mode: HEIGHT_SOURCE.PROVIDER,
    network: NETWORK,
    endpoints: ["stub-a", "stub-b"],
    read: async () => undefined,
  });

  assert.equal(resolved.ok, false);
  assert.equal(resolved.status, 400);
  assert.match(resolved.body.reason, /will not fall back/);
  assert.deepEqual(resolved.body.endpoints, ["stub-a", "stub-b"]);
});

test("the buyer's mode asks for nothing and promises nothing", async () => {
  const resolved = await resolveHeight({
    mode: HEIGHT_SOURCE.BUYER,
    network: NETWORK,
    read: async () => {
      throw new Error("the buyer's mode must not read the chain");
    },
  });
  // `null` means "use the one in the request", which is what keeps the buyer's
  // assertion a request rather than a measurement.
  assert.equal(resolved.ok, true);
  assert.equal(resolved.atBlock, null);
  assert.equal(resolved.heightSource, "buyer");
});

test("a window proof sent where a reveal belongs is refused, not crashed on", () => {
  // The mistake this route is most likely to see, and the most important one to
  // get right: the window proof is a strict subset of the reveal, so sending it
  // here is the natural error. It has no denomination, so it cannot settle
  // anything — and it must not take the provider down while proving that.
  const p = provider();
  const at = p.window.to + 1;
  const admitted = admitReveal({
    order: p.order,
    state: "emitted",
    planned: p.plan.length,
    body: { reveal: serialiseWindowProof(p.reveal), atBlock: at, cell: CELL },
    atBlock: at,
    network: NETWORK,
  });

  assert.equal(admitted.ok, false);
  assert.equal(admitted.status, 400);
  assert.match(admitted.body.error, /malformed/);
  assert.match(admitted.body.hint, /window proof/);
  assert.equal(admitted.claimed.size, 0);
});

test("settlement refuses to run without a height or a cell", () => {
  const p = provider();
  const reveal = serialiseReveal(p.reveal);
  const base = { order: p.order, state: "emitted", planned: p.plan.length, network: NETWORK };

  const noHeight = admitReveal({ ...base, body: { reveal, cell: CELL }, atBlock: undefined });
  assert.equal(noHeight.status, 400);
  assert.match(noHeight.body.error, /atBlock/);

  const noCell = admitReveal({ ...base, body: { reveal, atBlock: p.window.to + 1 }, atBlock: p.window.to + 1 });
  assert.equal(noCell.status, 400);
  assert.match(noCell.body.error, /cell/);
});

test("re-sending a settled reveal returns the same verdict and claims nothing new", () => {
  const p = provider();
  const emitted = asEmitted(p.plan);
  const at = p.window.to + 1;
  const body = { reveal: serialiseReveal(p.reveal), atBlock: at, cell: CELL, observedDecoys: emitted };

  const first = admitReveal({
    order: p.order,
    state: "emitted",
    planned: p.plan.length,
    body,
    atBlock: at,
    network: NETWORK,
  });
  assert.equal(first.ok, true, first.body?.reason ?? "");
  assert.ok(first.claimed.size > 0, "the plan produced nothing in the buyer's cell");

  const again = admitReveal({
    order: p.order,
    state: "revealed",
    planned: p.plan.length,
    settled: first.body,
    body,
    atBlock: at,
    network: NETWORK,
    claimed: first.claimed,
  });

  assert.equal(again.ok, true);
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.settlement.bits, first.body.settlement.bits);
  assert.equal(again.claimed.size, first.claimed.size, "a duplicate settlement grew the registry");

  // The regression this catches: settling moves the record to `revealed`, so a
  // state guard that only admits `emitted` answers a legitimate re-send with
  // "the invoice is not paid, so there is nothing to settle" — a 409 about an
  // invoice that was paid, sent to a buyer whose order is already settled.
  assert.notEqual(again.status, 409, "a duplicate reveal was refused as an unpaid invoice");
});

test("a second order cannot settle decoys the first one already claimed", () => {
  // Windows overlap constantly, so this is the ordinary case, not an attack.
  const first = provider({ seed: 5 });
  const second = provider({ seed: 6, from: FROM + 5 });
  const emitted = asEmitted(first.plan);
  const at = second.window.to + 1;

  const a = admitReveal({
    order: first.order,
    state: "emitted",
    planned: first.plan.length,
    body: { reveal: serialiseReveal(first.reveal), atBlock: at, cell: CELL, observedDecoys: emitted },
    atBlock: at,
    network: NETWORK,
  });
  assert.equal(a.ok, true, a.body?.reason ?? "");
  assert.ok(a.claimed.size > 0);

  const b = admitReveal({
    order: second.order,
    state: "emitted",
    planned: second.plan.length,
    body: { reveal: serialiseReveal(second.reveal), atBlock: at, cell: CELL, observedDecoys: emitted },
    atBlock: at,
    network: NETWORK,
    claimed: a.claimed,
  });

  assert.equal(b.ok, true, b.body?.reason ?? "");
  assert.ok(b.body.settlement.inCell.length > 0, "the two cells do not overlap, so this proves nothing");
  assert.equal(b.body.settlement.claimable.length, 0, "the same decoys were settled twice");
  assert.equal(b.body.settlement.bits, 0, "a buyer who can claim nothing was credited with anonymity");
  assert.equal(b.claimed.size, a.claimed.size, "the second settlement grew the registry");
});

// --- the four steps, in order, with no chain --------------------------------

test("the journey closes: measure → order → transact → reveal", () => {
  // 1. MEASURE — free, and nothing leaves the machine. The buyer's own number
  //    for the cell it is sitting in. `npm run measure` prints it.
  const cell = CELL;

  // 2. ORDER — commit to one cell: a window and a rung. What goes out is the
  //    public order and the WINDOW proof. The reveal stays home, and that is
  //    the thing this asserts rather than assumes.
  const { order, reveal, priced } = buyer();
  const sent = JSON.parse(JSON.stringify({ order: serialiseOrder(order), windowProof: serialiseWindowProof(reveal) }));

  assert.deepEqual(Object.keys(sent.windowProof).sort(), ["window", "windowSalt"]);
  assert.ok(
    !JSON.stringify(sent).includes(reveal.denomination.toString() + '"'),
    "the rung went out with the order",
  );

  const accepted = acceptOrder(sent.order, parseWindowProof(sent.windowProof), { terms: TERMS });
  assert.equal(accepted.ok, true, accepted.reason ?? "");

  // 3. TRANSACT — the wallet pays, and the spend lands inside the window. The
  //    provider emits next; that is the step that needs a node and the one this
  //    test stands in for, so the plan is built and never broadcast.
  const quoted = invoiceFor(sent.order, TERMS);
  const invoice = markPaid(quoted, verifiedPayment(quoted, { orderId: sent.order.id, block: FROM - 1 }));
  assert.equal(invoice.amount, priced.cost * UNIT);

  const plan = planDecoys({
    window: accepted.window,
    decoys: sent.order.decoys,
    next: mulberry32(orderSeed(11n, order.id)),
  });
  assert.equal(plan.length, priced.decoys);

  // 4a. REVEAL, too early. On the window's own last block the answer is still
  //     no — one more block has to pass. This is the refusal that makes the
  //     split commitment worth anything.
  const early = admitReveal({
    order,
    state: "emitted",
    planned: plan.length,
    body: { reveal: serialiseReveal(reveal), atBlock: FROM + WIDTH, cell },
    atBlock: FROM + WIDTH,
    network: NETWORK,
  });
  assert.equal(early.ok, false);
  assert.equal(early.status, 400);
  assert.equal(early.body.waitBlocks, 1);
  assert.equal(early.claimed.size, 0);

  // 4b. REVEAL, after it closes.
  const late = admitReveal({
    order,
    state: "emitted",
    planned: plan.length,
    body: { reveal: serialiseReveal(reveal), atBlock: FROM + WIDTH + 1, cell },
    atBlock: FROM + WIDTH + 1,
    network: NETWORK,
  });
  assert.equal(late.ok, true, late.body?.reason ?? "");
  assert.equal(late.body.state, "revealed");
  assert.equal(late.body.settlement.promised, priced.bitsRequested);

  // And the part that did not happen is visible in the result rather than
  // rounded away: nothing was emitted, so nothing landed, so the shortfall is
  // the whole promise. An order can be settled and still have delivered
  // nothing, and a settlement that reported "settled" without that number would
  // be the most expensive kind of green.
  assert.equal(late.body.settlement.emitted, 0);
  assert.equal(late.body.settlement.bits, 0);
  assert.equal(late.body.settlement.shortfall, priced.bitsRequested);
  assert.match(late.body.emission, /nothing has been emitted/);
});

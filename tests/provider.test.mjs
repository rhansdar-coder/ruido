// The provider side of the trade, and the round trip that closes it.
//
// Everything in tests/order.test.mjs is the buyer talking to itself: commit,
// price, settle. Nothing there has a counterparty, so nothing there can catch the
// two failures that only appear once there is one:
//
//   1. A provider that emits on an unverified plaintext window. The order
//      carries the window in the clear as a courtesy copy, and a buyer who
//      commits to one window while naming another gets the work done for free.
//      `acceptOrder` has to refuse that BEFORE anything is planned.
//   2. A provider that spreads its decoys wider than the window. The quote
//      prices window-only at a landing rate of 1/ladder, which assumes every
//      decoy clears the block filter by construction. A provider that places
//      them over a bigger span delivers a fraction of the bits it sold and
//      charges for all of them — and it would look like a working trade.
//
// Both are tested here, and the second is tested by measuring the realised rate
// against the quoted one rather than by asserting the implementation.

import test from "node:test";
import assert from "node:assert/strict";

import { mulberry32 } from "../src/rng.mjs";
import { DENOMINATIONS, FEE_PER_CALL } from "../src/cover.mjs";
import {
  buildOrder,
  serialiseOrder,
  serialiseReveal,
  serialiseWindowProof,
  parseWindowProof,
} from "../src/order.mjs";
import {
  providerTerms,
  acceptOrder,
  deriveOrderId,
  invoiceFor,
  markPaid,
  planDecoys,
  summarisePlan,
  orderSeed,
} from "../src/provider.mjs";
import { quote } from "../src/quote.mjs";
import { claim, decoyInCell, settle } from "../src/settlement.mjs";

const NETWORK = "sepolia";
const CELL = 1.93;
const BITS = 3;
const FROM = 14_865_231;
const WIDTH = 20;
const LADDER = DENOMINATIONS.length;

/** One buyer's order, ready to send. */
function buyer({ seed = 1, rung = DENOMINATIONS[3], from = FROM, width = WIDTH, bits = BITS, mode = "window" } = {}) {
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

const TERMS = providerTerms({ network: NETWORK });

/** The plan turned into the shape settlement reads, which is what the chain gives. */
const asEmitted = (plan) => plan.map((d, i) => ({ noteId: `0x${(i + 1).toString(16)}`, block: d.block, denomination: d.denomination }));

// --- the terms a provider publishes -----------------------------------------

test("the terms publish the ladder and the fee a buyer needs to check a quote", () => {
  const terms = providerTerms({ network: "sepolia" });
  assert.equal(terms.ladder, LADDER);
  assert.equal(terms.feePerCall, FEE_PER_CALL.sepolia);
  // The buyer cannot turn bits into decoys without the ladder, so a provider
  // that withholds it makes the quote unverifiable rather than cheaper.
  assert.ok(terms.ladder > 0);
  assert.equal(providerTerms({ network: "mainnet" }).feePerCall, FEE_PER_CALL.mainnet);
});

test("a provider cannot advertise a ladder with no rungs", () => {
  assert.throws(() => providerTerms({ ladder: 0 }), /at least one rung/);
});

// --- the window proof: the provider's only defence ---------------------------

test("the provider is handed the window half and accepts the order", () => {
  const { order, reveal } = buyer();
  const accepted = acceptOrder(order, parseWindowProof(serialiseWindowProof(reveal)), { terms: TERMS });
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.window, { from: FROM, to: FROM + WIDTH });
});

test("a window proof that does not open the commitment is refused", () => {
  // The attack: commit to one window, name another. The provider emits in the
  // named window, the reveal opens the committed one, the cell is empty, and the
  // provider has paid for decoys nobody bought.
  const { order } = buyer();
  const lie = { window: { from: FROM, to: FROM + WIDTH }, windowSalt: 12345n };
  const accepted = acceptOrder(order, lie, { terms: TERMS });
  assert.equal(accepted.ok, false);
  assert.match(accepted.reason, /window commitment/);
});

test("a window proof for a different window is refused even with the right salt", () => {
  // The salt is correct; the edges are not. A proof is the whole triple, not a
  // nonce — accepting on the salt alone would let the buyer move the window
  // after the fact, which is the same attack with extra steps.
  const { order, reveal } = buyer();
  const moved = { window: { from: FROM + 1, to: FROM + WIDTH + 1 }, windowSalt: reveal.windowSalt };
  assert.equal(acceptOrder(order, moved, { terms: TERMS }).ok, false);
});

test("an order with no window proof at all is refused", () => {
  const { order } = buyer();
  assert.equal(acceptOrder(order, undefined, { terms: TERMS }).ok, false);
  assert.equal(acceptOrder(order, null, { terms: TERMS }).ok, false);
  assert.equal(acceptOrder(order, { window: { from: FROM, to: FROM + WIDTH } }, { terms: TERMS }).ok, false);
});

test("the window proof carries no denomination, by construction", () => {
  // The security boundary of the whole customer path. Asserting the exact key
  // set, because a substring check on a 64-hex commitment proves nothing.
  const { reveal } = buyer();
  const proof = serialiseWindowProof(reveal);
  assert.deepEqual(Object.keys(proof).sort(), ["window", "windowSalt"]);

  const wire = JSON.stringify(proof);
  assert.ok(!wire.includes(reveal.denomination.toString() + '"'), "the rung leaked into the proof");
  assert.ok(!wire.includes(reveal.denominationSalt.toString(16)), "the denomination salt leaked");
});

test("the full reveal carries both halves, so the two are not the same object", () => {
  const { reveal } = buyer();
  const full = serialiseReveal(reveal);
  assert.deepEqual(Object.keys(full).sort(), ["denomination", "denominationSalt", "window", "windowSalt"]);
  // If these ever became the same function, the proof test above would still
  // pass while every client shipped the rung to its provider.
  assert.notDeepEqual(Object.keys(full).sort(), Object.keys(serialiseWindowProof(reveal)).sort());
});

// --- what acceptOrder refuses -------------------------------------------------

test("an order for another network is refused", () => {
  const { order, reveal } = buyer();
  const proof = parseWindowProof(serialiseWindowProof(reveal));
  const mainnet = { ...order, network: "mainnet" };
  const accepted = acceptOrder(mainnet, proof, { terms: TERMS });
  assert.equal(accepted.ok, false);
  assert.match(accepted.reason, /serves sepolia/);
});

test("an unsupported order version is refused", () => {
  const { order, reveal } = buyer();
  const accepted = acceptOrder({ ...order, version: 99 }, parseWindowProof(serialiseWindowProof(reveal)), { terms: TERMS });
  assert.equal(accepted.ok, false);
  assert.match(accepted.reason, /unsupported order version/);
});

test("an order id that is not derived from its own commitments is refused", () => {
  // The id is the key settlement claims under, so a buyer who supplies a
  // different one is claiming a cell the order does not describe.
  const { order, reveal } = buyer();
  const proof = parseWindowProof(serialiseWindowProof(reveal));
  const forged = { ...order, id: "0x" + "ab".repeat(32) };
  const accepted = acceptOrder(forged, proof, { terms: TERMS });
  assert.equal(accepted.ok, false);
  assert.match(accepted.reason, /not derived/);
  // And the derivation is stable: the real order passes it.
  assert.equal(deriveOrderId(order), order.id);
});

test("an order over the provider's cap is refused, and the cap is a real number", () => {
  const { order, reveal } = buyer();
  const proof = parseWindowProof(serialiseWindowProof(reveal));
  const small = providerTerms({ network: NETWORK, maxDecoys: 10 });
  const accepted = acceptOrder(order, proof, { terms: small });
  assert.equal(accepted.ok, false);
  assert.match(accepted.reason, /over the provider's cap/);
  // A provider with a generous cap accepts the same order, so the refusal is
  // the cap and not something else in the order.
  assert.equal(acceptOrder(order, proof, { terms: TERMS }).ok, true);
});

test("an order asking for zero bits is refused", () => {
  const { order, reveal } = buyer();
  const proof = parseWindowProof(serialiseWindowProof(reveal));
  const accepted = acceptOrder({ ...order, bits: 0 }, proof, { terms: TERMS });
  assert.equal(accepted.ok, false);
  assert.match(accepted.reason, /positive number of bits/);
});

// --- the invoice --------------------------------------------------------------

test("the invoice is priced per decoy and its id is derived from the order", () => {
  const { order } = buyer();
  const invoice = invoiceFor(order, TERMS);
  assert.equal(invoice.amount, BigInt(order.decoys) * FEE_PER_CALL.sepolia);
  assert.equal(invoice.orderId, order.id);
  // Derived, so two parties who disagree about whether an invoice was issued can
  // both recompute it from the public order.
  assert.equal(invoiceFor(order, TERMS).id, invoice.id);
});

test("a margin is charged on top of the pool fee and shows up in the amount", () => {
  const { order } = buyer();
  const withMargin = providerTerms({ network: NETWORK, margin: 1n });
  const invoice = invoiceFor(order, withMargin);
  assert.equal(invoice.amount, BigInt(order.decoys) * (FEE_PER_CALL.sepolia + 1n));
  assert.equal(invoice.margin, 1n);
});

test("an invoice cannot be paid twice", () => {
  const { order } = buyer();
  const paid = markPaid(invoiceFor(order, TERMS), { txHash: "0xabc", block: 1 });
  assert.equal(paid.paid.txHash, "0xabc");
  assert.throws(() => markPaid(paid, { txHash: "0xdef" }), /already paid/);
});

test("a payment without a transaction hash is refused", () => {
  // "Paid" has to mean "there is a transfer to check", or the invoice state is
  // a boolean the provider sets for itself.
  const { order } = buyer();
  assert.throws(() => markPaid(invoiceFor(order, TERMS), {}), /transaction hash/);
});

// --- the plan -----------------------------------------------------------------

test("every decoy in the plan falls inside the window", () => {
  // The load-bearing property: the quote's landing rate assumes it.
  const next = mulberry32(7);
  for (const width of [0, 1, 5, 20, 200]) {
    const plan = planDecoys({ window: { from: FROM, to: FROM + width }, decoys: 400, next });
    for (const decoy of plan) {
      assert.ok(
        decoy.block >= FROM && decoy.block <= FROM + width,
        `decoy landed at ${decoy.block}, outside ${FROM}..${FROM + width}`,
      );
    }
  }
});

test("the plan draws from the whole ladder, not from one rung", () => {
  // A plan that put every decoy on one rung would leave the buyer's cell as
  // empty as no cover at all, while looking like a full order.
  const plan = planDecoys({ window: { from: FROM, to: FROM + WIDTH }, decoys: 500, next: mulberry32(3) });
  const summary = summarisePlan(plan);
  assert.equal(summary.rungsUsed, LADDER);
  for (const { count } of summary.perRung) {
    assert.ok(count > 20, `a rung got only ${count} of 500 decoys`);
  }
});

test("the same seed produces the same plan and a different seed does not", () => {
  // A dispute has to be re-runnable rather than arguable.
  const window = { from: FROM, to: FROM + WIDTH };
  const a = planDecoys({ window, decoys: 50, next: mulberry32(11) });
  const b = planDecoys({ window, decoys: 50, next: mulberry32(11) });
  const c = planDecoys({ window, decoys: 50, next: mulberry32(12) });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test("a plan refuses a bad window or a zero count", () => {
  const next = mulberry32(1);
  assert.throws(() => planDecoys({ window: { from: 10, to: 5 }, decoys: 1, next }), /bad window/);
  assert.throws(() => planDecoys({ window: { from: 1, to: 2 }, decoys: 0, next }), /at least one decoy/);
});

test("the order seed is reproducible and depends on the provider's own seed", () => {
  const { order } = buyer();
  assert.equal(orderSeed(4242n, order.id), orderSeed(4242n, order.id));
  assert.notEqual(orderSeed(4242n, order.id), orderSeed(4243n, order.id));
  const seed = orderSeed(4242n, order.id);
  assert.ok(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff, `seed out of range: ${seed}`);
});

// --- the link between the provider's plan and the buyer's quote ---------------

test("the realised landing rate matches the rate the quote priced", () => {
  // This is the test that would have caught a provider spreading its decoys
  // wider than the window: the plan looks fine, the invoice is correct, and the
  // buyer silently receives a fraction of the bits. Measured, not asserted.
  const ORDERS = 40;
  let decoys = 0;
  let inCell = 0;
  const next = mulberry32(20260913);

  for (let i = 0; i < ORDERS; i += 1) {
    const from = FROM + i * 50;
    const plan = planDecoys({ window: { from, to: from + WIDTH }, decoys: 95, next });
    const rung = DENOMINATIONS[3];
    for (const decoy of plan) {
      decoys += 1;
      if (decoyInCell(decoy, { window: { from, to: from + WIDTH }, denomination: rung })) inCell += 1;
    }
  }

  const realised = inCell / decoys;
  const expected = 1 / LADDER;
  const standardError = Math.sqrt((expected * (1 - expected)) / decoys);
  const z = (realised - expected) / standardError;

  assert.ok(decoys > 3000, `only ${decoys} decoys — too few for this to mean anything`);
  assert.ok(
    Math.abs(z) < 4,
    `realised landing rate ${(realised * 100).toFixed(2)}% against a quoted ${(expected * 100).toFixed(2)}% (z = ${z.toFixed(2)})`,
  );
});

// --- the round trip, with no node and no chain --------------------------------

test("the whole trade closes offline: commit, accept, invoice, pay, plan, settle, claim", () => {
  const { order, reveal, priced } = buyer();

  // 1. The buyer sends the public order and the window half — nothing else.
  const onWire = JSON.parse(JSON.stringify({ order: serialiseOrder(order), windowProof: serialiseWindowProof(reveal) }));

  // 2. The provider accepts.
  const accepted = acceptOrder(onWire.order, parseWindowProof(onWire.windowProof), { terms: TERMS });
  assert.equal(accepted.ok, true);

  // 3. It invoices, and is paid.
  const invoice = markPaid(invoiceFor(onWire.order, TERMS), { txHash: "0xpaid", block: FROM - 1 });
  assert.equal(invoice.amount, priced.cost);

  // 4. It plans the decoys — still nothing on chain.
  const plan = planDecoys({ window: accepted.window, decoys: onWire.order.decoys, next: mulberry32(orderSeed(99n, order.id)) });
  assert.equal(plan.length, priced.decoys);

  // 5. The emission lands, and the chain assigns note ids. Synthetic here: this
  //    is the one step that needs a node, and it is the one step this test
  //    deliberately stands in for.
  const emitted = asEmitted(plan);

  // 6. The window closes, the buyer publishes the full reveal, anyone settles.
  const settlement = settle({ order, reveal, decoys: emitted, targetCell: CELL, network: NETWORK });
  assert.equal(settlement.ok, true, settlement.reason ?? "");
  assert.equal(settlement.emitted, priced.decoys);
  assert.ok(settlement.claimable.length > 0, "the plan produced nothing the buyer can claim");

  // 7. The buyer's value is at least what was promised, because the decoy count
  //    was rounded up when it was priced.
  assert.ok(
    settlement.bits >= settlement.promised,
    `settlement paid ${settlement.bits} bits against a promise of ${settlement.promised}`,
  );
  assert.equal(settlement.shortfall, 0);

  // 8. The claim is registered under the order id.
  const registry = claim(new Map(), order, settlement);
  assert.equal(registry.size, settlement.claimable.length);
  for (const noteId of registry.keys()) assert.equal(registry.get(noteId), order.id);
});

test("the trade survives the JSON wire in both directions", () => {
  // BigInt does not survive JSON.stringify, and the whole protocol is felts.
  const { order, reveal } = buyer();
  const roundTrip = JSON.parse(JSON.stringify({ order: serialiseOrder(order), windowProof: serialiseWindowProof(reveal) }));
  const proof = parseWindowProof(roundTrip.windowProof);
  assert.equal(typeof proof.windowSalt, "bigint");
  assert.equal(acceptOrder(roundTrip.order, proof, { terms: TERMS }).ok, true);
});

test("a second order on the same cell cannot resell the same decoys", () => {
  // Windows overlap constantly, and two orders sharing a window AND a rung share
  // a cell. Without first-claim, one batch of decoys is sold to every buyer.
  const first = buyer({ seed: 5, rung: DENOMINATIONS[3] });
  const second = buyer({ seed: 6, rung: DENOMINATIONS[3], from: FROM + 5 });

  const plan = planDecoys({ window: { from: FROM, to: FROM + WIDTH }, decoys: first.order.decoys, next: mulberry32(1) });
  const emitted = asEmitted(plan);

  const s1 = settle({ order: first.order, reveal: first.reveal, decoys: emitted, targetCell: CELL, network: NETWORK });
  const registry = claim(new Map(), first.order, s1);
  assert.ok(s1.claimable.length > 0);

  const s2 = settle({
    order: second.order,
    reveal: second.reveal,
    decoys: emitted,
    claimed: registry,
    targetCell: CELL,
    network: NETWORK,
  });
  assert.ok(s2.inCell.length > 0, "the second cell should overlap the first, or this proves nothing");
  assert.equal(s2.claimable.length, 0, "the same decoys were sold twice");
  assert.equal(s2.rejected.length, s2.inCell.length);
  assert.equal(s2.bits, 0, "a buyer who can claim nothing was credited with anonymity");
});

test("re-settling the same order is idempotent, not a second sale", () => {
  const { order, reveal } = buyer({ seed: 9 });
  const emitted = asEmitted(planDecoys({ window: { from: FROM, to: FROM + WIDTH }, decoys: order.decoys, next: mulberry32(2) }));
  const first = settle({ order, reveal, decoys: emitted, targetCell: CELL, network: NETWORK });
  const registry = claim(new Map(), order, first);
  const again = settle({ order, reveal, decoys: emitted, claimed: registry, targetCell: CELL, network: NETWORK });
  assert.equal(again.claimable.length, first.claimable.length);
  assert.equal(again.rejected.length, 0);
});

test("a tampered reveal keeps its reason through the provider's own accept path", () => {
  // The provider accepted a window it verified; a reveal that opens a different
  // one must still be named as a window problem at settlement, not as a
  // generic failure.
  const { order, reveal } = buyer();
  const accepted = acceptOrder(order, parseWindowProof(serialiseWindowProof(reveal)), { terms: TERMS });
  assert.equal(accepted.ok, true);

  const tampered = { ...reveal, window: { from: reveal.window.from, to: reveal.window.to + 3 } };
  const emitted = asEmitted(planDecoys({ window: accepted.window, decoys: order.decoys, next: mulberry32(4) }));
  const settlement = settle({ order, reveal: tampered, decoys: emitted, targetCell: CELL, network: NETWORK });
  assert.equal(settlement.ok, false);
  assert.equal(settlement.reason, "window-mismatch");
});

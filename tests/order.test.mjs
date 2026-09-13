// The customer-facing half of Ruido: commit, quote, settle.
//
// These are the three things a buyer and a provider have to agree on before any
// money moves, and none of them needs a node, a chain, or a key. That is the
// point — the customer path sits above the emitter and can be built and tested
// today.

import test from "node:test";
import assert from "node:assert/strict";

import { mulberry32 } from "../src/rng.mjs";
import { DENOMINATIONS } from "../src/cover.mjs";
import {
  DOMAIN,
  commitDenomination,
  commitWindow,
  feltBytes,
  hashFelt,
  networkId,
  orderId,
  randomSalt,
  verifyReveal,
} from "../src/commitment.mjs";
import {
  MODES,
  bitsFor,
  decoyCountFor,
  landingRate,
  marginalCostPerBit,
  quote,
} from "../src/quote.mjs";
import { claim, decoyInCell, poolCost, settle } from "../src/settlement.mjs";
import {
  buildOrder,
  parseReveal,
  serialiseOrder,
  serialiseReveal,
} from "../src/order.mjs";

const next = () => mulberry32(20260912);
const NETWORK = "sepolia";
const GEOMETRY = { ladder: DENOMINATIONS.length, windowWidth: 21, blockSpan: 5000 };

// --- the split commitment ---------------------------------------------------
test("a commitment opens to what it was made from, and to nothing else", () => {
  const n = next();
  const salt = randomSalt(n);
  const c = commitWindow({ network: NETWORK, from: 100, to: 120, salt });

  assert.equal(commitWindow({ network: NETWORK, from: 100, to: 120, salt }), c, "deterministic");
  assert.notEqual(commitWindow({ network: NETWORK, from: 100, to: 121, salt }), c);
  assert.notEqual(commitWindow({ network: NETWORK, from: 99, to: 120, salt }), c);
  assert.notEqual(commitWindow({ network: NETWORK, from: 100, to: 120, salt: salt + 1n }), c);
});

test("the two halves are separated by domain, not only by content", () => {
  // Without the tags, a window edge of 10 and a denomination of 10 would commit
  // to the same value — and a reveal for one half could be replayed against the
  // other. This is the test that fails if someone "simplifies" the tags away.
  const salt = 12345n;
  const asWindow = commitWindow({ network: NETWORK, from: 10, to: 10, salt });
  const asDenomination = commitDenomination({ network: NETWORK, denomination: 10n, salt });
  assert.notEqual(asWindow, asDenomination);
  assert.notEqual(DOMAIN.window, DOMAIN.denomination);
});

test("the same cell commits differently on each network", () => {
  const salt = 999n;
  const sepolia = commitDenomination({ network: "sepolia", denomination: 25n, salt });
  const mainnet = commitDenomination({ network: "mainnet", denomination: 25n, salt });
  assert.notEqual(sepolia, mainnet, "an order on one pool must not settle on the other");
  assert.throws(() => networkId("base"), /unknown network/);
});

test("the salt is what keeps a seven-element denomination hidden", () => {
  // A denomination is one of seven values. If the salt were short, the rung
  // would be readable straight off the order book by anyone willing to try seven
  // times, and the split commitment would be decoration. So the attack is
  // demonstrated rather than asserted: break an unsalted commitment, then fail
  // to break a real one.
  const rung = DENOMINATIONS[3];

  const unsalted = commitDenomination({ network: NETWORK, denomination: rung, salt: 0n });
  const recovered = DENOMINATIONS.find(
    (d) => commitDenomination({ network: NETWORK, denomination: d, salt: 0n }) === unsalted,
  );
  assert.equal(recovered, rung, "without a salt the rung falls out in at most seven tries");

  const n = next();
  const salt = randomSalt(n);
  const committed = commitDenomination({ network: NETWORK, denomination: rung, salt });
  const guessed = DENOMINATIONS.find(
    (d) => commitDenomination({ network: NETWORK, denomination: d, salt: 0n }) === committed,
  );
  assert.equal(guessed, undefined, "with a salt, knowing the rung is not enough");
  assert.ok(salt >= 1n << 200n, `salt is only ${salt.toString(2).length} bits wide`);
});

test("orderId is derived, so both sides compute the same one", () => {
  const n = next();
  const windowCommitment = commitWindow({ network: NETWORK, from: 1, to: 2, salt: randomSalt(n) });
  const denominationCommitment = commitDenomination({ network: NETWORK, denomination: 1n, salt: randomSalt(n) });
  const base = { network: NETWORK, windowCommitment, denominationCommitment, decoys: 71 };

  assert.equal(orderId(base), orderId({ ...base }));
  assert.notEqual(orderId(base), orderId({ ...base, decoys: 72 }));
  assert.notEqual(orderId(base), orderId({ ...base, network: "mainnet" }));
  assert.throws(() => orderId({ ...base, decoys: 1.5 }), /whole number/);
});

test("feltBytes refuses what is not a felt", () => {
  assert.equal(feltBytes(0n).length, 32);
  assert.equal(feltBytes(1n).toString("hex"), `${"0".repeat(63)}1`);
  assert.throws(() => feltBytes(-1n), /cannot be negative/);
  assert.throws(() => feltBytes(1n << 256n), /wider than a felt/);
  assert.throws(() => hashFelt("t", 1n << 256n), /wider than a felt/);
});

// --- the quote --------------------------------------------------------------
test("landing rate is geometry: 1 aimed, 1/ladder windowed, both blind", () => {
  assert.equal(landingRate({ mode: "aimed", ...GEOMETRY }), 1);
  assert.equal(landingRate({ mode: "window", ...GEOMETRY }), 1 / 7);
  // Blind has to clear the window and the rung: (21/5000) * (1/7) = 1 in 1,667.
  assert.ok(Math.abs(landingRate({ mode: "blind", ...GEOMETRY }) - 1 / 1666.67) < 1e-3);
  assert.throws(() => landingRate({ mode: "guessed", ...GEOMETRY }), /unknown placement mode/);
  assert.throws(
    () => landingRate({ mode: "blind", ladder: 7, windowWidth: 6000, blockSpan: 5000 }),
    /cannot exceed the span/,
  );
});

test("the quote inverts the model: asking for bits buys at least those bits", () => {
  // The order form asks for bits, not decoys, because a decoy count is not what
  // a buyer wants. The inversion has to be conservative in the buyer's favour,
  // which is why the count is rounded up.
  const targetCell = 1.93;
  for (const bits of [0.5, 1, 2.628, 3, 5]) {
    for (const mode of MODES) {
      const decoys = decoyCountFor({ targetCell, bits, mode, ...GEOMETRY });
      const delivered = bitsFor({ targetCell, decoys, mode, ...GEOMETRY });
      assert.ok(
        delivered >= bits - 1e-9,
        `${mode}: ${decoys} decoys deliver ${delivered.toFixed(4)}b, asked for ${bits}`,
      );
      // And not grossly more: one decoy of rounding slack at most.
      const oneLess = bitsFor({ targetCell, decoys: decoys - 1, mode, ...GEOMETRY });
      assert.ok(oneLess < bits || decoys === 0, `${mode}: ${decoys - 1} decoys already deliver ${bits}`);
    }
  }
});

test("the three positions cost the ladder width, not a mystery multiple", () => {
  // For the same anonymity, withholding the denomination costs exactly the
  // ladder — you have to emit every rung to hide which one is yours — and blind
  // costs 1/landingRate. Stated at the same *bits*, because that is the question
  // a customer actually asks. The same-budget comparison in the README gives a
  // smaller ratio (3.5x at ten decoys) and both are true; they are just
  // different questions, and conflating them is how "300x" got published once.
  const targetCell = 1.93;
  const bits = 3;
  const aimed = decoyCountFor({ targetCell, bits, mode: "aimed", ...GEOMETRY });
  const window = decoyCountFor({ targetCell, bits, mode: "window", ...GEOMETRY });
  const blind = decoyCountFor({ targetCell, bits, mode: "blind", ...GEOMETRY });

  assert.ok(window / aimed > 6 && window / aimed < 8, `window/aimed = ${window / aimed}`);
  assert.ok(blind / aimed > 1000, `blind/aimed = ${blind / aimed}`);
});

test("the marginal bit gets dearer, which is why one figure is not a price", () => {
  const targetCell = 1.93;
  const prices = [0, 10, 50, 250].map((decoys) =>
    marginalCostPerBit({ targetCell, decoys, mode: "aimed", ...GEOMETRY }),
  );
  for (let i = 1; i < prices.length; i += 1) {
    assert.ok(prices[i] > prices[i - 1], `marginal price must rise: ${prices.join(" < ")}`);
  }
  // The floor is the infinitesimal first bit: cell * ln2 * fee = 1.93 * 0.693 * 2.
  assert.ok(Math.abs(prices[0] - 1.93 * Math.LN2 * 2) < 0.02);
});

test("a quote reports what was asked for, what is delivered, and what it costs", () => {
  const q = quote({ targetCell: 1.93, bits: 3, mode: "window", network: "sepolia", ...GEOMETRY });
  assert.equal(q.mode, "window");
  assert.equal(q.bitsRequested, 3);
  assert.ok(q.bitsDelivered >= 3);
  assert.equal(q.cost, BigInt(q.decoys) * 2n);
  assert.ok(q.cost > 0n);
  assert.throws(() => quote({ targetCell: 0, bits: 1, mode: "aimed", ...GEOMETRY }), /at least the buyer/);
  assert.throws(() => quote({ targetCell: 2, bits: 0, mode: "aimed", ...GEOMETRY }), /must be positive/);
});

// --- settlement -------------------------------------------------------------
const decoy = (noteId, block, denomination) => ({ noteId, block, denomination });

function makeOrder({ from = 100, to = 120, denomination = 10n, decoys = 71, bits = 3 } = {}) {
  const n = next();
  const windowSalt = randomSalt(n);
  const denominationSalt = randomSalt(n);
  const windowCommitment = commitWindow({ network: NETWORK, from, to, salt: windowSalt });
  const denominationCommitment = commitDenomination({ network: NETWORK, denomination, salt: denominationSalt });
  return {
    order: {
      id: orderId({ network: NETWORK, windowCommitment, denominationCommitment, decoys }),
      windowCommitment,
      denominationCommitment,
      decoys,
      bits,
    },
    reveal: { window: { from, to }, windowSalt, denomination, denominationSalt },
  };
}

test("a decoy counts only if it is in the window AND on the rung", () => {
  const reveal = { window: { from: 100, to: 120 }, denomination: 10n };
  assert.equal(decoyInCell(decoy(1, 100, 10n), reveal), true, "inclusive lower edge");
  assert.equal(decoyInCell(decoy(2, 120, 10n), reveal), true, "inclusive upper edge");
  assert.equal(decoyInCell(decoy(3, 99, 10n), reveal), false, "one block early");
  assert.equal(decoyInCell(decoy(4, 121, 10n), reveal), false, "one block late");
  assert.equal(decoyInCell(decoy(5, 110, 25n), reveal), false, "right window, wrong rung");
  // The denomination arrives from JSON as a number often enough to matter.
  assert.equal(decoyInCell(decoy(6, 110, 10), reveal), true, "number and BigInt agree");
});

test("settlement separates the work done from the value delivered", () => {
  const { order, reveal } = makeOrder();
  const decoys = [
    decoy(1, 110, 10n), decoy(2, 111, 10n), decoy(3, 112, 10n),
    decoy(4, 113, 10n), decoy(5, 114, 10n),          // in the cell
    decoy(6, 90, 10n), decoy(7, 130, 10n),           // outside the window
    decoy(8, 115, 25n), decoy(9, 116, 50n),          // wrong rung
  ];
  const result = settle({ order, reveal, decoys, targetCell: 1.93, network: NETWORK });

  assert.equal(result.ok, true);
  assert.equal(result.emitted, 9, "every decoy the provider presents is counted as work");
  assert.equal(result.inCell.length, 5, "only five of them are worth anything to this buyer");
  assert.equal(result.claimable.length, 5);
  assert.equal(result.bits, Number(bitsFor({ targetCell: 1.93, decoys: 5, mode: "aimed" }).toFixed(4)));
  assert.equal(result.shortfall, Number(Math.max(0, 3 - result.bits).toFixed(4)));
});

test("one batch of decoys cannot be sold twice", () => {
  // The failure TOKEN.md §3 warns about without explaining. Windows overlap, so
  // a decoy in one buyer's cell is usually in another's too.
  const first = makeOrder({ from: 100, to: 120, decoys: 10, bits: 2 });
  const second = makeOrder({ from: 105, to: 125, decoys: 10, bits: 2 });
  const shared = [decoy(1, 110, 10n), decoy(2, 111, 10n), decoy(3, 112, 10n)];

  const a = settle({ order: first.order, reveal: first.reveal, decoys: shared, targetCell: 2, network: NETWORK });
  assert.equal(a.claimable.length, 3, "the first buyer gets all three");

  const registry = claim(new Map(), first.order, a);
  const b = settle({
    order: second.order, reveal: second.reveal, decoys: shared, targetCell: 2,
    claimed: registry, network: NETWORK,
  });

  assert.equal(b.ok, true, "the second order still settles — it is not fraudulent, it is just too late");
  assert.equal(b.inCell.length, 3, "the decoys are in its cell too");
  assert.equal(b.claimable.length, 0, "but none of them are left to claim");
  assert.equal(b.rejected.length, 3);
  assert.ok(b.rejected.every((r) => r.claimedBy === first.order.id));
  assert.equal(b.bits, 0);
});

test("settling the same order twice is idempotent, not a double sale", () => {
  const { order, reveal } = makeOrder({ decoys: 5, bits: 1 });
  const decoys = [decoy(1, 110, 10n), decoy(2, 111, 10n)];
  const first = settle({ order, reveal, decoys, targetCell: 2, network: NETWORK });
  const registry = claim(new Map(), order, first);
  const again = settle({ order, reveal, decoys, targetCell: 2, claimed: registry, network: NETWORK });

  assert.equal(again.claimable.length, 2, "same order id, so it re-settles to the same thing");
  assert.equal(again.rejected.length, 0);
  assert.equal(claim(registry, order, again).size, 2, "and the registry does not grow");
});

test("a tampered reveal fails, and the reason is kept apart", () => {
  // Window and denomination mismatches are different attacks — claiming a
  // different window versus claiming a different rung — so collapsing them into
  // one boolean throws away the only evidence settlement has.
  const { order, reveal } = makeOrder();
  const decoys = [decoy(1, 110, 10n)];

  const widened = settle({
    order, decoys, targetCell: 2, network: NETWORK,
    reveal: { ...reveal, window: { from: 90, to: 140 } },
  });
  assert.equal(widened.ok, false);
  assert.equal(widened.reason, "window-mismatch");
  assert.equal(widened.claimable.length, 0, "a failed settlement pays nothing");

  const rerouted = settle({
    order, decoys, targetCell: 2, network: NETWORK,
    reveal: { ...reveal, denomination: 100n },
  });
  assert.equal(rerouted.reason, "denomination-mismatch");

  const right = settle({ order, reveal, decoys, targetCell: 2, network: NETWORK });
  assert.equal(right.ok, true);
  assert.equal(right.reason, null);
  assert.throws(() => claim(new Map(), order, widened), /cannot claim a failed settlement/);
});

test("pool cost is one call per decoy, so a payout floor is well defined", () => {
  assert.equal(poolCost(10, "sepolia"), 20n);
  assert.equal(poolCost(10, "mainnet"), 60n);
  assert.equal(poolCost(0), 0n);
});

// --- the wire format --------------------------------------------------------
test("the public half of an order carries no secret, by construction", () => {
  // The property the whole split exists for. Asserting on the exact key set
  // rather than on substrings, because a 64-hex commitment contains "25" about
  // half the time and a substring check would be flaky for the wrong reason.
  const n = next();
  const { order, reveal } = buildOrder({
    network: NETWORK, from: 100, to: 120, denomination: 25n, decoys: 10, bits: 2, next: n,
  });

  assert.deepEqual(Object.keys(serialiseOrder(order)).sort(), [
    "bits",
    "decoys",
    "denominationCommitment",
    "id",
    "network",
    "version",
    "window",
    "windowCommitment",
  ]);

  const publicJson = JSON.stringify(serialiseOrder(order));
  for (const salt of [reveal.windowSalt, reveal.denominationSalt]) {
    assert.ok(
      !publicJson.includes(salt.toString(16)),
      "a salt must never appear in the public half — it is the whole hiding argument",
    );
  }
  assert.equal(serialiseReveal(reveal).denomination, "25", "the rung lives only in the reveal");
});

test("an order survives the wire, which BigInt does not do on its own", () => {
  // JSON.stringify throws on BigInt, so every felt is hex on the wire. This is
  // the trap: a serialiser that works in memory and explodes the first time a
  // buyer saves an order to a file.
  const n = next();
  const { order, reveal } = buildOrder({
    network: NETWORK, from: 100, to: 120, denomination: 10n, decoys: 71, bits: 3, next: n,
  });

  const wireOrder = JSON.parse(JSON.stringify(serialiseOrder(order)));
  const wireReveal = JSON.parse(JSON.stringify(serialiseReveal(reveal)));

  const verdict = verifyReveal(wireOrder, parseReveal(wireReveal), { network: NETWORK });
  assert.equal(verdict.ok, true, "the round trip must still verify");
  assert.equal(verdict.windowOk, true);
  assert.equal(verdict.denominationOk, true);
  assert.equal(verdict.id, order.id, "and the order id must recompute to the same value");

  // And the whole path works: build, serialise, parse, settle.
  const decoys = [decoy(1, 110, 10n), decoy(2, 111, 10n), decoy(3, 112, 10n)];
  const result = settle({
    order: wireOrder, reveal: parseReveal(wireReveal), decoys, targetCell: 2, network: NETWORK,
  });
  assert.equal(result.ok, true);
  assert.equal(result.claimable.length, 3);
});

test("buildOrder refuses a window it cannot mean", () => {
  const n = next();
  assert.throws(
    () => buildOrder({ network: NETWORK, from: 20, to: 10, denomination: 1n, decoys: 5, bits: 1, next: n }),
    /bad window/,
  );
  assert.throws(
    () => buildOrder({ network: NETWORK, from: 10, to: 20, denomination: 1n, decoys: 0, bits: 1, next: n }),
    /at least one decoy/,
  );
});

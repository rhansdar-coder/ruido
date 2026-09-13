// The other side of the trade: what a provider does when an order arrives.
//
// Everything up to here was the buyer's side — commit, price, order, settle —
// and none of it had a counterparty. This module is the counterparty. It is
// deliberately offline: accepting an order, pricing it, planning the decoys and
// recording a payment are all arithmetic, and none of them need a node. Only the
// emission itself does, and that is the emitter's job.
//
// ## The provider sells DECOYS; the buyer buys BITS
//
// The two are not the same order of thing, and the gap between them is the
// buyer's measurement, not the provider's. `decoys = cell * (2**bits - 1) / rate`
// needs `cell`, which is what the buyer measured about the pool. A provider
// cannot verify it and should not try: a buyer who understates the cell pays
// less and receives fewer bits than the order promises, which settlement reports
// as a shortfall. So the provider validates the decoy count it is asked to emit
// and prices that, and `order.bits` travels as the buyer's own claim.
//
// ## What the provider is trusted with, and what it learns
//
// It receives the window preimage and never the denomination — enforced
// structurally by `serialiseWindowProof`, not by good intentions. The
// consequence has to be said plainly, because it is the product: **a provider
// running window-only cover learns WHEN its buyer transacts** (a handful of
// blocks around the spend) and not how much. That is what "knows when, not how
// much" means from the other side of the counter, and it is why the position is
// cheaper than aimed and dearer than blind.
//
// ## Why `planDecoys` places every decoy inside the window
//
// The quote prices window-only cover at a landing rate of `1/ladder`, which
// assumes every decoy clears the block filter by construction and only has to
// clear the denomination one. A provider that spread its decoys across a wider
// span — cheaper, and easy to do by accident — would deliver a fraction of the
// bits it sold while charging for all of them. So the plan asserts it, and a
// test measures the realised rate against the quoted one.

import { DENOMINATIONS, FEE_PER_CALL } from "./cover.mjs";
import { DOMAIN, hashFelt, networkId, verifyWindowProof } from "./commitment.mjs";
import { ORDER_VERSION } from "./order.mjs";
import { randomInt } from "./rng.mjs";

export const PROVIDER_VERSION = 1;

/**
 * What a provider publishes about itself, before any order exists.
 *
 * `ladder` is published because it is the number that turns "how many bits" into
 * "how many decoys" in the window-only position, and a buyer who cannot see it
 * cannot check the quote. `margin` is the provider's own cut on top of the pool
 * fee; it defaults to zero because TOKEN.md §5 says to run this invoiced or
 * prepaid first and discover the margin, not to assume one.
 */
export function providerTerms({
  network = "sepolia",
  ladder = DENOMINATIONS.length,
  margin = 0n,
  address = null,
  maxDecoys = 100_000,
} = {}) {
  if (!Number.isInteger(ladder) || ladder < 1) {
    throw new Error(`a ladder needs at least one rung, got ${ladder}`);
  }
  return {
    providerVersion: PROVIDER_VERSION,
    orderVersion: ORDER_VERSION,
    network,
    ladder,
    feePerCall: FEE_PER_CALL[network] ?? FEE_PER_CALL.sepolia,
    margin: BigInt(margin),
    address,
    maxDecoys,
  };
}

/**
 * Validates an arriving order against the terms and the window proof.
 *
 * Returns the parts rather than a bare boolean, for the same reason
 * `verifyReveal` does: "your proof does not open your commitment" and "your
 * order id is not derived from your own commitments" are different problems and
 * collapsing them loses the only evidence there is.
 *
 * A rejection here must happen BEFORE any emission. The check that matters is
 * the window proof: without it the plaintext window in the order is an
 * unverified claim, and emitting on an unverified claim is how a provider does
 * unpaid work.
 */
export function acceptOrder(order, windowProof, { terms }) {
  const reject = (reason) => ({ ok: false, reason, window: null });

  if (order.version !== ORDER_VERSION) {
    return reject(`unsupported order version ${order.version}`);
  }
  if (order.network !== terms.network) {
    return reject(`order is for ${order.network}, this provider serves ${terms.network}`);
  }
  if (!Number.isInteger(order.decoys) || order.decoys < 1) {
    return reject(`an order needs at least one decoy, got ${order.decoys}`);
  }
  if (order.decoys > terms.maxDecoys) {
    return reject(`order asks for ${order.decoys} decoys, over the provider's cap of ${terms.maxDecoys}`);
  }
  if (!(order.bits > 0)) {
    return reject(`an order must ask for a positive number of bits, got ${order.bits}`);
  }

  const proof = verifyWindowProof(order, windowProof, { network: terms.network });
  if (!proof.windowOk) return reject(proof.reason);

  // The id is derived, so recomputing it is the only way to know the order the
  // provider is about to work on is the order the buyer committed to.
  const derived = deriveOrderId(order);
  if (derived !== order.id) {
    return reject("the order id is not derived from this order's commitments");
  }

  return { ok: true, reason: null, window: { from: windowProof.window.from, to: windowProof.window.to } };
}

/** The order id recomputed from an arriving order's own fields. */
export function deriveOrderId(order) {
  return hashFelt(
    DOMAIN.order,
    networkId(order.network),
    order.windowCommitment,
    order.denominationCommitment,
    order.decoys,
  );
}

/**
 * The invoice, with an id derived from the order it bills.
 *
 * Derived rather than assigned so that a buyer and a provider who disagree about
 * whether an invoice was issued can both recompute it from the public order. The
 * amount is the pool fee the provider will actually pay — one `apply_actions`
 * call per decoy — plus whatever margin the terms declare.
 */
export function invoiceFor(order, terms) {
  const perDecoy = terms.feePerCall + terms.margin;
  const amount = BigInt(order.decoys) * perDecoy;
  return {
    id: hashFelt(DOMAIN.invoice, networkId(order.network), order.id, amount, order.decoys),
    orderId: order.id,
    network: order.network,
    decoys: order.decoys,
    feePerCall: terms.feePerCall,
    margin: terms.margin,
    amount,
    paid: null,
  };
}

/**
 * Records a payment against an invoice.
 *
 * This is the whole payment rail, and it is deliberately this thin: a provider
 * checks a transfer it can see on chain and writes down the reference. There is
 * no escrow, no custody and no refund path in this repository — TOKEN.md §5 says
 * to run it invoiced or prepaid before any of that is designed, and a rail
 * nobody has used is a rail nobody can size.
 */
export function markPaid(invoice, { txHash, block }) {
  if (invoice.paid) throw new Error(`invoice ${invoice.id} is already paid`);
  if (!txHash) throw new Error("a payment needs a transaction hash to be checkable");
  return { ...invoice, paid: { txHash, block: block ?? null } };
}

/**
 * The decoy plan: which blocks and which rungs the provider will emit.
 *
 * Deterministic from `next`, so the same order and the same seed produce the
 * same plan and a dispute can be re-run instead of argued. Every block lands
 * inside the window — see the module header for why that is load-bearing rather
 * than tidy — and the rung is drawn uniformly, which is what makes the provider
 * unable to tell the buyer's rung from a decoy's.
 *
 * `noteId` is NOT assigned here. A note id only exists once the emission lands,
 * and inventing one in the plan would let a plan be mistaken for a receipt.
 */
export function planDecoys({ window, decoys, next, denominations = DENOMINATIONS }) {
  const { from, to } = window;
  if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) {
    throw new Error(`bad window: ${from}..${to}`);
  }
  if (!Number.isInteger(decoys) || decoys < 1) {
    throw new Error(`a plan needs at least one decoy, got ${decoys}`);
  }
  const plan = [];
  for (let index = 0; index < decoys; index += 1) {
    // [from, to] inclusive: the window is a set of blocks the adversary
    // searches, and a decoy one block outside it is a decoy that does not count.
    const block = randomInt(next, from, to + 1);
    const denomination = denominations[randomInt(next, 0, denominations.length)];
    plan.push({ index, block, denomination });
  }
  return plan;
}

/**
 * The seed a provider's plan for one order is drawn from.
 *
 * Mixed with a provider-held seed rather than taken from the order id alone, so
 * the plan is reproducible for a dispute but is not computable by the buyer
 * before the provider commits to it. That is a tidiness property, not a security
 * one — the emissions are public the moment they land — and it is worth saying
 * so, because "the plan is secret" would be a claim this does not support.
 */
export function orderSeed(providerSeed, orderId) {
  const mixed = hashFelt(DOMAIN.invoice, BigInt(providerSeed), orderId);
  // mulberry32 takes a 32-bit state; take the low word of the mixed hash.
  return Number(BigInt(mixed) & 0xffffffffn);
}

/** The plan's own summary, so a provider can see the shape before emitting. */export function summarisePlan(plan, { ladder = DENOMINATIONS.length } = {}) {
  const blocks = plan.map((d) => d.block);
  const byRung = new Map();
  for (const decoy of plan) {
    const key = decoy.denomination.toString();
    byRung.set(key, (byRung.get(key) ?? 0) + 1);
  }
  return {
    decoys: plan.length,
    from: Math.min(...blocks),
    to: Math.max(...blocks),
    // The spread across rungs is what the buyer is buying: a plan that put every
    // decoy on one rung would leave the cell as empty as no cover at all.
    rungsUsed: byRung.size,
    ladder,
    perRung: [...byRung.entries()].map(([rung, count]) => ({ rung, count })),
  };
}

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
import { canSell } from "./sale.mjs";
import { TAG_MOD } from "./payment.mjs";
import { UNIT } from "./pool.mjs";
import { randomInt } from "./rng.mjs";

/**
 * Bumped to 2 when `margin` stopped being whole STRK.
 *
 * This is a unit change on a wire field, which is the dangerous kind: an offer
 * whose margin was 1 STRK under v1 reads as 1 base unit under v2, so the price
 * comes out at 2 STRK instead of 3 and nothing complains. Silent, and in the
 * buyer's favour, which is the direction that never gets reported.
 *
 * A version that is only published is not a defence, so `offerFromTerms` in
 * `src/orderbook.mjs` refuses a terms document that declares a different version
 * — or none at all. A provider that does not say which unit its margin is in has
 * not said which unit its margin is in, and unknown is a refusal.
 */
export const PROVIDER_VERSION = 2;

/**
 * What a provider publishes about itself, before any order exists.
 *
 * `ladder` is published because it is the number that turns "how many bits" into
 * "how many decoys" in the window-only position, and a buyer who cannot see it
 * cannot check the quote. `margin` is the provider's own cut on top of the pool
 * fee; it defaults to zero because TOKEN.md §5 says to run this invoiced or
 * prepaid first and discover the margin, not to assume one.
 *
 * **`margin` is in BASE UNITS (10^-18 STRK) per decoy, and `feePerCall` is in
 * whole STRK.** That asymmetry is deliberate and it is the only one in the
 * protocol: the pool charges whole STRK per call, so the fee it charges is whole
 * by nature, while a margin that could only be whole would be 0%, 50% or 100% on
 * a 2 STRK fee and nothing in between — which is not a margin anyone would set.
 * Quantising the margin to whole STRK quantises the business model to three
 * points.
 *
 * The margin must be a multiple of `TAG_MOD` (10^12 base units, or 10^-6 STRK),
 * because the payment rail writes its per-order tag into the low 12 digits of
 * the amount. `invoiceFor` refuses a margin that does not leave that room rather
 * than issuing an invoice that cannot be tagged. 10^-6 STRK of granularity is
 * five parts in ten million of a 2 STRK fee, so the constraint is free.
 */
export function providerTerms({
  network = "sepolia",
  ladder = DENOMINATIONS.length,
  margin = 0n,
  address = null,
  maxDecoys = 100_000,
  coordination = null,
  emits = false,
} = {}) {
  if (!Number.isInteger(ladder) || ladder < 1) {
    throw new Error(`a ladder needs at least one rung, got ${ladder}`);
  }
  const cut = BigInt(margin);
  if (cut < 0n) throw new Error(`a margin cannot be negative, got ${cut}`);
  if (cut % TAG_MOD !== 0n) {
    throw new Error(
      `a margin must be a multiple of ${TAG_MOD} base units (10^-6 STRK) so the ` +
        `payment tag has somewhere to live, got ${cut}`,
    );
  }
  return {
    providerVersion: PROVIDER_VERSION,
    orderVersion: ORDER_VERSION,
    network,
    ladder,
    feePerCall: FEE_PER_CALL[network] ?? FEE_PER_CALL.sepolia,
    margin: cut,
    address,
    maxDecoys,
    // Absent by default, and that is the truth rather than a placeholder: a
    // provider that forwards nothing declares nothing. This is an ADDITIVE
    // optional field, so `PROVIDER_VERSION` does not move — that version tracks
    // the unit of `margin`, and nothing here changes a unit. The book reads it
    // in `readCoordination` (src/orderbook.mjs), and the provider's obligation to
    // forward is `commissionRequest` (src/commission.mjs).
    coordination,
    // Whether this provider can actually BROADCAST the plan it makes. The
    // default is `false`, and that is the safe direction: a provider that does
    // not say it can emit cannot, and `acceptOrder` refuses on it.
    //
    // The failure this closes is not hypothetical. Until this field existed, a
    // provider with no emitter — which is every provider in this repository,
    // because the emitter is not written — would accept an order, invoice it,
    // verify a REAL on-chain payment, mark the invoice paid and hand back a plan
    // it would never emit. Money taken for work it cannot do, with the receipt
    // to prove it. Accepting an order IS the commitment to emit (`src/trust.mjs`
    // says so in those words), so a provider that cannot emit must not accept.
    //
    // Additive and optional, so `PROVIDER_VERSION` does not move, for the same
    // reason `coordination` did not: absence is the SAFE reading here, so there
    // is no silent mis-read for a version guard to catch. A reader that has never
    // heard of the field sees `emits: false` and declines to order, which is
    // exactly what it should do.
    emits: Boolean(emits),
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
 *
 * The FIRST check is not about the order at all. A provider that cannot emit
 * refuses every order, so it says so before it reads one — and the reason it
 * gives is about itself rather than about the order, because a buyer who
 * reaches a provider that cannot serve them sent a perfectly good order.
 * Reporting an order problem there would be a red herring that blames the buyer
 * for the provider's gap.
 */
export function acceptOrder(order, windowProof, { terms }) {
  const reject = (reason) => ({ ok: false, reason, window: null });

  // The same function the buyer's screen gates on, so a page cannot hand over a
  // command this line is about to refuse.
  const sale = canSell(terms);
  if (!sale.ok) return reject(sale.reason);

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
 *
 * **`amount` is in base units.** It used to be whole STRK, and that is what
 * forced `margin` to be whole STRK, which is what left a provider with exactly
 * three prices: 2, 3 or 4 STRK per decoy, or a margin of 0%, 50% or 100%. The
 * pool fee is still whole by nature and is scaled here rather than stored scaled,
 * so `feePerCall` keeps the unit the pool actually quotes in and a reader who
 * sees "2" is not left guessing whether that means 2 STRK or 2 base units.
 *
 * The amount is asserted to leave the low `TAG_MOD` digits free. It does
 * whenever the margin does, because `feePerCall * UNIT` is a multiple of 10^18
 * and therefore of 10^12 — so this is the margin's quantisation checked where the
 * amount is made, rather than where the tag is applied, which is too late to say
 * which term was wrong.
 */
export function invoiceFor(order, terms) {
  const perDecoy = BigInt(terms.feePerCall) * UNIT + BigInt(terms.margin);
  const amount = BigInt(order.decoys) * perDecoy;
  if (amount % TAG_MOD !== 0n) {
    throw new Error(
      `an invoice amount must leave the low ${TAG_MOD} base units free for the payment ` +
        `tag, got ${amount}; the margin is ${terms.margin} base units per decoy`,
    );
  }
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
 * Records a payment against an invoice — and only a VERIFIED one.
 *
 * This used to take `{ txHash, block }` and write it down, which made it a form
 * rather than a rail: nothing checked that the transfer existed, that it came to
 * this provider, or that it was for the amount quoted. The old call shape now
 * throws instead of succeeding, and that is the point — "record a hash someone
 * looked at" is no longer expressible in this repository.
 *
 * The argument is the verdict from `verifyPayment` (src/payment.mjs), and the
 * only thing that produces one is that verifier, which needs a receipt naming
 * this provider and this exact amount. There is still no escrow, no custody and
 * no refund path: TOKEN.md §5 says to run it invoiced or prepaid before any of
 * that is designed, and a rail nobody has used is a rail nobody can size.
 */
export function markPaid(invoice, verification) {
  if (invoice.paid) throw new Error(`invoice ${invoice.id} is already paid`);
  if (!verification || verification.ok !== true || !verification.payment) {
    throw new Error(
      "an invoice can only be marked paid from the output of verifyPayment — " +
        "a bare transaction hash is not evidence that anything was transferred",
    );
  }
  return { ...invoice, paid: { ...verification.payment } };
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

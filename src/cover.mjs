// Cover traffic: what to emit, how often, and what it costs.
//
// Three decisions carry all the weight here and each one is a place a naive
// implementation quietly fails:
//
//   1. Fixed denominations. Variable amounts make the public deposit leg a
//      fingerprint even when the note contents are encrypted, because the
//      deposit is an ordinary ERC-20 transfer.
//   2. Constant rate, not constant-per-deal. Cover traffic that scales with
//      your real activity tells the observer exactly when you are busy.
//   3. Randomised envelopes. See salt.mjs — a zero-filled padding region is a
//      one-line classifier away from being a label.

import { randomInt } from "./rng.mjs";

/**
 * Denomination ladder, in STRK. Every decoy deposits one of these and nothing
 * else, so the public funding leg carries no amount signal beyond the ladder.
 */
export const DENOMINATIONS = [1n, 2n, 5n, 10n, 25n, 50n, 100n];

/**
 * The pool's fee, in STRK. Measured on-chain 2026-09-11: Sepolia 2, mainnet 6.
 *
 * **It is charged per `apply_actions` CALL, flat, not per action.** From
 * `privacy.cairo`:
 *
 *     fn apply_actions(ref self, actions: Span<ServerAction>, screening: Option<..>) {
 *         self.validate_proof(:actions);
 *         self.collect_fee();          // one flat fee, however many actions follow
 *         ...
 *
 * A single call carrying N `CreateEncNote`s therefore costs 2 STRK, not 2N. The
 * old name here was `FEE_PER_ACTION`, which invites exactly the wrong reading —
 * that cover is ten times cheaper than the model says. It is not, and the reason
 * is below.
 */
export const FEE_PER_CALL = { sepolia: 2n, mainnet: 6n };

export const MODES = ["none", "fixed", "adaptive"];

export function pickDenomination(next) {
  return DENOMINATIONS[randomInt(next, 0, DENOMINATIONS.length)];
}

/**
 * How many decoys to emit in each window.
 *
 * `fixed` emits a constant count. `adaptive` emits a base count plus a fraction
 * of the *observed pool-wide* activity in that window — never a fraction of
 * this operator's own real deals, which would reintroduce the correlation the
 * cover exists to remove.
 */
export function schedule({ mode, windows, baseRate, poolActivity = [], adaptiveFraction = 0.5, next }) {
  const counts = [];
  for (let w = 0; w < windows; w += 1) {
    if (mode === "none") {
      counts.push(0);
    } else if (mode === "adaptive") {
      const observed = poolActivity[w] ?? 0;
      counts.push(baseRate + Math.round(observed * adaptiveFraction));
    } else {
      // Jitter around the base rate so the rate itself is not a constant that
      // an observer can subtract out.
      counts.push(baseRate + randomInt(next, -1, 2));
    }
  }
  return counts;
}

/**
 * The cost of a cover plan. This is the number that decides whether the idea is
 * economic, so it is returned rather than left to the reader.
 *
 * ## Why one call per decoy, when the contract would let you batch
 *
 * The fee is per call (see `FEE_PER_CALL`), so ten decoys in one `apply_actions`
 * would cost 2 STRK instead of 20. It would be easy to call that a tenfold
 * saving. It is not a saving, it is a different and much worse product, and the
 * reason is the finding this whole repository is built on:
 *
 * **Decoys batched into one call share an origin.** The measurement counts
 * *origins*, not notes, because a shared origin is on the ledger rather than
 * inferred — one Sepolia transaction minted 295 notes in one block, which is 295
 * anonymous people by note count and **one suspect** by origin count. A batch of
 * ten decoys is therefore one candidate, and widening a set from 3 to 4 is not
 * what anyone is buying.
 *
 * So one decoy per call is the only shape that buys bits, and it is what this
 * model prices. `calls === decoys` is not an oversight; it is the price of each
 * decoy being its own origin.
 */
export function costEstimate(counts, { network = "sepolia" } = {}) {
  const decoys = counts.reduce((sum, n) => sum + n, 0);
  const fee = FEE_PER_CALL[network] ?? FEE_PER_CALL.sepolia;
  // One call per decoy, deliberately. Batching is cheaper and buys nothing.
  const calls = decoys;
  return { decoys, calls, feePerCall: fee, totalFee: BigInt(calls) * fee, network };
}

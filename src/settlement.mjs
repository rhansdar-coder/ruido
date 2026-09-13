// Settlement: turning a reveal and a list of decoys into the facts a payout can
// be argued from.
//
// Two things happen here and only the first is obvious.
//
//   1. Count the decoys that landed in the revealed cell.
//   2. Refuse to pay twice for the same decoy.
//
// The second is the part an implementation gets wrong, and TOKEN.md §3 says so
// without saying why. The why is that **windows overlap constantly** — the
// buyer's window is a handful of blocks around a block the adversary already
// knows — so a decoy that lands in one buyer's cell usually lands in several
// others' as well. Without a first-claim rule, one batch of decoys can be sold
// to every buyer who asks and the market is a fiction.
//
// The claim key is the order id, which is derived from the two commitments. Two
// different orders cannot collide on it without being the same order, so the
// registry needs no coordination beyond first-write-wins.
//
// ## What settlement deliberately does not decide
//
// It reports both halves of the trade and leaves the policy alone: the decoys
// *emitted* are the provider's work, and the decoys *in the cell* are the
// buyer's value. Those are different numbers whenever the position is
// window-only, and collapsing them into one "payout" figure here would hide a
// decision that belongs in the spec. See docs/ORDER.md.

import { FEE_PER_CALL } from "./cover.mjs";
import { verifyReveal } from "./commitment.mjs";
import { bitsFor } from "./quote.mjs";

/** Whether a decoy falls in the revealed cell. */
export function decoyInCell(decoy, { window, denomination }) {
  if (decoy.block < window.from || decoy.block > window.to) return false;
  return BigInt(decoy.denomination) === BigInt(denomination);
}

/**
 * Settles one order.
 *
 * `decoys` are the emissions the provider is presenting, as
 * `{ noteId, block, denomination }` — read off the chain, not taken on trust.
 * `claimed` is the first-claim registry, a `Map` from note id to the order id
 * that claimed it.
 */
export function settle({ order, reveal, decoys, claimed = new Map(), targetCell, network }) {
  const verdict = verifyReveal(order, reveal, { network });
  if (!verdict.ok) {
    return {
      ok: false,
      reason: !verdict.windowOk
        ? "window-mismatch"
        : !verdict.denominationOk
          ? "denomination-mismatch"
          : "order-id-mismatch",
      verdict,
      emitted: decoys.length,
      inCell: [],
      claimable: [],
      rejected: [],
      bits: 0,
      promised: order.bits ?? null,
      shortfall: null,
    };
  }

  const inCell = decoys.filter((decoy) => decoyInCell(decoy, reveal));
  const claimable = [];
  const rejected = [];
  for (const decoy of inCell) {
    const owner = claimed.get(decoy.noteId);
    // Re-claiming under the same order id is not a double sale, it is the same
    // order settling twice — idempotent, so it is allowed through.
    if (owner === undefined || owner === order.id) claimable.push(decoy);
    else rejected.push({ noteId: decoy.noteId, claimedBy: owner });
  }

  // The placement mode is `aimed` here on purpose: these decoys are already in
  // the cell, because the filter above put them there. Applying a landing rate
  // again would charge the buyer for the same geometry twice.
  const bits = bitsFor({ targetCell, decoys: claimable.length, mode: "aimed" });
  const promised = order.bits ?? null;

  return {
    ok: true,
    reason: null,
    verdict,
    emitted: decoys.length,
    inCell,
    claimable,
    rejected,
    bits: Number(bits.toFixed(4)),
    promised,
    shortfall: promised === null ? null : Number(Math.max(0, promised - bits).toFixed(4)),
  };
}

/**
 * Applies a settlement to the registry and returns the new one.
 *
 * Separate from `settle` so that a settlement can be computed, inspected and
 * discarded without mutating anything — which is what a dispute needs.
 */
export function claim(claimed, order, settlement) {
  if (!settlement.ok) throw new Error(`cannot claim a failed settlement: ${settlement.reason}`);
  const next = new Map(claimed);
  for (const decoy of settlement.claimable) {
    const owner = next.get(decoy.noteId);
    if (owner !== undefined && owner !== order.id) {
      throw new Error(`decoy ${decoy.noteId} is already claimed by ${owner}`);
    }
    next.set(decoy.noteId, order.id);
  }
  return next;
}

/**
 * The pool fee a set of decoys cost, which is the floor under any payout: the
 * provider paid it, one `apply_actions` call per decoy.
 */
export function poolCost(decoys, network = "sepolia") {
  const fee = FEE_PER_CALL[network] ?? FEE_PER_CALL.sepolia;
  return BigInt(decoys) * fee;
}

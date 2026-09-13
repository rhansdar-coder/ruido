// What an order costs, and what it buys.
//
// The measurement says the price of a bit is a curve, not a number: bits grow
// logarithmically while cost grows linearly, so the marginal bit gets dearer and
// there is no volume discount. Quoting one figure is therefore not quoting a
// price — which is exactly the mistake this repository made in public, twice.
//
// So the order form does not ask "how much cover do you want". It asks **how many
// bits**, and this module inverts the model to say how many decoys that takes and
// what they cost. The inversion is exact:
//
//     bits = log2((cell + landed) / cell)   =>   landed = cell * (2**bits - 1)
//     decoys = landed / landingRate
//
// where `landingRate` is the fraction of decoys that land in the cell the
// adversary actually searches. That fraction is the whole difference between the
// three positions, and it is geometry rather than statistics:
//
//     aimed        1
//     window-only  1/ladder
//     blind        (windowWidth / blockSpan) * (1/ladder)
//
// At the defaults that is 1, 1/7 and 1/1,709 — so the same three bits cost one
// price aimed, seven times that window-only, and three orders of magnitude
// blind. See docs/ORDER.md for how that reaches a customer.

import { DENOMINATIONS, FEE_PER_CALL } from "./cover.mjs";

export const MODES = ["aimed", "window", "blind"];

/**
 * Fraction of emitted decoys that land in the target cell.
 *
 * Blind cover has to clear two independent filters: the decoy's block has to
 * fall inside the window, and its denomination has to be the target's. Window-only
 * clears the first by construction and only has to clear the second. Aimed clears
 * both by construction, which is what the provider is paid for.
 */
export function landingRate({ mode, ladder = DENOMINATIONS.length, windowWidth, blockSpan }) {
  if (!MODES.includes(mode)) throw new Error(`unknown placement mode: ${mode}`);
  if (mode === "aimed") return 1;
  const rung = 1 / ladder;
  if (mode === "window") return rung;
  if (!(windowWidth > 0) || !(blockSpan > 0)) {
    throw new Error("blind cover needs the window width and the block span it is spread over");
  }
  if (windowWidth > blockSpan) {
    throw new Error(`window (${windowWidth}) cannot exceed the span it is spread over (${blockSpan})`);
  }
  return (windowWidth / blockSpan) * rung;
}

/** Bits bought by `decoys` decoys, against a cell that already holds `targetCell`. */
export function bitsFor({ targetCell, decoys, ...rest }) {
  assertCell(targetCell);
  if (!(decoys >= 0)) throw new Error(`decoy count cannot be negative: ${decoys}`);
  const rate = landingRate(rest);
  return Math.log2(1 + (decoys * rate) / targetCell);
}

/**
 * Decoys needed to buy `bits`, rounded up.
 *
 * Rounded up because a decoy is atomic: there is no such thing as 1.4 decoys, and
 * rounding down would quietly sell less anonymity than the order says. The
 * rounding is the reason the quoted cost per bit is slightly above the model's
 * marginal figure at small orders — at one decoy the difference is the whole gap
 * between 2.4 and 3.3 STRK per bit.
 */
export function decoyCountFor({ targetCell, bits, ...rest }) {
  assertCell(targetCell);
  if (!(bits > 0)) throw new Error(`bits must be positive, got ${bits}`);
  const rate = landingRate(rest);
  return Math.ceil((targetCell * (2 ** bits - 1)) / rate);
}

/**
 * The full breakdown a customer sees before committing.
 *
 * `cost` is the pool fee only — one `apply_actions` call per decoy, because
 * decoys batched into one call share an origin and the measurement counts
 * origins, not notes. There is no provider margin in this number; see TOKEN.md.
 */
export function quote({ targetCell, bits, mode, network = "sepolia", ...rest }) {
  const decoys = decoyCountFor({ targetCell, bits, mode, ...rest });
  const fee = FEE_PER_CALL[network] ?? FEE_PER_CALL.sepolia;
  const delivered = bitsFor({ targetCell, decoys, mode, ...rest });
  return {
    mode,
    network,
    targetCell,
    bitsRequested: bits,
    // What the decoys actually buy, which is never less than asked for and is
    // usually a little more, because the count was rounded up.
    bitsDelivered: Number(delivered.toFixed(4)),
    decoys,
    landingRate: landingRate({ mode, ...rest }),
    feePerCall: fee,
    cost: BigInt(decoys) * fee,
    costPerBit: Number((BigInt(decoys) * fee) / BigInt(Math.round(delivered * 1000))) / 1000,
  };
}

/**
 * The marginal price of the next bit, in STRK.
 *
 * Included because it is the number that shows the curve is a curve. `quote`
 * averages over the order; this is the derivative, and it is strictly increasing
 * — which is what makes "9.5 STRK/bit" meaningless without an order size.
 */
export function marginalCostPerBit({ targetCell, decoys, network = "sepolia", ...rest }) {
  assertCell(targetCell);
  const fee = FEE_PER_CALL[network] ?? FEE_PER_CALL.sepolia;
  const rate = landingRate(rest);
  // d(bits)/d(decoys) = rate / ((cell + decoys*rate) * ln2)
  const slope = rate / ((targetCell + decoys * rate) * Math.LN2);
  return Number(fee) / slope;
}

function assertCell(targetCell) {
  if (!(targetCell >= 1)) {
    throw new Error(
      `a target cell always contains at least the buyer's own note, got ${targetCell}`,
    );
  }
}

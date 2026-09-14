// The pool's identity on-chain, per network.
//
// ## Why this is its own module
//
// The same two addresses were written into twelve scripts. The Sepolia pool
// address appeared in ten of them as a bare `const POOL = "0x0254…"`, the mainnet
// one in the corpus builder, and the STRK token in two more — so a redeployment
// would have been a change in twelve files, and the file that was missed would
// have kept measuring the OLD pool while reporting the new one. That is a wrong
// number that looks right, which is the failure this repository is built to
// avoid.
//
// The corpus builder is the clearest case and it makes the point by accident: its
// RPC list is imported from `src/blockheight.mjs` under a comment saying
// "Imported, not copied", and the pool address sits two lines below it as a
// literal. The comment was right and the literal was still there.
//
// ## What belongs here, and what does not
//
// Only facts about the *pool itself*: where it is, and what it settles in. Not
// endpoints (those rotate, and they are in `src/blockheight.mjs`), not the
// protocol's shapes (`src/starknet-events.mjs`), not the fee (that is a
// measurement, and it lives with the other measured numbers in `src/cover.mjs`).
//
// The distinction is not tidiness. An address is a fact that is either right or
// wrong for the whole network, so it has exactly one correct home; an endpoint is
// a fact that goes stale, so it has a rotation list. Putting them together would
// make the rotating thing look as fixed as the fixed one.

/**
 * The STRK20 pool, per network.
 *
 * Both addresses were read from the chains themselves, not recalled: the Sepolia
 * one is the contract every decoded event in `data/corpus.json` came from, and
 * the mainnet one is what `npm run corpus:mainnet` indexes. They are also
 * **different contracts** — different deployments, with different histories and
 * three implementations behind the Sepolia one — so they are two entries rather
 * than one address and a network flag.
 *
 * `docs/FINDING-strk20-sepolia.md` records the class-hash history that makes the
 * "three implementations" fact load-bearing: resolving the ABI per block is the
 * only way to decode the Sepolia pool, because decoding it with today's ABI
 * returns plausible garbage without throwing.
 */
export const STRK20_POOL = {
  sepolia: "0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91",
  mainnet: "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a",
};

/**
 * The pool's address on a network, or `undefined` for one we do not serve.
 *
 * `undefined` rather than a throw or a default, for the same reason
 * `readBlockHeight` returns `undefined`: a caller that got a plausible address
 * for the wrong network would decode a real chain and produce real-looking
 * numbers about the wrong pool. Every caller here treats it as a refusal.
 */
export function poolFor(network) {
  return STRK20_POOL[network];
}

/**
 * The asset the pool settles in.
 *
 * Not guessed. The evidence is in this repository's own corpora: this address is
 * the most-used token in **both** the Sepolia pool (5,258 of 21,065 decoded
 * events) and the mainnet one (31,803 of 125,772), and `scripts/verify-compile.mjs`
 * already compiled calldata against it over a Sepolia RPC. That is chain data,
 * reproducible with `npm run corpus`, rather than an address recalled.
 *
 * One address for both networks. That is a measurement, not an assumption: the
 * same token dominates both corpora, and a per-network map with two identical
 * values would invite somebody to "fix" one of them.
 */
export const STRK_TOKEN = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

/**
 * STRK's decimals, which are **not** read from the chain.
 *
 * Said plainly because it is the one number here that is recalled rather than
 * derived: the public Sepolia RPC answers `starknet_blockNumber` and then rejects
 * `starknet_call` with "invalid fp.Element encoding" at spec 0.10.2, so the
 * on-chain `decimals()` could not be read at the time of writing. It is a
 * parameter everywhere it is used, so an operator can override it.
 *
 * A wrong value here is not silent: the buyer would send an amount off by a power
 * of ten and verification would REFUSE it as "not the amount this order was
 * quoted". Wrong is a refusal, which is the acceptable failure.
 */
export const STRK_DECIMALS = 18;

/**
 * The base unit of STRK.
 *
 * An invoice is in this unit, and so is the chain, and so is the payment tag.
 * It used to be that an invoice was in whole STRK and this was only the chain's
 * unit, which is what kept every price a whole number of STRK and left a
 * provider able to charge 0%, 50% or 100% and nothing between. See `invoiceFor`
 * in `src/provider.mjs`.
 *
 * The pool's own fee is still quoted in whole STRK, because the pool charges
 * whole STRK per call — `FEE_PER_CALL` in `src/cover.mjs` is the one figure in
 * the protocol that is whole by nature rather than by convention.
 */
export const UNIT = 10n ** BigInt(STRK_DECIMALS);

/**
 * A decimal STRK string, as base units — exactly.
 *
 * Exact rather than floating, and that is the whole reason this exists. `0.2` is
 * representable as a double but `0.1` is not, and `Number("0.1") * 1e18` is
 * 100000000000000000 only by luck of the rounding. A margin off by one base unit
 * is a margin that fails `invoiceFor`'s multiple-of-10^12 check, and the operator
 * would be looking at a number that prints identically to the one they meant.
 *
 * Digits, not floats. A margin is money, and money is counted.
 */
export function strkToBase(text) {
  const s = String(text).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`not a STRK amount: ${text}`);
  const [whole, frac = ""] = s.split(".");
  if (frac.length > STRK_DECIMALS) {
    throw new Error(`${text} has more than ${STRK_DECIMALS} decimals, which STRK does not have`);
  }
  return BigInt(whole) * UNIT + BigInt(frac.padEnd(STRK_DECIMALS, "0"));
}

/**
 * Base units as a STRK string, for a human to read.
 *
 * Trims trailing zeros rather than padding to 18, because `2.000000000000000000`
 * reads as a precision the figure does not have. A whole amount comes back
 * without a decimal point at all.
 */
export function baseToStrk(base) {
  const value = BigInt(base);
  const whole = value / UNIT;
  const frac = (value % UNIT).toString().padStart(STRK_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

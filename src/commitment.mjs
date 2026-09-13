// The split commitment: how a buyer commits to a cell without handing the
// provider the half it must not know.
//
// A single `H(window, denomination, nonce)` cannot sell the middle position. The
// provider has to know the window — cover that lands after the spend protects
// nobody, so timing is a precondition of the service, not a secret a buyer can
// keep — and it must not learn the denomination, which is the only axis a buyer
// can withhold and the one the measurement prices at 3.5x the aimed price.
// Opening the window would open the denomination with it. So the commitment is
// split in two, and each half is bound on its own.
//
// ## Domain separation is load-bearing, not hygiene
//
// Both halves hash small integers. Without a tag, a window edge of 10 and a
// denomination of 10 would commit to the same value, and a reveal could be
// replayed against the wrong half of the order. The tags below are versioned so
// a change to the layout cannot silently reinterpret an old commitment.
//
// ## The salt is load-bearing too
//
// A denomination is one of seven values and a window is a small block range. A
// short nonce would let anyone brute-force the commitment in a handful of tries
// and read the rung straight off the order book, which is the one thing the
// split exists to prevent. Both salts are full-width felts, and there is a test
// that fails if that stops being true.

import { keccak256 } from "./keccak.mjs";
import { randomBigInt } from "./rng.mjs";

export const DOMAIN = {
  window: "ruido.window.v1",
  denomination: "ruido.denom.v1",
  order: "ruido.order.v1",
  invoice: "ruido.invoice.v1",
};

/** Only the two networks the STRK20 pool is deployed on carry orders. */
const NETWORK_ID = { sepolia: 1n, mainnet: 2n };

export function networkId(network) {
  const id = NETWORK_ID[network];
  if (id === undefined) {
    throw new Error(`unknown network for an order: ${network}`);
  }
  return id;
}

/** A felt as 32 big-endian bytes, which is how Starknet lays them out. */
export function feltBytes(value) {
  const felt = BigInt(value);
  if (felt < 0n) throw new Error(`a felt cannot be negative: ${value}`);
  const hex = felt.toString(16);
  if (hex.length > 64) throw new Error(`wider than a felt: ${hex.length} hex digits`);
  return Buffer.from(hex.padStart(64, "0"), "hex");
}

/** keccak256 over a domain tag and a list of felts, as a 0x string. */
export function hashFelt(tag, ...values) {
  const input = Buffer.concat([Buffer.from(tag, "ascii"), ...values.map(feltBytes)]);
  return `0x${keccak256(input).toString("hex")}`;
}

/**
 * A full-width salt. `randomBigInt(next, 250)` lands in [0, 2**250), which is a
 * felt with room to spare and far out of brute-force range for a 7-element set.
 */
export function randomSalt(next) {
  return randomBigInt(next, 250);
}

/** Binds a window. The provider is given this half in the clear, and this proves
 * at reveal that the window it emitted in was the window that was committed. */
export function commitWindow({ network, from, to, salt }) {
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    throw new Error("window edges must be block numbers");
  }
  if (to < from) throw new Error(`window is inverted: ${from}..${to}`);
  return hashFelt(DOMAIN.window, networkId(network), from, to, salt);
}

/** Hides a denomination. This half is opened only at reveal, after the emission. */
export function commitDenomination({ network, denomination, salt }) {
  return hashFelt(DOMAIN.denomination, networkId(network), denomination, salt);
}

/**
 * The order's identity, and the key settlement claims decoys under.
 *
 * Derived from the two commitments and the decoy count rather than assigned, so
 * both sides compute the same value from the same published order and there is
 * no identifier to disagree about. It deliberately does **not** include the
 * plaintext window or denomination: those are what the commitments hide.
 */
export function orderId({ network, windowCommitment, denominationCommitment, decoys }) {
  if (!Number.isInteger(decoys) || decoys < 0) {
    throw new Error(`decoy count must be a whole number, got ${decoys}`);
  }
  return hashFelt(
    DOMAIN.order,
    networkId(network),
    windowCommitment,
    denominationCommitment,
    decoys,
  );
}

/**
 * Checks the window half of a reveal, on its own, before the other half exists.
 *
 * This is the provider's only defence and it has to run at ACCEPT time, not at
 * settlement time. The order carries the window in the clear as a courtesy copy,
 * and a buyer who commits to one window while telling the provider another gets
 * the provider to emit in the wrong place: the work is done, the reveal opens
 * the committed window, the cell is empty, and settlement returns
 * `window-mismatch` on an order the provider already paid for. Checking the
 * proof against the commitment before emitting is what makes the plaintext
 * window in the order something other than a claim.
 *
 * The denomination half is deliberately not checked here and must not be
 * requested — see `serialiseWindowProof` in order.mjs. A provider that asks for
 * the full reveal to "verify the order" has been handed the rung, and the split
 * commitment was for nothing.
 */
export function verifyWindowProof(order, proof, { network }) {
  if (!proof || !proof.window || proof.windowSalt === undefined) {
    return { windowOk: false, reason: "no window proof supplied" };
  }
  const windowOk =
    commitWindow({
      network,
      from: proof.window.from,
      to: proof.window.to,
      salt: proof.windowSalt,
    }) === order.windowCommitment;
  return {
    windowOk,
    reason: windowOk ? null : "the proof does not open the order's window commitment",
  };
}

/**
 * Recomputes both halves from a reveal and reports which of them hold.
 *
 * Returns the parts rather than a bare boolean, because the two failures mean
 * different things: a window mismatch is a buyer trying to claim a different
 * window after seeing where the decoys landed, and a denomination mismatch is
 * the same move on the other axis. A settlement that collapses them into `false`
 * throws away the only evidence it has.
 */
export function verifyReveal(order, reveal, { network }) {
  const windowOk =
    commitWindow({ network, from: reveal.window.from, to: reveal.window.to, salt: reveal.windowSalt })
    === order.windowCommitment;
  const denominationOk =
    commitDenomination({ network, denomination: reveal.denomination, salt: reveal.denominationSalt })
    === order.denominationCommitment;
  const id = orderId({
    network,
    windowCommitment: order.windowCommitment,
    denominationCommitment: order.denominationCommitment,
    decoys: order.decoys,
  });
  return {
    windowOk,
    denominationOk,
    idOk: order.id === undefined ? true : id === order.id,
    ok: windowOk && denominationOk && (order.id === undefined || id === order.id),
    id,
  };
}

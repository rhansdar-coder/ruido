// Building an order: the one place that decides which parts are public and which
// are secret, and the one place the wire format is defined.
//
// Kept out of the CLI deliberately. A CLI that builds an order slightly
// differently from the code the tests exercise is the classic way a demo passes
// and a product leaks — and here the leak would be the denomination, which is the
// only thing the split commitment exists to protect.
//
// The division is three-way, and only the first two ever leave the buyer:
//
//   ORDER   public. Carries both commitments and the window in the clear,
//           because the provider has to emit inside that window.
//   WINDOW  to the provider, at order time. The window preimage, so the provider
//           can prove the plaintext window is the committed one and emit in it.
//   REVEAL  secret until the window closes. Carries both salts and the rung.
//
// `window` appears in all three. That is not duplication: in the order it is a
// courtesy copy the provider acts on, in the window proof it is the preimage
// that makes that copy checkable, and in the reveal it is the same preimage
// re-presented as evidence. Only the last two are binding, which is why a
// settlement that trusts the order's copy is broken.
//
// The one field that must never reach the provider before the window closes is
// the denomination. `serialiseWindowProof` exists so that "send the provider
// what it needs" cannot be read as "send the provider the reveal".

import {
  commitDenomination,
  commitWindow,
  orderId,
  randomSalt,
} from "./commitment.mjs";

export const ORDER_VERSION = 1;

/**
 * Builds an order and its reveal from one RNG stream.
 *
 * The two salts come from the same stream as everything else so the whole order
 * is reproducible from a seed — which is the only way a disputed order can be
 * re-derived by a third party.
 */
export function buildOrder({ network, from, to, denomination, decoys, bits, next }) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) {
    throw new Error(`bad window: ${from}..${to}`);
  }
  if (!(decoys > 0)) throw new Error(`an order needs at least one decoy, got ${decoys}`);

  const windowSalt = randomSalt(next);
  const denominationSalt = randomSalt(next);
  const windowCommitment = commitWindow({ network, from, to, salt: windowSalt });
  const denominationCommitment = commitDenomination({ network, denomination, salt: denominationSalt });

  return {
    order: {
      version: ORDER_VERSION,
      network,
      window: { from, to },
      windowCommitment,
      denominationCommitment,
      decoys,
      bits,
      id: orderId({ network, windowCommitment, denominationCommitment, decoys }),
    },
    reveal: {
      window: { from, to },
      windowSalt,
      denomination: BigInt(denomination),
      denominationSalt,
    },
  };
}

const hex = (felt) => `0x${BigInt(felt).toString(16)}`;

/**
 * The wire formats. Defined here rather than at each call site because the
 * format *is* the contract between a buyer and a provider, and two JSON shapes
 * that nearly agree is how an order gets rejected for the wrong reason.
 *
 * BigInt does not survive `JSON.stringify`, so every felt is a hex string on the
 * wire. The round trip is tested — see tests/order.test.mjs.
 */
export function serialiseOrder(order) {
  return {
    version: order.version,
    network: order.network,
    window: { from: order.window.from, to: order.window.to },
    windowCommitment: order.windowCommitment,
    denominationCommitment: order.denominationCommitment,
    decoys: order.decoys,
    bits: order.bits,
    id: order.id,
  };
}

export function serialiseReveal(reveal) {
  return {
    window: { from: reveal.window.from, to: reveal.window.to },
    windowSalt: hex(reveal.windowSalt),
    denomination: BigInt(reveal.denomination).toString(),
    denominationSalt: hex(reveal.denominationSalt),
  };
}

/**
 * The half of the reveal a buyer sends to the PROVIDER, at order time.
 *
 * The provider has to be able to emit inside the window, so it needs the window
 * preimage before the window opens — and it must never see the denomination.
 * Sending `serialiseReveal` "so the provider can check the order" is the whole
 * failure this split exists to prevent, and it would look like diligence: the
 * provider gets a complete, verifiable reveal and the rung along with it.
 *
 * So the safe half is its own function with its own key set, and there is a test
 * that asserts exactly which keys it carries. The denomination half is only ever
 * published after the window closes, where it stops being a secret and becomes
 * the evidence settlement runs on.
 */
export function serialiseWindowProof(reveal) {
  return {
    window: { from: reveal.window.from, to: reveal.window.to },
    windowSalt: hex(reveal.windowSalt),
  };
}

/** Parses a window proof off the wire, turning the hex salt back into a felt. */
export function parseWindowProof(json) {
  return {
    window: { from: Number(json.window.from), to: Number(json.window.to) },
    windowSalt: BigInt(json.windowSalt),
  };
}

/** Parses a reveal off the wire, turning the hex salts back into felts. */
export function parseReveal(json) {
  return {
    window: { from: Number(json.window.from), to: Number(json.window.to) },
    windowSalt: BigInt(json.windowSalt),
    denomination: BigInt(json.denomination),
    denominationSalt: BigInt(json.denominationSalt),
  };
}

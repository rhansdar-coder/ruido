// Salt primitives and the one classifier Ruido has to beat.
//
// Wire constants are taken from the Erebus codec (`sdk/ts/src/channel/wire-v3.ts`)
// and verified against the STRK20 contract bounds. The adversary classifier is
// ported line-for-line from the Erebus repo so the comparison is against their
// attack and not a friendlier one we invented.

import { randomBigInt, randomInt } from "./rng.mjs";

export const NOTES_PER_MESSAGE = 5;
export const PAYLOAD_BITS_PER_NOTE = 119;
export const CAPACITY_BITS = NOTES_PER_MESSAGE * PAYLOAD_BITS_PER_NOTE; // 595
export const FLAG_BIT = 1n << 119n; // bit 119 pinned: contract requires salt >= 2
export const SALT_LIMIT = 1n << 120n;
export const MIN_SALT = 2n;

/**
 * The historical wire-v2 fingerprint, verbatim from `scripts/observer.py:223`:
 *
 *     def has_v2_fifth_salt_shape(salt: int) -> bool:
 *         return salt >> 60 == 1 << 59
 *
 * Reads no content bits, only shape: bit 119 set and bits 60..118 all zero.
 * This is the attack M1 is defined against.
 */
export function hasV2FifthSaltShape(salt) {
  return salt >> 60n === 1n << 59n;
}

/** True when the pool contract would accept the salt at all. */
export function isValidSalt(salt) {
  return salt >= MIN_SALT && salt < SALT_LIMIT;
}

/** A uniformly random in-range salt. This is the null model M1 uses. */
export function randomSalt(next) {
  let salt = 0n;
  do {
    salt = randomBigInt(next, 120);
  } while (salt < MIN_SALT);
  return salt;
}

/**
 * A salt carrying the v2 fingerprint: bit 119 pinned, bits 60..118 zero, and
 * an arbitrary low payload. Used to model legacy traffic so the classifier can
 * be shown firing instead of assumed to fire.
 */
export function legacyShapedSalt(next) {
  const payload = randomBigInt(next, 60); // bits 0..59, free
  return payload | FLAG_BIT;
}

/**
 * A salt that deliberately does NOT carry the v2 fingerprint: bit 119 pinned
 * and the padding region filled with noise.
 *
 * The padding is the whole point. Wire v2 zero-filled 59 bits there, which is
 * what made the classifier trivial. Ruido never emits a zero-filled envelope.
 */
export function noiseSalt(next) {
  let salt = 0n;
  do {
    salt = randomBigInt(next, 119) | FLAG_BIT;
  } while (hasV2FifthSaltShape(salt));
  return salt;
}

/**
 * One decoy message: a full set of notes with a random payload.
 *
 * Decoys carry no plaintext and no key material on purpose. A decoy only has to
 * be indistinguishable from a real message to an observer without keys, and
 * uniform random bits are exactly that — no key exists that would let anyone,
 * including us, tell a decoy from a real message later.
 */
export function decoySalts(next, notes = NOTES_PER_MESSAGE) {
  const salts = [];
  for (let i = 0; i < notes; i += 1) salts.push(noiseSalt(next));
  return salts;
}

/** A legacy-shaped message, for negative controls. */
export function legacySalts(next, notes = NOTES_PER_MESSAGE) {
  const salts = [];
  for (let i = 0; i < notes; i += 1) salts.push(legacyShapedSalt(next));
  return salts;
}

/** The number of notes a settlement produces, with optional padding to a fixed count. */
export function settlementNoteCount(next, { fixedShape }) {
  // Without a fixed shape the note count itself leaks one bit: an exact payment
  // produces 6 notes, a payment with change produces 7.
  return fixedShape ? 7 : 6 + randomInt(next, 0, 2);
}

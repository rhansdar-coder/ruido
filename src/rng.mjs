// Seeded RNG. Every number Ruido reports has to be reproducible, because a
// privacy measurement that cannot be re-run is an assertion wearing a decimal.

/** mulberry32: small, fast, good enough for corpus generation. */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A uniform BigInt in [0, 2**bits). */
export function randomBigInt(next, bits) {
  const words = Math.ceil(bits / 32);
  let value = 0n;
  for (let i = 0; i < words; i += 1) {
    value = (value << 32n) | BigInt(Math.floor(next() * 4294967296));
  }
  const excess = words * 32 - bits;
  return excess > 0 ? value >> BigInt(excess) : value;
}

/** A uniform integer in [min, max). */
export function randomInt(next, min, max) {
  return min + Math.floor(next() * (max - min));
}

/** Fisher-Yates, driven by the seeded source. */
export function shuffle(next, items) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

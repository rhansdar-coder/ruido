// starknet_keccak, implemented here so Ruido stays dependency-free.
//
// A Starknet entry point or event selector is keccak256(name) masked to 250
// bits. Node ships no keccak256 in its default provider, and pulling in a
// crypto library to hash fourteen short strings is how a zero-dependency
// project acquires a supply chain.
//
// This is verified against selectors produced by the `starknet` SDK — see
// tests/keccak.test.mjs. Do not edit the round constants.

const MASK = (1n << 250n) - 1n;
const MASK64 = 0xffffffffffffffffn;

const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// Rotation offsets r[x][y].
const ROTATION = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

const rotl = (value, shift) =>
  ((value << BigInt(shift)) | (value >> BigInt(64 - shift))) & MASK64;

/** keccak256 over bytes, returned as a 32-byte Buffer. */
export function keccak256(input) {
  const rate = 136; // 1088 bits: keccak256 sponge rate
  const padding = (rate - ((input.length + 1) % rate)) % rate;
  const padded = Buffer.concat([
    input,
    Buffer.from([0x01]),
    Buffer.alloc(padding),
  ]);
  padded[padded.length - 1] ^= 0x80;

  const state = Array.from({ length: 25 }, () => 0n);

  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let lane = 0; lane < rate / 8; lane += 1) {
      state[lane] ^= padded.readBigUInt64LE(offset + lane * 8);
    }
    for (let round = 0; round < 24; round += 1) {
      // theta
      const C = [0, 1, 2, 3, 4].map(
        (x) => state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20],
      );
      const D = [0, 1, 2, 3, 4].map((x) => C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1));
      for (let x = 0; x < 5; x += 1) {
        for (let y = 0; y < 5; y += 1) state[x + y * 5] ^= D[x];
      }
      // rho and pi
      const B = Array.from({ length: 25 }, () => 0n);
      for (let x = 0; x < 5; x += 1) {
        for (let y = 0; y < 5; y += 1) {
          B[y + ((2 * x + 3 * y) % 5) * 5] = rotl(state[x + y * 5], ROTATION[x][y]);
        }
      }
      // chi
      for (let x = 0; x < 5; x += 1) {
        for (let y = 0; y < 5; y += 1) {
          state[x + y * 5] =
            B[x + y * 5] ^ (~B[((x + 1) % 5) + y * 5] & B[((x + 2) % 5) + y * 5]);
        }
      }
      // iota
      state[0] ^= ROUND_CONSTANTS[round];
    }
  }

  const out = Buffer.alloc(32);
  for (let lane = 0; lane < 4; lane += 1) out.writeBigUInt64LE(state[lane], lane * 8);
  return out;
}

/** A Starknet selector: keccak256(name) masked to 250 bits. */
export function selectorOf(name) {
  return (BigInt(`0x${keccak256(Buffer.from(name, "ascii")).toString("hex")}`) & MASK);
}

/** Hex form, which is how selectors appear in RPC responses. */
export function selectorHex(name) {
  return `0x${selectorOf(name).toString(16)}`;
}

// Known-answer tests for src/keccak.mjs.
//
// Node does not expose keccak256 through node:crypto on any platform we run on
// (verified: "Digest method not supported" on Linux and Windows), so these
// vectors were generated against pycryptodome — an independent implementation —
// and frozen here. They deliberately straddle the 136-byte sponge rate: 135,
// 136 and 137 bytes. Single-block bugs hide there and nowhere else.
//
// Regenerate only if you have a reference implementation to check against:
//   python -c "from Crypto.Hash import keccak; print(keccak.new(digest_bits=256, data=b'').hexdigest())"

import test from "node:test";
import assert from "node:assert/strict";
import { keccak256, selectorOf, selectorHex } from "../src/keccak.mjs";

const hex = (buffer) => buffer.toString("hex");

// Canonical published vectors. These are the two everyone quotes.
const CANONICAL = [
  ["", "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"],
  ["abc", "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"],
];

// Generated: input byte i is (i * 7 + n) % 256, for length n. Covers the rate
// boundary (136) and every awkward sub-multiple around it.
const GENERATED = {
  1: "5fe7f977e71dba2ea1a68e21057beebb9be2ac30c6410aa38d4f3fbe41dcffd2",
  3: "7d228cdb40e661b0731cd20c876de675137701233a19b450a36e53a053407a22",
  55: "546a7fe6ccfdaf2fb18c8725219ad2041f386774722f4f2dcb3b2793bfa58b7e",
  56: "0cdb8fcd4763c8d9f8b6c398744ab4424b90653a7f12c33ee1c2d1a07537b799",
  63: "23d423b6d670da9f8eb7005be5babaaae40beaade0df1285f9afe52c99a48913",
  64: "d432c602ee561dfffe10aa1a7df28751b7990fcb5ba7a66055452fd680beb44c",
  65: "d14beec624675ed9c45cd3291bfe6c7117ead23dda513937c78e4d9703ff88a0",
  71: "ad89939b62ad68d3486ddcf0afb76f5005e548ecb5be0b539977e9972a9d1473",
  72: "76f26b049572c8817894cecfcb21c080480ed822a9d1a1192ed1dc6390f39db7",
  135: "8ab570337c9a3a773c3605160ca58e3f0546d92d217c908669cc4f35a31933bc",
  136: "16b30a6be318a7acbcba7a2194789f628abf68dfbbf55a4d840f22f6a4d29efd",
  137: "6a7e8293441d51be41bf4994995b35981f90c07866c7fd0465f405e2b7a8f8dd",
  143: "44155d1cbe1b42fdc2d7da57823137461f4589a7e86cfe5e429c55cb55a258ae",
  144: "fe052a68a78768cd738644a394394460e6bc3dfa6fbf82581c63531d1bcda736",
  200: "5df43bf0d784fc93408fa76ffebdf2b45f60884dbbae8b0f1e47ab05f37f8508",
  1000: "5cab097db1a529f5b1a15428cc494df950671bc3824340aad89941fa68e151bc",
};

const pattern = (n) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7 + n) % 256));

test("keccak256 matches published vectors", () => {
  for (const [input, expected] of CANONICAL) {
    assert.equal(hex(keccak256(Buffer.from(input, "ascii"))), expected, `input ${JSON.stringify(input)}`);
  }
});

test("keccak256 matches reference across lengths and block boundaries", () => {
  for (const [length, expected] of Object.entries(GENERATED)) {
    const n = Number(length);
    assert.equal(hex(keccak256(pattern(n))), expected, `length ${n}`);
  }
});

test("keccak256 returns exactly 32 bytes and is deterministic", () => {
  const a = keccak256(Buffer.from("ruido", "ascii"));
  const b = keccak256(Buffer.from("ruido", "ascii"));
  assert.equal(a.length, 32);
  assert.equal(hex(a), hex(b));
  assert.notEqual(hex(a), hex(keccak256(Buffer.from("ruidp", "ascii"))));
});

test("keccak256 does not mutate its input", () => {
  const input = Buffer.from("EncNoteCreated", "ascii");
  const copy = Buffer.from(input);
  keccak256(input);
  assert.deepEqual(input, copy);
});

// Real Starknet selectors. The EncNoteCreated / NoteUsed / Deposit values below
// are the actual keys[0] observed in starknet_getEvents against the deployed
// STRK20 pool, which is the strongest available check: it is not a test vector
// we chose, it is what the chain emitted.
const SELECTORS = {
  EncNoteCreated: "0x23c20207be8b1ef4430c25eef8ce779c9745ebe04139555ae81bd4f8fdd6ec5",
  NoteUsed: "0x247fc60d782e0094e7f98c47f277d92a3345d07a436f1f56b27a9b62be2322e",
  Deposit: "0x9149d2123147c5f43d258257fef0b7b969db78269369ebcf5ebb9eef8592f2",
  Withdrawal: "0x2eed7e29b3502a726faf503ac4316b7101f3da813654e8df02c13449e03da8",
  ViewingKeySet: "0x1321a492485b4f19851fb787ab3800a0030b595332cba93cd5fe40dfb5a4daf",
  OpenNoteCreated: "0x22330482fd296a27cf9096807b4a3622cd619d31cce42c1e55655914e8459ee",
  get_version: "0x2a4bb4205277617b698a9a2950b938d0a236dd4619f82f05bec02bdbd245fab",
};

test("selectorHex produces the keys the pool actually emits", () => {
  for (const [name, expected] of Object.entries(SELECTORS)) {
    assert.equal(selectorHex(name), expected, name);
  }
});

test("selectors are masked to 250 bits", () => {
  const limit = 1n << 250n;
  for (const name of Object.keys(SELECTORS)) {
    const value = selectorOf(name);
    assert.ok(value >= 0n && value < limit, `${name} = ${value} out of range`);
  }
});

test("masking actually bites on a name whose hash starts high", () => {
  // EncNoteCreated hashes to 0x3e3c... — the top bits are non-zero, so if the
  // mask were missing this would return 0x3e3c... and the corpus index would
  // silently match zero events. This is the bug the mask exists to prevent.
  const unmasked = BigInt("0x3e3c20207be8b1ef4430c25eef8ce779c9745ebe04139555ae81bd4f8fdd6ec5");
  assert.equal(selectorOf("EncNoteCreated"), unmasked & ((1n << 250n) - 1n));
  assert.notEqual(selectorOf("EncNoteCreated"), unmasked);
});

test("selectorOf and selectorHex agree", () => {
  assert.equal(selectorHex("NoteUsed"), `0x${selectorOf("NoteUsed").toString(16)}`);
});

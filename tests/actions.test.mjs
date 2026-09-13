// Tests for the calldata decoder.
//
// The bug this file exists for was silent. `splitGeneric` returned the head of
// `core::array::Span::<X>` as `"core::array::Span::"` — with the separator still
// attached — so the comparison against `"core::array::Span"` failed, the Span
// branch was skipped, and the decoder fell through to "one felt". It did not
// throw. It returned `consumed 4 of 55` on a real transaction: a wrong answer
// that looked like a right one, which is the failure mode this project treats
// as the enemy.
//
// The exact-consumption assertion is what caught it, so that is what is pinned
// here.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decodeCall,
  decodeValue,
  encodeCall,
  encodeValue,
  findFunction,
  splitGeneric,
  splitTopLevel,
  typeRegistry,
  unwrapExecute,
} from "../src/actions.mjs";

test("splitGeneric strips the separator before the generic bracket", () => {
  const { head, inner } = splitGeneric("core::array::Span::<privacy::actions::ServerAction>");
  // The regression: `head` used to be "core::array::Span::" and every caller
  // comparing against the bare name silently took the wrong branch.
  assert.equal(head, "core::array::Span");
  assert.equal(inner, "privacy::actions::ServerAction");
});

test("splitGeneric balances nested generics instead of truncating", () => {
  const { head, inner } = splitGeneric("core::array::Span::<core::array::Span::<core::felt252>>");
  assert.equal(head, "core::array::Span");
  assert.equal(inner, "core::array::Span::<core::felt252>");
});

test("splitGeneric on a non-generic type returns the type itself", () => {
  assert.deepEqual(splitGeneric("core::felt252"), { head: "core::felt252", inner: null });
});

test("splitTopLevel splits tuples only at depth zero", () => {
  assert.deepEqual(splitTopLevel("core::felt252, core::felt252"), ["core::felt252", " core::felt252"]);
  assert.deepEqual(splitTopLevel("core::array::Span::<core::felt252>, core::bool"), [
    "core::array::Span::<core::felt252>",
    " core::bool",
  ]);
});

test("decodeValue reads a Span as [length, ...elements]", () => {
  const reg = { structs: new Map(), enums: new Map() };
  const out = decodeValue("core::array::Span::<core::felt252>", ["0x3", "0xa", "0xb", "0xc"], 0, reg);
  assert.deepEqual(out.value, ["0xa", "0xb", "0xc"]);
  assert.equal(out.consumed, 4);
});

test("decodeValue reads Option Some as variant 0 and None as variant 1", () => {
  // Cairo declares `enum Option<T> { Some: T, None }`, so `Some` owns variant 0
  // and carries the payload. The SDK states the same fact from the other side:
  // `screening_suffix(None) == vec![Felt::ONE]` (sdk/rs/src/calldata.rs:151), and
  // sdk/ts/tests/wire-pool.test.ts:107 calls the trailing `0x1` "Serde for
  // Option::None".
  //
  // This test used to assert the inverse (`["0x0"]` is None), so it pinned the
  // bug instead of catching it. A real `Some` read as `None` still returned a
  // value — it just left the attestation's felts unread, and only the
  // exact-consumption check noticed.
  const reg = { structs: new Map(), enums: new Map() };

  const some = decodeValue("core::option::Option::<core::felt252>", ["0x0", "0xbeef"], 0, reg);
  assert.equal(some.value, "0xbeef");
  assert.equal(some.consumed, 2);

  const none = decodeValue("core::option::Option::<core::felt252>", ["0x1"], 0, reg);
  assert.equal(none.value, null);
  assert.equal(none.consumed, 1);
});

test("decodeValue rejects an Option variant that is neither 0 nor 1", () => {
  const reg = { structs: new Map(), enums: new Map() };
  assert.throws(
    () => decodeValue("core::option::Option::<core::felt252>", ["0x2", "0xbeef"], 0, reg),
    /bad Option variant 2/,
  );
});

test("decodeValue reads a tuple with no generic inside it", () => {
  // `splitGeneric` returns the whole string as `head` when there is no `<`, so
  // the tuple branch's old `head === "("` test was false for exactly this shape
  // — `ScreeningAttestation.signature: (felt252, felt252)`. The tuple fell
  // through to the one-felt fallback and left a felt unread.
  const reg = { structs: new Map(), enums: new Map() };
  const out = decodeValue("(core::felt252, core::felt252)", ["0xa", "0xb"], 0, reg);
  assert.deepEqual(out.value, ["0xa", "0xb"]);
  assert.equal(out.consumed, 2);
});

test("decodeValue reads u256 as two felts, not one", () => {
  // `u256` sat in PRIMITIVES, which is tested before WIDE — so it decoded as a
  // single felt and the WIDE set was dead code.
  const reg = { structs: new Map(), enums: new Map() };
  const out = decodeValue("core::integer::u256", ["0x64", "0x0"], 0, reg);
  assert.deepEqual(out.value, { low: "0x64", high: "0x0" });
  assert.equal(out.consumed, 2);
});

test("an Option<ScreeningAttestation> consumes variant plus three felts", () => {
  // The shape that found all three bugs at once, against real calldata:
  //   ScreeningAttestation { issued_at: u64, signature: (felt252, felt252) }
  // so Some is 4 felts in total and None is 1. Decoding `Some` as 3 left the
  // last signature felt unread and reported consumed 100 of 101.
  const reg = {
    structs: new Map([
      [
        "privacy::snip12::ScreeningAttestation",
        [
          { name: "issued_at", type: "core::integer::u64" },
          { name: "signature", type: "(core::felt252, core::felt252)" },
        ],
      ],
    ]),
    enums: new Map(),
  };
  const type = "core::option::Option::<privacy::snip12::ScreeningAttestation>";

  const some = decodeValue(type, ["0x0", "0x6a5d85a1", "0xaa", "0xbb"], 0, reg);
  assert.equal(some.consumed, 4);
  assert.deepEqual(some.value, { issued_at: "0x6a5d85a1", signature: ["0xaa", "0xbb"] });

  const none = decodeValue(type, ["0x1"], 0, reg);
  assert.equal(none.value, null);
  assert.equal(none.consumed, 1);
});

test("decodeValue throws on an unknown type instead of guessing one felt", () => {
  // The old fallback returned one felt for anything unrecognised, which is how a
  // dead tuple branch stayed invisible. `scripts/check-abi-types.mjs` proves the
  // throw cannot fire on the deployed ABI.
  const reg = { structs: new Map(), enums: new Map() };
  assert.throws(() => decodeValue("priv::NotInTheRegistry", ["0x1"], 0, reg), /cannot decode type/);
});

test("decodeValue reads an enum variant and its payload", () => {
  const reg = {
    structs: new Map([["priv::DepositInput", [{ name: "user", type: "core::felt252" }, { name: "amount", type: "core::felt252" }]]]),
    enums: new Map([["priv::Action", [{ name: "Nothing" }, { name: "Deposit", type: "priv::DepositInput" }]]]),
  };
  const out = decodeValue("priv::Action", ["0x1", "0xabc", "0x64"], 0, reg);
  assert.equal(out.value.variant, "Deposit");
  assert.deepEqual(out.value.value, { user: "0xabc", amount: "0x64" });
  assert.equal(out.consumed, 3);

  const bare = decodeValue("priv::Action", ["0x0"], 0, reg);
  assert.equal(bare.value.variant, "Nothing");
  assert.equal(bare.consumed, 1);
});

test("decodeCall reports exact consumption, not just success", () => {
  const abi = [
    {
      type: "interface",
      name: "priv::IThing",
      items: [
        {
          type: "function",
          name: "do_it",
          inputs: [
            { name: "actions", type: "core::array::Span::<core::felt252>" },
            { name: "flag", type: "core::option::Option::<core::felt252>" },
          ],
        },
      ],
    },
  ];
  // 1 length + 2 elements + 1 felt of None (variant 1)
  const good = decodeCall(abi, "do_it", ["0x2", "0xa", "0xb", "0x1"]);
  assert.equal(good.ok, true);
  assert.equal(good.consumed, 4);
  assert.deepEqual(good.args.actions, ["0xa", "0xb"]);
  assert.equal(good.args.flag, null);

  // The same call with Some: variant 0 plus one payload felt.
  const some = decodeCall(abi, "do_it", ["0x2", "0xa", "0xb", "0x0", "0xbeef"]);
  assert.equal(some.ok, true);
  assert.equal(some.consumed, 5);
  assert.equal(some.args.flag, "0xbeef");

  // One felt left over: the layout is wrong, and `ok` is the only thing that
  // says so. This is the exact shape of the bug this file guards.
  const trailing = decodeCall(abi, "do_it", ["0x2", "0xa", "0xb", "0x1", "0xdead"]);
  assert.equal(trailing.ok, false);
  assert.equal(trailing.consumed, 4);
  assert.equal(trailing.length, 5);
});

test("findFunction reaches into interfaces, where the pool keeps its entrypoints", () => {
  const abi = [
    { type: "interface", name: "priv::IClient", items: [{ type: "function", name: "apply_actions", inputs: [] }] },
  ];
  assert.equal(findFunction(abi, "apply_actions")?.name, "apply_actions");
  assert.equal(findFunction(abi, "nope"), null);
});

test("unwrapExecute reads the account envelope, not the pool arguments", () => {
  // [calls_len, to, selector, calldata_len, ...calldata]
  const calldata = ["0x1", "0xpool", "0xsel", "0x3", "0xa", "0xb", "0xc"];
  const calls = unwrapExecute(calldata);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, "0xpool");
  assert.equal(calls[0].selector, "0xsel");
  assert.deepEqual(calls[0].args, ["0xa", "0xb", "0xc"]);
});

test("unwrapExecute handles a two-call batch", () => {
  const calldata = [
    "0x2",
    "0xaaa", "0xs1", "0x1", "0x1",
    "0xbbb", "0xs2", "0x2", "0x2", "0x3",
  ];
  const calls = unwrapExecute(calldata);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ["0x1"]);
  assert.deepEqual(calls[1].args, ["0x2", "0x3"]);
});

test("typeRegistry separates structs from enums", () => {
  const abi = [
    { type: "struct", name: "s::A", members: [{ name: "x", type: "core::felt252" }] },
    { type: "enum", name: "s::B", variants: [{ name: "V" }] },
  ];
  const reg = typeRegistry(abi);
  assert.ok(reg.structs.has("s::A"));
  assert.ok(reg.enums.has("s::B"));
});

// --- the encoder -------------------------------------------------------------
// The encoder exists because the emitter has to *build* an `apply_actions` call
// and this project could only read one. It is written as the inverse of the
// decoder, so most of these are round-trips: decode, encode, require the felts
// back. `scripts/verify-encode.mjs` does the same thing against 83 real
// transactions spanning all seven pool implementations; these pin the individual
// shapes so a failure names the shape rather than naming a felt index.

const EMPTY_REG = { structs: new Map(), enums: new Map() };

test("encodeValue inverts decodeValue for a Span", () => {
  const felts = ["0x3", "0xa", "0xb", "0xc"];
  const decoded = decodeValue("core::array::Span::<core::felt252>", felts, 0, EMPTY_REG);
  assert.deepEqual(
    encodeValue("core::array::Span::<core::felt252>", decoded.value, EMPTY_REG),
    [3n, 10n, 11n, 12n],
  );
});

test("encodeValue writes Option Some as variant 0 and None as variant 1", () => {
  const type = "core::option::Option::<core::felt252>";
  assert.deepEqual(encodeValue(type, "0xbeef", EMPTY_REG), [0n, 0xbeefn]);
  assert.deepEqual(encodeValue(type, null, EMPTY_REG), [1n]);
});

test("encodeValue refuses an Option<Option<T>>, where null is ambiguous", () => {
  // `Some(None)` and `None` both decode to `null`, so a null cannot be
  // re-encoded. Guessing would silently convert one into the other — the same
  // class of invisible mistake the Option order bug was. The deployed ABI has no
  // nested Option, so this guard exists to make adding one an error.
  const type = "core::option::Option::<core::option::Option::<core::felt252>>";
  assert.throws(() => encodeValue(type, null, EMPTY_REG), /indistinguishable/);
  // A present value is not ambiguous and still encodes: Some(Some(7)).
  assert.deepEqual(encodeValue(type, "0x7", EMPTY_REG), [0n, 0n, 7n]);
});

test("encodeValue inverts decodeValue for a tuple with no generic inside it", () => {
  const felts = ["0xa", "0xb"];
  const decoded = decodeValue("(core::felt252, core::felt252)", felts, 0, EMPTY_REG);
  assert.deepEqual(encodeValue("(core::felt252, core::felt252)", decoded.value, EMPTY_REG), [10n, 11n]);
});

test("encodeValue writes u256 as two felts and demands both", () => {
  assert.deepEqual(encodeValue("core::integer::u256", { low: "0x64", high: "0x0" }, EMPTY_REG), [100n, 0n]);
  assert.throws(() => encodeValue("core::integer::u256", { low: "0x64" }, EMPTY_REG), /both low and high/);
  assert.throws(() => encodeValue("core::integer::u256", "0x64", EMPTY_REG), /needs \{low, high\}/);
});

test("encodeValue writes a bool as one felt", () => {
  assert.deepEqual(encodeValue("core::bool", true, EMPTY_REG), [1n]);
  assert.deepEqual(encodeValue("core::bool", false, EMPTY_REG), [0n]);
});

test("encodeValue writes an enum variant and refuses the two short forms", () => {
  const reg = {
    structs: new Map([
      ["priv::DepositInput", [
        { name: "user", type: "core::felt252" },
        { name: "amount", type: "core::felt252" },
      ]],
    ]),
    enums: new Map([
      ["priv::Action", [{ name: "Nothing" }, { name: "Deposit", type: "priv::DepositInput" }]],
    ]),
  };

  // A variant that takes no payload is fine as a bare name.
  assert.deepEqual(encodeValue("priv::Action", "Nothing", reg), [0n]);
  // One that does take a payload takes it in the decoder's own shape, which is
  // what makes the round-trip work.
  assert.deepEqual(
    encodeValue("priv::Action", { variant: "Deposit", value: { user: "0xabc", amount: "0x64" } }, reg),
    [1n, 0xabcn, 100n],
  );

  // Naming a payload-carrying variant without a payload would write the variant
  // felt and nothing else, shifting every following field by one. Refuse.
  assert.throws(() => encodeValue("priv::Action", "Deposit", reg), /needs a payload/);
  // And the inverse: a payload handed to a variant that takes none would write
  // a felt the contract will read as the next field.
  assert.throws(
    () => encodeValue("priv::Action", { variant: "Nothing", value: "0x1" }, reg),
    /carries no payload/,
  );
  assert.throws(() => encodeValue("priv::Action", "Nope", reg), /no variant Nope/);
});

test("encodeValue refuses a struct with a member missing", () => {
  const reg = {
    structs: new Map([
      ["priv::S", [{ name: "a", type: "core::felt252" }, { name: "b", type: "core::felt252" }]],
    ]),
    enums: new Map(),
  };
  assert.throws(() => encodeValue("priv::S", { a: "0x1" }, reg), /missing member b/);
});

test("encodeValue throws on an unknown type instead of writing one felt", () => {
  // Same doctrine as the decoder's throw: an unknown type here would write a
  // felt that means nothing, and the contract would either revert or accept it
  // as something else.
  assert.throws(() => encodeValue("priv::NotInTheRegistry", "0x1", EMPTY_REG), /cannot encode type/);
});

test("encodeCall inverts decodeCall over a whole apply_actions argument list", () => {
  // The exact argument list the emitter has to produce: a Span of actions, each
  // carrying a Span payload, plus an Option<Attestation> whose payload holds a
  // tuple. Every branch that has ever had a bug, in one call.
  const abi = [
    { type: "struct", name: "priv::Action", members: [
      { name: "kind", type: "core::felt252" },
      { name: "payload", type: "core::array::Span::<core::felt252>" },
    ] },
    { type: "struct", name: "priv::Attestation", members: [
      { name: "issued_at", type: "core::integer::u64" },
      { name: "signature", type: "(core::felt252, core::felt252)" },
    ] },
    { type: "function", name: "apply_actions", inputs: [
      { name: "actions", type: "core::array::Span::<priv::Action>" },
      { name: "screening", type: "core::option::Option::<priv::Attestation>" },
    ] },
  ];

  const actions = [
    "0x2",
    "0x5", "0x2", "0xaa", "0xbb",
    "0x4", "0x0",
  ];

  const some = [...actions, "0x0", "0x6a5d85a1", "0xcc", "0xdd"];
  const outSome = decodeCall(abi, "apply_actions", some);
  assert.ok(outSome.ok, `decoder consumed ${outSome.consumed} of ${outSome.length}`);
  assert.deepEqual(encodeCall(abi, "apply_actions", outSome.args), some.map((f) => BigInt(f)));

  const none = [...actions, "0x1"];
  const outNone = decodeCall(abi, "apply_actions", none);
  assert.ok(outNone.ok, `decoder consumed ${outNone.consumed} of ${outNone.length}`);
  assert.equal(outNone.args.screening, null);
  assert.deepEqual(encodeCall(abi, "apply_actions", outNone.args), none.map((f) => BigInt(f)));
});

test("encodeCall refuses a missing argument instead of writing a short call", () => {
  const abi = [
    { type: "function", name: "f", inputs: [
      { name: "a", type: "core::felt252" },
      { name: "b", type: "core::felt252" },
    ] },
  ];
  assert.throws(() => encodeCall(abi, "f", { a: "0x1" }), /missing argument b/);
  assert.throws(() => encodeCall(abi, "nope", { a: "0x1", b: "0x2" }), /no function nope in ABI/);
});

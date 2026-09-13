// Tests for the Starknet event decoder.
//
// The decoder exists because amounts were dropped at the RPC boundary and the
// denomination axis could not be measured. The tests below are aimed at the
// specific way that axis can be measured *wrongly*: a member read from the
// wrong felt index returns a plausible number rather than an error. On a
// Withdrawal the correct index is data[3], and data[0] holds a fragment of the
// recipient's encrypted address. Nothing about that mistake announces itself,
// so it has to be pinned by a test.

import { test } from "node:test";
import assert from "node:assert/strict";

import { selectorHex } from "../src/keccak.mjs";
import {
  decimalToHex,
  decodeEvent,
  eventDefinitions,
  feltToDecimal,
  feltWidth,
  shortName,
  structTable,
} from "../src/starknet-events.mjs";

// The shapes below are copied from the deployed pool's ABI, trimmed to the
// members that matter. The widths are the whole point: EncUserAddr is three
// felts, which is what pushes Withdrawal.amount to data[3].
const ABI = [
  {
    type: "struct",
    name: "privacy::objects::EncUserAddr",
    members: [
      { name: "auditor_public_key", type: "core::felt252" },
      { name: "ephemeral_pubkey", type: "core::felt252" },
      { name: "enc_user_addr", type: "core::felt252" },
    ],
  },
  {
    type: "event",
    kind: "struct",
    name: "privacy::events::Deposit",
    members: [
      { name: "user_addr", kind: "key", type: "core::starknet::contract_address::ContractAddress" },
      { name: "token", kind: "key", type: "core::starknet::contract_address::ContractAddress" },
      { name: "amount", kind: "data", type: "core::integer::u128" },
    ],
  },
  {
    type: "event",
    kind: "struct",
    name: "privacy::events::Withdrawal",
    members: [
      { name: "enc_user_addr", kind: "data", type: "privacy::objects::EncUserAddr" },
      { name: "to_addr", kind: "key", type: "core::starknet::contract_address::ContractAddress" },
      { name: "token", kind: "key", type: "core::starknet::contract_address::ContractAddress" },
      { name: "amount", kind: "data", type: "core::integer::u128" },
    ],
  },
  {
    type: "event",
    kind: "struct",
    name: "privacy::events::OpenNoteDeposited",
    members: [
      { name: "depositor", kind: "key", type: "core::starknet::contract_address::ContractAddress" },
      { name: "token", kind: "key", type: "core::starknet::contract_address::ContractAddress" },
      { name: "note_id", kind: "key", type: "core::felt252" },
      { name: "amount", kind: "data", type: "core::integer::u128" },
    ],
  },
  {
    // An event whose payload cannot be sized: an array has no fixed width.
    type: "event",
    kind: "struct",
    name: "privacy::events::HasArray",
    members: [
      { name: "items", kind: "data", type: "core::array::Array<core::felt252>" },
    ],
  },
];

const defs = eventDefinitions(ABI).defs;
const byName = (name) => [...defs.values()].find((d) => d.name === name);

// --- widths -----------------------------------------------------------------

test("feltWidth resolves primitives", () => {
  const structs = structTable(ABI);
  assert.equal(feltWidth("core::felt252", structs), 1);
  assert.equal(feltWidth("core::integer::u128", structs), 1);
  // u256 is (low, high): two felts, not one.
  assert.equal(feltWidth("core::integer::u256", structs), 2);
});

test("feltWidth sums nested struct members", () => {
  const structs = structTable(ABI);
  // This is the number that moves Withdrawal.amount from data[0] to data[3].
  assert.equal(feltWidth("privacy::objects::EncUserAddr", structs), 3);
});

test("feltWidth returns null for a type it cannot size", () => {
  const structs = structTable(ABI);
  assert.equal(feltWidth("core::array::Array<core::felt252>", structs), null);
  assert.equal(feltWidth("some::Unknown::Type", structs), null);
  // null, never a guess of 1. An unsized member is a missing measurement.
  assert.notEqual(feltWidth("core::array::Array<core::felt252>", structs), 1);
});

test("feltWidth terminates on a recursive struct instead of looping", () => {
  const structs = new Map([
    ["Node", [{ name: "next", type: "Node" }]],
  ]);
  assert.equal(feltWidth("Node", structs), null);
});

// --- selector convention ----------------------------------------------------

test("selectors are derived from the short event name", () => {
  // Both forms were present in the codebase and only one is real. These two
  // constants were checked against live events: the short form resolved all
  // eight selectors observed on chain, the full form resolved none.
  assert.equal(
    selectorHex("Deposit"),
    "0x9149d2123147c5f43d258257fef0b7b969db78269369ebcf5ebb9eef8592f2",
  );
  assert.notEqual(
    selectorHex("privacy::events::Deposit"),
    "0x9149d2123147c5f43d258257fef0b7b969db78269369ebcf5ebb9eef8592f2",
  );
  assert.equal(shortName("privacy::events::Deposit"), "Deposit");
});

test("eventDefinitions keys the map by the short-name selector", () => {
  assert.ok(defs.has(selectorHex("Deposit")));
  assert.ok(!defs.has(selectorHex("privacy::events::Deposit")));
  assert.equal(byName("Deposit").fullName, "privacy::events::Deposit");
});

test("eventDefinitions reports a short-name collision instead of picking one", () => {
  const clashing = [
    {
      type: "event",
      kind: "struct",
      name: "a::Thing",
      members: [{ name: "x", kind: "data", type: "core::felt252" }],
    },
    {
      type: "event",
      kind: "struct",
      name: "b::Thing",
      members: [{ name: "y", kind: "data", type: "core::felt252" }],
    },
  ];
  const out = eventDefinitions(clashing);
  assert.equal(out.collisions.length, 1);
  assert.deepEqual(out.collisions[0].names.sort(), ["a::Thing", "b::Thing"]);
  // The survivor is arbitrary, so exactly one is kept and the clash is surfaced.
  assert.equal(out.defs.size, 1);
});

test("eventDefinitions marks an unsized event undecodable and says why", () => {
  const out = eventDefinitions(ABI);
  assert.equal(out.undecodable.length, 1);
  assert.equal(out.undecodable[0].name, "HasArray");
  assert.match(out.undecodable[0].reason, /width is not derivable/);
  assert.equal(byName("HasArray").decodable, false);
});

// --- decoding ---------------------------------------------------------------

test("decodeEvent reads Deposit.amount from data[0] and starts keys at 1", () => {
  const raw = {
    keys: [selectorHex("Deposit"), "0xabc", "0xtoken"],
    data: ["0xde0b6b3a7640000"],
  };
  const out = decodeEvent(byName("Deposit"), raw);
  assert.equal(out.ok, true);
  assert.equal(out.consumed, 1);
  // keys[0] is the selector, so user_addr is keys[1] — not keys[0].
  assert.equal(out.values.user_addr, "0xabc");
  assert.equal(out.values.token, "0xtoken");
  assert.equal(feltToDecimal(out.values.amount), "1000000000000000000");
});

test("decodeEvent reads Withdrawal.amount from data[3], not data[0]", () => {
  const raw = {
    keys: [selectorHex("Withdrawal"), "0xto", "0xtoken"],
    data: ["0x111", "0x222", "0x333", "0xde0b6b3a7640000"],
  };
  const out = decodeEvent(byName("Withdrawal"), raw);
  assert.equal(out.ok, true);
  assert.equal(out.consumed, 4);
  // The regression that matters: the encrypted address occupies data[0..2] and
  // is three separate felts, so the amount is data[3].
  assert.deepEqual(out.values.enc_user_addr, ["0x111", "0x222", "0x333"]);
  assert.equal(feltToDecimal(out.values.amount), "1000000000000000000");
  assert.notEqual(out.values.amount, raw.data[0]);
});

test("decodeEvent reports a felt-count disagreement rather than absorbing it", () => {
  // The ABI explains one data felt; the event carried two. The ABI and the
  // chain have diverged and the caller must be able to see it.
  const raw = {
    keys: [selectorHex("Deposit"), "0xabc", "0xtoken"],
    data: ["0xde0b6b3a7640000", "0xdead"],
  };
  const out = decodeEvent(byName("Deposit"), raw);
  assert.equal(out.ok, false);
  assert.equal(out.consumed, 1);
  assert.equal(out.dataLength, 2);
});

test("decodeEvent reads note_id for open notes from the key section", () => {
  const raw = {
    keys: [selectorHex("OpenNoteDeposited"), "0xdepositor", "0xtoken", "0xnoteid"],
    data: ["0x1bc16d674ec80000"],
  };
  const out = decodeEvent(byName("OpenNoteDeposited"), raw);
  assert.equal(out.ok, true);
  // note_id is a key, and it is what joins an open note to its amount without
  // guessing from the transaction.
  assert.equal(out.values.note_id, "0xnoteid");
  assert.equal(feltToDecimal(out.values.amount), "2000000000000000000");
});

// --- decimal helpers --------------------------------------------------------

test("feltToDecimal and decimalToHex survive values beyond Number precision", () => {
  // 2 ETH in wei is 2e18, well past Number.MAX_SAFE_INTEGER (~9e15). Routing it
  // through a JS number would round it and silently merge two denominations.
  const wei = "2000000000000000000";
  const hex = decimalToHex(wei);
  assert.equal(hex, "0x1bc16d674ec80000");
  assert.equal(feltToDecimal(hex), wei);
  assert.equal(Number(wei) > Number.MAX_SAFE_INTEGER, true);
  assert.equal(feltToDecimal(null), null);
  assert.equal(decimalToHex("not-a-number"), null);
});

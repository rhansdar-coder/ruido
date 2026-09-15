// The emitter's decoy set: assembly, the three rules, and the wire format.
//
// WHAT THESE TESTS CAN AND CANNOT PROVE
//
// They are offline, so they use a fixture ABI. A fixture ABI written by the same
// hand that wrote the assembler would prove nothing on its own — the field order
// would agree because both came from one reading. What makes them worth having
// is the second half: the assembled set is pushed through the encoder and back
// through the decoder, and those two are the pair that has been held against 83
// real transactions with exact consumption as the assertion. A field out of
// order here shows up as a round-trip that does not come back.
//
// The assertion that the DEPLOYED contract accepts the wire format is not here.
// It is `scripts/check-decoy-set.mjs`, which reads the live ABI and asks the
// live pool — because "the fixture agrees with the fixture" is not evidence.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CLIENT_ACTION_ORDER,
  INVOKE_PHASE,
  PHASE,
  WRITE_ONCE_PRODUCERS,
  assembleDecoySet,
  checkSet,
  compileCalldata,
  emissionNotes,
  encodeSet,
  phasesOf,
} from "../src/emitter.mjs";
import { decodeValue, typeRegistry } from "../src/actions.mjs";
import { strkToBase } from "../src/pool.mjs";

const A = "core::starknet::contract_address::ContractAddress";
const F = "core::felt252";
const U32 = "core::integer::u32";
const U128 = "core::integer::u128";
const SPAN = "core::array::Span::<privacy::actions::ClientAction>";

// The deployed shapes, copied field for field from the live ABI. If they drift,
// `scripts/check-decoy-set.mjs` re-reads the live ABI and fails — this fixture
// cannot notice on its own, and saying so is cheaper than pretending otherwise.
const ABI = [
  {
    type: "struct",
    name: "privacy::actions::UseNoteInput",
    members: [
      { name: "channel_key", type: F },
      { name: "token", type: A },
      { name: "index", type: U32 },
    ],
  },
  {
    type: "struct",
    name: "privacy::actions::CreateEncNoteInput",
    members: [
      { name: "recipient_addr", type: A },
      { name: "recipient_public_key", type: F },
      { name: "token", type: A },
      { name: "amount", type: U128 },
      { name: "index", type: U32 },
      { name: "salt", type: U128 },
    ],
  },
  {
    type: "enum",
    name: "privacy::actions::ClientAction",
    variants: [
      { name: "SetViewingKey", type: "privacy::actions::SetViewingKeyInput" },
      { name: "OpenChannel", type: "privacy::actions::OpenChannelInput" },
      { name: "OpenSubchannel", type: "privacy::actions::OpenSubchannelInput" },
      { name: "CreateEncNote", type: "privacy::actions::CreateEncNoteInput" },
      { name: "CreateOpenNote", type: "privacy::actions::CreateOpenNoteInput" },
      { name: "Deposit", type: "privacy::actions::DepositInput" },
      { name: "UseNote", type: "privacy::actions::UseNoteInput" },
      { name: "Withdraw", type: "privacy::actions::WithdrawInput" },
      { name: "InvokeExternal", type: "privacy::actions::InvokeExternalInput" },
      { name: "ComputeAndInvoke", type: "privacy::actions::ComputeAndInvokeInput" },
    ],
  },
  {
    type: "interface",
    name: "privacy::interface::IClient",
    items: [
      {
        type: "function",
        name: "compile_actions",
        inputs: [
          { name: "user_addr", type: A },
          { name: "user_private_key", type: F },
          // `client_actions`, NOT `actions`. This fixture said `actions` and its
          // own test passed, because `encodeCall` matches the name the fixture
          // declared — the deployed contract refused the calldata. It was
          // `scripts/check-decoy-set.mjs` that caught it, which is the whole
          // argument for having a check that talks to the chain.
          { name: "client_actions", type: SPAN },
        ],
        outputs: [],
        state_mutability: "view",
      },
    ],
  },
];

const CHANNEL = 0xabc123n;
const TOKEN = 0x04718f5an;
const ME = 0x41c9dbe8n;
const MY_KEY = 0x2f00n;

const set = (overrides = {}) =>
  assembleDecoySet({
    channelKey: CHANNEL,
    token: TOKEN,
    spendIndex: 0,
    notes: emissionNotes({ firstIndex: 1, decoys: 1, denomination: 100n, changeAmount: 50n }),
    recipient: ME,
    recipientKey: MY_KEY,
    salts: [11n, 12n],
    ...overrides,
  });

// ---------------------------------------------------------------------------
// The trap: the ABI index is not the phase
// ---------------------------------------------------------------------------

test("the ABI order and the phase order genuinely disagree", () => {
  const index = Object.fromEntries(CLIENT_ACTION_ORDER.map((n, i) => [n, i]));
  assert.equal(index.CreateEncNote, 3);
  assert.equal(PHASE.CreateEncNote, 5);
  assert.notEqual(index.CreateEncNote, PHASE.CreateEncNote);

  assert.equal(index.Deposit, 5);
  assert.equal(PHASE.Deposit, 3);
  assert.notEqual(index.Deposit, PHASE.Deposit);

  // And the ones that agree must agree, or the disagreement above is noise.
  for (const name of ["SetViewingKey", "OpenChannel", "OpenSubchannel"]) {
    assert.equal(index[name], PHASE[name], `${name} should share its index and phase`);
  }
});

test("the phase table covers every variant in the ABI order", () => {
  for (const name of CLIENT_ACTION_ORDER) {
    assert.equal(typeof PHASE[name], "number", `${name} has no phase`);
  }
  assert.equal(Object.keys(PHASE).length, CLIENT_ACTION_ORDER.length);
});

test("phasesOf reads the phase, not the index", () => {
  assert.deepEqual(phasesOf(set()), [4, 5, 5]);
});

// ---------------------------------------------------------------------------
// The three rules
// ---------------------------------------------------------------------------

test("the decoy set satisfies all three rules", () => {
  const check = checkSet(set());
  assert.equal(check.ok, true, check.violations.join("; "));
});

test("an empty set is refused, and for the right reason", () => {
  const check = checkSet([]);
  assert.equal(check.ok, false);
  assert.match(check.violations[0], /empty set/);
});

test("a set whose phase drops is refused", () => {
  // Phase 5 then 4 — the shape that the contract does NOT catch for this set,
  // because the subchannel lookup runs first. So the check has to be here.
  const check = checkSet([{ variant: "CreateEncNote" }, { variant: "UseNote" }]);
  assert.equal(check.ok, false);
  assert.match(check.violations.join(" "), /phase drops from 5 to 4/);
  assert.match(check.violations.join(" "), /ACTIONS_OUT_OF_ORDER/);
});

test("a set with two invokes is refused", () => {
  const check = checkSet([
    { variant: "UseNote" },
    { variant: "InvokeExternal" },
    { variant: "ComputeAndInvoke" },
  ]);
  assert.equal(check.ok, false);
  assert.match(check.violations.join(" "), /2 invoke actions/);
});

test("a set with no WriteOnce producer is refused", () => {
  // Deposit and Withdraw produce no WriteOnce, so this set has no replay
  // protection — which is what the deployed pool answers with
  // NO_REPLAY_PROTECTION for a [Deposit]-only set.
  const check = checkSet([{ variant: "Deposit" }, { variant: "Withdraw" }]);
  assert.equal(check.ok, false);
  assert.match(check.violations.join(" "), /no replay protection/);
  assert.match(check.violations.join(" "), /NO_REPLAY_PROTECTION/);
});

test("every action that produces a WriteOnce is in the table", () => {
  // The four that do not, from the source. If one of them were added to the
  // table the no-replay check would go quiet, so the complement is asserted.
  for (const name of ["Deposit", "Withdraw", "InvokeExternal", "ComputeAndInvoke"]) {
    assert.equal(WRITE_ONCE_PRODUCERS.has(name), false, `${name} produces no WriteOnce`);
  }
  for (const name of ["UseNote", "CreateEncNote", "SetViewingKey", "OpenSubchannel"]) {
    assert.equal(WRITE_ONCE_PRODUCERS.has(name), true, `${name} produces a WriteOnce`);
  }
});

test("the violations are all reported, not just the first", () => {
  // Withdraw (6) then Deposit (3) drops the phase, and neither produces a
  // WriteOnce — so this set breaks two rules at once and both are named.
  const check = checkSet([{ variant: "Withdraw" }, { variant: "Deposit" }]);
  assert.equal(check.ok, false);
  assert.equal(check.violations.length, 2);
  assert.match(check.violations.join(" "), /phase drops/);
  assert.match(check.violations.join(" "), /no replay protection/);
});

// ---------------------------------------------------------------------------
// The assembly
// ---------------------------------------------------------------------------

test("an emission is one UseNote followed by one CreateEncNote per created note", () => {
  const actions = set();
  assert.equal(actions.length, 3);
  assert.equal(actions[0].variant, "UseNote");
  assert.equal(actions[1].variant, "CreateEncNote");
  assert.equal(actions[2].variant, "CreateEncNote");
});

test("the change is the last CreateEncNote, and the decoys come first", () => {
  const actions = set();
  assert.equal(actions[1].value.amount, 100n); // the decoy, at the rung
  assert.equal(actions[2].value.amount, 50n); // the change, what is left
  assert.equal(actions[1].value.index, 1);
  assert.equal(actions[2].value.index, 2);
});

test("a salt per created note, and no reuse", () => {
  const actions = set();
  const salts = actions.slice(1).map((a) => a.value.salt);
  assert.deepEqual(salts, [11n, 12n]);
  assert.notEqual(salts[0], salts[1]);
});

test("a salt count that does not match the notes is refused", () => {
  assert.throws(
    () => set({ salts: [11n] }),
    /need one salt per created note: 2 notes, 1 salts/,
  );
});

test("a set with no notes to create is refused", () => {
  assert.throws(() => set({ notes: [] }), /at least one note/);
});

test("every emission the assembler builds satisfies its own rules", () => {
  // The check runs inside the assembler, so an emission can never produce
  // something the emitter would then have to reject at submit time. There is no
  // way to hand `assembleDecoySet` a shape that breaks a rule — it only ever
  // emits UseNote then CreateEncNote — so what is worth asserting is that it
  // stays that way across sizes.
  for (const decoys of [1, 2, 5, 50]) {
    const actions = assembleDecoySet({
      channelKey: CHANNEL,
      token: TOKEN,
      spendIndex: 0,
      notes: emissionNotes({ firstIndex: 0, decoys, denomination: 10n, changeAmount: 3n }),
      recipient: ME,
      recipientKey: MY_KEY,
      salts: Array.from({ length: decoys + 1 }, (_, i) => BigInt(i + 2)),
    });
    assert.equal(actions.length, decoys + 2, `${decoys} decoys plus the change`);
    assert.equal(checkSet(actions).ok, true);
    assert.deepEqual(phasesOf(actions), [4, ...Array(decoys + 1).fill(5)]);
  }
});

// ---------------------------------------------------------------------------
// emissionNotes
// ---------------------------------------------------------------------------

test("the notes are the decoys at one rung, then the change", () => {
  const notes = emissionNotes({ firstIndex: 10, decoys: 3, denomination: 25n, changeAmount: 7n });
  assert.deepEqual(notes, [
    { index: 10, amount: 25n },
    { index: 11, amount: 25n },
    { index: 12, amount: 25n },
    { index: 13, amount: 7n },
  ]);
});

test("the amounts are base units, and a ladder rung is not one", () => {
  // The ladder in src/cover.mjs is whole STRK. `CreateEncNote.amount` is a u128
  // in base units. Passing a rung straight through mints a note worth 10 wei —
  // a valid note that nobody else holds, so the chain reports nothing and the
  // anonymity set is quietly smaller. `scripts/emit.mjs` is the one place that
  // converts, and this is the test that says the conversion is not optional.
  const rung = 10n;
  const notes = emissionNotes({
    firstIndex: 0,
    decoys: 1,
    denomination: strkToBase(String(rung)),
    changeAmount: 0n,
  });
  assert.equal(notes[0].amount, 10n * 10n ** 18n);
  assert.notEqual(notes[0].amount, rung);
});

test("every decoy carries the same rung, which is what makes them decoys", () => {
  const notes = emissionNotes({ firstIndex: 0, decoys: 4, denomination: 100n, changeAmount: 1n });
  const decoys = notes.slice(0, 4).map((n) => n.amount);
  assert.deepEqual(decoys, [100n, 100n, 100n, 100n]);
});

test("a zero change creates no note, rather than a note worth nothing", () => {
  const notes = emissionNotes({ firstIndex: 0, decoys: 2, denomination: 10n, changeAmount: 0n });
  assert.equal(notes.length, 2);
  assert.equal(notes.some((n) => n.amount === 0n), false);
});

test("a missing change is a zero change", () => {
  assert.equal(emissionNotes({ firstIndex: 0, decoys: 1, denomination: 10n }).length, 1);
});

test("a negative change is refused", () => {
  assert.throws(
    () => emissionNotes({ firstIndex: 0, decoys: 1, denomination: 10n, changeAmount: -1n }),
    /cannot be negative/,
  );
});

test("zero decoys is refused", () => {
  assert.throws(
    () => emissionNotes({ firstIndex: 0, decoys: 0, denomination: 10n, changeAmount: 5n }),
    /at least one decoy/,
  );
});

// ---------------------------------------------------------------------------
// The wire format, held against the validated codec pair
//
// `encodeSet` returns the WHOLE span encoding, length prefix included, because
// that is what `apply_actions` and `compile_actions` take. A span is
// `[length, ...elements]`, and forgetting the prefix is a one-felt shift — the
// same class of mistake as reading `Withdrawal.amount` at `data[0]`.
// ---------------------------------------------------------------------------

test("the span encoding carries its own length first", () => {
  const felts = encodeSet(ABI, set());
  assert.equal(felts[0], 3n, "three actions");
  assert.equal(felts[1], 6n, "UseNote is variant 6");
});

test("the assembled set round-trips through the encoder and the decoder", () => {
  const actions = set();
  const felts = encodeSet(ABI, actions);
  const back = decodeValue(SPAN, felts, 0, typeRegistry(ABI));

  assert.equal(back.consumed, felts.length, "the decoder must consume the encoder exactly");
  assert.deepEqual(back.value.map((a) => a.variant), ["UseNote", "CreateEncNote", "CreateEncNote"]);

  // And back out again, felt for felt. This is the assertion that catches a
  // field in the wrong order: the round-trip cannot come back if one moved.
  assert.deepEqual(encodeSet(ABI, back.value), felts);
});

test("the set encodes to the felt count the shapes imply", () => {
  // 1 for the span length, then
  // UseNote is [variant, channel_key, token, index] = 4, and
  // CreateEncNote is [variant, recipient, recipient_key, token, amount, index, salt] = 7.
  const felts = encodeSet(ABI, set());
  assert.equal(felts.length, 1 + 4 + 7 + 7);
});

test("the variant index on the wire is the ABI index, not the phase", () => {
  const felts = encodeSet(ABI, set());
  assert.equal(felts[1], 6n, "UseNote is variant 6, and its phase is 4");
  assert.equal(felts[5], 3n, "CreateEncNote is variant 3, and its phase is 5");
});

test("the decoy amount survives at its declared width", () => {
  const big = 2n ** 100n;
  const actions = assembleDecoySet({
    channelKey: CHANNEL,
    token: TOKEN,
    spendIndex: 0,
    notes: [{ index: 1, amount: big }],
    recipient: ME,
    recipientKey: MY_KEY,
    salts: [1n],
  });
  const back = decodeValue(SPAN, encodeSet(ABI, actions), 0, typeRegistry(ABI));
  assert.equal(back.value[1].value.amount, big);
});

// ---------------------------------------------------------------------------
// compileCalldata
// ---------------------------------------------------------------------------

test("compile_actions calldata is the address, the key, then the whole span", () => {
  const actions = set();
  const calldata = compileCalldata(ABI, { userAddr: ME, viewingKey: MY_KEY, actions });
  assert.equal(calldata[0], ME);
  assert.equal(calldata[1], MY_KEY);
  assert.equal(calldata[2], 3n, "the span length, which the calldata carries itself");
  assert.deepEqual(calldata.slice(2), encodeSet(ABI, actions));
});

test("compile_actions is found inside the interface, not at the top level", () => {
  // The ABI exposes `interface`, not `function`. A scan for `type === "function"`
  // finds zero entrypoints and reads as "the pool has no functions".
  assert.equal(ABI.filter((x) => x.type === "function").length, 0);
  assert.doesNotThrow(() => compileCalldata(ABI, { userAddr: 1n, viewingKey: 2n, actions: set() }));
});

test("an invoke phase is 7 and nothing else is", () => {
  assert.equal(PHASE.InvokeExternal, INVOKE_PHASE);
  assert.equal(PHASE.ComputeAndInvoke, INVOKE_PHASE);
  assert.equal(INVOKE_PHASE, 7);
});

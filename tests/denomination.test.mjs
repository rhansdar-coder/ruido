// Tests for the denomination join.
//
// The join had a bug, and the bug is the reason this file exists. The first
// version treated every money-in event as evidence about every note in its
// transaction, so an open-note deposit was broadcast onto the encrypted notes
// sharing that batch. On the deployed pool that was 470 transactions and 508
// notes, and the resulting numbers were plausible. A wrong amount is not an
// error, it is a smaller anonymity set, which is why this needs pinning.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  amountInWindow,
  amountKey,
  assignAmounts,
  bucketSizes,
  denominationModels,
  lowerBound,
  sampleOf,
} from "../src/denomination.mjs";

const NOTE = "EncNoteCreated";
const OPEN_NOTE = "OpenNoteCreated";
const note = (block, tx, noteId = null) => ({ block, tx, noteId, name: noteId ? OPEN_NOTE : NOTE });

test("an open note takes its amount from the deposit carrying the same note_id", () => {
  const events = [
    { name: OPEN_NOTE, tx: "0xt1", note_id: "0xn1", block: 10 },
    { name: "OpenNoteDeposited", tx: "0xt1", note_id: "0xn1", token: "0xtok", amount: "500", block: 10 },
  ];
  const notes = [note(10, "0xt1", "0xn1")];
  const routes = assignAmounts(events, notes);
  assert.equal(routes.explicit, 1);
  assert.equal(notes[0].amountRoute, "explicit");
  assert.equal(notes[0].amount, "500");
  assert.equal(notes[0].token, "0xtok");
});

test("an encrypted note in a batch with only an open-note deposit stays unknown", () => {
  // The regression. This transaction deposits into an open note and separately
  // mints an encrypted note. The encrypted note is a change note; its amount has
  // nothing to do with the open-note deposit sitting beside it.
  const events = [
    { name: OPEN_NOTE, tx: "0xt1", note_id: "0xn1", block: 10 },
    { name: "OpenNoteDeposited", tx: "0xt1", note_id: "0xn1", token: "0xtok", amount: "978846926911866735", block: 10 },
    { name: NOTE, tx: "0xt1", note_id: "0xn2", block: 10 },
  ];
  const notes = [note(10, "0xt1", "0xn1"), note(10, "0xt1", "0xn2")];
  const routes = assignAmounts(events, notes);

  assert.equal(notes[0].amountRoute, "explicit");
  assert.equal(notes[1].amountRoute, "unknown");
  assert.equal(notes[1].amount, undefined);
  // Not merely different — absent. A wrong amount here would shrink a bucket.
  assert.notEqual(notes[1].amount, "978846926911866735");
  assert.equal(routes.transaction, 0);
});

test("an encrypted note takes the amount of its transaction's single deposit", () => {
  const events = [
    { name: "Deposit", tx: "0xt1", token: "0xtok", amount: "1000", block: 10 },
    { name: NOTE, tx: "0xt1", note_id: "0xn1", block: 10 },
  ];
  const notes = [note(10, "0xt1")];
  const routes = assignAmounts(events, notes);
  assert.equal(routes.transaction, 1);
  assert.equal(notes[0].amount, "1000");
  assert.equal(notes[0].amountRoute, "transaction");
});

test("two identical deposits in one transaction still resolve", () => {
  // A batch that deposits the same amount twice mints two notes of that amount,
  // and the adversary learns the amount even though it cannot tell which deposit
  // funded which note. Collapsing identical amounts is what makes this usable.
  const events = [
    { name: "Deposit", tx: "0xt1", token: "0xtok", amount: "1000", block: 10 },
    { name: "Deposit", tx: "0xt1", token: "0xtok", amount: "1000", block: 10 },
    { name: NOTE, tx: "0xt1", note_id: "0xn1", block: 10 },
    { name: NOTE, tx: "0xt1", note_id: "0xn2", block: 10 },
  ];
  const notes = [note(10, "0xt1"), note(10, "0xt1")];
  const routes = assignAmounts(events, notes);
  assert.equal(routes.transaction, 2);
  assert.equal(notes[0].amount, "1000");
  assert.equal(notes[1].amount, "1000");
});

test("two different deposits in one transaction leave the notes unknown", () => {
  const events = [
    { name: "Deposit", tx: "0xt1", token: "0xtok", amount: "1000", block: 10 },
    { name: "Deposit", tx: "0xt1", token: "0xtok", amount: "2000", block: 10 },
    { name: NOTE, tx: "0xt1", note_id: "0xn1", block: 10 },
  ];
  const notes = [note(10, "0xt1")];
  const routes = assignAmounts(events, notes);
  assert.equal(routes.unknown, 1);
  assert.equal(notes[0].amount, undefined);
});

test("a change note with no deposit anywhere is unknown", () => {
  const events = [
    { name: "NoteUsed", tx: "0xt1", block: 10 },
    { name: NOTE, tx: "0xt1", note_id: "0xn1", block: 10 },
  ];
  const notes = [note(10, "0xt1")];
  const routes = assignAmounts(events, notes);
  assert.equal(routes.unknown, 1);
});

test("the same amount in a different token is a different bucket", () => {
  const notes = [
    { token: "0xa", amount: "1000" },
    { token: "0xa", amount: "1000" },
    { token: "0xb", amount: "1000" },
  ];
  const buckets = bucketSizes(notes);
  assert.equal(buckets.get(amountKey(notes[0])), 2);
  assert.equal(buckets.get(amountKey(notes[2])), 1);
});

test("lowerBound finds the first block at or after a value", () => {
  const blocks = [10, 20, 20, 30];
  assert.equal(lowerBound(blocks, 5), 0);
  assert.equal(lowerBound(blocks, 20), 1);
  assert.equal(lowerBound(blocks, 21), 3);
  assert.equal(lowerBound(blocks, 31), 4);
});

test("amountInWindow counts only same-denomination notes inside the window", () => {
  const visible = [
    { block: 100, token: "0xa", amount: "1000" },
    { block: 102, token: "0xa", amount: "1000" },
    { block: 103, token: "0xa", amount: "2000" },
    { block: 900, token: "0xa", amount: "1000" },
  ];
  const blocks = visible.map((n) => n.block);
  // ±1 around block 100 reaches 102? No: 102 > 101, so only the target itself.
  assert.equal(amountInWindow(visible, blocks, visible[0], 1), 1);
  // ±10 reaches 102 and 103; 103 is a different denomination and 900 is outside.
  assert.equal(amountInWindow(visible, blocks, visible[0], 10), 2);
  // ±1000 reaches everything of the same denomination.
  assert.equal(amountInWindow(visible, blocks, visible[0], 1000), 3);
});

test("denominationModels reports the global set and the windowed set", () => {
  // Three notes of 1 ETH inside a tight window, one note of 5 ETH far away.
  const visible = [
    { block: 100, token: "0xa", amount: "1000" },
    { block: 101, token: "0xa", amount: "1000" },
    { block: 102, token: "0xa", amount: "1000" },
    { block: 9000, token: "0xa", amount: "5000" },
  ];
  const buckets = bucketSizes(visible);
  const models = denominationModels(visible, visible, buckets, [1]);

  const amount = models.find((m) => m.model === "amount");
  const windowed = models.find((m) => m.model === "timing+amount ±1");

  // Global: three notes share 1 ETH, one stands alone. Mean 2.5.
  assert.equal(amount.candidates, 2.5);
  assert.equal(amount.fractionAlone, 0.25);

  // Windowed, ±1 block. Per target: block 100 sees {100,101}=2, block 101 sees
  // {100,101,102}=3, block 102 sees {101,102}=2, block 9000 sees only itself.
  // Mean (2+3+2+1)/4 = 2, and only the far note stands alone.
  assert.equal(windowed.candidates, 2);
  assert.equal(windowed.fractionAlone, 0.25);
  // The window can only shrink a set, never grow it.
  assert.ok(windowed.candidates <= amount.candidates);
});

test("denominationModels returns nothing for an empty target list", () => {
  // A quiet pool is a real case. A mean over an empty list is NaN, and NaN
  // propagates into every table it touches.
  assert.deepEqual(denominationModels([], [], new Map(), [1]), []);
});

test("sampleOf spreads across the list instead of taking a prefix", () => {
  const list = Array.from({ length: 100 }, (_, i) => i);
  const sampled = sampleOf(list, 10);
  assert.equal(sampled.length, 10);
  assert.equal(sampled[0], 0);
  // A prefix sample would end at 9 and measure the busiest burst as the pool.
  assert.ok(sampled[sampled.length - 1] > 80);
  assert.deepEqual(sampleOf([1, 2, 3], 10), [1, 2, 3]);
});

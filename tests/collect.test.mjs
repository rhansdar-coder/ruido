// Regression tests for the "Maximum call stack size exceeded" crash.
//
// The original code used `events.push(...found)` and `Math.min(...blocks)`.
// Both work on a small pool and both die on a real one: mainnet produced a
// single 55,000-event window and a 125,751-event block list. These tests use
// 200,000 elements, which is comfortably past any engine's argument limit and
// comfortably inside what a busy pool will produce.

import test from "node:test";
import assert from "node:assert/strict";
import { appendAll, blockRange } from "../src/collect.mjs";

const N = 200_000;

test("the naive spread really does overflow, so this test is not theatre", () => {
  // If this ever stops throwing, the guards below are pointless and should be
  // revisited rather than kept as ceremony.
  const big = Array.from({ length: N }, (_, i) => i);
  assert.throws(() => Math.min(...big), RangeError);
});

test("appendAll handles 200,000 elements without overflowing", () => {
  const target = [];
  const source = Array.from({ length: N }, (_, i) => i);
  const returned = appendAll(target, source);
  assert.equal(returned, target, "returns the target array");
  assert.equal(target.length, N);
  assert.equal(target[0], 0);
  assert.equal(target[N - 1], N - 1);
});

test("appendAll preserves order and appends rather than replacing", () => {
  const target = ["a"];
  appendAll(target, ["b", "c"]);
  appendAll(target, ["d"]);
  assert.deepEqual(target, ["a", "b", "c", "d"]);
});

test("appendAll is a no-op on an empty source", () => {
  const target = [1, 2];
  appendAll(target, []);
  assert.deepEqual(target, [1, 2]);
});

test("blockRange handles 200,000 elements without overflowing", () => {
  const values = Array.from({ length: N }, (_, i) => (i * 7919) % 1_000_003);
  const range = blockRange(values);
  let min = values[0];
  let max = values[0];
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  assert.deepEqual(range, { first: min, last: max });
});

test("blockRange returns null for an empty list, not Infinity", () => {
  // Math.min() of nothing is Infinity, which would end up in the JSON as
  // `"first": null` after serialisation and read as a real block number.
  assert.equal(blockRange([]), null);
});

test("blockRange handles a single element and an unsorted list", () => {
  assert.deepEqual(blockRange([42]), { first: 42, last: 42 });
  assert.deepEqual(blockRange([9, 3, 17, 1, 8]), { first: 1, last: 17 });
});

test("blockRange copes with negative and zero values", () => {
  assert.deepEqual(blockRange([0, -5, 3]), { first: -5, last: 3 });
});

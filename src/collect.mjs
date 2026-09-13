// Small collection helpers that do not blow the stack on real data.
//
// These exist because of a bug that only appeared at scale. Indexing the
// Sepolia pool (21,062 events) worked fine with `events.push(...found)` and
// `Math.min(...blocks)`. Indexing mainnet (125,751 events) crashed with
// "Maximum call stack size exceeded", because spreading an array into a call
// spreads it into the argument list, and engines cap that far below the array
// sizes a real pool produces.
//
// Both helpers are here, and tested against 200,000-element inputs, so the
// regression cannot come back quietly. See tests/collect.test.mjs.

/** Append every element of `source` to `target`. Returns `target`. */
export function appendAll(target, source) {
  for (const item of source) target.push(item);
  return target;
}

/**
 * Smallest and largest value, without spreading.
 * Returns null for an empty input rather than {first: Infinity, last: -Infinity}.
 */
export function blockRange(values) {
  if (!values.length) return null;
  let first = values[0];
  let last = values[0];
  for (const value of values) {
    if (value < first) first = value;
    if (value > last) last = value;
  }
  return { first, last };
}

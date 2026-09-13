// Tests for the EVM measurement logic.
//
// The point of these is not coverage. It is that the two mistakes this project
// already made once — comparing block windows across chains with different
// block times, and shipping a shielded-pool detector that could never fire —
// are now impossible to reintroduce without a red test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ALL_SYSTEM_ADDRESSES,
  CHAINS,
  CHAIN_KEYS,
  ENTRYPOINTS,
  isSystemAddress,
  resolveChain,
} from "../src/chains.mjs";
import {
  blocksToSeconds,
  secondsToBlocks,
  buildTimeline,
  lowerBoundIndex,
  timingCounts,
  reuseStats,
  concentrationStats,
  contractMixerScan,
  isValueTransfer,
  poolSignature,
  sampleTargets,
  identifiabilityClauses,
} from "../src/evm.mjs";

// --- the unit conversion ----------------------------------------------------
// The published STRK20 windows are in blocks. The moment a second chain enters
// the table they have to become seconds, and the two chains differ by ~16.7x.

const BLOCK_TIME_STARKNET = 1.702;
const BLOCK_TIME_ROBINHOOD = 0.1022;

test("±10 blocks means two different amounts of time on the two chains", () => {
  const starknet = blocksToSeconds(10, BLOCK_TIME_STARKNET);
  const robinhood = blocksToSeconds(10, BLOCK_TIME_ROBINHOOD);
  assert.equal(Number(starknet.toFixed(1)), 17.0);
  assert.equal(Number(robinhood.toFixed(1)), 1.0);
  // The ratio is the whole reason the report states windows in seconds.
  assert.ok(starknet / robinhood > 16 && starknet / robinhood < 17);
});

test("seconds convert back to the block count that contains them", () => {
  assert.equal(secondsToBlocks(17, BLOCK_TIME_STARKNET), 10);
  assert.equal(secondsToBlocks(17, BLOCK_TIME_ROBINHOOD), 166);
  // A round trip cannot be exact — a block is atomic, so the result is the
  // block whose span contains the request. The property that must hold is that
  // the error stays within one block time, on both chains.
  for (const bt of [BLOCK_TIME_STARKNET, BLOCK_TIME_ROBINHOOD]) {
    for (const seconds of [1, 17, 60, 600, 3600]) {
      const back = blocksToSeconds(secondsToBlocks(seconds, bt), bt);
      assert.ok(Math.abs(back - seconds) <= bt, `${seconds}s round-tripped to ${back}s on block time ${bt}`);
    }
  }
});

// --- system addresses -------------------------------------------------------

test("the Arbitrum L1-block pseudo-address is treated as infrastructure", () => {
  assert.ok(ALL_SYSTEM_ADDRESSES.has("0x00000000000000000000000000000000000a4b05"));
  // Case must not matter: RPC payloads are not consistent about it.
  assert.equal(isSystemAddress("0x00000000000000000000000000000000000A4B05"), true);
  assert.equal(isSystemAddress("0x00000000000000000000000000000000000a4b05"), true);
  // And it must be scoped to the chains that actually have it.
  assert.equal(isSystemAddress("0x00000000000000000000000000000000000a4b05", "robinhood"), true);
  assert.equal(isSystemAddress("0x00000000000000000000000000000000000a4b05", "ethereum"), false);
});

test("an ordinary address is not mistaken for infrastructure", () => {
  assert.equal(isSystemAddress("0xcaf681a66d020601342297493863e78c959e5cb2"), false);
  assert.equal(isSystemAddress(null), false);
  assert.equal(isSystemAddress(undefined), false);
  assert.equal(isSystemAddress(""), false);
});

test("both EntryPoint versions are recognised", () => {
  assert.equal(ENTRYPOINTS["0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789"], "entrypoint-v0.6");
  assert.equal(ENTRYPOINTS["0x0000000071727de22e5e9d8baf0edac6f37da032"], "entrypoint-v0.7");
});

// --- the chain registry -----------------------------------------------------
// Adding a chain must be a data change. These tests exist so that a chain
// added carelessly — wrong ID, no RPCs, an unmeasured block time presented as
// fact — fails here instead of in a published measurement.

test("every registry entry is complete enough to index", () => {
  for (const key of CHAIN_KEYS) {
    const c = CHAINS[key];
    assert.equal(c.key, key, `${key}: key must match its registry key`);
    assert.ok(Number.isInteger(c.chainId) && c.chainId > 0, `${key}: needs a chain ID`);
    assert.ok(Array.isArray(c.rpcs) && c.rpcs.length > 0, `${key}: needs at least one RPC`);
    for (const rpc of c.rpcs) assert.match(rpc, /^https:\/\//, `${key}: RPC must be https`);
    assert.ok(c.blockTimeSeconds > 0, `${key}: needs a block-time hint`);
    assert.ok(Array.isArray(c.systemAddresses), `${key}: needs a system-address list`);
    for (const a of c.systemAddresses) {
      assert.match(a, /^0x[0-9a-f]{40}$/, `${key}: system address must be lowercase 40-hex: ${a}`);
    }
  }
});

test("the two chain IDs we verified against the live chains are right", () => {
  assert.equal(CHAINS.robinhood.chainId, 4663);
  // The official docs list 4663 for the testnet too. The chain says 46630.
  assert.equal(CHAINS["robinhood-testnet"].chainId, 46630);
});

test("resolveChain fails loudly on a typo instead of returning undefined", () => {
  assert.equal(resolveChain("base").chainId, 8453);
  assert.throws(() => resolveChain("basee"), /unknown chain/);
  assert.throws(() => resolveChain(""), /unknown chain/);
});

test("OP Stack and Arbitrum chains do not share system addresses", () => {
  assert.ok(CHAINS.base.systemAddresses.includes("0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001"));
  assert.ok(!CHAINS.base.systemAddresses.includes("0x00000000000000000000000000000000000a4b05"));
  assert.ok(CHAINS.robinhood.systemAddresses.includes("0x00000000000000000000000000000000000a4b05"));
});

// --- binary search ----------------------------------------------------------

test("lowerBoundIndex finds the first element at or after the value", () => {
  const sorted = [10, 20, 20, 30, 40];
  assert.equal(lowerBoundIndex(sorted, 5), 0);
  assert.equal(lowerBoundIndex(sorted, 10), 0);
  assert.equal(lowerBoundIndex(sorted, 20), 1);
  assert.equal(lowerBoundIndex(sorted, 25), 3);
  assert.equal(lowerBoundIndex(sorted, 40), 4);
  assert.equal(lowerBoundIndex(sorted, 99), 5);
  assert.equal(lowerBoundIndex([], 7), 0);
});

// --- the timing axis --------------------------------------------------------

test("buildTimeline sorts by timestamp and keeps the columns aligned", () => {
  const txs = [
    { ts: 30, from: "c" },
    { ts: 10, from: "a" },
    { ts: 20, from: "b" },
  ];
  const { txs: sorted, times } = buildTimeline(txs);
  assert.deepEqual(sorted.map((t) => t.ts), [10, 20, 30]);
  assert.deepEqual(sorted.map((t) => t.from), ["a", "b", "c"]);
  // times[i] must always be txs[i].ts, or every window query silently shifts.
  sorted.forEach((tx, i) => assert.equal(times[i], tx.ts));
});

test("timingCounts counts distinct senders inside the window, inclusive", () => {
  const txs = [
    { ts: 0, from: "A" },
    { ts: 1, from: "B" },
    { ts: 2, from: "A" },
    { ts: 3, from: "C" },
    { ts: 4, from: "B" },
  ];
  const { txs: timeline, times } = buildTimeline(txs);

  // A zero-width window sees only the target itself: the "alone" case.
  assert.deepEqual(timingCounts(timeline, times, [{ ts: 0, from: "A" }], 0), [1]);
  assert.deepEqual(timingCounts(timeline, times, [{ ts: 2, from: "A" }], 0), [1]);

  // ±1 second around ts=2 catches ts=1,2,3 -> senders B, A, C.
  assert.deepEqual(timingCounts(timeline, times, [{ ts: 2, from: "A" }], 1), [3]);

  // Duplicate senders collapse: ±1 around ts=0 catches ts=0,1 -> A, B.
  assert.deepEqual(timingCounts(timeline, times, [{ ts: 0, from: "A" }], 1), [2]);

  // A window wide enough for everything sees the whole cast.
  assert.deepEqual(timingCounts(timeline, times, [{ ts: 2, from: "A" }], 10), [3]);
});

test("timingCounts returns one result per target, in order", () => {
  const txs = [
    { ts: 0, from: "A" },
    { ts: 100, from: "B" },
  ];
  const { txs: timeline, times } = buildTimeline(txs);
  const counts = timingCounts(timeline, times, [{ ts: 0, from: "A" }, { ts: 100, from: "B" }], 0);
  assert.deepEqual(counts, [1, 1]);
});

// --- reuse ------------------------------------------------------------------

test("reuseStats separates single-use addresses from repeats", () => {
  const senders = new Map([["A", 3], ["B", 1], ["C", 1]]);
  const r = reuseStats(senders, 5);
  assert.equal(r.distinctSenders, 3);
  assert.equal(r.transactions, 5);
  assert.equal(r.transactionsPerSender, 1.667);
  assert.equal(r.singleUseSenders, 2);
  assert.equal(Number(r.singleUseFraction.toFixed(4)), 0.6667);
  // One address is responsible for more than half of all activity.
  assert.equal(r.sendersForHalfOfActivity, 1);
  assert.equal(Number(r.sendersForHalfOfActivityFraction.toFixed(4)), 0.3333);
});

test("reuseStats survives an empty pool instead of dividing by zero", () => {
  const r = reuseStats(new Map(), 0);
  assert.equal(r.distinctSenders, 0);
  assert.equal(r.transactionsPerSender, 0);
  assert.equal(r.singleUseFraction, 0);
});

// --- concentration ----------------------------------------------------------

test("concentrationStats reports how few contracts absorb the traffic", () => {
  const targets = new Map([["X", 8], ["Y", 1], ["Z", 1]]);
  const c = concentrationStats(targets);
  assert.equal(c.distinctTargets, 3);
  assert.equal(c.shareTop1, 0.8);
  assert.equal(c.shareTop10, 1);
  assert.equal(c.targetsFor80Percent, 1);
});

test("concentrationStats on an empty map does not produce NaN", () => {
  const c = concentrationStats(new Map());
  assert.equal(c.distinctTargets, 0);
  assert.equal(c.shareTop1, 0);
  assert.equal(c.targetsFor80Percent, 0);
});

// --- the shielded-pool detector --------------------------------------------
// These are the tests that matter most. A detector that answers "no pool"
// regardless of its input is worse than no detector, because it manufactures
// confidence. The first assertion below proves the detector can fire.

test("a mixer-shaped distribution is detected", () => {
  // Five fixed denominations, each used hundreds of times, plus a little noise.
  const counts = new Map([
    ["1000000000000000000", 500],
    ["10000000000000000000", 450],
    ["100000000000000000000", 400],
    ["1000000000000000000000", 350],
    ["10000000000000000000000", 300],
  ]);
  for (let i = 0; i < 20; i += 1) counts.set(`odd-${i}`, 1);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);

  const r = poolSignature(counts, total);
  assert.equal(r.shieldedPoolSignaturePresent, true, "detector failed to fire on mixer traffic");
  assert.ok(r.top5ShareOfTransfers > 0.6);
  assert.ok(r.valueSpaceRatio < 0.1);
  assert.match(r.verdict, /signature of a mixer/);
});

test("ordinary long-tailed traffic is not flagged as a mixer", () => {
  // 1000 transfers across 950 distinct values: a large value space.
  const counts = new Map();
  for (let i = 0; i < 900; i += 1) counts.set(`unique-${i}`, 1);
  for (let i = 0; i < 50; i += 1) counts.set(`twice-${i}`, 2);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);

  const r = poolSignature(counts, total);
  assert.equal(r.shieldedPoolSignaturePresent, false);
  assert.ok(r.valueSpaceRatio > 0.1);
  assert.match(r.verdict, /not of a mixer/);
});

test("the detector requires both conditions, not either", () => {
  // Concentrated top-5, but a huge value space: a busy token, not a mixer.
  const counts = new Map();
  counts.set("big", 700);
  for (let i = 0; i < 300; i += 1) counts.set(`other-${i}`, 1);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const r = poolSignature(counts, total);
  assert.ok(r.top5ShareOfTransfers > 0.6);
  assert.ok(r.valueSpaceRatio > 0.1);
  assert.equal(r.shieldedPoolSignaturePresent, false);
});

test("poolSignature survives an empty value set", () => {
  const r = poolSignature(new Map(), 0);
  assert.equal(r.valueTransfers, 0);
  assert.equal(r.distinctValues, 0);
  assert.equal(r.shieldedPoolSignaturePresent, false);
  assert.equal(Number.isFinite(r.valueSpaceRatio), true);
});

// --- the same test, at the granularity that actually works ------------------
// This block exists because the chain-wide detector was measured on Ethereum
// and returned "no pool" while Tornado Cash was deployed there. The cause was
// dilution: a mixer with a hundred deposits is 0.03% of a 10-hour window's
// 340,000 value transfers.
//
// Then the per-contract version was measured on Robinhood Chain and it fired on
// 11 contracts that turned out to be fixed-amount payment patterns, not pools.
// So the two definitional conditions below are pinned by tests too: a contract
// with one depositor cannot be a pool, and a contract that only ever takes
// value in cannot be one either.

const DENOMINATIONS = [1, 10, 100, 1000, 10000];

/**
 * A realistic pool: many independent depositors paying fixed denominations,
 * odd-amount noise, and value flowing back out to fresh recipients.
 */
function poolRows(target, base, { depositors = 50, withdrawals = 60 } = {}) {
  const rows = [];
  for (const d of DENOMINATIONS) {
    for (let i = 0; i < 100; i += 1) {
      rows.push({
        from: 9000 + (i % depositors),
        to: target,
        value: String(BigInt(d) * 10n ** 18n),
      });
    }
  }
  for (let i = 0; i < 25; i += 1) {
    rows.push({ from: 9000 + (i % depositors), to: target, value: `${base}${i}` });
  }
  for (let i = 0; i < withdrawals; i += 1) {
    rows.push({ from: target, to: 50000 + i, value: String(10n * 10n ** 18n) });
  }
  return rows;
}

/** Ordinary traffic: a long tail of near-unique values, one sender each. */
function ordinaryRows(target, count, seed) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({
      from: 200000 + seed,
      to: target,
      value: String(BigInt(seed) * 1000000n + BigInt(i) * 7919n),
    });
  }
  return rows;
}

test("a mixer is found per contract even when the chain-wide test is diluted", () => {
  // One pool among 400 ordinary contracts, and the ordinary traffic outnumbers
  // the pool by more than an order of magnitude — the Ethereum situation.
  const rows = poolRows(7, "0xodd");
  for (let c = 0; c < 400; c += 1) rows.push(...ordinaryRows(c + 100, 300, c + 1));

  const pool = rows.filter((r) => r.to === 7);
  assert.ok(pool.length / rows.length < 0.02, "fixture is not diluted enough to be a real test");

  // The chain-wide test, on exactly this input, cannot fire.
  const valueCounts = new Map();
  for (const r of rows) valueCounts.set(r.value, (valueCounts.get(r.value) ?? 0) + 1);
  const chainWide = poolSignature(valueCounts, rows.length);
  assert.equal(chainWide.shieldedPoolSignaturePresent, false,
    "chain-wide test fired; the fixture no longer demonstrates dilution");

  // The per-contract scan finds it, and it survives both definitional tests.
  const scan = contractMixerScan(rows, { minTransfers: 50 });
  assert.equal(scan.shapeMatches.length, 1, `expected 1 shape match, got ${scan.shapeMatches.length}`);
  assert.equal(scan.viablePoolCandidates.length, 1);
  const hit = scan.viablePoolCandidates[0];
  assert.equal(hit.target, "7");
  assert.equal(hit.distinctDepositors, 50);
  assert.equal(hit.singleActor, false);
  assert.equal(hit.oneSided, false);
  assert.match(scan.verdict, /needs its own measurement/);
});

test("a single actor repeating an amount is not a pool, whatever its shape", () => {
  // Measured on Robinhood Chain: contracts with 94 and 105 identical transfers
  // from exactly one address. The value shape is perfect; the anonymity set is
  // one. Reporting that as a detected pool would be a fabricated finding.
  const rows = [];
  for (const d of DENOMINATIONS) {
    for (let i = 0; i < 100; i += 1) {
      rows.push({ from: 42, to: 9, value: String(BigInt(d) * 10n ** 18n) });
    }
  }
  const scan = contractMixerScan(rows, { minTransfers: 50 });
  assert.equal(scan.shapeMatches.length, 1, "the shape test should still fire");
  assert.equal(scan.viablePoolCandidates.length, 0, "a one-depositor contract is not a pool");
  assert.equal(scan.shapeMatches[0].singleActor, true);
  assert.equal(scan.shapeMatches[0].distinctDepositors, 1);
  assert.match(scan.verdict, /one depositor/);
  assert.match(scan.verdict, /No viable pool candidate/);
});

test("a contract that only ever takes value in is not a pool", () => {
  // A vault, a fee collector, a sale. Deposits with no withdrawals anywhere in
  // the window. Flagged rather than silently dropped, because a pool observed
  // during a deposit-only stretch would look like this too.
  const rows = poolRows(9, "0xa", { withdrawals: 0 });
  const scan = contractMixerScan(rows, { minTransfers: 50 });
  assert.equal(scan.shapeMatches.length, 1);
  assert.equal(scan.viablePoolCandidates.length, 0);
  assert.equal(scan.shapeMatches[0].oneSided, true);
  assert.equal(scan.shapeMatches[0].outboundTransfers, 0);
  assert.match(scan.verdict, /no outflow/);
});

test("a fee collector sweeping irregular totals is not a pool", () => {
  // This is the actual contract the scan returned on Robinhood Chain:
  // 0xda5494742e05ca4c1271df6fd515f89635c702fe. 120 deposits of exactly
  // 0.0005 ETH from 72 addresses, then 10 withdrawals of which 7 went to the
  // same address in irregular lumps. It survives the deposit shape, the
  // depositor count and the two-sided test. Only the outflow shape rejects it,
  // which is why that condition exists.
  const rows = [];
  for (let i = 0; i < 120; i += 1) {
    rows.push({ from: 9000 + (i % 72), to: 5, value: "500000000000000" });
  }
  const sweep = ["11469736072605452", "2701682223063049", "767782424261317",
    "4935093151126607", "15557828005418548", "1290239447065802",
    "18616492153254889", "1500000000000000", "1500000000000000", "1500000000000000"];
  for (const v of sweep) rows.push({ from: 5, to: 60000 + sweep.indexOf(v), value: v });

  const scan = contractMixerScan(rows, { minTransfers: 50 });
  assert.equal(scan.shapeMatches.length, 1);
  assert.equal(scan.shapeMatches[0].distinctDepositors, 72);
  assert.equal(scan.shapeMatches[0].oneSided, false, "it does have outflows");
  assert.equal(scan.shapeMatches[0].outflowPoolShaped, false,
    "irregular sweeps must not count as a pool-shaped outflow");
  assert.equal(scan.viablePoolCandidates.length, 0,
    "a fee accumulator must not be reported as a detected pool");
  assert.match(scan.verdict, /outflows not pool-shaped/);
});

test("a pool-shaped outflow is required, not just any outflow", () => {
  // Same deposits, but the pool now returns its own denomination to fresh
  // recipients. This one must survive.
  const rows = poolRows(5, "0xa", { withdrawals: 80 });
  const scan = contractMixerScan(rows, { minTransfers: 50 });
  const hit = scan.viablePoolCandidates[0];
  assert.equal(scan.shapeMatches.length, 1);
  assert.equal(hit.outflowPoolShaped, true);
  assert.ok(hit.outflowValueSpaceRatio < 0.1);
  assert.equal(hit.distinctDepositors, 50);
});

test("shape matches that fail a definitional condition are reported, not hidden", () => {
  // The gap between the two counts is itself the finding, so nothing is dropped.
  const rows = [
    ...poolRows(9, "0xa", { withdrawals: 0 }),          // one-sided
    ...Array.from({ length: 500 }, (_, i) => ({          // single actor
      from: 77,
      to: 11,
      value: String(BigInt(DENOMINATIONS[i % 5]) * 10n ** 18n),
    })),
  ];
  const scan = contractMixerScan(rows, { minTransfers: 50 });
  assert.equal(scan.shapeMatches.length, 2);
  assert.equal(scan.viablePoolCandidates.length, 0);
  assert.equal(scan.rejectedByDefinition.length, 2);
});

test("a negative per-contract scan still reports how close anything came", () => {
  // No mixer: a result of zero is only useful if the near miss is visible.
  const rows = [];
  for (let c = 0; c < 50; c += 1) rows.push(...ordinaryRows(c, 200, c + 1));
  const scan = contractMixerScan(rows, { minTransfers: 50 });
  assert.equal(scan.shapeMatches.length, 0);
  assert.equal(scan.viablePoolCandidates.length, 0);
  assert.equal(scan.contractsScanned, 50);
  assert.ok(scan.closest.length > 0, "closest misses must be reported");
  for (const c of scan.closest) assert.equal(Number.isFinite(c.mixerScore), true);
  assert.match(scan.verdict, /No contract in this window/);
});

test("contracts below the transfer floor are not scanned", () => {
  const rows = [...poolRows(1, "0xa"), { from: 3, to: 2, value: "5" }, { from: 4, to: 2, value: "6" }];
  const scan = contractMixerScan(rows, { minTransfers: 50 });
  assert.equal(scan.contractsScanned, 1);
  // The pool, its two recipients, and the two dust targets.
  assert.ok(scan.contractsWithValueTransfers >= 2);
});

test("contractMixerScan ignores zero-value calls and creations", () => {
  const rows = [
    ...poolRows(1, "0xa"),
    { from: 5, to: -1, value: "0" },
    { from: 6, to: 3, value: "0" },
  ];
  const scan = contractMixerScan(rows, { minTransfers: 50 });
  assert.equal(scan.valueTransfersConsidered, 585);
});

test("contractMixerScan survives an empty corpus", () => {
  const scan = contractMixerScan([], { minTransfers: 50 });
  assert.equal(scan.contractsScanned, 0);
  assert.deepEqual(scan.shapeMatches, []);
  assert.deepEqual(scan.viablePoolCandidates, []);
  assert.deepEqual(scan.closest, []);
  assert.match(scan.verdict, /No contract in this window/);
});

test("a zero value is not a value transfer, however it is encoded", () => {
  // "0" is truthy in JavaScript. A bare `if (value)` guard would count every
  // zero-value call as a value transfer and quietly deflate every ratio.
  assert.equal(isValueTransfer("0"), false);
  assert.equal(isValueTransfer(0), false);
  assert.equal(isValueTransfer(null), false);
  assert.equal(isValueTransfer(undefined), false);
  assert.equal(isValueTransfer(""), false);
  assert.equal(isValueTransfer("1"), true);
  assert.equal(isValueTransfer(1n), true);
  assert.equal(isValueTransfer("1000000000000000000"), true);

  // And the scan honours it: two zero-value calls do not become a contract.
  const rows = [...poolRows(1, "0xa"), { from: 8, to: 9, value: "0" }, { from: 8, to: 9, value: null }];
  const scan = contractMixerScan(rows, { minTransfers: 1 });
  // The pool, plus its 60 withdrawal recipients. Target 9 never appears,
  // because both of its transfers carried no value.
  assert.equal(scan.contractsWithValueTransfers, 61);
});

test("the label resolver decides what the report calls a contract", () => {
  const rows = poolRows(4, "0xb");
  const scan = contractMixerScan(rows, {
    minTransfers: 50,
    label: (i) => `0xcontract${i}`,
  });
  assert.equal(scan.viablePoolCandidates[0].target, "0xcontract4");
});

// --- sampling ---------------------------------------------------------------

test("sampleTargets spreads across the timeline instead of clustering", () => {
  const txs = Array.from({ length: 1000 }, (_, i) => ({ ts: i, from: `a${i}` }));
  const picked = sampleTargets(txs, 10);
  assert.equal(picked.length, 10);
  assert.equal(picked[0].ts, 0);
  assert.equal(picked[9].ts, 900);
  // Not the first ten.
  assert.ok(picked[5].ts > 400);
});

test("sampleTargets on a short list returns the list", () => {
  const txs = [{ ts: 1 }, { ts: 2 }];
  assert.equal(sampleTargets(txs, 250).length, 2);
});

// --- the argument -----------------------------------------------------------

test("every identifiability clause names how it could be falsified", () => {
  const clauses = identifiabilityClauses();
  assert.equal(clauses.length, 4);
  for (const c of clauses) {
    assert.ok(c.claim && c.claim.length > 10, "clause needs a claim");
    assert.ok(c.consequence && c.consequence.length > 10, "clause needs a consequence");
    assert.ok(c.falsifiableBy && c.falsifiableBy.length > 10, "clause must be falsifiable");
  }
  // The sequencer clause is the one that must admit it is unobservable.
  assert.match(clauses[3].consequence, /not observable from public data/i);
});

// --- structural -------------------------------------------------------------
// The maths must not be re-implemented in a script. The web app and the CLI
// already share src/*.mjs; the EVM measurement has to follow the same rule or
// the two drift and one of them is wrong in public.

test("the EVM measurement script uses the shared module rather than its own maths", () => {
  const source = readFileSync(new URL("../scripts/measure-evm.mjs", import.meta.url), "utf8");
  assert.match(source, /from "\.\.\/src\/evm\.mjs"/);
  assert.match(source, /from "\.\.\/src\/chains\.mjs"/);
  // It must not define its own window arithmetic.
  assert.equal(/function\s+lowerBound\b/.test(source), false);
  assert.equal(/function\s+poolSignature\b/.test(source), false);
});

test("the EVM indexer takes the chain from the registry, not from a literal", () => {
  const source = readFileSync(new URL("../scripts/build-evm-corpus.mjs", import.meta.url), "utf8");
  assert.match(source, /from "\.\.\/src\/chains\.mjs"/);
  assert.match(source, /resolveChain\(CHAIN_KEY\)/);
  assert.match(source, /isSystemAddress/);
  // A hardcoded chain ID here would defeat the point of the registry.
  assert.equal(/chainId\s*[:=]\s*\d{3,}/.test(source), false);
});

test("adding a chain is a registry change, not an indexer change", () => {
  const source = readFileSync(new URL("../scripts/build-evm-corpus.mjs", import.meta.url), "utf8");

  // No hardcoded infrastructure addresses. These are the thing most likely to
  // get copy-pasted into a new chain's code path, and the thing most likely to
  // be wrong for that chain.
  const addresses = source.match(/0x[0-9a-fA-F]{40}/g) ?? [];
  assert.deepEqual(addresses, [], "indexer contains a hardcoded address; move it to src/chains.mjs");

  // No hardcoded chain IDs either.
  assert.equal(/chainId\s*[:=]\s*\d{3,}/.test(source), false, "indexer hardcodes a chain ID");

  // The chain must come from the registry. A default chain key is fine — that
  // is a convenience, not a special case — but it must be a real registry key.
  assert.match(source, /resolveChain\(CHAIN_KEY\)/);
  const defaultKey = source.match(/arg\("chain",\s*"([^"]+)"\)/);
  assert.ok(defaultKey, "indexer should have a default chain");
  assert.ok(CHAINS[defaultKey[1]], `default chain "${defaultKey[1]}" is not in the registry`);
});

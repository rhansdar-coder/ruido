#!/usr/bin/env node
// Measure any EVM chain in the registry. Not a shielded pool — a transparent
// chain, which is what almost every chain is.
//
// The STRK20 report asked: given a real note, how many other notes could it be?
// On a transparent chain that question has no answer, and the honest report
// says so: the sender address is written in the clear, so the adversary does
// not guess, they read.
//
// So this measures something else, and it is not a consolation prize. It
// measures the timing axis — the one axis that exists on every chain, shielded
// or not — and then shows that on these chains the number is large and worth
// nothing. That is the same nominal-versus-effective distinction Ruido was
// built around, applied to a chain with no shielding primitive at all.
//
// Two methodological points this script exists to enforce:
//
//   1. Windows are in SECONDS, not blocks. Starknet makes a block every 1.702 s
//      and Robinhood Chain every 0.102 s. "±10 blocks" is 17 seconds on one and
//      1 second on the other; a table mixing them is a table of nothing.
//   2. A large candidate set is not privacy. On a chain with persistent,
//      cleartext addresses the candidate set is a list of identified parties,
//      not a list of suspects.
//
// All measurement maths lives in src/evm.mjs so that tests can hold it to
// account and so the web app can use the same implementation rather than a
// second one that drifts.
//
//   node scripts/measure-evm.mjs
//   node scripts/measure-evm.mjs --chain base
//   node scripts/measure-evm.mjs --chain ethereum

import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveChain } from "../src/chains.mjs";
import {
  buildTimeline,
  blocksToSeconds,
  concentrationStats,
  contractMixerScan,
  identifiabilityClauses,
  isValueTransfer,
  poolSignature,
  reuseStats,
  sampleTargets,
  timingCounts,
} from "../src/evm.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const CHAIN_KEY = arg("chain", "robinhood");
const chain = resolveChain(CHAIN_KEY);

const IN = resolve(ROOT, arg("corpus", `data/corpus-${CHAIN_KEY}.json`));
const OUT = resolve(ROOT, arg("out", `data/measurement-${CHAIN_KEY}.json`));
const STARKNET_MEASUREMENT = resolve(ROOT, arg("starknet", "data/measurement-mainnet.json"));
const SAMPLES = Number(arg("samples", 250));

const corpus = JSON.parse(await readFile(IN, "utf8"));

const blockTs = new Map();
for (const b of corpus.blocks) blockTs.set(b.n, b.ts);

const txs = corpus.transactions.map((row) => ({
  block: row.b,
  ts: blockTs.get(row.b),
  from: row.f,
  to: row.t,
  value: row.v,
}));

if (txs.length === 0) {
  console.error(`no transactions in ${IN} — run scripts/build-evm-corpus.mjs --chain ${CHAIN_KEY} first`);
  process.exit(1);
}

const { txs: timeline, times } = buildTimeline(txs);
const firstTs = times[0];
const lastTs = times[times.length - 1];
const spanSeconds = lastTs - firstTs;

const senderTxs = new Map();
const targetTxs = new Map();
for (const tx of timeline) {
  senderTxs.set(tx.from, (senderTxs.get(tx.from) ?? 0) + 1);
  if (tx.to >= 0) targetTxs.set(tx.to, (targetTxs.get(tx.to) ?? 0) + 1);
}

const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
const fraction = (v, test) => (v.length ? v.filter(test).length / v.length : 0);
const median = (v) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const bits = (n) => (n > 0 ? Math.log2(n) : 0);

const targets = sampleTargets(timeline, SAMPLES);

// --- 1. the timing axis, in seconds ----------------------------------------
// The window list contains the exact wall-clock equivalent of the STRK20 window
// already published: ±10 Starknet blocks at 1.702 s = ±17.0 s.
const BLOCK_TIME_STARKNET = 1.702;
const MATCHED = 17;
const WINDOWS = [1, 10, MATCHED, 60, 300, 600];

const timing = WINDOWS.map((window) => {
  const counts = timingCounts(timeline, times, targets, window);
  return {
    windowSeconds: window,
    matchedToStarknet: window === MATCHED,
    note: window === MATCHED
      ? `Wall-clock equivalent of the published STRK20 window (±10 Starknet blocks at ${BLOCK_TIME_STARKNET} s).`
      : undefined,
    candidates: Number(mean(counts).toFixed(1)),
    median: median(counts),
    bits: Number(bits(mean(counts)).toFixed(3)),
    fractionAlone: Number(fraction(counts, (c) => c <= 1).toFixed(4)),
  };
});

const matched = timing.find((t) => t.windowSeconds === MATCHED);

// --- 2. reuse, concentration, value space ----------------------------------
const reuse = reuseStats(senderTxs, timeline.length);
const concentration = concentrationStats(targetTxs);

const valueCounts = new Map();
for (const tx of timeline) {
  if (isValueTransfer(tx.value)) valueCounts.set(tx.value, (valueCounts.get(tx.value) ?? 0) + 1);
}
const valueTransfers = [...valueCounts.values()].reduce((a, b) => a + b, 0);
const pool = poolSignature(valueCounts, valueTransfers);

// The chain-wide test above is a summary. This is the actual test: a mixer is a
// contract, not a chain, and a chain-wide distribution on a busy chain is far
// too diluted for a single contract's behaviour to show through.
const contractScan = contractMixerScan(timeline, {
  minTransfers: 50,
  label: (i) => corpus.addresses[i] ?? String(i),
});

// --- 3. the zero ------------------------------------------------------------
// Every clause is a statement about the chain that could be checked and, in
// principle, contradicted.
const identifiability = {
  measuredBits: 0,
  nominalTimingCandidates: matched.candidates,
  reason: "The timing candidate set is a list of identified parties, not a list "
    + "of suspects. Anonymity requires that the answer to 'who is this' be "
    + "ambiguous. Here it is written in the transaction.",
  clauses: identifiabilityClauses(),
  notMeasurableFromPublicData: [
    "Whether the sequencer or block producer correlates arrival order with an identity.",
    "Whether IP-level data links an address to a person.",
    "Whether third-party monitoring clusters addresses off-chain.",
  ],
};

// --- 4. comparison with STRK20 ---------------------------------------------
let comparison = null;
try {
  const starknet = JSON.parse(await readFile(STARKNET_MEASUREMENT, "utf8"));
  const starknetAll = starknet.models?.find((m) => m.model === "origins ±10");
  const starknetHuman = starknet.humanScaleOnly?.models?.find((m) => m.model === "origins ±10");
  comparison = {
    note: "Same wall-clock window, same formula, two chains. The block counts differ by a factor of "
      + (BLOCK_TIME_STARKNET / corpus.window.blockTimeSeconds).toFixed(1) + "x, which is why the window is stated in seconds.",
    windowSeconds: MATCHED,
    starknetMainnet: {
      blockTimeSeconds: BLOCK_TIME_STARKNET,
      windowInBlocks: 10,
      windowSeconds: Number(blocksToSeconds(10, BLOCK_TIME_STARKNET).toFixed(1)),
      model: "origins ±10",
      candidatesAll: starknetAll?.candidates ?? null,
      candidatesHumanScale: starknetHuman?.candidates ?? null,
      measuredBits: starknet.headline?.measuredBits ?? null,
    },
    thisChain: {
      key: CHAIN_KEY,
      name: chain.name,
      blockTimeSeconds: corpus.window.blockTimeSeconds,
      windowInBlocks: Math.round(MATCHED / corpus.window.blockTimeSeconds),
      windowSeconds: MATCHED,
      model: "distinct senders",
      candidates: matched.candidates,
      measuredBits: 0,
    },
    conclusion: `${chain.name} has the larger candidate set and the smaller `
      + "anonymity set, because the candidate set is not an anonymity set. A "
      + "number only becomes privacy when the parties in it are indistinguishable "
      + "from each other. On STRK20 they are notes. Here they are addresses, and "
      + "addresses are names.",
  };
} catch {
  comparison = null;
}

// --- 5. headline, conditioned on what the detector found --------------------
// On Ethereum the shielded-pool detector has something real to find, so the
// headline cannot be a fixed sentence about there being no pool. It reports
// what was found and says what the 0-bit result does and does not cover.
//
// Three tests, in increasing strictness, and the strictest one is the claim:
//   chain-wide  — a summary; a busy chain can never satisfy it
//   shape       — per contract, the value distribution looks like a mixer
//   viable      — shape AND independent depositors AND two-sided flow
// Only `viable` supports the sentence "a pool was detected". The shape-only
// matches are reported because the gap between the two counts is the finding:
// fixed-amount payment patterns wear the same value shape as a deposit pool.
const chainWideFired = pool.shieldedPoolSignaturePresent;
const shapeHits = contractScan.shapeMatches.length;
const viableHits = contractScan.viablePoolCandidates.length;
const found = chainWideFired || viableHits > 0;
const headline = found
  ? {
    claim: `${chain.name} is a transparent chain, but a shielded pool was `
      + "detected inside the observed window.",
    measurement: `Within ±${MATCHED} seconds a transaction sits among ${matched.candidates} `
      + "distinct senders, and the effective anonymity of the transparent "
      + "population is 0 bits. The detected pool is a SEPARATE population and "
      + "needs its own measurement: this number does not describe it.",
    claimedBits: null,
    measuredBits: 0,
    effectiveBits: 0,
    nominalTimingCandidates: matched.candidates,
    shieldedPoolDetected: true,
    detectedBy: chainWideFired ? "chain-wide distribution" : "per-contract scan",
  }
  : {
    // Deliberately a claim about the WINDOW, not about the chain. Saying "this
    // chain has no shielded pool" would be false for Ethereum, where Tornado
    // Cash is deployed; what was measured is that none was found here.
    claim: `No shielded pool was detected on ${chain.name} in the observed window.`,
    measurement: `Within ±${MATCHED} seconds a transaction sits among ${matched.candidates} `
      + "distinct senders. That number is not privacy: the effective anonymity "
      + "set is 0 bits, because the sender is written in the transaction.",
    claimedBits: null,
    measuredBits: 0,
    effectiveBits: 0,
    nominalTimingCandidates: matched.candidates,
    shieldedPoolDetected: false,
    detectedBy: null,
    // Not hidden: the shape test fired and the reason it did not become a
    // detection is stated, so the negative result can be argued with.
    shapeMatchedButRejected: shapeHits,
  };

const measurement = {
  kind: "evm",
  source: {
    chain: CHAIN_KEY,
    chainName: chain.name,
    chainId: corpus.chainId,
    family: corpus.family,
    stack: corpus.stack,
    // The registry's own description of the chain, carried through so the page
    // does not have to keep a second copy of it that drifts.
    chainNote: chain.note,
    rpc: corpus.rpc,
    corpusFetchedAt: corpus.fetchedAt,
    headAtFetch: corpus.headAtFetch,
    wholeChainIndexed: corpus.completeness?.wholeChain ?? false,
    coverageNote: corpus.completeness?.reason,
    blocksMissing: corpus.completeness?.blocksMissing ?? 0,
    transactionsIndexed: corpus.totals.transactions,
    systemTransactionsExcluded: corpus.totals.systemTransactionsExcluded,
    suspiciousSystemCandidates: corpus.exclusions?.suspiciousSystemCandidates ?? [],
  },
  measuredAt: new Date().toISOString(),
  window: {
    fromBlock: corpus.window.from,
    toBlock: corpus.window.to,
    blocks: corpus.window.blocks,
    spanSeconds,
    spanMinutes: Number((spanSeconds / 60).toFixed(2)),
    blockTimeSeconds: corpus.window.blockTimeSeconds,
    transactions: timeline.length,
    transactionsPerSecond: Number((timeline.length / spanSeconds).toFixed(3)),
    transactionsPerDay: Math.round((timeline.length / spanSeconds) * 86400),
  },
  headline,
  identifiability,
  timing,
  reuse,
  concentration,
  poolSignature: pool,
  contractScan,
  erc4337: corpus.erc4337,
  txTypes: corpus.txTypes,
  comparison,
  caveats: [
    `Sampled window, not a census: ${corpus.window.blocks.toLocaleString()} contiguous blocks out of ${corpus.headAtFetch.toLocaleString()} (coverage ${corpus.completeness?.coverageOfChainBlocks}).`,
    "Adversary sees only public block data from a public RPC. A real adversary also sees arrival order and, for accounts it serves, off-chain identity records.",
    "Every figure is an upper bound on privacy. The notMeasurableFromPublicData list is why.",
    "Contract identities were not resolved against an explorer. The shielded-pool test is behavioural, not nominal.",
    "The chain-wide value-distribution test is a summary and cannot fire on a busy chain: one contract's behaviour is invisible against hundreds of thousands of transfers. The per-contract scan is the test that carries weight.",
    "The value shape alone over-reports. Fixed-amount payment patterns — a sale at a fixed price, a batch payer, one bot repeating an amount, a fee collector sweeping a treasury — produce the same deposit shape as a pool. A detection therefore also requires more than one depositor, value flowing both ways, and a pool-shaped outflow. All three are definitional requirements of a pool, not tuned thresholds.",
    ...(found
      ? ["A shielded pool was detected. The 0-bit result describes the transparent population only; the detected pool was NOT measured and its effective set is unknown."]
      : shapeHits
        ? [`The value shape matched ${shapeHits} contract(s) and none survived the definitional conditions. No pool was detected, and the shape matches are listed rather than hidden.`]
        : []),
  ],
};

await writeFile(OUT, JSON.stringify(measurement, null, 2));

const pad = (s, n) => String(s).padEnd(n);
console.log(`RUIDO · EVM measurement   ${chain.name} (${corpus.chainId})`);
console.log(`stack       ${corpus.stack}`);
console.log(`window      blocks ${corpus.window.from.toLocaleString()} → ${corpus.window.to.toLocaleString()}`
  + `  =  ${(spanSeconds / 60).toFixed(1)} min`);
console.log(`coverage    ${corpus.completeness?.coverageOfChainBlocks} of all blocks (sampled, not a census)`);
if (corpus.completeness?.blocksMissing) console.log(`holes       ${corpus.completeness.blocksMissing} block(s) missing`);

console.log("\nscale");
console.log(`  transactions           ${timeline.length.toLocaleString()}`);
console.log(`  per second             ${measurement.window.transactionsPerSecond}`);
console.log(`  per day (extrapolated) ${measurement.window.transactionsPerDay.toLocaleString()}`);
console.log(`  block time             ${corpus.window.blockTimeSeconds} s`);
console.log(`  system tx excluded     ${corpus.totals.systemTransactionsExcluded}`);

console.log("\naddress reuse");
console.log(`  distinct senders       ${reuse.distinctSenders.toLocaleString()}`);
console.log(`  tx per sender          ${reuse.transactionsPerSender}`);
console.log(`  used exactly once      ${reuse.singleUseSenders.toLocaleString()}  (${(reuse.singleUseFraction * 100).toFixed(1)}%)`);
console.log(`  senders for 50% of tx  ${reuse.sendersForHalfOfActivity}  (${(reuse.sendersForHalfOfActivityFraction * 100).toFixed(1)}% of senders)`);

console.log("\ncontract concentration");
console.log(`  distinct targets       ${concentration.distinctTargets.toLocaleString()}`);
console.log(`  top 1 / 10 / 100       ${(concentration.shareTop1 * 100).toFixed(1)}% / ${(concentration.shareTop10 * 100).toFixed(1)}% / ${(concentration.shareTop100 * 100).toFixed(1)}%`);
console.log(`  targets for 80% of tx  ${concentration.targetsFor80Percent}`);

console.log(`\n${"=".repeat(72)}`);
console.log("  timing axis, in wall-clock seconds (the unit that is comparable)");
console.log(`${"=".repeat(72)}`);
console.log(`  ${pad("window", 12)}${pad("candidates", 13)}${pad("median", 9)}${pad("bits", 9)}alone`);
for (const t of timing) {
  const label = t.matchedToStarknet ? `±${t.windowSeconds} s *` : `±${t.windowSeconds} s`;
  console.log(`  ${pad(label, 12)}${pad(t.candidates, 13)}${pad(t.median, 9)}${pad(t.bits, 9)}${(t.fractionAlone * 100).toFixed(1)}%`);
}
console.log(`  * matches the published STRK20 window (±10 Starknet blocks)`);

console.log(`\n${"=".repeat(72)}`);
console.log("  EFFECTIVE ANONYMITY    0 bits");
console.log(`  nominal timing set     ${matched.candidates} senders`);
console.log("  The set is large. The set is not an anonymity set: it is a list of");
console.log("  identified parties, because the sender is written in the transaction.");
console.log(`${"=".repeat(72)}`);

console.log("\nshielded pool test (behavioural, not nominal)");
console.log(`  value transfers        ${pool.valueTransfers.toLocaleString()}`);
console.log(`  distinct values        ${pool.distinctValues.toLocaleString()}`);
console.log(`  appearing once         ${pool.valuesAppearingOnce.toLocaleString()}  (${(pool.valuesAppearingOnceFraction * 100).toFixed(1)}%)`);
console.log(`  top 5 share            ${(pool.top5ShareOfTransfers * 100).toFixed(1)}%   (mixer if > ${pool.thresholds.top5ShareAbove * 100}%)`);
console.log(`  value space ratio      ${pool.valueSpaceRatio}   (mixer if < ${pool.thresholds.valueSpaceRatioBelow})`);
console.log(`  signature present      ${pool.shieldedPoolSignaturePresent}   <- chain-wide summary, cannot fire on a busy chain`);

console.log("\nshielded pool test, per contract (the test that counts)");
console.log(`  contracts scanned      ${contractScan.contractsScanned.toLocaleString()} of ${contractScan.contractsWithValueTransfers.toLocaleString()} with value transfers`);
console.log(`  minimum transfers      ${contractScan.minTransfers}`);
console.log(`  value shape matched    ${shapeHits} contract(s)`);
console.log(`  viable pool candidates ${viableHits} contract(s)   <- shape + depositors + two-sided + pool-shaped outflow`);
if (shapeHits) {
  console.log("  every shape match, and why it is or is not a pool:");
  for (const c of contractScan.shapeMatches) {
    const why = c.singleActor ? "one depositor — anonymity set of 1 by construction"
      : c.oneSided ? "no outflow — value only ever goes in"
        : !c.outflowPoolShaped ? `outflow not pool-shaped — ${c.outflowDistinctValues} different amounts paid out`
          : "SURVIVES every condition";
    console.log(`    ${c.target}  ${String(c.transfers).padStart(6)} tx`
      + `  ratio ${String(c.valueSpaceRatio).padEnd(7)}`
      + `  depositors ${String(c.distinctDepositors).padStart(5)}`
      + `  out ${String(c.outboundTransfers).padStart(5)}`
      + `  outRatio ${String(c.outflowValueSpaceRatio).padEnd(7)}  ${why}`);
  }
}
console.log("  closest misses (top5Share / valueSpaceRatio = mixerScore):");
for (const c of contractScan.closest) {
  console.log(`    ${c.target}  ${String(c.transfers).padStart(6)} tx`
    + `  top5 ${(c.top5ShareOfTransfers * 100).toFixed(1)}%`
    + `  ratio ${c.valueSpaceRatio}`
    + `  score ${c.mixerScore}`);
}
console.log(`  thresholds             top5 > ${contractScan.thresholds.top5ShareAbove * 100}% AND ratio < ${contractScan.thresholds.valueSpaceRatioBelow}`);

console.log("\nerc-4337");
console.log(`  entrypoint tx          ${corpus.erc4337.total} of ${timeline.length} (${((corpus.erc4337.total / timeline.length) * 100).toFixed(2)}%)`);
for (const e of corpus.erc4337.entrypoints) console.log(`    ${e.name}  ${e.txs}`);

if (comparison) {
  console.log(`\n${"=".repeat(72)}`);
  console.log(`  same wall-clock window (±${MATCHED} s), two chains`);
  console.log(`${"=".repeat(72)}`);
  console.log(`  STRK20 mainnet         ${comparison.starknetMainnet.candidatesAll} origins`
    + `  →  ${comparison.starknetMainnet.measuredBits} bits`);
  console.log(`  ${pad(chain.name, 22)} ${comparison.thisChain.candidates} senders`
    + `  →  0 bits`);
  console.log("  Larger set, less privacy. The number was never the privacy.");
}

if (found) {
  console.log(`\n${"!".repeat(72)}`);
  console.log("  A mixer-shaped value distribution was detected in this window.");
  console.log("  The 0-bit result above describes the transparent population ONLY.");
  console.log("  The detected pool was not measured; its effective set is unknown.");
  console.log(`${"!".repeat(72)}`);
}

console.log(`\nwritten to ${OUT}`);

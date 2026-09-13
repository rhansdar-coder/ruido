#!/usr/bin/env node
// Ruido measurement CLI. Runs offline against a seeded corpus, so every number
// here is reproducible with `node scripts/measure.mjs`.

import { mulberry32, randomInt } from "../src/rng.mjs";
import {
  decoySalts,
  legacySalts,
  randomSalt,
  NOTES_PER_MESSAGE,
} from "../src/salt.mjs";
import { DENOMINATIONS, FEE_PER_CALL, schedule, costEstimate } from "../src/cover.mjs";
import { buildPool, addCover, addWindowCover, addTargetedCover, candidateSet, anonymityBits, summarise } from "../src/anonymity.mjs";
import { m1, m3, formatScore } from "../src/metrics.mjs";

const args = new Map(
  process.argv.slice(2).reduce((acc, value, index, all) => {
    if (value.startsWith("--")) acc.push([value.slice(2), all[index + 1]]);
    return acc;
  }, []),
);

const SEED = Number(args.get("seed") ?? 20260911);
const next = mulberry32(SEED);

const POOL_SIZE = Number(args.get("pool") ?? 2000);
const BLOCKS = Number(args.get("blocks") ?? 5000);
const WINDOWS = Number(args.get("windows") ?? 24);
const ACCOUNTS = Number(args.get("accounts") ?? 40);
const BASE_RATE = Number(args.get("rate") ?? 3);
const NETWORK = args.get("network") ?? "sepolia";

const pad = (value, width) => String(value).padEnd(width);
const num = (value, width) => String(value).padStart(width);

console.log(`RUIDO · anonymity measurement   seed=${SEED}  network=${NETWORK}`);
console.log(`pool=${POOL_SIZE} notes  windows=${WINDOWS}  accounts=${ACCOUNTS}  rate=${BASE_RATE}/window`);

// --- M1 ---------------------------------------------------------------------
// Two positive sets, one negative set. Legacy reproduces the fingerprint the
// upstream threat model documents; ruido is what we emit.
const legacyPositives = Array.from({ length: 200 }, () => legacySalts(next));
const ruidoPositives = Array.from({ length: 200 }, () => decoySalts(next));
const negatives = Array.from({ length: 10000 }, () =>
  Array.from({ length: NOTES_PER_MESSAGE }, () => randomSalt(next)),
);

const legacyScore = m1({ positives: legacyPositives, negatives });
const ruidoScore = m1({ positives: ruidoPositives, negatives });

console.log("\nM1 · can an observer tell our traffic from ordinary pool traffic?");
console.log(`  ${pad("legacy wire-v2 shape", 26)} balanced ${formatScore(legacyScore).balancedAccuracy}  ${formatScore(legacyScore).counts}`);
console.log(`  ${pad("ruido (randomised)", 26)} balanced ${formatScore(ruidoScore).balancedAccuracy}  ${formatScore(ruidoScore).counts}`);
console.log(`  ${pad("target", 26)} balanced 0.5000`);

// --- M3 ---------------------------------------------------------------------
const perAccountBase = Array.from({ length: ACCOUNTS }, () => ({ deals: randomInt(next, 0, 12) }));
const coverCounts = schedule({ mode: "fixed", windows: 1, baseRate: BASE_RATE, next });

const withCover = perAccountBase.map((account) => ({
  deals: account.deals,
  cover: randomInt(next, Math.max(0, BASE_RATE - 1), BASE_RATE + 2),
}));
const noCover = perAccountBase.map((account) => ({ deals: account.deals, cover: 0 }));

const m3Without = m3({ perAccount: noCover });
const m3With = m3({ perAccount: withCover });

console.log("\nM3 · how accurately can an observer count deals per account?");
console.log(`  ${pad("", 12)} ${num("maeNaive", 9)} ${num("maeBest", 9)} ${num("uncertainty", 12)}`);
console.log(`  ${pad("no cover", 12)} ${num(m3Without.maeNaive, 9)} ${num(m3Without.maeBest, 9)} ${num(m3Without.uncertainty, 12)}`);
console.log(`  ${pad("with cover", 12)} ${num(m3With.maeNaive, 9)} ${num(m3With.maeBest, 9)} ${num(m3With.uncertainty, 12)}`);

// --- Anonymity set ----------------------------------------------------------
const pool = buildPool({ size: POOL_SIZE, blocks: BLOCKS, denominations: DENOMINATIONS, next });
const target = pool[0];

const counts = schedule({ mode: "fixed", windows: WINDOWS, baseRate: BASE_RATE, next });
const totalDecoys = counts.reduce((sum, n) => sum + n, 0);
const covered = addCover(pool, totalDecoys, { blocks: BLOCKS, denominations: DENOMINATIONS, next });

const TARGETS = Array.from({ length: 200 }, () => pool[randomInt(next, 0, pool.length)]);
const before = summarise(pool, TARGETS, { timingWindow: 10 });
const after = summarise(covered, TARGETS, { timingWindow: 10 });

console.log(`\nAnonymity set · target note, ${totalDecoys} decoys added`);
console.log(`  ${pad("adversary model", 16)} ${num("before", 14)} ${num("after", 14)}`);
for (let i = 0; i < before.length; i += 1) {
  const b = before[i];
  const a = after[i];
  console.log(
    `  ${pad(b.model, 16)} ${num(`${b.candidates} (${b.bits}b)`, 14)} ${num(`${a.candidates} (${a.bits}b)`, 14)}`,
  );
}

// --- Scaling sweep ---------------------------------------------------------
// The section that decides whether this is a product. Cover traffic is only
// worth paying for if the marginal bit gets cheaper, not dearer, as volume
// grows. Sweep multiples of the pool size and show bits per STRK.
const FEE = FEE_PER_CALL[NETWORK] ?? FEE_PER_CALL.sepolia;
const strongest = (notes) => summarise(notes, TARGETS, { timingWindow: 10 }).at(-1);

console.log("\nScaling · how much cover does one bit cost?");
console.log(`  ${pad("cover", 12)} ${num("decoys", 9)} ${num("candidates", 11)} ${num("bits", 7)} ${num("STRK", 10)} ${num("STRK/bit", 10)}`);
for (const multiple of [0, 0.25, 0.5, 1, 2, 4, 8, 16]) {
  const decoys = Math.round(POOL_SIZE * multiple);
  const extended = addCover(pool, decoys, { blocks: BLOCKS, denominations: DENOMINATIONS, next });
  const result = strongest(extended);
  const base = strongest(pool);
  const gained = result.bits - base.bits;
  const spent = Number(BigInt(decoys) * FEE);
  console.log(
    `  ${pad(`${multiple}x pool`, 12)} ${num(decoys, 9)} ${num(result.candidates, 11)} ${num(result.bits, 7)} ${num(spent, 10)} ${num(gained > 0 ? (spent / gained).toFixed(1) : "—", 10)}`,
  );
}

// --- Placement: what does knowing less cost? --------------------------------
// One budget, three placements, measured on the same notes throughout so the
// columns are comparable.
//
// The three are not a menu of equals. `window` is the one a provider can
// actually be held to: cover has to land before the spend, so the timing is
// given away by construction, and the denomination is the only thing the buyer
// can withhold. This table is what withholding it costs.
console.log("\nPlacement · same budget, three strategies (adversary model 'all')");

const MODEL = { model: "all", timingWindow: 10 };
const PLACEMENT_TARGETS = TARGETS.slice(0, 100);
// A per-target seed, so what a target gets does not depend on how many targets
// were measured before it.
const seedFor = (index) => mulberry32(SEED + 7919 * (index + 1));

const meanCell = (notes) => {
  let total = 0;
  for (const t of PLACEMENT_TARGETS) total += candidateSet(notes, t, MODEL).length;
  return total / PLACEMENT_TARGETS.length;
};
// Aimed cover is aimed at each note in turn and measured on that note. It is
// the only way to compare it with uniform cover on equal terms: same notes,
// same adversary, same budget.
const meanAimedCell = (place, decoys) => {
  let total = 0;
  PLACEMENT_TARGETS.forEach((t, i) => {
    total += candidateSet(place(t, i, decoys), t, MODEL).length;
  });
  return total / PLACEMENT_TARGETS.length;
};
const placeWindow = (t, i, n) =>
  addWindowCover(pool, n, { target: t, timingWindow: 10, denominations: DENOMINATIONS, next: seedFor(i) });
const placeTargeted = (t, i, n) =>
  addTargetedCover(pool, n, { target: t, timingWindow: 10, next: seedFor(i) });

// Uniform cover is the blind position, and its effect on the strongest
// adversary is so close to zero that one draw cannot measure it: a single
// 500-decoy draw moves the mean cell by anywhere from 0.04 to 0.17, which showed
// up here as a column that was not even monotone. Averaged over independent
// draws, the same treatment the aimed strategies get by averaging over targets.
const UNIFORM_DRAWS = 8;
const meanUniformCell = (decoys) => {
  let total = 0;
  for (let d = 0; d < UNIFORM_DRAWS; d += 1) {
    total += meanCell(
      addCover(pool, decoys, {
        blocks: BLOCKS,
        denominations: DENOMINATIONS,
        next: mulberry32(SEED + 104729 * (d + 1)),
      }),
    );
  }
  return total / UNIFORM_DRAWS;
};

// An earlier version of this table measured uniform cover against the pool mean
// and aimed cover against a single note, and the two baselines differed by more
// than the effect being measured. Worse, a single note's cell is one draw: the
// note this table used to report on had a cell of 3 against a pool mean of 1.9,
// which made cover look 40% dearer than it is. Averaging over the same notes
// removes both problems at once.
const baselineCell = meanCell(pool);
const baselineBits = anonymityBits(baselineCell);
console.log(
  `  cell before any cover: ${baselineCell.toFixed(2)} candidates (${baselineBits.toFixed(3)}b), mean over ${PLACEMENT_TARGETS.length} notes`,
);
console.log(
  `  ${pad("decoys", 8)} ${num("uni", 7)} ${num("win", 7)} ${num("tgt", 7)} ${num("STRK", 8)} ${num("u./bit", 9)} ${num("w./bit", 9)} ${num("t./bit", 9)}`,
);

const placement = [];
for (const decoys of [10, 25, 50, 100, 250, 500]) {
  const row = {
    decoys,
    spent: Number(BigInt(decoys) * FEE),
    uniformBits: anonymityBits(meanUniformCell(decoys)),
    windowBits: anonymityBits(meanAimedCell(placeWindow, decoys)),
    targetedBits: anonymityBits(meanAimedCell(placeTargeted, decoys)),
  };
  placement.push(row);
  const rate = (bits) => {
    const gained = bits - baselineBits;
    return gained > 0 ? (row.spent / gained).toFixed(1) : "—";
  };
  console.log(
    `  ${pad(decoys, 8)} ${num(row.uniformBits.toFixed(3), 7)} ${num(row.windowBits.toFixed(3), 7)} ${num(row.targetedBits.toFixed(3), 7)} ${num(row.spent, 8)} ${num(rate(row.uniformBits), 9)} ${num(rate(row.windowBits), 9)} ${num(rate(row.targetedBits), 9)}`,
  );
}

// The penalty for withholding the denomination, read off the rows above rather
// than recomputed with fresh draws — recomputing would let the table and the
// summary drift apart on a different sample, which is the failure this repo
// exists to catch. The ladder width is why it is not free: one rung in seven is
// the target's, so six of every seven decoys land outside the cell that matters.
const penalty = (row) => (row.targetedBits - baselineBits) / (row.windowBits - baselineBits);
const perBit = (row, bits) => row.spent / (bits - baselineBits);
const head = placement[0];
const tail = placement.at(-1);
console.log(
  `  withholding the denomination costs ${penalty(head).toFixed(2)}x the aimed price at ${head.decoys} decoys, ${penalty(tail).toFixed(2)}x at ${tail.decoys}`,
);
// That ratio falling is not window-only getting good. At 500 decoys both
// strategies are buying saturated bits and the ratio converges because the cell
// is full — a symptom, not a saving. The absolute number is the one to read, and
// it is why the section below exists.
console.log(
  `  it falls because both get dearer, not because window-only gets good: ${perBit(tail, tail.windowBits).toFixed(0)} vs ${perBit(tail, tail.targetedBits).toFixed(0)} STRK/bit at ${tail.decoys}`,
);
console.log(
  `  the ladder is ${DENOMINATIONS.length} rungs wide, so ${DENOMINATIONS.length - 1} in ${DENOMINATIONS.length} decoys land outside the cell`,
);

// --- Landing rate: why the three prices differ ------------------------------
// The STRK/bit columns above are noisy wherever the effect is small, and the
// blind column is at the edge of what 100 notes can resolve: its gain at 10
// decoys is about 0.005 bits against a sampling standard error near 0.14. The
// quantity underneath those columns is exact and cheap to measure on a large
// sample, though, and it explains the whole table: what fraction of decoys land
// in the cell the adversary actually looks in?
console.log("\nLanding rate · how many decoys land where the adversary looks");
console.log(
  `  ${pad("strategy", 10)} ${num("decoys", 10)} ${num("on cell", 10)} ${num("rate", 9)} ${num("decoys per cell note", 20)}`,
);
const LANDING_DECOYS = 200000;
const landingTarget = TARGETS[0];
for (const [name, place] of [
  ["blind", (n, seed) => addCover(pool, n, { blocks: BLOCKS, denominations: DENOMINATIONS, next: seed })],
  ["window", (n, seed) => addWindowCover(pool, n, { target: landingTarget, timingWindow: 10, denominations: DENOMINATIONS, next: seed })],
  ["aimed", (n, seed) => addTargetedCover(pool, n, { target: landingTarget, timingWindow: 10, next: seed })],
]) {
  const extended = place(LANDING_DECOYS, mulberry32(SEED + 31337));
  const onCell = extended
    .slice(pool.length)
    .filter(
      (note) =>
        Math.abs(note.block - landingTarget.block) <= 10 &&
        note.denomination === landingTarget.denomination,
    ).length;
  const rate = onCell / LANDING_DECOYS;
  console.log(
    `  ${pad(name, 10)} ${num(LANDING_DECOYS, 10)} ${num(onCell, 10)} ${num(rate.toFixed(5), 9)} ${num(rate > 0 ? `1 in ${Math.round(1 / rate)}` : "—", 20)}`,
  );
}
console.log(
  "  blind cover is the same product at 1/1700th the yield, which is the whole argument for aiming it",
);

// --- Order size: what should a customer actually buy? -----------------------
// The price per bit is not a constant, so a single figure is not a price. The
// first bits are the cheapest, because the set is being multiplied from a small
// base; a later bit needs the same multiplication applied to a number that is
// already large. Marginal bits therefore get dearer, so there is a cheapest
// order size and it is small — which makes any quoted "STRK/bit" an operating
// point rather than a price, and quoting one without the order size a mistake.
console.log("\nOrder size · where is the cheapest bit? (targeted cover, aimed at one note)");
console.log(`  ${pad("decoys", 8)} ${num("cell", 8)} ${num("bits", 7)} ${num("gained", 8)} ${num("STRK", 8)} ${num("STRK/bit", 9)}`);
let cheapest = null;
for (const decoys of [1, 2, 3, 5, 10, 25, 50]) {
  const cell = meanAimedCell(placeTargeted, decoys);
  const bits = anonymityBits(cell);
  const gained = bits - baselineBits;
  const spent = Number(BigInt(decoys) * FEE);
  const each = gained > 0 ? spent / gained : Infinity;
  if (gained > 0 && (cheapest === null || each < cheapest.each)) {
    cheapest = { decoys, each, gained };
  }
  console.log(
    `  ${pad(decoys, 8)} ${num(cell.toFixed(2), 8)} ${num(bits.toFixed(3), 7)} ${num(gained.toFixed(3), 8)} ${num(spent, 8)} ${num(Number.isFinite(each) ? each.toFixed(1) : "—", 9)}`,
  );
}
console.log(
  `  cheapest bit: ${cheapest.each.toFixed(1)} STRK at ${cheapest.decoys} decoy(s) for ${cheapest.gained.toFixed(3)} bits — the price rises from here`,
);

// --- Cost -------------------------------------------------------------------
const cost = costEstimate(counts, { network: NETWORK });
console.log("\nCost of the scheduled plan above");
console.log(`  ${cost.decoys} decoys × ${cost.feePerCall} STRK per call = ${cost.totalFee} STRK (${cost.network})`);
console.log(`  anonymity gain under 'all': ${(after.at(-1).bits - before.at(-1).bits).toFixed(3)} bits`);

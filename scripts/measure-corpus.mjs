#!/usr/bin/env node
// Measure the real STRK20 pool. Not a model — the actual note set.
//
// Everything else in this repo argues about a synthetic pool. This script reads
// data/corpus.json, which is every event the deployed pool has ever emitted,
// and asks the only question that matters: given a real note, how many other
// notes could it be?
//
// The adversary here sees only public data: block numbers and transaction
// hashes. No mempool, no IP addresses, no exchange records. A real adversary
// has all of those. Every number below is therefore an upper bound on privacy.
//
//   node scripts/measure-corpus.mjs
//   node scripts/measure-corpus.mjs --corpus data/corpus.json

import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assignAmounts,
  bucketSizes,
  denominationModels,
  sampleOf,
} from "../src/denomination.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const IN = resolve(ROOT, arg("corpus", "data/corpus.json"));
const OUT = resolve(ROOT, arg("out", "data/measurement.json"));
const SAMPLES = Number(arg("samples", 400));

const corpus = JSON.parse(await readFile(IN, "utf8"));

const NOTE_EVENTS = new Set(["EncNoteCreated", "OpenNoteCreated"]);
const notes = corpus.events
  .filter((e) => NOTE_EVENTS.has(e.name))
  .map((e) => ({ block: e.block, tx: e.tx, noteId: e.note_id ?? null, name: e.name }))
  .sort((a, b) => a.block - b.block);

// Ids are assigned after the sort, never before. Assigning them in map() and
// then sorting silently points every id at the wrong note.
notes.forEach((note, i) => {
  note.id = i;
});

if (notes.length === 0) {
  console.error("no notes in corpus — run scripts/build-corpus.mjs first");
  process.exit(1);
}

// Notes minted by the same transaction share an origin. That is not an
// inference, it is a fact written into the ledger: one account, one nonce, one
// transaction. Any adversary holding the funding transaction holds the cluster.
//
// A load generator minting 300 notes is one origin, not 300 suspects. Counting
// notes instead of origins is how a bot makes a pool look anonymous, so both
// are reported and never mixed.
const clusterOf = new Map();
for (const note of notes) {
  if (!clusterOf.has(note.tx)) clusterOf.set(note.tx, []);
  clusterOf.get(note.tx).push(note.id);
}
for (const ids of clusterOf.values()) {
  for (const id of ids) notes[id].clusterSize = ids.length;
}

const blocks = notes.map((n) => n.block);
const firstBlock = blocks[0];
const lastBlock = blocks[blocks.length - 1];
const span = lastBlock - firstBlock;

const bits = (n) => (n > 0 ? Math.log2(n) : 0);

/** Index of the first note with block >= value. Blocks are sorted. */
function lowerBound(value) {
  let lo = 0;
  let hi = blocks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Notes whose creation block falls within `window` blocks of `block`. */
function inWindow(block, window) {
  let count = 0;
  for (let i = lowerBound(block - window); i < notes.length; i += 1) {
    if (notes[i].block > block + window) break;
    count += 1;
  }
  return count;
}

// Sample real notes as targets. Sampling without replacement, spread across
// the whole history rather than clustered in the busiest burst.
const step = Math.max(1, Math.floor(notes.length / SAMPLES));
const targets = [];
for (let i = 0; i < notes.length && targets.length < SAMPLES; i += step) targets.push(notes[i]);

// A mean over an empty list is NaN, and NaN silently propagates into every
// table it touches. Small pools are a real case here: mainnet is quiet, and an
// "no human-scale notes" corpus is a finding, not a crash.
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const fraction = (values, test) => (values.length ? values.filter(test).length / values.length : 0);
const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// --- models -----------------------------------------------------------------
// Each model is one thing an adversary can do with public data alone.

const WINDOWS = [1, 10, 100, 1000];

const models = [];

models.push({
  model: "nominal",
  description: "Every note in the pool. The number a project puts on a slide.",
  candidates: notes.length,
  bits: Number(bits(notes.length).toFixed(3)),
});

for (const window of WINDOWS) {
  const counts = targets.map((t) => inWindow(t.block, window));
  models.push({
    model: `timing ±${window}`,
    description: `Adversary knows when, to within ${window} blocks.`,
    candidates: Number(mean(counts).toFixed(2)),
    median: Number(median(counts).toFixed(2)),
    bits: Number(bits(mean(counts)).toFixed(3)),
    fractionAlone: Number(fraction(counts, (c) => c <= 1).toFixed(3)),
  });
}

// Distinct origins in the timing window.
//
// If the adversary's question is "which account did this", then three hundred
// notes minted by one bot transaction are one suspect, not three hundred. This
// is the version of the timing model that a bot cannot inflate.
for (const window of WINDOWS) {
  const counts = targets.map((t) => {
    const origins = new Set();
    for (let i = lowerBound(t.block - window); i < notes.length; i += 1) {
      if (notes[i].block > t.block + window) break;
      origins.add(notes[i].tx);
    }
    return origins.size;
  });
  models.push({
    model: `origins ±${window}`,
    description: `Distinct funding transactions in a ${window}-block window.`,
    candidates: Number(mean(counts).toFixed(2)),
    median: Number(median(counts).toFixed(2)),
    bits: Number(bits(mean(counts)).toFixed(3)),
    fractionAlone: Number(fraction(counts, (c) => c <= 1).toFixed(3)),
  });
}

{
  const counts = targets.map((t) => t.clusterSize);
  models.push({
    model: "same transaction",
    description: "Adversary holds the funding transaction. Set is the cluster it minted.",
    candidates: Number(mean(counts).toFixed(2)),
    median: Number(median(counts).toFixed(2)),
    bits: Number(bits(mean(counts)).toFixed(3)),
    fractionAlone: Number(fraction(counts, (c) => c <= 1).toFixed(3)),
  });
}

// --- bot traffic ------------------------------------------------------------
// Testnet pools carry load generators that mint hundreds of notes in one
// transaction. They are not users and they inflate every average above. This
// separates the two so neither number is passed off as the other.
const HUMAN_MAX = 6;
const human = notes.filter((n) => n.clusterSize <= HUMAN_MAX);
const bot = notes.filter((n) => n.clusterSize > HUMAN_MAX);
const humanTargets = targets.filter((t) => t.clusterSize <= HUMAN_MAX);

// Same measurement, restricted to human-scale traffic and to origins only.
// This is the number to quote, because it is the one a bot cannot move.
const humanBlocks = human.map((n) => n.block).sort((a, b) => a - b);
const humanLowerBound = (value) => {
  let lo = 0;
  let hi = humanBlocks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (humanBlocks[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

const humanOrigins = (target, window) => {
  const origins = new Set();
  for (let i = humanLowerBound(target.block - window); i < human.length; i += 1) {
    if (human[i].block > target.block + window) break;
    origins.add(human[i].tx);
  }
  return origins.size;
};

const humanModels = [];
for (const window of WINDOWS) {
  const notes_ = humanTargets.map((t) => {
    let count = 0;
    for (let i = humanLowerBound(t.block - window); i < human.length; i += 1) {
      if (human[i].block > t.block + window) break;
      count += 1;
    }
    return count;
  });
  const origins = humanTargets.map((t) => humanOrigins(t, window));
  humanModels.push({
    model: `notes ±${window}`,
    candidates: Number(mean(notes_).toFixed(2)),
    median: median(notes_),
    bits: Number(bits(mean(notes_)).toFixed(3)),
    fractionAlone: Number(fraction(notes_, (c) => c <= 1).toFixed(3)),
  });
  humanModels.push({
    model: `origins ±${window}`,
    candidates: Number(mean(origins).toFixed(2)),
    median: median(origins),
    bits: Number(bits(mean(origins)).toFixed(3)),
    fractionAlone: Number(fraction(origins, (c) => c <= 1).toFixed(3)),
  });
}

// --- denomination axis ------------------------------------------------------
//
// The pool's own events expose the amount of a note in exactly two ways, and
// both are public:
//
//   explicit     an open note publishes note_id, and OpenNoteDeposited publishes
//                the same note_id together with an amount. The join is exact.
//   transaction  the note's transaction carries exactly one distinct
//                (token, amount) deposit. Every note that transaction minted
//                therefore has that amount.
//
// Everything else stays unknown, and unknown is left unknown. The one other
// candidate was checked and rejected: EncNoteCreated.packed_value does not carry
// the amount, and the check is worth recording because it would have changed the
// coverage from 41% to 100% if it had. Its magnitude is 55 orders of magnitude
// above the amounts it would have to encode, so it is a commitment, not a
// plaintext amount. See scripts/_recon8.mjs.
//
// Two consequences worth stating plainly:
//
//   * The axis cannot see the whole pool. A change note minted by spending an
//     existing note has no deposit anywhere in its transaction, so its amount is
//     unobservable. Coverage is reported, not assumed.
//   * Where it does apply it can only shrink the candidate set. The measured
//     amounts are round (2 ETH, 0.1 ETH, 0.001 ETH), and a round amount is a
//     small bucket.

// The join lives in src/denomination.mjs so it can be tested. It had a bug once:
// every money-in event was treated as evidence about every note in its
// transaction, which broadcast open-note amounts onto unrelated encrypted notes
// in the same batch.
const routeCounts = assignAmounts(corpus.events, notes);
const visible = notes.filter((n) => n.amount);

// How many notes share each (token, amount). This is the whole point: a round
// denomination is a small bucket, and a small bucket is a small anonymity set.
const bucketSize = bucketSizes(visible);

const visibleTargets = sampleOf(visible, SAMPLES);
const visibleHuman = visible.filter((n) => n.clusterSize <= HUMAN_MAX);
const visibleHumanTargets = sampleOf(visibleHuman, SAMPLES);
// The human-scale bucket must be counted inside the human-scale subset, or a bot
// would be inflating a bucket the human model claims to have measured.
const humanBucketSize = bucketSizes(visibleHuman);

const denominationModelsAll = denominationModels(visibleTargets, visible, bucketSize, WINDOWS);
const denominationModelsHuman = denominationModels(
  visibleHumanTargets,
  visibleHuman,
  humanBucketSize,
  WINDOWS,
);

// The raw evidence, so the shape of the amounts is visible rather than summarised
// into a single "roundness" score that nobody can check.
const amountHistogram = [...bucketSize]
  .map(([key, count]) => {
    const [token, amount] = key.split("|");
    return { token, amount, notes: count };
  })
  .sort((a, b) => b.notes - a.notes);

const denomination = {
  note: "Amounts are public for a subset of notes, and only a subset. Two routes "
    + "expose them: an open note publishes note_id and OpenNoteDeposited publishes the "
    + "same note_id with an amount (exact join), or the note's transaction carries "
    + "exactly one distinct deposit amount. A change note minted by spending an existing "
    + "note has neither, so its amount is unobservable and is left unknown. "
    + "EncNoteCreated.packed_value was tested and does not carry the amount. "
    + "The candidate set is the observable same-denomination set: the notes an adversary "
    + "can actually list. Change notes are not in it, and not because they were excluded "
    + "for convenience — they are created by a spend rather than a deposit, so they are "
    + "structurally distinguishable from a note whose amount is known.",
  coverage: {
    notes: notes.length,
    withAmount: visible.length,
    fractionWithAmount: Number((visible.length / notes.length).toFixed(3)),
    byRoute: routeCounts,
    distinctDenominations: bucketSize.size,
  },
  headline: denominationModelsAll.length
    ? {
      model: "amount",
      candidates: denominationModelsAll[0].candidates,
      bits: denominationModelsAll[0].bits,
      fractionAlone: denominationModelsAll[0].fractionAlone,
    }
    : null,
  models: denominationModelsAll,
  humanScaleOnly: {
    note: `Amount-visible notes from transactions minting at most ${HUMAN_MAX} notes.`,
    notes: visibleHuman.length,
    samples: visibleHumanTargets.length,
    models: denominationModelsHuman,
  },
  amountHistogram: amountHistogram.slice(0, 12),
  caveats: [
    "The axis covers only the notes whose amount is publicly derivable, so it describes that subset and not the pool as a whole.",
    "A transaction carrying several distinct deposit amounts is treated as unknown, which understates the leak rather than overstating it.",
    "Where it applies it can only shrink the candidate set, so the figures here are still upper bounds.",
  ],
};

// --- output -----------------------------------------------------------------

// The number to quote: human-scale traffic, adversary knows the block to
// within 10. Anything looser flatters the pool; anything tighter is a
// different claim.
const baseline = humanModels.find((m) => m.model === "origins ±10");

const measurement = {
  source: {
    network: corpus.network,
    pool: corpus.pool,
    corpusFetchedAt: corpus.fetchedAt,
    complete: corpus.complete,
    headAtFetch: corpus.headAtFetch,
    // The size of the evidence, which is not the size of the anonymity set.
    // Conflating the two is how a dashboard ends up claiming the pool's note
    // count as its "events indexed" figure.
    events: corpus.totals.events,
    classes: corpus.classHistory?.length ?? 1,
  },
  measuredAt: new Date().toISOString(),
  pool: {
    notes: notes.length,
    clusters: clusterOf.size,
    blockRange: { first: firstBlock, last: lastBlock, span },
    notesPerThousandBlocks: Number(((notes.length / span) * 1000).toFixed(3)),
    medianClusterSize: median(notes.map((n) => n.clusterSize)),
    humanScaleNotes: human.length,
    botScaleNotes: bot.length,
  },
  samples: targets.length,
  headline: {
    claim: `The pool holds ${notes.length.toLocaleString()} notes.`,
    measurement: `A real note is indistinguishable from ${baseline.candidates} others, on average, `
      + `if the adversary knows which block it was created in to within 10 blocks.`,
    claimedBits: Number(bits(notes.length).toFixed(2)),
    measuredBits: baseline.bits,
    claimedSet: notes.length,
    measuredSet: baseline.candidates,
    fractionAlone: baseline.fractionAlone,
  },
  models,
  humanScaleOnly: {
    note: `Transactions minting at most ${HUMAN_MAX} notes. Excludes load generators.`,
    notes: human.length,
    samples: humanTargets.length,
    models: humanModels,
  },
  denomination,
  caveats: [
    "Sepolia testnet. Volumes are not mainnet volumes and some traffic is load generation.",
    "Adversary sees only public RPC data: block numbers, transaction hashes, and the amounts the pool's own events publish.",
    `Denomination is measured on the ${((visible.length / notes.length) * 100).toFixed(1)}% of notes whose amount is publicly derivable, not on the whole pool.`,
    "Every figure is an upper bound on privacy. A real adversary knows more.",
  ],
};

await writeFile(OUT, JSON.stringify(measurement, null, 2));

const pad = (s, n) => String(s).padEnd(n);
console.log(`RUIDO · real pool measurement   ${corpus.network}`);
console.log(`pool        ${corpus.pool.slice(0, 20)}…`);
console.log(`corpus      ${corpus.fetchedAt}  complete=${corpus.complete}`);
console.log(`\npool`);
console.log(`  notes              ${measurement.pool.notes}`);
console.log(`  origin clusters    ${measurement.pool.clusters}`);
console.log(`  block range        ${firstBlock} → ${lastBlock}  (span ${span.toLocaleString()})`);
console.log(`  notes / 1k blocks  ${measurement.pool.notesPerThousandBlocks}`);
console.log(`  median cluster     ${measurement.pool.medianClusterSize}`);
console.log(`  human-scale notes  ${human.length}   bot-scale ${bot.length}`);

console.log(`\n${"=".repeat(66)}`);
console.log(`  CLAIMED     ${measurement.headline.claimedSet.toLocaleString()} notes`
  + `   =  ${measurement.headline.claimedBits} bits`);
console.log(`  MEASURED    ${baseline.candidates} origins  =  ${baseline.bits} bits`
  + `   (adversary knows the block, ±10)`);
console.log(`  ${(baseline.fractionAlone * 100).toFixed(1)}% of notes have no other origin in their window.`);
console.log(`${"=".repeat(66)}`);

console.log(`\nwhole pool  (mean over ${targets.length} real notes; bot traffic included)`);
console.log(`  ${pad("model", 24)}${pad("candidates", 12)}${pad("median", 9)}${pad("bits", 9)}alone`);
for (const m of models) {
  console.log(
    `  ${pad(m.model, 24)}${pad(m.candidates, 12)}${pad(m.median ?? "", 9)}${pad(m.bits, 9)}${m.fractionAlone ?? ""}`,
  );
}

console.log(`\nhuman-scale only  (≤ ${HUMAN_MAX} notes/tx, ${humanTargets.length} samples)`);
console.log(`  ${pad("model", 24)}${pad("candidates", 12)}${pad("median", 9)}${pad("bits", 9)}alone`);
for (const m of humanModels) {
  console.log(
    `  ${pad(m.model, 24)}${pad(m.candidates, 12)}${pad(m.median ?? "", 9)}${pad(m.bits, 9)}${m.fractionAlone}`,
  );
}

console.log(`\ndenomination  (${visible.length} of ${notes.length} notes have a public amount`
  + ` — ${((visible.length / notes.length) * 100).toFixed(1)}%)`);
console.log(`  by route      explicit ${routeCounts.explicit}   transaction ${routeCounts.transaction}`
  + `   unknown ${routeCounts.unknown}`);
console.log(`  denominations ${bucketSize.size} distinct (token, amount) pairs`);
console.log(`  ${pad("model", 24)}${pad("candidates", 12)}${pad("median", 9)}${pad("bits", 9)}alone`);
for (const m of denominationModelsAll) {
  console.log(
    `  ${pad(m.model, 24)}${pad(m.candidates, 12)}${pad(m.median ?? "", 9)}${pad(m.bits, 9)}${m.fractionAlone ?? ""}`,
  );
}
if (denominationModelsHuman.length) {
  console.log(`\n  amount-visible, human-scale only  (${visibleHuman.length} notes)`);
  console.log(`  ${pad("model", 24)}${pad("candidates", 12)}${pad("median", 9)}${pad("bits", 9)}alone`);
  for (const m of denominationModelsHuman) {
    console.log(
      `  ${pad(m.model, 24)}${pad(m.candidates, 12)}${pad(m.median ?? "", 9)}${pad(m.bits, 9)}${m.fractionAlone ?? ""}`,
    );
  }
}
console.log("\n  the amounts themselves, by note count");
for (const row of denomination.amountHistogram) {
  const eth = Number(row.amount) / 1e18;
  const shown = eth >= 1e-9 ? `${eth} ETH` : `${row.amount} wei`;
  console.log(`    ${pad(shown, 22)}${pad(row.notes, 8)}notes   ${String(row.token).slice(0, 12)}…`);
}

console.log(`\nwritten to ${OUT}`);

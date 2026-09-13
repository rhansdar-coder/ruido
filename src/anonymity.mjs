// Effective anonymity set: the number nobody in this space publishes.
//
// Nominal set size is the count of notes in the pool. Effective size is what is
// left after an adversary applies the auxiliary data they actually hold. Both
// Erebus and Stellar Private Payments state the distinction; neither measures
// it. That gap is the whole reason Ruido exists.

import { randomInt } from "./rng.mjs";

export const MODELS = ["naive", "timing", "amount", "timing+amount", "linkage", "all"];

/**
 * A synthetic pool. Notes carry only what an adversary can plausibly observe:
 * the block they appeared in and the denomination of the public funding leg.
 */
export function buildPool({ size, blocks, denominations, next, linkableFraction = 0.2 }) {
  const notes = [];
  for (let i = 0; i < size; i += 1) {
    notes.push({
      id: i,
      block: randomInt(next, 0, blocks),
      denomination: denominations[randomInt(next, 0, denominations.length)],
      // A public ERC-20 deposit that the adversary can attribute back to a
      // known account. This is the leak that quietly halves every real set.
      linkable: next() < linkableFraction,
      decoy: false,
    });
  }
  return notes;
}

/** Adds decoy notes to a pool in place and returns the extended pool. */
export function addCover(notes, count, { blocks, denominations, next }) {
  const extended = notes.slice();
  for (let i = 0; i < count; i += 1) {
    extended.push({
      id: notes.length + i,
      block: randomInt(next, 0, blocks),
      denomination: denominations[randomInt(next, 0, denominations.length)],
      linkable: false,
      decoy: true,
    });
  }
  return extended;
}

/**
 * Decoys concentrated in the one cell the adversary will actually look in:
 * the target's timing window and its denomination.
 *
 * Uniform cover spreads decoys across every block and every denomination, so
 * only a fraction land in the cell that matters and the rest are spent on
 * anonymity the target cannot use. This function is the alternative, and the
 * measurement CLI exists largely to show how far apart the two are.
 */
export function addTargetedCover(notes, count, { target, timingWindow = 10, next }) {
  const extended = notes.slice();
  for (let i = 0; i < count; i += 1) {
    extended.push({
      id: notes.length + i,
      block: target.block + randomInt(next, -timingWindow, timingWindow + 1),
      denomination: target.denomination,
      linkable: false,
      decoy: true,
    });
  }
  return extended;
}

/**
 * Decoys placed in the target's timing window, at a denomination drawn
 * uniformly from the ladder.
 *
 * ## Why this is the middle position, and why the middle is the interesting one
 *
 * The provider has to know *when* to emit. Cover that lands after the spend
 * protects nobody, so timing is not a secret the buyer can keep — it is a
 * precondition of the service. That leaves exactly one axis the buyer can
 * withhold: *how much*. This function is what withholding it costs.
 *
 * That also collapses what looks like a 2×2 into a line. The four corners would
 * be aimed (window+amount), window-only, amount-only and blind — but
 * amount-only is not a position anyone can occupy, because a provider who knows
 * the amount and not the window has no way to deliver the cover in time. There
 * are three real positions, not four: aimed, window-only, and blind.
 *
 * ## The cost equivalence worth knowing
 *
 * Emitting all seven rungs in each window slot costs the same as emitting one
 * note per slot at a uniformly drawn rung, and puts the same number of notes in
 * the cell that matters. The two differ only in detectability: seven notes per
 * window, one per rung, is a perfectly regular pattern an observer can subtract,
 * while a uniform draw is not. M1 is the metric that should catch that, and M1
 * does not yet model placement regularity — it only looks at salt shape. Noted
 * rather than fixed, because it changes what a buyer gets for the money.
 */
export function addWindowCover(notes, count, { target, timingWindow = 10, denominations, next }) {
  const extended = notes.slice();
  for (let i = 0; i < count; i += 1) {
    extended.push({
      id: notes.length + i,
      block: target.block + randomInt(next, -timingWindow, timingWindow + 1),
      denomination: denominations[randomInt(next, 0, denominations.length)],
      linkable: false,
      decoy: true,
    });
  }
  return extended;
}

/**
 * Candidates consistent with what this adversary model can see.
 *
 * `target` is the note whose owner we are protecting. The adversary knows the
 * target's own attributes — that is the premise — and eliminates every note
 * that cannot be it.
 */
export function candidateSet(notes, target, { model = "naive", timingWindow = 10, removeLinkable = false } = {}) {
  return notes.filter((note) => {
    if (removeLinkable && note.linkable && note.id !== target.id) return false;
    if (model === "naive") return true;
    if (model === "timing") return Math.abs(note.block - target.block) <= timingWindow;
    if (model === "amount") return note.denomination === target.denomination;
    if (model === "timing+amount") {
      return Math.abs(note.block - target.block) <= timingWindow
        && note.denomination === target.denomination;
    }
    if (model === "linkage") return !(note.linkable && note.id !== target.id);
    if (model === "all") {
      return Math.abs(note.block - target.block) <= timingWindow
        && note.denomination === target.denomination
        && !(note.linkable && note.id !== target.id);
    }
    throw new Error(`unknown adversary model: ${model}`);
  });
}

/** Anonymity in bits. 1 candidate = 0 bits = no hiding at all. */
export function anonymityBits(count) {
  return count > 0 ? Math.log2(count) : 0;
}

/**
 * Effective set for a target, under one model.
 * Reports the count and its log2, because "1,000 notes" sounds safe and
 * "10 bits" is the number that actually tells you how safe.
 */
export function measure(notes, target, options = {}) {
  const candidates = candidateSet(notes, target, options);
  return {
    model: options.model ?? "naive",
    candidates: candidates.length,
    bits: Number(anonymityBits(candidates.length).toFixed(3)),
  };
}

/** Every model at once, which is what a report should show. */
export function report(notes, target, options = {}) {
  return MODELS.map((model) => measure(notes, target, { ...options, model }));
}

/**
 * Mean candidate count over many targets.
 *
 * A single target is not a measurement. Under a tight timing window the count
 * is 1 or 2 and swings non-monotonically as cover is added, which would make a
 * scaling curve say that more cover sometimes buys less privacy. Averaging over
 * `targets.length` notes is what turns it into a curve that can be read.
 */
export function summarise(notes, targets, options = {}) {
  return MODELS.map((model) => {
    let total = 0;
    for (const target of targets) {
      total += candidateSet(notes, target, { ...options, model }).length;
    }
    const mean = total / targets.length;
    return {
      model,
      candidates: Number(mean.toFixed(2)),
      bits: Number(anonymityBits(mean).toFixed(3)),
    };
  });
}

// The two metrics, defined the way the Erebus threat model defines them so the
// numbers are comparable rather than merely ours.

import { hasV2FifthSaltShape } from "./salt.mjs";

/**
 * M1 — traffic classification. Can an observer tell our records from ordinary
 * pool traffic without any key?
 *
 * Balanced accuracy, not AUC: the classifier is a deterministic predicate with
 * one operating point, so an "AUC" would be that point under another name.
 * 0.5 means the observer is guessing.
 */
export function binaryScore({ truePositive, falsePositive, trueNegative, falseNegative }) {
  const called = truePositive + falsePositive;
  const actual = truePositive + falseNegative;
  const negatives = trueNegative + falsePositive;
  const precision = called ? truePositive / called : 0;
  const recall = actual ? truePositive / actual : 0;
  const trueNegativeRate = negatives ? trueNegative / negatives : 0;
  return {
    precision,
    recall,
    trueNegativeRate,
    balancedAccuracy: (recall + trueNegativeRate) / 2,
    truePositive,
    falsePositive,
    trueNegative,
    falseNegative,
  };
}

/**
 * Runs the historical fifth-salt classifier over a labelled corpus.
 *
 * `positives` and `negatives` are arrays of salt arrays (one per transaction).
 * A transaction is called "ours" when any of its salts trips the predicate.
 */
export function m1({ positives, negatives }) {
  let tp = 0;
  let fn = 0;
  let fp = 0;
  let tn = 0;
  for (const salts of positives) (salts.some(hasV2FifthSaltShape) ? (tp += 1) : (fn += 1));
  for (const salts of negatives) (salts.some(hasV2FifthSaltShape) ? (fp += 1) : (tn += 1));
  return binaryScore({ truePositive: tp, falsePositive: fp, trueNegative: tn, falseNegative: fn });
}

/** Balanced accuracy to 4 places, which is how the upstream report shows it. */
export function formatScore(score) {
  return {
    precision: score.precision.toFixed(4),
    recall: score.recall.toFixed(4),
    balancedAccuracy: score.balancedAccuracy.toFixed(4),
    counts: `tp=${score.truePositive} fp=${score.falsePositive} tn=${score.trueNegative} fn=${score.falseNegative}`,
  };
}

/**
 * M3 — how accurately can an observer count deals per account?
 *
 * The honest framing: cover traffic does not hide *whether* you transacted. It
 * makes the *count* unknowable, because the observer cannot tell which actions
 * were real. So we report three things, not one:
 *
 *   maeNaive     error if the observer assumes every action is a real deal
 *   maeBest      error of the best possible estimator, knowing the mixture
 *   uncertainty  standard deviation of the true count given what was observed
 *
 * An implementation that reported only maeNaive would make cover traffic look
 * strictly bad. One that reported only uncertainty would make it look better
 * than it is.
 */
export function m3({ perAccount }) {
  // perAccount: [{ deals, cover }]
  let naiveErr = 0;
  let bestErr = 0;
  let uncertainty = 0;

  const totalDeals = perAccount.reduce((s, a) => s + a.deals, 0);
  const totalCover = perAccount.reduce((s, a) => s + a.cover, 0);
  const totalActions = totalDeals + totalCover;
  const p = totalActions ? totalDeals / totalActions : 0; // P(an observed action is real)

  for (const account of perAccount) {
    const observed = account.deals + account.cover;
    naiveErr += Math.abs(observed - account.deals); // assumes all real
    bestErr += Math.abs(observed * p - account.deals);
    uncertainty += Math.sqrt(observed * p * (1 - p));
  }

  const n = perAccount.length || 1;
  return {
    accounts: perAccount.length,
    mixture: Number(p.toFixed(4)),
    maeNaive: Number((naiveErr / n).toFixed(4)),
    maeBest: Number((bestErr / n).toFixed(4)),
    uncertainty: Number((uncertainty / n).toFixed(4)),
  };
}

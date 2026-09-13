// Pure measurement logic for EVM chains. No I/O, no RPC, no files.
//
// This module exists because the interesting parts of an EVM measurement are
// also the parts that are easy to get quietly wrong, and logic that lives
// inside a script that calls main() on import cannot be tested. Everything here
// is a pure function of its arguments, so tests/robinhood.test.mjs can hold it
// to account.
//
// It also carries the one correction that matters most for this project:
//
//   WINDOWS ARE IN SECONDS, NOT BLOCKS.
//
// Starknet produces a block every ~1.702 s. Robinhood Chain produces one every
// ~0.102 s. A report that says "the adversary knows the block to within 10" is
// describing 17 seconds on one chain and 1 second on the other. Publishing both
// in the same table without conversion is not a comparison, it is a coincidence
// of arithmetic. Use secondsToBlocks/blocksToSeconds at every boundary.

/**
 * Addresses that are infrastructure rather than people now live in
 * src/chains.mjs, because which addresses those are is a property of the chain
 * and this module is deliberately chain-agnostic. Import from there.
 */

/** Blocks -> seconds. The conversion that makes two chains comparable. */
export const blocksToSeconds = (blocks, blockTimeSeconds) => blocks * blockTimeSeconds;

/** Seconds -> blocks. Rounded, because a fraction of a block is not a block. */
export const secondsToBlocks = (seconds, blockTimeSeconds) =>
  Math.round(seconds / blockTimeSeconds);

/**
 * Sort a transaction list into a timeline and precompute the timestamp column.
 *
 * times[i] is always txs[i].ts. Callers pass both to the window functions
 * rather than each one rebuilding the column, because the same timeline is
 * queried once per window size.
 */
export function buildTimeline(txs) {
  const sorted = [...txs].sort((a, b) => a.ts - b.ts);
  return { txs: sorted, times: sorted.map((t) => t.ts) };
}

/** Index of the first element >= value, in a sorted array. */
export function lowerBoundIndex(sorted, value) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * For each target, the number of distinct senders active within ±windowSeconds.
 *
 * The target's own sender is included, so a result of 1 means "alone" — the
 * same convention the STRK20 measurement used for origins, which is what makes
 * the two comparable at the same wall-clock window.
 */
export function timingCounts(txs, times, targets, windowSeconds) {
  return targets.map((target) => {
    const senders = new Set();
    for (let i = lowerBoundIndex(times, target.ts - windowSeconds); i < txs.length; i += 1) {
      if (txs[i].ts > target.ts + windowSeconds) break;
      senders.add(txs[i].from);
    }
    return senders.size;
  });
}

/**
 * Address reuse.
 *
 * On a chain with persistent addresses the second transaction from an address
 * is not a new suspect; it is a confirmation of a link the adversary already
 * held. This quantifies how often that happens.
 */
export function reuseStats(senderCounts, totalTxs) {
  const counts = [...senderCounts.values()];
  const singleUse = counts.filter((c) => c === 1).length;
  const sorted = [...counts].sort((a, b) => b - a);

  let cumulative = 0;
  let sendersForHalf = 0;
  for (const c of sorted) {
    cumulative += c;
    sendersForHalf += 1;
    if (cumulative >= totalTxs / 2) break;
  }

  return {
    distinctSenders: counts.length,
    transactions: totalTxs,
    transactionsPerSender: counts.length ? Number((totalTxs / counts.length).toFixed(3)) : 0,
    singleUseSenders: singleUse,
    singleUseFraction: counts.length ? Number((singleUse / counts.length).toFixed(4)) : 0,
    sendersForHalfOfActivity: sendersForHalf,
    sendersForHalfOfActivityFraction: counts.length
      ? Number((sendersForHalf / counts.length).toFixed(4))
      : 0,
  };
}

/**
 * How few destinations absorb how much of the traffic.
 *
 * If a handful of contracts take most of the transactions, then "what is this
 * address doing" is largely answered by which contract it calls.
 */
export function concentrationStats(targetCounts) {
  const counts = [...targetCounts.values()].sort((a, b) => b - a);
  const total = counts.reduce((a, b) => a + b, 0);
  const shareTop = (n) =>
    total ? Number((counts.slice(0, n).reduce((a, b) => a + b, 0) / total).toFixed(4)) : 0;

  let cumulative = 0;
  let targetsFor80 = 0;
  for (const c of counts) {
    cumulative += c;
    targetsFor80 += 1;
    if (cumulative >= total * 0.8) break;
  }

  return {
    distinctTargets: counts.length,
    shareTop1: shareTop(1),
    shareTop10: shareTop(10),
    shareTop100: shareTop(100),
    targetsFor80Percent: targetsFor80,
  };
}

/**
 * The behavioural test for a shielded pool.
 *
 * A Tornado-style pool is not identifiable by its label — labels come from an
 * explorer, and an explorer is a third party with its own incentives. It is
 * identifiable by its behaviour: a handful of fixed denominations, each
 * deposited and withdrawn many times, producing a value distribution that is a
 * few tall spikes rather than a long tail.
 *
 * Ordinary transfers are the opposite: mostly unique values, a long tail, no
 * dominant denomination. So the test is the shape of the distribution.
 *
 * @param {Map<string, number>} valueCounts  value (wei string) -> occurrences
 * @param {number} totalValueTransfers
 */
export function poolSignature(valueCounts, totalValueTransfers) {
  const entries = [...valueCounts].sort((a, b) => b[1] - a[1]);
  const unique = entries.filter(([, c]) => c === 1).length;
  const top5 = entries.slice(0, 5).reduce((a, [, c]) => a + c, 0);

  const top5Share = totalValueTransfers ? top5 / totalValueTransfers : 0;

  // The second signal has to be the size of the VALUE SPACE relative to the
  // number of transfers, not the share of singletons among distinct values.
  //
  // An earlier draft used "singletons are a minority of distinct values". That
  // test can never fire on a real mixer: a mixer has a handful of denominations
  // plus a scattering of odd amounts, so singletons dominate the distinct-value
  // count and the detector would answer "no pool" forever. A detector that
  // always says no is not a detector.
  //
  // A mixer reuses the same amounts constantly, so the number of distinct
  // values stays tiny next to the number of transfers. Ordinary traffic does
  // the opposite. That is the discriminating quantity.
  const valueSpaceRatio = totalValueTransfers ? entries.length / totalValueTransfers : 1;

  // Thresholds, stated so they can be argued with rather than buried.
  const present = top5Share > 0.6 && valueSpaceRatio < 0.1;

  return {
    valueTransfers: totalValueTransfers,
    distinctValues: entries.length,
    valuesAppearingOnce: unique,
    valuesAppearingOnceFraction: Number((entries.length ? unique / entries.length : 0).toFixed(4)),
    top5ShareOfTransfers: Number(top5Share.toFixed(4)),
    valueSpaceRatio: Number(valueSpaceRatio.toFixed(4)),
    thresholds: { top5ShareAbove: 0.6, valueSpaceRatioBelow: 0.1 },
    topValues: entries.slice(0, 10).map(([wei, count]) => ({ wei, count })),
    shieldedPoolSignaturePresent: present,
    verdict: present
      ? "Value distribution is concentrated into a few fixed denominations, "
        + "reused many times over. This is the signature of a mixer and "
        + "warrants a closer look."
      : "Value distribution is long-tailed with a large value space relative to "
        + "the number of transfers. This is the signature of ordinary transfers, "
        + "not of a mixer. No shielded pool was observed in this window.",
  };
}

/**
 * Is this a transfer of value, rather than a call or a creation?
 *
 * The corpus encodes a zero-value transaction as `null`, but `"0"` is a
 * perfectly ordinary way for a JSON producer to encode it too — and in
 * JavaScript `"0"` is truthy, so a bare `if (value)` guard silently counts
 * every zero-value call as a value transfer and inflates the denominator of
 * every ratio built on it. One predicate, used everywhere, so that cannot
 * depend on which encoding the corpus happened to use.
 */
export const isValueTransfer = (value) =>
  value !== null && value !== undefined && value !== "" && String(value) !== "0";

/**
 * The same behavioural test, applied per CONTRACT instead of per chain.
 *
 * This exists because the chain-wide version was measured and found to be
 * diluted into uselessness. On Ethereum a 10-hour window carries ~340,000
 * value transfers; a working mixer with a hundred deposits is 0.03% of that,
 * so a chain-wide distribution can never be concentrated enough to fire. The
 * first version of this test returned "no shielded pool" on Ethereum while
 * Tornado Cash was deployed on it, and the honest reading of that result is
 * not "Tornado Cash is gone" — it is "the test was asking the wrong question".
 *
 * A mixer is a contract, not a chain. So ask per contract: for each target
 * that received at least `minTransfers` value transfers, does THAT contract's
 * own value distribution look like a mixer?
 *
 * ---
 *
 * And then a second correction, because the per-contract version was measured
 * too and it OVER-reports. On Robinhood Chain it fired on 11 contracts, and
 * investigating them showed what they actually are: fixed-amount payment
 * patterns. A contract that takes 0.005 ETH from hundreds of buyers at a fixed
 * price, or a single bot sending the same amount 94 times, produces exactly
 * the same value shape as a mixer deposit pool. The shape alone cannot tell
 * them apart.
 *
 * So three more conditions are applied. The first two are definitional, which
 * is why they can be stated as requirements rather than as parameters. The
 * third is calibrated on fixed-denomination designs and is flagged as such:
 *
 *   independentDepositors  A pool's anonymity set IS its set of depositors.
 *                          A contract with one depositor offers an anonymity
 *                          set of one, whatever its value shape looks like.
 *                          A single actor repeating an amount is not a pool.
 *
 *   twoSidedFlow           A pool takes deposits AND lets them out. Value that
 *                          only ever flows in and never leaves is a vault, a
 *                          fee collector or a sale, not a pool.
 *
 *   outflowPoolShaped      And the outflow has to be pool-shaped too. A pool
 *                          returns the denominations it took; a fee collector
 *                          takes a fixed micro-amount and sweeps the whole
 *                          balance to a treasury in one irregular lump. Both
 *                          have a tiny deposit value space, so the deposit
 *                          shape cannot separate them — but the OUTFLOW shape
 *                          can, and applying the same test to the outflow side
 *                          is the whole discriminator.
 *
 * That last one was not designed, it was measured. The per-contract scan was
 * run on Robinhood Chain and returned exactly one viable candidate; looking at
 * its withdrawals settled it: 120 deposits of exactly 0.0005 ETH from 72
 * addresses, and 10 withdrawals of which 7 went to the same address in
 * irregular lumps of 0.77 to 18.6 ETH. That is a fee accumulator sweeping to
 * its treasury, not a mixer. A test that called it a shielded pool would have
 * published a fabricated finding.
 *
 * Nothing is hidden by these: `shapeMatches` reports every contract the shape
 * test fired on, and `viablePoolCandidates` is the subset that also survives
 * the definitional conditions. The gap between the two counts is the finding.
 *
 * @param {Array<{from:number,to:number,value:string}>} txs
 * @param {object} [options]
 * @param {number} [options.minTransfers=50]  below this a "spike" is just noise
 * @param {(target:number)=>string} [options.label]  index -> display string
 */
export function contractMixerScan(txs, options = {}) {
  const minTransfers = options.minTransfers ?? 50;
  const label = options.label ?? ((target) => String(target));

  const inbound = new Map();       // target -> Map(value -> occurrences)
  const depositors = new Map();    // target -> Set(sender)
  const outflowCounts = new Map(); // address -> Map(value -> occurrences)
  let considered = 0;

  for (const tx of txs) {
    if (tx.to < 0 || !isValueTransfer(tx.value)) continue;
    considered += 1;

    let counts = inbound.get(tx.to);
    if (!counts) {
      counts = new Map();
      inbound.set(tx.to, counts);
    }
    counts.set(tx.value, (counts.get(tx.value) ?? 0) + 1);

    let who = depositors.get(tx.to);
    if (!who) {
      who = new Set();
      depositors.set(tx.to, who);
    }
    who.add(tx.from);

    let out = outflowCounts.get(tx.from);
    if (!out) {
      out = new Map();
      outflowCounts.set(tx.from, out);
    }
    out.set(tx.value, (out.get(tx.value) ?? 0) + 1);
  }

  const total = (counts) => [...counts.values()].reduce((a, b) => a + b, 0);

  const rows = [];
  for (const [target, counts] of inbound) {
    const transfers = total(counts);
    if (transfers < minTransfers) continue;

    const signature = poolSignature(counts, transfers);
    const distinctDepositors = depositors.get(target)?.size ?? 0;

    const outCounts = outflowCounts.get(target);
    const outboundTransfers = outCounts ? total(outCounts) : 0;
    const outflow = outCounts ? poolSignature(outCounts, outboundTransfers) : null;

    const singleActor = distinctDepositors <= 1;
    const oneSided = outboundTransfers === 0;
    const outflowPoolShaped = Boolean(outflow?.shieldedPoolSignaturePresent);

    rows.push({
      target: label(target),
      transfers,
      distinctValues: signature.distinctValues,
      top5ShareOfTransfers: signature.top5ShareOfTransfers,
      valueSpaceRatio: signature.valueSpaceRatio,
      shapeMatches: signature.shieldedPoolSignaturePresent,
      // The anonymity set this contract would offer if it were a pool.
      distinctDepositors,
      singleActor,
      outboundTransfers,
      oneSided,
      outflowPoolShaped,
      outflowDistinctValues: outflow?.distinctValues ?? 0,
      outflowValueSpaceRatio: outflow?.valueSpaceRatio ?? null,
      // Every condition a pool cannot fail, in one place.
      viablePoolCandidate: signature.shieldedPoolSignaturePresent
        && !singleActor && !oneSided && outflowPoolShaped,
    });
  }

  // How close did anything come? Reported so a negative result carries
  // information instead of being an unfalsifiable "nothing found". A score of
  // top5Share / valueSpaceRatio is large exactly when a contract concentrates
  // its traffic into few values, which is the mixer shape.
  const score = (r) => r.top5ShareOfTransfers / Math.max(r.valueSpaceRatio, 1e-6);
  const scored = rows.map((r) => ({ ...r, mixerScore: Number(score(r).toFixed(3)) }));

  const shapeMatches = scored
    .filter((r) => r.shapeMatches)
    .sort((a, b) => b.transfers - a.transfers);
  const viable = shapeMatches.filter((r) => r.viablePoolCandidate);
  const rejected = shapeMatches.filter((r) => !r.viablePoolCandidate);

  const closest = [...scored].sort((a, b) => b.mixerScore - a.mixerScore).slice(0, 5);

  const why = (r) => {
    if (r.singleActor) return `${r.target} (one depositor — anonymity set of 1)`;
    if (r.oneSided) return `${r.target} (no outflow — value only goes in)`;
    return `${r.target} (outflows not pool-shaped — takes a fixed denomination, `
      + `pays out ${r.outflowDistinctValues} different amounts)`;
  };

  return {
    minTransfers,
    contractsWithValueTransfers: inbound.size,
    contractsScanned: rows.length,
    valueTransfersConsidered: considered,
    shapeMatches,
    viablePoolCandidates: viable,
    rejectedByDefinition: rejected,
    closest,
    thresholds: { top5ShareAbove: 0.6, valueSpaceRatioBelow: 0.1 },
    conditions: [
      "value shape: few fixed denominations, reused many times",
      "more than one depositor",
      "value flows both in and out",
      "the outflow is pool-shaped too — it returns what it took",
    ],
    verdict: viable.length
      ? `${viable.length} contract(s) match the mixer value shape AND have more `
        + "than one depositor AND value flowing both ways AND a pool-shaped "
        + "outflow. Each needs its own measurement: the chain-wide 0-bit result "
        + "does not describe them."
      : shapeMatches.length
        ? `The value shape fired on ${shapeMatches.length} contract(s), and every `
          + `one of them fails a condition a pool cannot fail: ${rejected.map(why).join("; ")}. `
          + "A single actor repeating an amount, a contract that only ever takes "
          + "value in, or a fee collector sweeping irregular totals to a treasury "
          + "all produce the mixer value shape without being a mixer. No viable "
          + "pool candidate in this window."
        : `No contract in this window concentrates its value transfers into a few `
          + `fixed denominations. Scanned ${rows.length} contracts that received at `
          + `least ${minTransfers} value transfers. The closest miss is reported so `
          + "the negative result can be checked rather than trusted.",
  };
}

/**
 * Sample targets spread across the whole timeline.
 *
 * Taking the first N would measure the busiest burst; taking every k-th
 * measures the window. Same reasoning as the STRK20 sampler.
 */
export function sampleTargets(txs, samples) {
  const step = Math.max(1, Math.floor(txs.length / samples));
  const targets = [];
  for (let i = 0; i < txs.length && targets.length < samples; i += step) targets.push(txs[i]);
  return targets;
}

/** The nominal-versus-effective argument, stated as checkable clauses. */
export function identifiabilityClauses() {
  return [
    {
      claim: "The sender of every transaction is public.",
      consequence: "The adversary reads the answer instead of guessing it. Candidate set of size 1, by construction.",
      falsifiableBy: "Finding a transaction on this chain whose sender is not in the public block data.",
    },
    {
      claim: "Addresses persist across transactions.",
      consequence: "One link deanonymises the entire history of that address.",
      falsifiableBy: "Observing addresses used once and never again, at scale.",
    },
    {
      claim: "ERC-4337 carries a negligible share of transactions, so the fee payer is the user.",
      consequence: "With no paymaster in the path there is no separating layer between the identity and the transaction.",
      falsifiableBy: "A window in which EntryPoint traffic carries a meaningful share of transactions.",
    },
    {
      claim: "A single operator sequences the chain first-come, first-served.",
      consequence: "The operator sees arrival order and, for accounts it serves, the identity behind them. Not observable from public data, so it is excluded from every number — which makes every number an upper bound.",
      falsifiableBy: "A decentralised sequencer set.",
    },
  ];
}

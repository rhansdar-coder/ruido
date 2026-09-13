import test from "node:test";
import assert from "node:assert/strict";

import { mulberry32 } from "../src/rng.mjs";
import {
  FLAG_BIT,
  SALT_LIMIT,
  MIN_SALT,
  hasV2FifthSaltShape,
  isValidSalt,
  legacyShapedSalt,
  noiseSalt,
  decoySalts,
  randomSalt,
  NOTES_PER_MESSAGE,
} from "../src/salt.mjs";
import { DENOMINATIONS, schedule, costEstimate } from "../src/cover.mjs";
import { buildPool, addCover, addWindowCover, addTargetedCover, candidateSet, summarise, anonymityBits } from "../src/anonymity.mjs";
import { m1, m3 } from "../src/metrics.mjs";

const next = () => mulberry32(1234);

// --- the classifier is a faithful port --------------------------------------
test("fifth-salt predicate matches observer.py exactly", () => {
  // observer.py: return salt >> 60 == 1 << 59
  const pinnedOnly = FLAG_BIT;
  assert.equal(hasV2FifthSaltShape(pinnedOnly), true);
  // any bit inside 60..118 set breaks the shape
  assert.equal(hasV2FifthSaltShape(FLAG_BIT | (1n << 60n)), false);
  assert.equal(hasV2FifthSaltShape(FLAG_BIT | (1n << 118n)), false);
  // bits below 60 are content and must not affect the verdict
  assert.equal(hasV2FifthSaltShape(FLAG_BIT | 12345n), true);
});

// --- decoys ------------------------------------------------------------------
test("decoy salts are valid and never carry the v2 fingerprint", () => {
  const n = next();
  for (let i = 0; i < 500; i += 1) {
    const salt = noiseSalt(n);
    assert.ok(isValidSalt(salt), "salt must be in [2, 2**120)");
    assert.equal(hasV2FifthSaltShape(salt), false);
  }
});

test("legacy salts do carry the fingerprint", () => {
  const n = next();
  for (let i = 0; i < 500; i += 1) {
    assert.equal(hasV2FifthSaltShape(legacyShapedSalt(n)), true);
  }
});

test("a decoy message emits one salt per note", () => {
  const salts = decoySalts(next());
  assert.equal(salts.length, NOTES_PER_MESSAGE);
  for (const salt of salts) assert.ok(salt < SALT_LIMIT && salt >= MIN_SALT);
});

// --- M1 ---------------------------------------------------------------------
test("M1: legacy fingerprint is perfectly separable, ruido is not", () => {
  const n = next();
  const negatives = Array.from({ length: 2000 }, () =>
    Array.from({ length: NOTES_PER_MESSAGE }, () => randomSalt(n)),
  );
  const legacy = m1({
    positives: Array.from({ length: 100 }, () =>
      Array.from({ length: NOTES_PER_MESSAGE }, () => legacyShapedSalt(n)),
    ),
    negatives,
  });
  const ruido = m1({
    positives: Array.from({ length: 100 }, () => decoySalts(n)),
    negatives,
  });

  assert.equal(legacy.balancedAccuracy, 1);
  assert.equal(ruido.balancedAccuracy, 0.5);
});

// --- M3 ---------------------------------------------------------------------
test("M3: without cover traffic the observer counts deals exactly", () => {
  const result = m3({ perAccount: [{ deals: 3, cover: 0 }, { deals: 7, cover: 0 }] });
  assert.equal(result.maeNaive, 0);
  assert.equal(result.maeBest, 0);
  assert.equal(result.uncertainty, 0);
});

test("M3: cover traffic makes the count unknowable, not hidden", () => {
  const result = m3({ perAccount: [{ deals: 3, cover: 10 }, { deals: 7, cover: 10 }] });
  assert.ok(result.maeNaive > 0, "a naive observer now overcounts");
  assert.ok(result.uncertainty > 0, "the true count is no longer determined");
});

// --- anonymity --------------------------------------------------------------
test("naive model counts the whole pool", () => {
  const n = next();
  const pool = buildPool({ size: 500, blocks: 1000, denominations: DENOMINATIONS, next: n });
  assert.equal(candidateSet(pool, pool[0], { model: "naive" }).length, 500);
});

test("a stronger adversary never sees a larger set", () => {
  // The models are NOT a single chain: timing and amount are two independent
  // axes, so neither contains the other. They only meet at timing+amount. An
  // earlier version of this test asserted one flat chain and failed, which is
  // the useful thing a test can do.
  const n = next();
  const pool = buildPool({ size: 800, blocks: 2000, denominations: DENOMINATIONS, next: n });
  const target = pool[0];
  const count = (model) => candidateSet(pool, target, { model, timingWindow: 10 }).length;

  for (const chain of [
    ["naive", "timing", "timing+amount", "all"],
    ["naive", "amount", "timing+amount", "all"],
    ["naive", "linkage", "all"],
  ]) {
    const counts = chain.map(count);
    for (let i = 1; i < counts.length; i += 1) {
      assert.ok(
        counts[i] <= counts[i - 1],
        `${chain[i]} (${counts[i]}) must not exceed ${chain[i - 1]} (${counts[i - 1]})`,
      );
    }
  }
});

test("anonymityBits: one candidate means no hiding", () => {
  assert.equal(anonymityBits(1), 0);
  assert.equal(anonymityBits(1024), 10);
});

test("targeted cover beats uniform cover at equal cost", () => {
  const n = next();
  const pool = buildPool({ size: 2000, blocks: 5000, denominations: DENOMINATIONS, next: n });
  const targets = Array.from({ length: 100 }, () => pool[Math.floor(n() * pool.length)]);
  const base = summarise(pool, targets, { timingWindow: 10 }).at(-1).bits;

  const uniform = summarise(
    addCover(pool, 100, { blocks: 5000, denominations: DENOMINATIONS, next: n }),
    targets,
    { timingWindow: 10 },
  ).at(-1).bits;

  const target = targets[0];
  const targetedBase = candidateSet(pool, target, { model: "all", timingWindow: 10 }).length;
  const targeted = candidateSet(
    addTargetedCover(pool, 100, { target, timingWindow: 10, next: n }),
    target,
    { model: "all", timingWindow: 10 },
  ).length;

  assert.ok(uniform >= base, "uniform cover helps a little");
  assert.ok(anonymityBits(targeted) > anonymityBits(targetedBase) + 3,
    "targeted cover buys several bits for the buyer");
});

test("window cover lands in the target's window and nowhere else", () => {
  const n = next();
  const pool = buildPool({ size: 500, blocks: 1000, denominations: DENOMINATIONS, next: n });
  const target = pool[0];
  const extended = addWindowCover(pool, 200, {
    target,
    timingWindow: 10,
    denominations: DENOMINATIONS,
    next: n,
  });

  const added = extended.slice(pool.length);
  assert.equal(added.length, 200);
  for (const note of added) {
    // The window is the part the provider is told, so every decoy has to land
    // in it. One that drifts outside is cover the buyer paid for and cannot use.
    assert.ok(
      Math.abs(note.block - target.block) <= 10,
      `decoy at block ${note.block} is outside the window around ${target.block}`,
    );
    assert.ok(DENOMINATIONS.includes(note.denomination), "denomination must come off the ladder");
    assert.equal(note.linkable, false, "a decoy is not a public deposit and must not be linkable");
    assert.equal(note.decoy, true);
  }
});

test("window cover puts one decoy in seven on the target's rung", () => {
  // The whole reason withholding the denomination is not free. Averaged over
  // many draws, because one draw of a 1-in-7 process is not a measurement: 500
  // decoys land anywhere from 54 to 87 on the rung depending on the seed, which
  // is enough to move the quoted price by 40%. That variance is what made an
  // earlier version of the placement table report 5.10x where the answer is 3.50x.
  const expected = 1 / DENOMINATIONS.length;
  let onRung = 0;
  let total = 0;
  for (let trial = 0; trial < 40; trial += 1) {
    const n = mulberry32(4000 + trial);
    const pool = buildPool({ size: 200, blocks: 500, denominations: DENOMINATIONS, next: n });
    const target = pool[0];
    const extended = addWindowCover(pool, 350, {
      target,
      timingWindow: 10,
      denominations: DENOMINATIONS,
      next: n,
    });
    for (const note of extended.slice(pool.length)) {
      total += 1;
      if (note.denomination === target.denomination) onRung += 1;
    }
  }
  const rate = onRung / total;
  const se = Math.sqrt((expected * (1 - expected)) / total);
  assert.ok(
    Math.abs(rate - expected) < 4 * se,
    `landed ${(rate * 100).toFixed(2)}% on the rung, expected ${(expected * 100).toFixed(2)}% +- ${(4 * se * 100).toFixed(2)}%`,
  );
});

test("knowing more buys cheaper bits: aimed beats window beats blind", () => {
  // The product claim, and the reason the placement table exists. Strictly
  // ordered, because if window-only ever stops costing more than aimed cover, or
  // blind cover stops being the worst of the three, then a design decision has
  // been made by accident and this is where it should surface.
  const n = next();
  const pool = buildPool({ size: 2000, blocks: 5000, denominations: DENOMINATIONS, next: n });
  const targets = pool.slice(0, 60);
  const MODEL = { model: "all", timingWindow: 10 };
  const DECOYS = 50;
  const seedFor = (i) => mulberry32(7919 * (i + 1));

  const meanCell = (notes) => {
    let total = 0;
    for (const t of targets) total += candidateSet(notes, t, MODEL).length;
    return total / targets.length;
  };
  const meanAimedCell = (place) => {
    let total = 0;
    targets.forEach((t, i) => {
      total += candidateSet(place(t, i), t, MODEL).length;
    });
    return total / targets.length;
  };

  const base = anonymityBits(meanCell(pool));
  const gain = (cell) => anonymityBits(cell) - base;

  const blind = gain(
    meanCell(addCover(pool, DECOYS, { blocks: 5000, denominations: DENOMINATIONS, next: n })),
  );
  const window = gain(
    meanAimedCell((t, i) =>
      addWindowCover(pool, DECOYS, {
        target: t,
        timingWindow: 10,
        denominations: DENOMINATIONS,
        next: seedFor(i),
      }),
    ),
  );
  const aimed = gain(
    meanAimedCell((t, i) =>
      addTargetedCover(pool, DECOYS, { target: t, timingWindow: 10, next: seedFor(i) }),
    ),
  );

  assert.ok(
    blind < window,
    `blind cover (${blind.toFixed(3)}b) must buy less than window cover (${window.toFixed(3)}b)`,
  );
  assert.ok(
    window < aimed,
    `window cover (${window.toFixed(3)}b) must buy less than aimed cover (${aimed.toFixed(3)}b)`,
  );
});

test("the price of a bit rises with volume, so there is no volume discount", () => {
  // The claim the whole pricing section rests on, and the one that stops
  // "9.5 STRK/bit" being quoted as if it were a price. If a future change makes
  // marginal bits cheaper, the product story changes and this goes red.
  const n = next();
  const pool = buildPool({ size: 2000, blocks: 5000, denominations: DENOMINATIONS, next: n });
  const targets = pool.slice(0, 60);
  const MODEL = { model: "all", timingWindow: 10 };
  const seedFor = (i) => mulberry32(7919 * (i + 1));

  const meanAimedCell = (decoys) => {
    let total = 0;
    targets.forEach((t, i) => {
      total += candidateSet(
        addTargetedCover(pool, decoys, { target: t, timingWindow: 10, next: seedFor(i) }),
        t,
        MODEL,
      ).length;
    });
    return total / targets.length;
  };

  const base = anonymityBits(meanAimedCell(0));
  const prices = [1, 5, 10, 50].map((decoys) => {
    const gained = anonymityBits(meanAimedCell(decoys)) - base;
    return (decoys * 2) / gained;
  });

  for (let i = 1; i < prices.length; i += 1) {
    assert.ok(
      prices[i] > prices[i - 1],
      `STRK/bit must rise with volume, got ${prices.map((p) => p.toFixed(1)).join(" < ")}`,
    );
  }
  // And the cheapest bit is the first one, not the tenth.
  assert.ok(
    prices[0] < 4.5,
    `the first bit should cost under 4.5 STRK, got ${prices[0].toFixed(2)}`,
  );
});

test("blind cover lands about one decoy in 1,700 in the cell that matters", () => {
  // The exact factor behind the blind column's price, and the number the README
  // and the FAQ quote. Analytic value is (2w+1)/blocks x 1/ladder = (21/5000)/7
  // = 1 in 1,667; measured it lands at 1 in 1,709. This is the quantity to trust
  // when the STRK/bit column is noise-bound.
  const n = mulberry32(31337);
  const pool = buildPool({ size: 2000, blocks: 5000, denominations: DENOMINATIONS, next: n });
  const target = pool[0];
  const DECOYS = 200000;

  const extended = addCover(pool, DECOYS, {
    blocks: 5000,
    denominations: DENOMINATIONS,
    next: mulberry32(99),
  });
  const onCell = extended
    .slice(pool.length)
    .filter(
      (note) =>
        Math.abs(note.block - target.block) <= 10 &&
        note.denomination === target.denomination,
    ).length;

  const rate = onCell / DECOYS;
  const expected = (21 / 5000) * (1 / DENOMINATIONS.length);
  assert.ok(
    Math.abs(rate - expected) < 0.2 * expected,
    `landed ${onCell} of ${DECOYS} (${(rate * 100).toFixed(4)}%), expected ${(expected * 100).toFixed(4)}%`,
  );
});

// --- cadence and cost -------------------------------------------------------
test("cadence: 'none' emits nothing, fixed jitters around the base rate", () => {
  const n = next();
  assert.deepEqual(schedule({ mode: "none", windows: 5, baseRate: 3, next: n }), [0, 0, 0, 0, 0]);
  const fixed = schedule({ mode: "fixed", windows: 50, baseRate: 3, next: n });
  assert.equal(fixed.length, 50);
  for (const count of fixed) assert.ok(count >= 2 && count <= 4);
});

test("cost is charged one call per decoy, because batching buys no bits", () => {
  const cost = costEstimate([10, 10, 10], { network: "sepolia" });
  assert.equal(cost.decoys, 30);
  assert.equal(cost.feePerCall, 2n);
  // `calls === decoys` is the load-bearing part, not arithmetic. The contract's
  // fee is flat per `apply_actions` call, so ten decoys in one call would cost
  // 2 STRK instead of 20 — and would be a single origin, which is the one thing
  // the measurement says destroys the value. If someone ever "optimises" this
  // into a batched call, this assertion is what should stop them.
  assert.equal(cost.calls, cost.decoys);
  assert.equal(cost.totalFee, 60n);
  assert.equal(costEstimate([10], { network: "mainnet" }).totalFee, 60n);
});

test("denominations are fixed so the deposit leg carries no amount signal", () => {
  assert.ok(DENOMINATIONS.length > 1);
  assert.equal(new Set(DENOMINATIONS).size, DENOMINATIONS.length);
});

// The dashboard imports the same modules the CLI uses. There is deliberately no
// second implementation of the maths in here: a UI that recomputes the numbers
// its own way is a UI that will eventually disagree with the paper.
//
// Two kinds of number live on this page and they must never be blended:
//   measured  - read from data/measurement.json, produced by indexing the real
//               pool. Reproducible, and true whether or not we like it.
//   modelled  - computed live from ./src/*.mjs on a synthetic pool. A calibrated
//               argument about what cover traffic would cost, clearly labelled.
//
// One file, two pages. `index.html` is the landing: hero, protocol, comparison,
// the other-chains finding, the entry points and the FAQ. `app.html` is the
// instrument: the meter, the cover simulator and the RDO calculator. They load
// this same file, so every panel it paints has to be optional.
//
// The landing carries TWO readings and they come from different files: the hero
// states STRK20 mainnet and the other-chains section states whichever EVM chain
// is selected there. That is why the hero has its own painter and its own stamp.
// One painter driven by one selection would have let the finding overwrite the
// headline — and the finding's measurement has no claimedBits to print, so the
// hero would have read "none" for bits claimed while sitting above a page about
// STRK20.

import { mulberry32, randomInt } from "./src/rng.mjs";
import { DENOMINATIONS, FEE_PER_CALL } from "./src/cover.mjs";
import { quote } from "./src/quote.mjs";
// From `sale.mjs` and not from `provider.mjs`, which is where the decision is
// enforced: `provider.mjs` reaches `payment.mjs`, and `payment.mjs` evaluates
// `Buffer.from("Transfer", "ascii")` at module scope. Importing it here would
// stop this file loading at all, in a browser, for one boolean.
import { canSell } from "./src/sale.mjs";
import {
  buildPool, addCover, addWindowCover, addTargetedCover, summarise, report,
} from "./src/anonymity.mjs";
import { decoySalts, randomSalt, NOTES_PER_MESSAGE } from "./src/salt.mjs";
import { m1 } from "./src/metrics.mjs";

// A page carries only the panels it is for, and there are ninety places below
// that write into one. Rather than making each of them remember to check, `el`
// returns an inert stand-in when the element is absent.
//
// It is deliberately a plain object with the handful of properties this file
// actually touches, and NOT a Proxy: a Proxy that swallows everything would
// absorb a typo (`el("run").addEventlistener`) as silently as a missing panel,
// which trades one invisible failure for another. A wrong property name still
// throws.
const INERT = {
  textContent: "", innerHTML: "", value: "", className: "",
  style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {}, removeEventListener() {}, scrollIntoView() {},
  setAttribute() {}, getAttribute() { return null; }, appendChild() {},
};
const el = (id) => document.getElementById(id) ?? INERT;

/** Whether this page is the instrument rather than the landing. */
const HAS_APP = Boolean(document.getElementById("measure"));

const fmt = (value, places = 2) => Number(value).toFixed(places);

/**
 * A count, formatted in the language the document is written in.
 *
 * A bare `toLocaleString()` follows the READER's locale instead, and on a
 * Spanish-locale machine the landing's headline read "125.772 pool events
 * indexed" — a thousands separator that an English reader reads as a decimal
 * point. The published screenshots carried it.
 *
 * In a project whose whole claim is that its numbers mean what they say, a
 * figure whose meaning changes with the reader's region is the most expensive
 * kind of ambiguity. The page declares `<html lang="en">`, so its numbers are
 * English numbers. Every count on the dashboard goes through here.
 */
const num = (value) => Number(value).toLocaleString("en-US");

/**
 * The "when was this measured, and is it live" line.
 *
 * There are two of them and they are not interchangeable: the landing's hero
 * carries one, the instrument's meter carries the other. Both have to be
 * written, because the failure they exist to prevent is a page that keeps its
 * hardcoded figures while looking perfectly correct — but each painter has to
 * say which one it means. A single default target would have let the
 * other-chains finding stamp the hero with Robinhood's date.
 */
const STAMP_IDS = { hero: ["s-stamp"], meter: ["fetch-stamp"] };

function stamp(text, where) {
  for (const id of STAMP_IDS[where]) el(id).textContent = text;
}

// ---------------------------------------------------------------- measurement
// Real chain numbers. If the file is missing we keep whatever is hardcoded in
// the HTML rather than showing a blank card — but we say so, because a stale
// number presented as a live one is the exact failure this project exists to
// prevent.
//
// Two shapes live behind this map and they must not be blended:
//   shielded - a pool with notes. Nominal set vs effective set, both meaningful.
//   evm      - a chain with no shielding primitive. There is no note set, so
//              the nominal/effective distinction has nothing to bite on and the
//              effective set is 0 bits by construction. Rendering it through
//              the shielded path would print a "claimed" figure for a claim
//              nobody made.

const MEASUREMENTS = {
  sepolia: { label: "STRK20 · Sepolia", file: "./data/measurement.json", kind: "shielded" },
  mainnet: { label: "STRK20 · Mainnet", file: "./data/measurement-mainnet.json", kind: "shielded" },
  robinhood: { label: "Robinhood Chain · 4663", file: "./data/measurement-robinhood.json", kind: "evm" },
  base: { label: "Base · 8453", file: "./data/measurement-base.json", kind: "evm" },
  ethereum: { label: "Ethereum · 1", file: "./data/measurement-ethereum.json", kind: "evm" },
};

// The hero labels are per-chain. Switching to a chain with no notes and back
// must not leave the words from the other one behind.
const SHIELDED_LABELS = {
  "s-events-k": "pool events indexed",
  "s-notes-k": "notes in the pool",
  "s-claimed-k": "bits claimed",
  "s-bits-k": "bits measured",
};

async function loadMeasurement(network) {
  try {
    const response = await fetch(MEASUREMENTS[network].file);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    console.warn(`measurement for ${network} unavailable:`, error.message);
    return null;
  }
}

function paintMeasurement(m, network) {
  if (!m) {
    stamp("Showing last published figures.", "meter");
    return;
  }
  if (m.kind === "evm") return paintEvmMeasurement(m, network);
  return paintShieldedMeasurement(m, network);
}

// ---------------------------------------------------------- measurement: hero
// The landing's headline reading. It is pinned to STRK20 mainnet — the hero
// states the finding, and the instrument is where you change the chain — so it
// is the one painter on either page that does not take its network from a
// selector.
//
// It is separate from paintShieldedMeasurement rather than a branch inside it
// because the landing carries two readings loaded from two files; see the note
// at the top of this file for what sharing one painter would have done.
const HERO_NETWORK = "mainnet";

function paintHeroStats(m, network) {
  const pool = m.pool;
  const headline = m.headline;

  el("hero-net").textContent = MEASUREMENTS[network].label;
  for (const [id, text] of Object.entries(SHIELDED_LABELS)) el(id).textContent = text;

  // Two different quantities, and using one for both is how a dashboard ends up
  // reporting the pool's note count as its "events indexed" figure.
  el("s-events").textContent = num(m.source.events ?? pool.notes);
  el("s-notes").textContent = num(pool.notes);
  el("s-claimed").textContent = fmt(headline.claimedBits, 2);
  el("s-bits").textContent = fmt(headline.measuredBits, 2);

  // The gap, drawn. Both widths are set here rather than one being typed into
  // the markup, because the ratio between them is the product's entire claim,
  // and a figure that is half typed and half computed is a figure that drifts.
  el("gap-claimed").style.width = "100%";
  el("gap-measured").style.width =
    `${((headline.measuredBits / headline.claimedBits) * 100).toFixed(1)}%`;

  el("hero-prefix").textContent =
    "Measured from every event the deployed pool has emitted.";
  const when = new Date(m.measuredAt);
  stamp(
    `Indexed ${when.toISOString().slice(0, 10)} · ${num(pool.clusters)} origin clusters`
    + ` · ${(pool.notes / pool.blockRange.span * 1000).toFixed(2)} notes per 1k blocks.`,
    "hero",
  );
}

function paintShieldedMeasurement(m, network) {
  const pool = m.pool;
  const headline = m.headline;
  const human = m.humanScaleOnly.models.find((x) => x.model === "origins ±10")
    ?? m.humanScaleOnly.models[0];

  // net-select, not the old net-pill. The pill was replaced by the network
  // switcher, and reaching for a removed element threw here — which silently
  // left the page showing its hardcoded fallback figures while looking correct.
  el("net-select").value = network;

  el("sim-note").style.display = "none";
  el("to-sim").textContent = "Model cover traffic";

  el("c-set").textContent = num(headline.claimedSet);
  el("c-bits").textContent = `${fmt(headline.claimedBits)} bits · log2 of pool size`;
  el("m-set").textContent = fmt(headline.measuredSet, 2);
  el("m-bits").textContent =
    `${fmt(headline.measuredBits)} bits · ${(human.fractionAlone * 100).toFixed(1)}% of notes are alone`;
  el("m-model").textContent = "origins ±10";

  // The sharpest axis is not the headline model, and a dashboard that shows only
  // the model with the biggest number is choosing the flattering one. The
  // denomination axis narrows a ±1-block observation far further than the timing
  // axis does, so it is stated here rather than left in the JSON — together with
  // the share of the pool it can even see, because it is a partial axis.
  el("assump-body").innerHTML = m.denomination
    ? "<b>block ±10</b> · public RPC only · amount is public for "
      + `${(m.denomination.coverage.fractionWithAmount * 100).toFixed(1)}% of notes, `
      + `which narrows a ±1-block set to ${fmt(
        (m.denomination.models.find((x) => x.model === "timing+amount ±1") ?? {}).candidates,
        2,
      )}`
    : "<b>block ±10</b> · public RPC only";

  // Default the simulator to the real pool instead of a round number, so the
  // model starts from the thing it is modelling.
  //
  // The block value is the history the pool was measured over, not the span of
  // its activity. The difference matters enormously: the pool is 1.25 notes per
  // thousand blocks, so its whole history is mostly empty blocks. Seeding the
  // simulator with the activity span would put 8,323 notes into a fraction of
  // the space they actually occupy and make the density look forty times higher
  // than it is — which would make every baseline below flattering and every
  // cover figure meaningless.
  el("pool").value = pool.notes;
  el("blocks").value = pool.blockRange.span;

  const when = new Date(m.measuredAt);
  el("fetch-prefix").textContent =
    "Measured from every event the deployed pool has emitted.";
  stamp(
    `Indexed ${when.toISOString().slice(0, 10)} · ${num(pool.clusters)} origin clusters`
    + ` · ${(pool.notes / pool.blockRange.span * 1000).toFixed(2)} notes per 1k blocks.`,
    "meter",
  );
}

// ---------------------------------------------------- measurement: EVM chains
// A chain with no shielded pool. There is no note set, so nothing here is a
// "claimed" figure and nothing is a candidate in the sense the meter uses.
// The timing number is real and it is published — with the reason it is not
// privacy printed directly underneath it, because a big number on a dashboard
// is read as good news unless the page says otherwise.

function paintEvmMeasurement(m, network) {
  el("net-select").value = network;
  // The same measurement paints two different controls depending on the page it
  // is on: the meter's network switcher on the instrument, and the finding's
  // chain switcher on the landing. Each page has exactly one of the two, and the
  // lookup for the other falls through to the inert stand-in.
  el("find-select").value = network;

  const matched = m.timing.find((t) => t.matchedToStarknet) ?? m.timing[0];
  const p = m.poolSignature;
  const scan = m.contractScan;
  const chainName = m.source.chainName ?? m.source.chain;

  // The four hero stats are NOT written here, and that is the whole point of the
  // split. They were, until a screenshot showed the landing's hero reading
  // "none bits claimed" above a pill that said STRK20 · Mainnet: the finding
  // loads Robinhood Chain, this painter ran after the hero's, and the headline
  // was overwritten by a chain with no pool. The hero has its own painter and
  // its own network now; a measurement reaches these four ids through
  // paintHeroStats and through nothing else.
  el("c-set").textContent = num(matched.candidates);
  el("c-bits").textContent = `distinct senders · not an anonymity set`;
  el("m-model").textContent = "no shielding primitive";
  el("m-set").textContent = "0";
  el("m-bits").textContent = "0 bits · the sender is written in the transaction";
  el("assump-body").innerHTML = "<b>everything</b> · all state is public";
  el("to-sim").textContent = "See the finding";

  // The section heading and lede are driven by the measurement, because the
  // same section has to describe a different chain on each switch. The
  // description itself comes from the chain registry, carried through in the
  // measurement, so there is exactly one copy of it.
  el("rh-eyebrow").textContent = `${chainName} · Chain ID ${m.source.chainId} · ${m.source.stack}`;
  el("rh-title").textContent = m.headline.claim;
  el("rh-lede").textContent = m.source.chainNote ?? "";
  el("rh-cmp-chain").textContent = chainName;
  el("rh-timing-head").textContent = `Candidates (${chainName})`;
  el("rh-cmp-blocktime").textContent = `${m.window.blockTimeSeconds} s`;

  // The seconds-not-blocks note has to name the block time of the chain it is
  // sitting under. It was written for Robinhood Chain's 0.102 s and would have
  // read "0.102 s" under Ethereum's 12.056 s table.
  el("rh-timing-foot").innerHTML =
    "Windows are in <b>seconds</b>, not blocks. Starknet produces a block every "
    + "1.702 s and " + chainName + " every " + m.window.blockTimeSeconds + " s, so a "
    + "shared \"±10 blocks\" column would compare "
    + `${(10 * 1.702).toFixed(1)} seconds against ${(10 * m.window.blockTimeSeconds).toFixed(1)}. `
    + "<b>±17 s is the exact wall-clock equivalent</b> of the STRK20 window we "
    + "published, which is what makes the next table a comparison rather than a "
    + "coincidence.";

  el("rh-matches-head").textContent =
    `Every contract the value shape fired on (${scan ? scan.shapeMatches.length : 0})`;

  // The cover-traffic model prices decoys inside a shielded pool. On a chain
  // with no shielding there is no pool to put them in, so the section says so
  // rather than quietly continuing to show STRK20 numbers.
  el("sim-note").style.display = "block";
  el("sim-note").textContent =
    "The model below prices decoys inside a shielded pool, so it does not apply "
    + `to ${chainName}: there is no pool to place them in and no note set for `
    + "them to join. The parameters and figures below are the STRK20 mainnet pool.";

  // --- the dedicated section ---
  el("rh-tx").textContent = num(m.window.transactions);
  el("rh-blocktime").textContent = m.window.blockTimeSeconds;
  el("rh-senders").textContent = num(m.reuse.distinctSenders);
  el("rh-bits").textContent = "0.00";

  el("rh-timing").innerHTML = m.timing.map((t) => {
    const label = t.matchedToStarknet ? `±${t.windowSeconds} s *` : `±${t.windowSeconds} s`;
    return `<tr><td class="f">${label}</td>`
      + `<td>${num(t.candidates)}</td>`
      + `<td>${t.median}</td><td>${fmt(t.bits)}</td>`
      + `<td>${(t.fractionAlone * 100).toFixed(1)}%</td></tr>`;
  }).join("");

  el("rh-clauses").innerHTML = m.identifiability.clauses.map((c) =>
    `<div class="clause">`
    + `<div class="c">${c.claim}</div>`
    + `<div class="k">${c.consequence}</div>`
    + `<div class="f">falsified by: ${c.falsifiableBy}</div>`
    + `</div>`).join("");

  const facts = [
    ["Transactions per second", m.window.transactionsPerSecond],
    ["Per day, extrapolated", num(m.window.transactionsPerDay)],
    ["Senders used exactly once", `${(m.reuse.singleUseFraction * 100).toFixed(1)}%`],
    ["Senders for 50% of activity",
      `${num(m.reuse.sendersForHalfOfActivity)}`
      + ` (${(m.reuse.sendersForHalfOfActivityFraction * 100).toFixed(1)}%)`],
    ["Top 10 contracts' share", `${(m.concentration.shareTop10 * 100).toFixed(1)}%`],
    ["Contracts for 80% of traffic", m.concentration.targetsFor80Percent],
    ["ERC-4337 share of transactions",
      `${((m.erc4337.total / m.window.transactions) * 100).toFixed(2)}%`],
    ["System transactions excluded",
      num(m.source.systemTransactionsExcluded)],
  ];
  el("rh-facts").innerHTML = facts
    .map(([k, v]) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`)
    .join("");

  el("rh-pooltest").innerHTML = [
    ["Value transfers", num(p.valueTransfers), "many"],
    ["Distinct values", num(p.distinctValues), "a handful"],
    ["Value space ratio", p.valueSpaceRatio, `< ${p.thresholds.valueSpaceRatioBelow}`],
    ["Top 5 share of transfers", `${(p.top5ShareOfTransfers * 100).toFixed(1)}%`,
      `> ${p.thresholds.top5ShareAbove * 100}%`],
    ["Signature present", p.shieldedPoolSignaturePresent ? "yes" : "no", "yes"],
  ].map(([k, a, b]) => `<tr><td class="f">${k}</td><td>${a}</td><td>${b}</td></tr>`).join("");

  el("rh-poolverdict").textContent = p.verdict;

  // --- the per-contract test, which is the one that carries weight ----------
  if (scan) {
    el("rh-contracttest").innerHTML = [
      ["Contracts with value transfers", num(scan.contractsWithValueTransfers), "—"],
      ["Contracts scanned (≥ " + scan.minTransfers + " transfers)",
        num(scan.contractsScanned), "—"],
      ["Value shape matched", scan.shapeMatches.length, "—"],
      ["Viable pool candidates", scan.viablePoolCandidates.length, "≥ 1"],
    ].map(([k, a, b]) => `<tr><td class="f">${k}</td><td>${a}</td><td>${b}</td></tr>`).join("");

    const whyOf = (c) => {
      if (c.singleActor) return "one depositor — anonymity set of 1";
      if (c.oneSided) return "no outflow — value only goes in";
      if (!c.outflowPoolShaped) {
        return `outflow not pool-shaped — ${c.outflowDistinctValues} different amounts paid out`;
      }
      return "survives every condition";
    };
    el("rh-contractverdict").innerHTML =
      `<b>${scan.verdict}</b>`;

    el("rh-matches").innerHTML = scan.shapeMatches.length
      ? scan.shapeMatches.map((c) => {
        const survives = c.viablePoolCandidate;
        return `<tr><td class="f">${c.target}</td>`
          + `<td>${num(c.transfers)}</td>`
          + `<td>${c.valueSpaceRatio}</td>`
          + `<td>${num(c.distinctDepositors)}</td>`
          + `<td>${num(c.outboundTransfers)}</td>`
          + `<td class="${survives ? "us" : ""}">${whyOf(c)}</td></tr>`;
      }).join("")
      : `<tr><td class="f">none</td><td>—</td><td>—</td><td>—</td><td>—</td>`
        + `<td>the value shape did not fire on any contract in this window</td></tr>`;
  }

  if (m.comparison) {
    el("rh-window-blocks").textContent = `±${m.comparison.thisChain.windowInBlocks}`;
    el("rh-cmp-stark").textContent =
      `${num(m.comparison.starknetMainnet.candidatesAll)} origins`;
    el("rh-cmp-rh").textContent =
      `${num(m.comparison.thisChain.candidates)} senders`;
    el("rh-cmp-stark-bits").textContent = `${m.comparison.starknetMainnet.measuredBits} bits`;
    el("rh-cmp-rh-bits").textContent = "0 bits";
    el("rh-cmp-foot").innerHTML =
      `${chainName} has the <b>larger</b> candidate set and the <b>smaller</b> `
      + "anonymity set. Both statements are true at once because the candidate "
      + "set is not an anonymity set. A number only becomes privacy when the "
      + "parties inside it are indistinguishable from each other. On STRK20 they "
      + "are notes. Here they are addresses, and addresses are names.";
  }

  const when = new Date(m.measuredAt);
  // The first version of this line read "sampled window of 51,193,541 blocks",
  // which reads as a window 51 million blocks long. The number was headAtFetch —
  // the chain's height — so the caption claimed a window seventeen thousand
  // times larger than the one measured. Window size and chain height are
  // different quantities and both are stated now.
  el("rh-stamp").textContent =
    `Indexed ${when.toISOString().slice(0, 10)} · blocks `
    + `${num(m.window.fromBlock)} → ${num(m.window.toBlock)} `
    + `(${num(m.window.blocks)} of ${num(m.source.headAtFetch)} in the chain) · `
    + `${Number(m.source.blocksMissing) === 0 ? "no missing blocks" : `${m.source.blocksMissing} missing blocks`}.`;

  // The prefix is part of the sentence, and it is chain-dependent: an EVM
  // measurement is a sampled window of a chain's transactions, not the whole
  // event history of a pool. Leaving the pool wording in place under a chain
  // with no pool would be a small lie in the smallest print.
  el("fetch-prefix").textContent =
    `Measured from a contiguous window of ${chainName} blocks.`;
  stamp(
    ` Indexed ${when.toISOString().slice(0, 10)} · ${num(m.window.transactions)}`
    + ` transactions in ${num(m.window.blocks)} blocks.`,
    "meter",
  );
}
// ------------------------------------------------------------------ simulator

function readInputs() {
  return {
    poolSize: Math.max(10, Number(el("pool").value)),
    blocks: Math.max(10, Number(el("blocks").value)),
    timingWindow: Math.max(1, Number(el("window").value)),
    network: el("network").value,
    strategy: el("strategy").value,
    decoys: Math.max(0, Number(el("decoys").value)),
    seed: Number(el("seed").value),
  };
}

function run() {
  const cfg = readInputs();
  const next = mulberry32(cfg.seed);

  const pool = buildPool({
    size: cfg.poolSize,
    blocks: cfg.blocks,
    denominations: DENOMINATIONS,
    next,
  });
  const targets = Array.from(
    { length: 200 },
    () => pool[randomInt(next, 0, pool.length)],
  );

  // Aimed cover only ever helps the note it was aimed at, so it is measured on
  // that note. Everything else is a public good and gets averaged over the pool.
  // Measuring both the same way is how one of them gets flattered.
  //
  // `window` counts as aimed because the provider still knows *when* the buyer
  // moves — the timing is given away by construction, since cover has to land
  // before the spend. What it does not know is the denomination, and that is the
  // whole difference between this row and `targeted`.
  const aimed = cfg.strategy === "targeted" || cfg.strategy === "window";
  const measureOn = (notes) =>
    aimed
      ? report(notes, targets[0], { timingWindow: cfg.timingWindow })
      : summarise(notes, targets, { timingWindow: cfg.timingWindow });

  const extended =
    cfg.strategy === "uniform"
      ? addCover(pool, cfg.decoys, { blocks: cfg.blocks, denominations: DENOMINATIONS, next })
      : cfg.strategy === "window"
        ? addWindowCover(pool, cfg.decoys, {
          target: targets[0], timingWindow: cfg.timingWindow,
          denominations: DENOMINATIONS, next,
        })
        : cfg.strategy === "targeted"
          ? addTargetedCover(pool, cfg.decoys, {
            target: targets[0], timingWindow: cfg.timingWindow, next,
          })
          : pool;

  const before = measureOn(pool);
  const after = measureOn(extended);

  const beforeAll = before.at(-1);
  const afterAll = after.at(-1);
  const gained = afterAll.bits - beforeAll.bits;

  el("before").textContent = `${fmt(beforeAll.candidates, 1)} notes`;
  el("after").textContent = `${fmt(afterAll.candidates, 1)} notes`;
  el("b-bits").textContent = fmt(beforeAll.bits);
  el("a-bits").textContent = fmt(afterAll.bits);
  el("delta").textContent = gained > 0.005
    ? `+${fmt(gained, 3)} bits`
    : "no change";
  el("delta").style.color = gained > 0.005 ? "var(--good)" : "var(--muted)";
  el("pill").textContent = `model: all · ${aimed ? "buyer's note" : "pool average"}`;

  el("candidates-line").textContent =
    `An adversary who knows the timing (±${cfg.timingWindow} blocks) and the `
    + `denomination can narrow ${fmt(cfg.poolSize, 0)} notes to `
    + `${fmt(afterAll.candidates, 1)} candidates. Nominal pool size is not the `
    + `number that matters.`;

  // --- model table ---
  el("models").innerHTML = after
    .map((row, index) => {
      const b = before[index];
      const worst = row.model === "all" ? ' style="color:var(--bad)"' : "";
      return `<tr${worst}><td>${row.model}</td>`
        + `<td style="text-align:right">${fmt(b.candidates, 1)} → ${fmt(row.candidates, 1)}</td>`
        + `<td style="text-align:right">${fmt(b.bits, 2)} → ${fmt(row.bits, 2)}</td></tr>`;
    })
    .join("");

  // --- cost ---
  // One call per decoy: the fee is charged per apply_actions call, so batching
  // would be cheaper — and would put every decoy in the same origin, which is the
  // one thing the measurement says destroys the value. See costEstimate.
  const fee = FEE_PER_CALL[cfg.network] ?? FEE_PER_CALL.sepolia;
  const spent = BigInt(cfg.decoys) * fee;
  const perBit = gained > 0.005 ? fmt(Number(spent) / gained, 1) : "—";
  const rows = [
    ["Decoys purchased", fmt(cfg.decoys, 0)],
    ["Fee per call", `${fee} STRK`],
    ["Total spent", `${spent} STRK`],
    ["Bits gained", fmt(gained, 3)],
    ["Cost per bit", `${perBit} STRK`],
  ];

  // M1 is cheap enough to recompute live, and it is the number that says whether
  // our decoys are distinguishable from ordinary traffic at all.
  const score = m1({
    positives: Array.from({ length: 200 }, () => decoySalts(next)),
    negatives: Array.from({ length: 4000 }, () =>
      Array.from({ length: NOTES_PER_MESSAGE }, () => randomSalt(next))),
  });
  rows.push(["M1 distinguishability", `${score.balancedAccuracy.toFixed(4)} · 0.5 = guessing`]);

  el("cost").innerHTML = rows
    .map(([k, v]) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`)
    .join("");
}

// ----------------------------------------------------------------- RDO tiers

function paintTiers() {
  const balance = Math.max(0, Number(el("rdo-bal").value) || 0);
  const tiers = [...document.querySelectorAll(".tier:not(.head)")];
  let active = tiers[0];
  for (const tier of tiers) {
    if (balance >= Number(tier.dataset.min)) active = tier;
  }
  for (const tier of tiers) tier.classList.toggle("sel", tier === active);
}

// --------------------------------------------------------------- noise field

// The mark at scale, behind the hero. The logo is 48px of a clean wave
// dissolving into noise; blown up and dimmed it becomes the page's own texture.
//
// Deterministic on purpose — no Math.random. A decorative layer that redrew a
// different field on every load would make every screenshot and every published
// artifact disagree with the next one, in a project whose whole claim is that
// its numbers can be checked.
function paintNoiseField() {
  // Looked up directly rather than through el(): the band is on the landing only,
  // and the inert stand-in is truthy, so `if (!host) return` would never fire and
  // the instrument would build a hundred and thirty bars to write them nowhere.
  const host = document.getElementById("noise-field");
  if (!host) return;

  // Geometry matches the band's own aspect (the CSS is 240px tall), so the bars
  // are not stretched on a normal viewport. `preserveAspectRatio="none"` keeps
  // the wave-to-noise reading intact at any width, which `slice` would crop away
  // on a phone.
  const W = 1440;
  const H = 240;
  const N = 132;
  const PITCH = W / N;
  const BAR = PITCH * 0.44;
  const CY = H / 2;

  const hash = (n) => {
    const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  const smoothstep = (a, b, t) => {
    const u = Math.min(1, Math.max(0, (t - a) / (b - a)));
    return u * u * (3 - 2 * u);
  };

  const bars = [];
  for (let i = 0; i < N; i += 1) {
    const t = i / (N - 1);
    // Left: a clean standing wave. Right: noise. The blend is a smoothstep, so
    // the transition dissolves instead of leaving a seam.
    const wave = Math.sin(t * Math.PI * 2 * 1.7) * 0.5 + 0.5;
    const noise = hash(i + 11);
    const mix = smoothstep(0.24, 0.42, t);
    const amp = wave * (1 - mix) + noise * mix;
    const h = 8 + amp * H * 0.44;
    const x = i * PITCH + (PITCH - BAR) / 2;
    const y = CY - h / 2;

    // Only the noise half moves. A field that flickered everywhere would read
    // as broken; this one says the signal holds while the noise moves.
    const moving = mix > 0.05;
    const style = moving
      ? ` style="animation-duration:${(0.72 + hash(i + 3) * 0.8).toFixed(2)}s;` +
        `animation-delay:-${(hash(i + 5) * 1.2).toFixed(2)}s"`
      : "";
    const cls = moving ? "nf-b nf-n" : "nf-b";
    const op = (0.34 + hash(i + 17) * 0.52).toFixed(2);
    bars.push(
      `<rect class="${cls}"${style} x="${x.toFixed(2)}" y="${y.toFixed(2)}"` +
        ` width="${BAR.toFixed(2)}" height="${h.toFixed(2)}" rx="${(BAR / 2).toFixed(2)}"` +
        ` opacity="${op}"/>`,
    );
  }

  host.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" focusable="false">` +
    `<g fill="var(--accent)">${bars.join("")}</g></svg>`;
}

// -------------------------------------------------------------------- buying

// The front door, and the only panel on either page that leads to spending. It
// spends nothing itself: it reads the terms a provider publishes, decides whether
// that provider can deliver at all, prices the order against the ladder the
// provider actually runs, and hands over the commands.
//
// It does NOT build the order, and that is a decision rather than an omission.
// The client is `scripts/buy.mjs`, which writes the order *and the reveal* to a
// file — and the reveal is the one secret the whole window/reveal split exists to
// keep off the wire. A browser that generated it would be asking the buyer to
// keep the trade's only secret in a download, and a second implementation of the
// commitments in here would be a second thing that can be wrong.
//
// The gate is `canSell()`, the same function `acceptOrder` refuses with, so this
// page cannot say "yes" over a provider that is about to say "no".

const BUY_PANELS = [
  "b-terms-panel", "b-order", "b-gate-panel", "b-price-panel",
  "b-handoff", "b-pay-panel", "b-reveal-panel",
];

let buyTerms = null;
let buyBase = null;

const buyValue = (id) => String(el(id).value).trim();
const buyToken = () => buyValue("b-token");
const buyHeaders = () => (buyToken() ? { authorization: `Bearer ${buyToken()}` } : {});

/** The rungs this provider's ladder actually covers, not the whole ladder. */
const rungsOf = (terms) => DENOMINATIONS.slice(0, terms.ladder);

async function readProvider() {
  buyTerms = null;
  buyBase = buyValue("b-url").replace(/\/+$/, "");
  for (const id of BUY_PANELS) el(id).hidden = true;

  if (!buyBase) {
    el("b-note").textContent =
      "A provider URL is required. There is no default, because a hardcoded one would be a provider nobody chose.";
    return;
  }

  el("b-note").textContent = `Reading ${buyBase}/terms…`;

  let published;
  try {
    const response = await fetch(`${buyBase}/terms`, { headers: buyHeaders() });
    if (!response.ok) {
      el("b-note").textContent = `${buyBase}/terms answered ${response.status}.`;
      return;
    }
    published = await response.json();
  } catch {
    // A browser cannot tell "nothing is listening" from "this page is https and
    // the provider is not", so the message names both rather than picking one and
    // being wrong half the time.
    el("b-note").textContent =
      `Could not reach a provider at ${buyBase}. Start one with ` +
      "`npm run serve:provider`. A page served over https cannot call a plain http " +
      "provider, so open this page locally to try one.";
    return;
  }

  buyTerms = published.terms ?? null;
  el("b-note").textContent = `Read ${buyBase}/terms. Nothing else on this page has spoken to it.`;
  paintProvider(published);
}

function paintProvider(published) {
  const terms = published.terms;
  const rungs = rungsOf(terms);

  el("b-terms-panel").hidden = false;
  el("b-network").textContent = terms.network;
  el("b-ladder").textContent = `${terms.ladder} rungs · ${rungs.map(String).join(", ")} STRK`;
  el("b-fee").textContent = `${terms.feePerCall} STRK per call`;
  el("b-margin").textContent = terms.margin === "0" ? "none" : `${terms.margin} base units per decoy`;
  el("b-emits").textContent = terms.emits ? "declared" : "no";
  el("b-payable").textContent = terms.address ?? "no address";
  el("b-height").textContent = published.heightSource ?? "";

  // The verdict is the provider's own refusal, read back to the buyer before
  // anything is built. When it is "no", the commands below are still shown and
  // are labelled: what the trade looks like is worth seeing, and hiding it would
  // leave the reader with a dead end and no picture of the door.
  const verdict = canSell(terms);
  el("b-verdict").textContent = verdict.ok ? "can serve" : "cannot serve";
  el("b-verdict").className = `pill ${verdict.ok ? "ok" : "no"}`;
  el("b-gate-panel").hidden = false;
  el("b-gate").textContent = verdict.ok
    ? published.emitsNote ?? ""
    : `${verdict.reason} — so the commands below are the shape of the trade, not something to run today.`;
  el("b-handoff-note").textContent = verdict.ok
    ? "The provider above accepts orders. Run this, then pay the invoice it returns."
    : "This provider refuses every order at the first check, so this command returns a refusal and no invoice. It is here because the door is part of the answer.";

  el("b-order").hidden = false;
  el("b-pay-panel").hidden = false;
  el("b-paynote").textContent = published.paymentNote ?? "";
  el("b-reveal-panel").hidden = false;
  el("b-reveal-cmd").textContent = "npm run reveal -- --order orders/order.json";

  el("b-denom").innerHTML = rungs.map((r) => `<option value="${r}">${r} STRK</option>`).join("");

  paintOrder();
}

/**
 * The price and the command, recomputed from the form.
 *
 * `quote` is the same function the simulator and the CLI use, so this figure and
 * the one `npm run buy` prints cannot disagree. What is priced here and not
 * there is the ladder: the simulator prices a model pool, and this prices the
 * ladder the provider in the URL is actually running.
 */
function paintOrder() {
  const terms = buyTerms;
  if (!terms) return;

  const cell = Number(buyValue("b-cell"));
  const bits = Number(buyValue("b-bits-wanted"));
  const mode = buyValue("b-mode");
  const width = Number(buyValue("b-width"));
  const span = Number(buyValue("b-span"));
  const denomination = buyValue("b-denom");

  el("b-span-field").hidden = mode !== "blind";

  let priced = null;
  try {
    priced = quote({
      targetCell: cell,
      bits,
      mode,
      network: terms.network,
      ladder: terms.ladder,
      windowWidth: width,
      blockSpan: span,
    });
  } catch (error) {
    // `quote` refuses a cell below one and a blind order with no span. Those are
    // half-typed form states, not bugs, so they are reported where the form is
    // rather than thrown into the console.
    el("b-price-panel").hidden = true;
    el("b-handoff").hidden = true;
    el("b-note").textContent = error.message;
    return;
  }

  el("b-price-panel").hidden = false;
  el("b-decoys").textContent = num(priced.decoys);
  el("b-cost").textContent = `${priced.cost} STRK`;
  el("b-delivered").textContent = `${priced.bitsDelivered} bits, for ${priced.bitsRequested} asked`;
  el("b-price-note").textContent =
    "Pool fee only — one `apply_actions` call per decoy, because decoys batched " +
    "into one call share an origin and the measurement counts origins. Any " +
    "provider margin is separate and is not in this figure.";

  // The command. Everything the page knows is filled in; `--from` is left as a
  // placeholder because the block a spend is planned for is the one thing here
  // that no page can know, and a plausible-looking default would be a number
  // nobody chose.
  const parts = [
    "npm run buy --",
    `--provider ${buyBase}`,
    `--cell ${cell}`,
    "--from <block>",
    `--denomination ${denomination}`,
    `--bits ${bits}`,
    `--mode ${mode}`,
  ];
  if (mode === "blind") parts.push(`--span ${span}`);
  parts.push(`--width ${width}`, "--out orders/order.json");
  el("b-command").textContent = parts.join(" \\\n  ");
  el("b-handoff").hidden = false;
}

// -------------------------------------------------------------------- wiring

// Mainnet leads, because it is the deployment that matters and because it is the
// one where our own prediction was wrong. Sepolia stays one click away.
//
// Two query parameters, because the two pages carry two different readings:
// ?net= preselects the meter and ?find= preselects the other-chains finding. One
// parameter would have made a link to "the Base finding" also switch a meter
// that is not on that page — and the whole reason the parameter exists is that a
// link landing on the right figures is checkable, while a link landing on the
// default and asking the reader to find a dropdown is not.
const params = new URLSearchParams(location.search);
const REQUESTED_NET = params.get("net");
const REQUESTED_FIND = params.get("find");
// `?provider=` prefills the buy panel's URL and reads it on load, for the same
// reason the other two exist: a link that lands on the right state is checkable,
// and one that lands on a default and asks the reader to paste something is not.
// It is also what makes the panel's two states — can serve, cannot serve —
// something a capture can show rather than something only a person who clicked
// has seen.
const REQUESTED_PROVIDER = params.get("provider");

let activeNetwork = MEASUREMENTS[REQUESTED_NET] ? REQUESTED_NET : "mainnet";
// The finding is about chains with no shielded pool, so only an EVM chain is a
// valid target for it. Pointing it at STRK20 would ask a section whose subject is
// the absence of a pool to render a pool.
let activeFinding = MEASUREMENTS[REQUESTED_FIND]?.kind === "evm"
  ? REQUESTED_FIND
  : "robinhood";

el("run").addEventListener("click", run);
el("to-sim").addEventListener("click", () => {
  // On a chain with no shielded pool there is nothing to model, so the button
  // goes to the finding instead of to a simulator that does not apply. Keyed on
  // the measurement kind rather than on a chain name, so a chain added to the
  // registry does not silently start pointing at the STRK20 simulator.
  const evm = MEASUREMENTS[activeNetwork]?.kind === "evm";
  const target = evm ? "robinhood" : "sim";
  // The finding is a section of the landing page. On the instrument that section
  // does not exist, so scrolling to it would scroll nowhere and the button would
  // look broken — it has to cross pages instead, and it carries ?find= so the
  // reader lands on the chain the meter was actually showing rather than on the
  // default one.
  const node = document.getElementById(target);
  if (node) node.scrollIntoView({ behavior: "smooth", block: "start" });
  else location.href = `./index.html?find=${activeNetwork}#robinhood`;
});
for (const id of ["strategy", "network"]) el(id).addEventListener("change", run);
el("rdo-bal").addEventListener("input", paintTiers);
el("rdo-reset").addEventListener("click", () => {
  el("rdo-bal").value = 0;
  paintTiers();
});
// Each page has exactly one of these two, and the listener for the other one
// lands on the inert stand-in.
el("net-select").addEventListener("change", (event) => showMeter(event.target.value));
el("find-select").addEventListener("change", (event) => showFinding(event.target.value));

// The buy panel. `input` covers typing and `change` covers the two selects and
// the number spinners; binding both is cheaper than deciding which fires when,
// and `paintOrder` is idempotent and cheap.
el("b-read").addEventListener("click", readProvider);
for (const id of ["b-cell", "b-bits-wanted", "b-mode", "b-width", "b-span", "b-denom"]) {
  el(id).addEventListener("input", paintOrder);
  el(id).addEventListener("change", paintOrder);
}
el("b-copy").addEventListener("click", async () => {
  const command = el("b-command").textContent;
  try {
    await navigator.clipboard.writeText(command);
    el("b-copy").textContent = "Copied";
  } catch {
    // The clipboard API needs a secure context, and this page is opened from a
    // file:// path or a plain-http dev server as often as not. Saying so beats a
    // button that looks like it worked.
    el("b-copy").textContent = "Select the command above and copy it";
  }
});

paintNoiseField();

async function showMeter(network) {
  activeNetwork = network;
  const measurement = await loadMeasurement(network);
  try {
    paintMeasurement(measurement, network);
  } catch (error) {
    // A throw here leaves the hardcoded fallback figures on screen, where they
    // look exactly like loaded ones. Say so instead of failing silently.
    console.error("could not paint measurement:", error);
    stamp(
      "Could not load the live measurement — the figures above are the last published ones.",
      "meter",
    );
    return;
  }
  // Re-seed the cover model from the real pool — but only for a chain that has
  // one. Running it for an EVM chain would leave STRK20 numbers sitting under a
  // selector that says Robinhood.
  if (measurement && MEASUREMENTS[network].kind === "shielded") run();
}

// The landing's hero. Nothing selects this network — it is the finding, stated
// once, and the instrument is where a reader goes to change it.
async function showHero() {
  const measurement = await loadMeasurement(HERO_NETWORK);
  if (!measurement) {
    stamp("Showing last published figures.", "hero");
    return;
  }
  paintHeroStats(measurement, HERO_NETWORK);
}

// The landing's other-chains section, driven by its own selector. It writes
// rh-stamp directly rather than through stamp(), because that line belongs to
// this section and not to either of the two that the hero and the meter own.
async function showFinding(network) {
  activeFinding = network;
  const measurement = await loadMeasurement(network);
  try {
    if (!measurement) {
      el("rh-stamp").textContent = "Showing last published figures.";
      return;
    }
    paintEvmMeasurement(measurement, network);
  } catch (error) {
    console.error(`could not paint the ${network} finding:`, error);
    el("rh-stamp").textContent =
      "Could not load the live measurement — the figures above are the last published ones.";
  }
}

// Which page is this. HAS_APP is keyed on the meter card, which exists on the
// instrument and nowhere else; the landing gets the hero and the finding, which
// are two readings and two loads.
if (HAS_APP) {
  paintTiers();
  run();
  await showMeter(activeNetwork);
  if (REQUESTED_PROVIDER) {
    el("b-url").value = REQUESTED_PROVIDER;
    await readProvider();
  }
} else {
  await showHero();
  await showFinding(activeFinding);
}

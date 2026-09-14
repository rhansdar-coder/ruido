// The dashboard has no build step and no type checker, so nothing connects
// app.js to index.html. That gap produced a real bug: the network pill was
// replaced by a network <select>, app.js kept reaching for the old id, and
// paintMeasurement threw on its first line. The page still looked correct,
// because the hardcoded fallback figures in the HTML are real numbers from the
// last measurement — they were simply never updated.
//
// A screenshot caught it. This test catches it faster.
//
// The file has since grown into "artifacts that must agree with each other":
// app.js against index.html, app.js against the measurement JSON, the docs
// against the numbers they quote, and the docs against the artifact manifest
// in scripts/build-site.mjs. Every one of those checks exists because the
// disagreement actually happened and nothing noticed.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { planArtifact } from "../scripts/build-site.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(resolve(ROOT, file), "utf8");

const app = read("app.js");
// The site is two pages. `html` stays the landing, because most of what follows
// is about the landing; `appPage` is the instrument. Checks that used to say
// "in index.html" now say "on one of the two", and the ones that are about a
// specific page say which.
const html = read("index.html");
const appPage = read("app.html");
const method = read("method.html");

/** Every id app.js looks up via el("..."). */
const lookedUp = new Set([...app.matchAll(/\bel\("([^"]+)"\)/g)].map((m) => m[1]));

/** Every id present in a document. */
const idsIn = (source) => new Set([...source.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

const ids = idsIn(html);
const appIds = idsIn(appPage);

test("app.js finds something to look up", () => {
  // If the regex ever stops matching, the test below passes vacuously.
  assert.ok(lookedUp.size > 10, `only found ${lookedUp.size} ids in app.js`);
});

test("every id app.js looks up exists on one of the two pages", () => {
  // It used to be index.html alone, because there was one page. The split moved
  // about ninety ids to app.html and the failure this guards is unchanged: an id
  // that exists on neither page makes el() hand back the inert stand-in, and a
  // panel that silently never updates looks exactly like a panel that did.
  const missing = [...lookedUp]
    .filter((id) => !ids.has(id) && !appIds.has(id))
    .sort();
  assert.deepEqual(
    missing,
    [],
    `app.js looks up ids that neither page defines: ${missing.join(", ")}`,
  );
});

test("neither page has duplicate ids", () => {
  // getElementById returns the first match, so a duplicate silently wires the
  // wrong element and the second one never updates.
  for (const [name, source] of [["index.html", html], ["app.html", appPage]]) {
    const all = [...source.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    const seen = new Set();
    const duplicates = new Set();
    for (const id of all) {
      if (seen.has(id)) duplicates.add(id);
      seen.add(id);
    }
    assert.deepEqual(
      [...duplicates].sort(),
      [],
      `${name} has duplicate ids: ${[...duplicates].join(", ")}`,
    );
  }
});

test("the landing and the instrument do not define each other's panels", () => {
  // This is the split's whole risk, and it is worth stating in a test because
  // the failure is invisible. Both pages load the same app.js and every lookup
  // falls back to an inert stand-in, so an id that ended up on the wrong page
  // does not throw — it just never updates, and a panel that never updates looks
  // exactly like a panel whose numbers did not change.
  const instrumentOnly = ["measure", "net-select", "run", "rdo-bal", "pool", "strategy", "sim-note"];
  const landingOnly = ["hero-card", "s-events", "s-stamp", "hero-prefix", "find-select", "rh-title", "rh-stamp"];

  for (const id of instrumentOnly) {
    assert.ok(appIds.has(id), `the instrument is missing #${id}`);
    assert.ok(!ids.has(id), `#${id} belongs to the instrument but is defined on the landing`);
  }
  for (const id of landingOnly) {
    assert.ok(ids.has(id), `the landing is missing #${id}`);
    assert.ok(!appIds.has(id), `#${id} belongs to the landing but is defined on the instrument`);
  }
});

test("every stamp() call names a target that exists", () => {
  // stamp() writes one of two "is this live" lines, chosen by name: the landing's
  // hero has one and the instrument's meter has the other. An unknown name is a
  // TypeError inside a paint path, where the surrounding catch reports it as
  // "could not load the live measurement" — a false diagnosis of what is really
  // a typo. Every call passes a string literal, so it is checkable here.
  const targets = new Set(
    [...app.matchAll(/const STAMP_IDS = \{([^}]*)\}/g)]
      .flatMap((m) => [...m[1].matchAll(/(\w+):/g)].map((x) => x[1])),
  );
  assert.equal(targets.size, 2, `could not read STAMP_IDS (found ${targets.size} targets)`);

  // `stamp(` followed by a quote or a backtick, so the function's own definition
  // — `function stamp(text, where)` — is not counted as a call.
  const calls = [...app.matchAll(/\bstamp\(\s*[`"][\s\S]*?,\s*"(\w+)"\s*,?\s*\)/g)].map((m) => m[1]);
  assert.ok(calls.length >= 4, `found only ${calls.length} stamp() calls with a target`);
  for (const name of calls) {
    assert.ok(targets.has(name), `stamp() is called with "${name}", which is not in STAMP_IDS`);
  }

  // The ids inside the map are looked up dynamically — `el(id)` inside stamp() —
  // so the "every id app.js looks up" check above cannot see them. Without this,
  // renaming one of the two spans would silently stop stamping that page.
  const stampIds = [...app.matchAll(/const STAMP_IDS = \{([\s\S]*?)\};/g)]
    .flatMap((m) => [...m[1].matchAll(/"([\w-]+)"/g)].map((x) => x[1]));
  assert.equal(stampIds.length, 2, `could not read the stamp ids (found ${stampIds.length})`);
  for (const id of stampIds) {
    assert.ok(
      ids.has(id) || appIds.has(id),
      `STAMP_IDS names #${id}, which is on neither page`,
    );
  }
});

test("every measurement file app.js fetches is shipped to the site", async () => {
  // A 404 here is silent: the fetch throws, loadMeasurement returns null, and
  // the page keeps its fallback numbers while looking healthy.
  //
  // This used to grep the workflow YAML for the filename. That only proved the
  // string appeared somewhere in the file, not that the file would be copied,
  // and it meant the artifact's contents were defined in the workflow. The
  // manifest now lives in scripts/build-site.mjs and this asks it directly.
  const fetched = [...app.matchAll(/file:\s*"\.\/data\/([^"]+)"/g)].map((m) => m[1]);
  assert.ok(fetched.length >= 2, `expected at least two measurement files, found ${fetched.length}`);

  const plan = await planArtifact(ROOT);
  for (const file of fetched) {
    assert.ok(
      plan.measurements.includes(`data/${file}`),
      `data/${file} is fetched by app.js but not in the artifact manifest`,
    );
    assert.ok(
      !plan.missing.includes(`data/${file}`),
      `data/${file} is in the manifest but not on disk`,
    );
  }
});

test("every asset the pages reference exists in the artifact", async () => {
  const plan = await planArtifact(ROOT);
  for (const page of ["index.html", "app.html", "method.html"]) {
    assert.ok(plan.rootFiles.includes(page), `${page} is not in the artifact manifest`);
    assert.ok(!plan.missing.includes(page), `${page} is in the manifest but not on disk`);
  }
  // app.js is not decoration: both pages load it as a module.
  assert.ok(plan.rootFiles.includes("app.js"), "app.js is not in the artifact manifest");
  assert.ok(plan.dirs.includes("assets"), "assets/ is not in the artifact manifest");
  assert.ok(plan.dirs.includes("src"), "src/ is not in the artifact manifest");
  assert.deepEqual(plan.missing, [], `artifact would be incomplete: ${plan.missing.join(", ")}`);
});

test("method.html does not depend on app.js", () => {
  // It is a static document on purpose. If it ever imports the dashboard
  // bundle, a JS error on the marketing page takes the methodology with it.
  assert.ok(!method.includes("app.js"), "method.html should stay dependency-free");
});

test("all three pages carry the Ruido brand", () => {
  for (const [name, source] of [
    ["index.html", html],
    ["app.html", appPage],
    ["method.html", method],
  ]) {
    assert.ok(source.includes("assets/logo.svg"), `${name} is missing the logo`);
    assert.ok(/Ruido/i.test(source), `${name} is missing the brand name`);
  }
});

test("the two pages link to each other, and every anchor they use exists", () => {
  // The split made this a real risk rather than a theoretical one: the nav used
  // to point at anchors on the page it was on, and now half of them point at
  // another document. A nav link to a section that does not exist scrolls
  // nowhere and looks like a broken button, not like a broken link.
  assert.match(html, /href="\.\/app\.html(#[\w-]+)?"/, "the landing does not link to the instrument");
  assert.match(appPage, /href="\.\/index\.html(#[\w-]+)?"/, "the instrument does not link back");

  for (const [name, source, other, otherSource] of [
    ["index.html", html, "app.html", appPage],
    ["app.html", appPage, "index.html", html],
  ]) {
    // Same-document anchors must resolve locally; cross-document ones must
    // resolve in the page they name.
    for (const m of source.matchAll(/href="(\.\/[\w.-]+\.html)?#([\w-]+)"/g)) {
      const target = m[1] ? otherSource : source;
      const where = m[1] ? other : name;
      assert.ok(
        idsIn(target).has(m[2]),
        `${name} links to #${m[2]}, which ${where} does not define`,
      );
    }
  }
});

// --- the measurement <-> dashboard contract ---------------------------------
// The gap above was a missing id. This is the same class of bug one level
// deeper: the measurement JSON is written by scripts/measure-evm.mjs and read
// by app.js, with nothing checking the two agree. It produced a real bug — the
// script wrote `comparison.thisChain`, app.js read `comparison.robinhood`, and
// the TypeError aborted the paint half way through. The section rendered with
// its tables filled and its timestamp blank, which reads as "still loading"
// rather than "broken".

/** Slice out a top-level function body, ending at the next top-level function. */
function sliceFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `could not find function ${name} in app.js`);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n(function |\/\/ ---)/);
  return next < 0 ? rest : rest.slice(0, next);
}

/**
 * Every `m.some.path` read in a block, minus method calls.
 *
 * The lookahead has to be `[\w$]*\s*\(` rather than `\s*\(`, because a bare
 * `\s*\(` lets the match backtrack INTO the identifier: `m.timing.map(...)`
 * then resolves to the non-existent field `timing.ma`, which is a false
 * positive that looks exactly like a real missing field.
 */
function measurementPaths(body) {
  const pattern = /\bm\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?![\w$]*\s*\()/g;
  return [...new Set([...body.matchAll(pattern)].map((x) => x[1]))].sort();
}

const hasPath = (obj, path) =>
  path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj) !== undefined;

const EVM_MEASUREMENTS = [
  "data/measurement-robinhood.json",
  "data/measurement-base.json",
  "data/measurement-ethereum.json",
];

test("every field app.js reads off an EVM measurement exists in the JSON", () => {
  const paths = measurementPaths(sliceFunction(app, "paintEvmMeasurement"));
  assert.ok(paths.length > 5, `the path extractor found only ${paths.length} fields`);
  assert.ok(paths.includes("comparison.thisChain.windowInBlocks"),
    "the extractor no longer sees nested paths");

  for (const file of EVM_MEASUREMENTS) {
    const json = JSON.parse(read(file));
    const missing = paths.filter((p) => !hasPath(json, p));
    assert.deepEqual(
      missing,
      [],
      `${file} does not contain fields that app.js reads: ${missing.join(", ")}`,
    );
  }
});

// --- one reading per painter -------------------------------------------------
// A screenshot caught this, and it is worth a test because the failure is
// invisible in every other way. The landing's hero read "none bits claimed"
// above a pill that said STRK20 · Mainnet, with Robinhood Chain's transaction
// count under it: paintEvmMeasurement — the finding's painter — still wrote the
// four hero ids, and it runs after the hero's. The page looked deliberate.
//
// The four figures are the headline of a page whose entire claim is that its
// numbers are current, so a painter that can overwrite them from a different
// chain's file is the most expensive bug this split could have produced.

const HERO_FIGURES = ["s-events", "s-notes", "s-claimed", "s-bits"];
const HERO_CAPTIONS = ["s-events-k", "s-notes-k", "s-claimed-k", "s-bits-k"];

test("only paintHeroStats writes the landing's headline figures", () => {
  for (const name of ["paintShieldedMeasurement", "paintEvmMeasurement"]) {
    const body = sliceFunction(app, name);
    const written = [...HERO_FIGURES, ...HERO_CAPTIONS].filter((id) => body.includes(`el("${id}")`));
    assert.deepEqual(
      written,
      [],
      `${name} writes the landing's headline figures (${written.join(", ")}); `
      + "only paintHeroStats may, or another chain's file overwrites the hero",
    );
  }

  // And the hero's painter must still write all of them. The four captions go
  // through SHIELDED_LABELS rather than as literals, so they are checked through
  // the table — a split that silently stopped writing one caption would leave a
  // number with the wrong word under it, which reads as a different number.
  const heroBody = sliceFunction(app, "paintHeroStats");
  for (const id of HERO_FIGURES) {
    assert.ok(heroBody.includes(`el("${id}")`), `paintHeroStats no longer writes #${id}`);
  }
  assert.match(heroBody, /Object\.entries\(SHIELDED_LABELS\)/,
    "paintHeroStats no longer writes the four captions");

  const captions = [...app.matchAll(/"(s-[\w-]+-k)":/g)].map((m) => m[1]).sort();
  assert.deepEqual(captions, [...HERO_CAPTIONS].sort(),
    "SHIELDED_LABELS no longer names exactly the four hero captions");
});

test("every count the dashboard prints is formatted in the document's language", () => {
  // A bare toLocaleString() follows the READER's locale. The page declares
  // lang="en", and on a Spanish-locale machine the landing's headline read
  // "125.772 pool events indexed" — a thousands separator that an English reader
  // reads as a decimal point. The published screenshots carried it, which is what
  // makes it worth a test: a figure whose meaning changes with the reader's
  // region is the exact class of number this project cannot ship.
  const bare = [...app.matchAll(/\.toLocaleString\(\s*\)/g)].map((m) => m[0]);
  assert.deepEqual(bare, [], `${bare.length} bare toLocaleString() calls remain`);
  assert.match(
    app,
    /const num = \(value\) => Number\(value\)\.toLocaleString\("en-US"\)/,
    "num() no longer pins the locale, so every count is reader-dependent again",
  );
});

test("every field app.js reads off a shielded measurement exists in the JSON", () => {
  // Two painters read a shielded measurement now: the instrument's meter and the
  // landing's hero. They were one function until the site split in two, and the
  // hero's fields would have stopped being checked the moment they moved — a
  // test that silently covers less than it used to is worse than no test.
  const paths = [...new Set([
    ...measurementPaths(sliceFunction(app, "paintShieldedMeasurement")),
    ...measurementPaths(sliceFunction(app, "paintHeroStats")),
  ])];
  assert.ok(paths.includes("humanScaleOnly.models"),
    `the extractor no longer sees nested paths (found: ${paths.join(", ")})`);

  for (const file of ["data/measurement.json", "data/measurement-mainnet.json"]) {
    const json = JSON.parse(read(file));
    const missing = paths.filter((p) => !hasPath(json, p));
    assert.deepEqual(
      missing,
      [],
      `${file} does not contain fields that app.js reads: ${missing.join(", ")}`,
    );
  }
});

test("each page offers exactly the chains it can render", () => {
  // MEASUREMENTS is what the two <select>s and the loader are driven by, so a
  // chain wired into one and not the other is a dead option or a 404.
  //
  // The split made the two selects different on purpose: the instrument's meter
  // offers every chain, and the landing's finding offers only the chains with no
  // shielded pool, because that is the section's subject. So each is checked
  // against what its own page can render, not against the other.
  const keysOf = (kind) => [...app.matchAll(
    new RegExp(`(\\w+):\\s*\\{[^}]*kind:\\s*"${kind}"[^}]*\\}`, "g"),
  )].map((m) => m[1]).sort();

  const evmKeys = keysOf("evm");
  const shieldedKeys = keysOf("shielded");
  assert.ok(evmKeys.length >= 3, `expected at least three EVM chains, found ${evmKeys.length}`);
  assert.ok(shieldedKeys.length >= 2,
    `expected at least two shielded chains, found ${shieldedKeys.length}`);

  for (const key of [...evmKeys, ...shieldedKeys]) {
    assert.ok(appPage.includes(`value="${key}"`),
      `${key} is in MEASUREMENTS but the instrument's meter does not offer it`);
  }
  for (const key of evmKeys) {
    assert.ok(html.includes(`value="${key}"`),
      `${key} has no shielded pool, so the landing's finding should offer it`);
  }
  for (const key of shieldedKeys) {
    assert.ok(!html.includes(`value="${key}"`),
      `the landing's finding offers ${key}, but its subject is chains with NO shielded pool`);
  }

  // And each EVM measurement says so itself, rather than being inferred from
  // the chain name — that inference is what broke when a second chain arrived.
  for (const file of EVM_MEASUREMENTS) {
    assert.equal(JSON.parse(read(file)).kind, "evm", `${file} is missing kind: "evm"`);
  }
});

// --- numbers typed by hand versus numbers computed ---------------------------
// The window-in-blocks figure is computed by measure-evm.mjs and also written
// into prose. It was typed as ±166 in five places while the measurement said
// ±167, which is the exact failure this project exists to catch: a hand-copied
// number that nobody recomputes. These two tests make the copies checkable.

test("the HTML fallback for window-in-blocks matches the measurement", () => {
  const m = JSON.parse(read("data/measurement-robinhood.json"));
  const expected = `±${m.comparison.thisChain.windowInBlocks}`;
  const match = html.match(/id="rh-window-blocks"[^>]*>([^<]+)</);
  assert.ok(match, "rh-window-blocks not found in index.html");
  assert.equal(match[1].trim(), expected,
    "the hardcoded fallback disagrees with the measurement it falls back to");
});

test("the prose window-in-blocks figure matches the measurement", () => {
  const m = JSON.parse(read("data/measurement-robinhood.json"));
  const expected = `±${m.comparison.thisChain.windowInBlocks}`;

  // Two shapes, because the figure is stated two ways. Each file must match at
  // least one, so a phrasing change turns this red instead of making it vacuous
  // — an earlier draft used one pattern, matched nothing in README.md or
  // method.html, and passed while checking nothing at all.
  const patterns = [
    /window,? in blocks \|[^|]*\|[^|]*?±(\d+)/g,        // table row
    /Robinhood Chain that is <strong>±(\d+) blocks/g,   // prose in method.html
  ];

  for (const file of ["README.md", "docs/FINDING-multichain.md",
    "docs/FINDING-robinhood-chain.md", "method.html"]) {
    const source = read(file);
    const stated = patterns.flatMap((p) => [...source.matchAll(p)].map((x) => x[1]));
    assert.ok(stated.length > 0,
      `${file} states the window in blocks but no pattern matched it — this check is vacuous`);
    for (const value of stated) {
      assert.equal(`±${value}`, expected,
        `${file} states ±${value} for the Robinhood Chain window; the measurement says ${expected}`);
    }
  }
});

// --- the access section, which is the customer's index of entry points -------
// This section makes three claims nothing else checked: how many ways in there
// are, that each one is fully specified, and that the commands it prints exist.
// A screenshot caught it once — but the screenshot run is slow, needs a
// browser, and (as discovered while adding this) silently returns the PREVIOUS
// image when the browser writes nothing. A claim a person has to eyeball is a
// claim that decays. These are cheap and run everywhere.

const access = html.slice(html.indexOf('id="access"'));
const accGrid = access.slice(access.indexOf("acc-grid"), access.indexOf("acc-no"));
// Split on the card opener; the first chunk is everything before it.
const accCards = accGrid.split('<div class="acc-c">').slice(1);

const COUNT_WORDS = [
  "zero", "one", "two", "three", "four", "five",
  "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
];

test("the access section parses into cards", () => {
  // Every check below is vacuous if the split stops matching.
  assert.ok(accCards.length >= 4, `split found ${accCards.length} cards`);
});

test("the heading's count matches the number of cards", () => {
  const stated = html.match(/<h2 class="sec">([A-Za-z]+) ways in/);
  assert.ok(stated, "the access heading no longer states a count");
  const word = COUNT_WORDS[accCards.length];
  assert.ok(word, `no count word for ${accCards.length} cards`);
  assert.equal(
    stated[1].toLowerCase(),
    word,
    `the heading says "${stated[1]} ways in" but ${accCards.length} cards are listed`,
  );
});

test("the access cards are numbered in order, with no gap or repeat", () => {
  const numbers = accCards.map((c) => c.match(/<span class="acc-n">(\d+)<\/span>/)?.[1]);
  const expected = accCards.map((_, i) => String(i + 1).padStart(2, "0"));
  assert.deepEqual(numbers, expected);
});

test("every access card carries all four of its metric rows", () => {
  // A card that lost its "Entry" row still renders — it just stops telling you
  // how to use it, which looks like a card that was never finished.
  const rows = accCards.map((c) => (c.match(/class="acc-m"/g) ?? []).length);
  assert.deepEqual(rows, accCards.map(() => 4));
});

test("every command the access section prints exists in package.json", () => {
  // The page tells a reader to run these. A renamed script turns the entry
  // point into a dead end, and nothing else connects the page to the repo.
  const scripts = Object.keys(JSON.parse(read("package.json")).scripts);
  const printed = [...accGrid.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)].map((m) => m[1]);
  assert.ok(printed.length >= 3, `found only ${printed.length} commands to check`);
  const missing = printed.filter((s) => !scripts.includes(s));
  assert.deepEqual(missing, [], `the page prints commands that do not exist: ${missing.join(", ")}`);
});

test("the last-card span rule exists if and only if the count is odd", () => {
  // Two columns, so an odd count leaves the final card half-width and the grid
  // reads as ragged rather than as a set. An even count needs no rule — and must
  // not carry one, because a rule that does nothing is a rule that lies about
  // why it is there. Asserting both directions means the count cannot change
  // without someone deciding which case they are in.
  const rule = /\.acc-c:last-child:nth-child\(odd\)\s*\{\s*grid-column:\s*1\s*\/\s*-1;?\s*\}/;
  const reset = /@media \(max-width: 880px\) \{ \.acc-c:last-child:nth-child\(odd\) \{ grid-column: auto; \} \}/;
  const odd = accCards.length % 2 === 1;

  if (odd) {
    assert.match(html, rule, `${accCards.length} cards in a two-column grid need the last-child span rule`);
    assert.match(html, reset, "the span rule must be reset in the single-column layout");
  } else {
    assert.doesNotMatch(
      html,
      rule,
      `${accCards.length} cards fill the grid, so the last-child span rule is dead CSS`,
    );
    assert.doesNotMatch(html, reset, "the reset for a rule that no longer exists is also dead");
  }
});

// --- the test count, which drifts every time a test is added ----------------
// README said 59, then 64, then 79; method.html said the same; PUBLISH.md still
// said 14 from an early draft. Nobody updates a number in three files by hand,
// and a wrong count is a small claim that is not true — which in this project
// is the whole problem. So the number is derived from the test files instead.

test("the test count stated in the docs matches the tests that exist", () => {
  const pkg = JSON.parse(read("package.json"));
  const files = pkg.scripts.test.split(/\s+/).filter((f) => f.startsWith("tests/"));
  assert.ok(files.length >= 4, `expected several test files in the test script, got ${files.length}`);

  const actual = files.reduce(
    (n, file) => n + [...read(file).matchAll(/^test\(/gm)].length,
    0,
  );
  assert.ok(actual > 50, `derived only ${actual} tests; the extractor is probably wrong`);

  const stated = [];
  for (const file of ["README.md", "method.html", "PUBLISH.md"]) {
    for (const m of read(file).matchAll(/(\d+)\s+tests?/g)) {
      stated.push({ file, value: Number(m[1]), text: m[0] });
    }
  }
  assert.ok(stated.length > 0, "no test count found in any document — this check is vacuous");

  for (const s of stated) {
    assert.equal(s.value, actual,
      `${s.file} says "${s.text}" but ${actual} tests exist`);
  }
});

// --- the same problem, one level down: a fact that is either right or wrong ---
// The pool address was written into twelve scripts as a bare literal, under a
// comment in one of them saying "Imported, not copied". A redeployment would have
// been a change in twelve files, and the file that was missed would have kept
// measuring the OLD pool while reporting the new one — a wrong number that looks
// right. The literals now live in `src/pool.mjs` and nowhere else, and this is
// what keeps them there: a fact with one correct value for the whole network has
// exactly one home, and a second copy is the bug rather than a style question.

test("the pool and token addresses have exactly one home", () => {
  const ADDRESSES = [
    "0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91", // STRK20, sepolia
    "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a", // STRK20, mainnet
    "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d", // STRK
  ];
  const OWNER = "src/pool.mjs";

  const offenders = [];
  for (const dir of ["src", "scripts"]) {
    for (const file of readdirSync(resolve(ROOT, dir)).filter((f) => f.endsWith(".mjs"))) {
      const path = `${dir}/${file}`;
      if (path === OWNER) continue;
      const text = read(path);
      for (const address of ADDRESSES) {
        if (text.includes(address)) offenders.push(`${path} carries ${address.slice(0, 12)}…`);
      }
    }
  }

  assert.deepEqual(offenders, [], `a duplicated address is a second thing to update:\n  ${offenders.join("\n  ")}`);

  // And the owner really does hold all three, so the check above cannot pass
  // because the addresses were deleted everywhere.
  const owner = read(OWNER);
  for (const address of ADDRESSES) {
    assert.ok(owner.includes(address), `${OWNER} lost ${address.slice(0, 12)}…`);
  }
});

// --- the same problem, one level down: a count stated about a table ----------
// docs/CUSTOMER.md ends its status table with "Nineteen rows, eleven live, one
// priced, seven not built". Every one of those four numbers is derivable from
// the table directly above it, which means every one of them can go stale the
// moment a row is added — and a reader who trusts the sentence instead of
// counting is exactly the reader this project writes for. Derived, not stated.

test("the row counts stated in docs/CUSTOMER.md match the table", () => {
  const doc = read("docs/CUSTOMER.md");
  const m = doc.match(/(\w+) rows, (\w+) live, (\w+) priced, (\w+) not built/);
  assert.ok(m, "docs/CUSTOMER.md no longer states its row counts — this check is vacuous");

  const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
                  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
                  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
                  eighteen: 18, nineteen: 19, twenty: 20, twentyone: 21 };
  const [, rows, live, priced, missing] = m.map((v) => (typeof v === "string" && words[v.toLowerCase()]) || v);

  // The table is the one under the "What has to exist for the journey to work"
  // heading: pipe rows, minus the header and the separator.
  const section = doc.split("## What has to exist for the journey to work")[1];
  assert.ok(section, "the status table's section heading was renamed");
  const body = section.split("\n## ")[0];
  const data = body.split("\n").filter((l) => l.startsWith("|")).slice(2);
  assert.ok(data.length > 10, `parsed only ${data.length} rows; the extractor is probably wrong`);

  // The verdict is bolded and the bold is not closed at the same place in every
  // row — `**live**`, `**live** — ...`, `**not built.**` — so the match is on the
  // bold opening plus the phrase, not on a whole closed span.
  const count = (word) => data.filter((l) => new RegExp(`\\*\\*${word}\\b`).test(l)).length;
  const derived = { rows: data.length, live: count("live"), priced: count("priced"), missing: count("not built") };

  assert.equal(Number(rows), derived.rows, `the sentence says ${rows} rows, the table has ${derived.rows}`);
  assert.equal(Number(live), derived.live, `the sentence says ${live} live, the table has ${derived.live}`);
  assert.equal(Number(priced), derived.priced, `the sentence says ${priced} priced, the table has ${derived.priced}`);
  assert.equal(Number(missing), derived.missing, `the sentence says ${missing} not built, the table has ${derived.missing}`);

  // And the four have to add up, or the sentence is internally wrong even when
  // each part matches: a row counted twice would hide here otherwise.
  assert.equal(
    derived.live + derived.priced + derived.missing,
    derived.rows,
    "the status table has a row that is none of live, priced, or not built",
  );
});

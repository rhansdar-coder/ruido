#!/usr/bin/env node
// Render the platform to PNGs, so the README and any launch post show the real
// page rather than a description of it.
//
// Zero dependencies: this drives the Chrome or Edge already installed on the
// machine. No Puppeteer, no browser download.
//
//   npm run web &          # the script needs the site served
//   node scripts/screenshots.mjs
//   node scripts/screenshots.mjs --url http://127.0.0.1:8080 --out shots
//   node scripts/screenshots.mjs --only 06-access,06b-access-mobile
//
// --only exists because a full run is twenty browser launches, and the reason
// to re-shoot is almost always that ONE section changed. Without it, checking a
// single CSS rule costs a full run and the temptation is to not check at all —
// which is how a section ships looking ragged. The blank-size guard below
// narrows to whatever was actually captured, so a partial run still fails
// loudly on a section that rendered nothing.
//
// Four things about headless Chrome that cost real time to learn, and which
// this script encodes so nobody has to learn them twice:
//
//   1. A fresh --user-data-dir per shot. Reusing one makes Chrome silently
//      produce blank pages after the first capture. It must also be a NATIVE
//      path: a Unix-style /tmp/... path silently produces no file at all on
//      Windows, with no error on stderr.
//   2. --virtual-time-budget in the tens of thousands. The default fires the
//      screenshot before a large image has decoded or before layout settles,
//      which yields a correctly-coloured but empty frame.
//   3. Never rely on scrolling to an anchor. Scrolling is not synchronised with
//      the capture, so #section shots come back blank at random.
//   4. Never crop by hardcoded pixel offsets. An earlier version of this script
//      carried a BANDS table of y-offsets, and adding one section invalidated
//      every offset below it — producing a blank FAQ band that only showed up
//      as a suspiciously small PNG. Instead, the crop page loads the site in a
//      same-origin iframe and MEASURES where the section actually is. The
//      offsets are read from the live layout, so they cannot go stale.

import { execFile } from "node:child_process";
import { mkdir, writeFile, access, stat, rm } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const URL_BASE = arg("url", "http://127.0.0.1:8080");
const OUT = resolve(ROOT, arg("out", "shots"));
const WIDTH = Number(arg("width", 1400));
const FULL_HEIGHT = Number(arg("height", 12000));
// Empty means "everything", which is the default and the release behaviour.
const ONLY = (arg("only", "") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const wants = (name) => ONLY.length === 0 || ONLY.includes(name);

const CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

async function findBrowser() {
  for (const candidate of CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try the next one
    }
  }
  throw new Error("no Chrome or Edge found; pass --browser <path>");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A blank capture is a correctly-coloured PNG of nothing, and it looks fine in
// a file listing. A capture that failed outright is a 0-byte file, which also
// looks fine to any check that only asks "did the command exit cleanly".
//
// Chrome's screenshot path is flaky here: the same URL with the same flags
// produces a good PNG, a 0-byte file, or no file at all, seemingly at random —
// and it always exits 0 with an empty stderr. Chasing the exact flag
// combination is a losing game, so the capture is RETRIED and the result is
// checked by size. An external process that fails silently gets a retry loop,
// not a bug report.
//
// Size alone is not enough, and this is the failure that actually bit: a run
// that re-shoots ONE section writes nothing, and the check above happily
// accepts the PNG the previous run left behind. The run prints "All shots
// non-blank", exits 0, and every image is stale — a worse outcome than an
// obvious crash, because the stale image looks exactly like a fresh one.
// So the file must have been written by THIS attempt, not merely exist. The
// mtime floor is compared with a slack because filesystem timestamp
// granularity is coarser than the few hundred ms a shot takes.
const MIN_BYTES = 20_000;
const ATTEMPTS = 4;
const FRESH_SLACK_MS = 2000;

// Shots that never got a fresh write. The size check at the end of main() asks
// "is there a big PNG here", which a leftover file answers YES to — so the
// failure has to be recorded here, where freshness is known, or a completely
// broken browser still reports a clean run.
const captureFailures = [];

async function shootOnce(browser, { name, url, height, width = WIDTH, profile }) {
  const target = join(OUT, `${name}.png`);
  await run(browser, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--run-all-compositor-stages-before-draw",
    `--user-data-dir=${profile}`,
    "--virtual-time-budget=30000",
    `--window-size=${width},${height}`,
    `--screenshot=${target}`,
    url,
  ], { maxBuffer: 32 * 1024 * 1024 }).catch(() => {
    // Chrome exits non-zero on some platforms even when the shot succeeded.
  });
  return target;
}

async function shoot(browser, opts) {
  const target = join(OUT, `${opts.name}.png`);
  let lastReason = "no attempt made";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const startedAt = Date.now();
    // A fresh profile per attempt: a locked profile from a half-exited Chrome
    // is one of the ways this fails.
    await shootOnce(browser, { ...opts, profile: `${opts.profile}-a${attempt}` });
    const stats = await stat(target).catch(() => null);
    if (!stats) {
      lastReason = "no file written";
    } else if (stats.size < MIN_BYTES) {
      lastReason = `${stats.size} bytes`;
    } else if (stats.mtimeMs < startedAt - FRESH_SLACK_MS) {
      // Written before this attempt began, so Chrome wrote nothing now.
      lastReason = `stale file from a previous run (${stats.size} bytes, not rewritten)`;
    } else {
      return target;
    }
    if (attempt < ATTEMPTS) {
      console.log(`  retry ${opts.name} — attempt ${attempt} gave ${lastReason}`);
      await sleep(1200);
    }
  }
  console.error(`  FAILED ${opts.name} after ${ATTEMPTS} attempts (${lastReason})`);
  captureFailures.push(`${opts.name} (${lastReason})`);
  return target;
}

const FULLPAGE_NAME = "00-fullpage";

// The crop page reads the section's real position out of the iframe's layout.
//
// The iframe is same-origin (both served from the same host), so the parent can
// read contentDocument. The iframe is never scrolled, so the element's
// getBoundingClientRect().top IS its document offset — no scroll synchronisation
// to lose a race against the capture.
//
// `sec` names a section id; without it the page renders from the top.
// `page` names which of the site's two pages to load. The site is a landing and
// an instrument now, and a section id that lives on one is not found on the
// other — the crop would render the top of the wrong page, which looks like a
// section that lost its styling rather than like a missing parameter.
// `q` is the query string, passed through verbatim: ?find= for the landing's
// other-chains section and ?net= for the instrument's meter. It is the raw
// string rather than a network name because the two pages read different
// parameters, and a single "net" argument would have quietly done nothing on
// the page that reads "find".
//
// The iframe src is "../" + page, not "./" + page. The crop helper lives in
// shots/, and a relative "./index.html" resolves to /shots/index.html, which
// does not exist — the iframe renders a 404 and every band comes back as a
// black frame with "Not found" in the corner. "../" is also what keeps this
// working if the site is ever served from a subpath.
//
// The wait is a POLL, not two animation frames. Two rAFs were enough while the
// page had nothing to fetch; the measurement is fetched asynchronously, so the
// section could be measured and captured before the numbers arrived.
const CROP_PAGE = `<!doctype html>
<meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:#08090b;overflow:hidden}
  iframe{position:absolute;left:0;top:0;width:${WIDTH}px;border:0;display:block}
</style>
<iframe id="f"></iframe>
<script>
  const params = new URLSearchParams(location.search);
  const sec = params.get("sec");
  const page = params.get("page") || "index.html";
  const q = params.get("q");
  const f = document.getElementById("f");

  // Wait for the page to have PAINTED, not merely loaded. Each page carries a
  // different set of "is this live" lines — the landing has one in the hero and
  // one under the finding, the instrument has one under the meter — so the wait
  // is on whichever ones this document actually has. Keying it on a single id
  // (it used to be #fetch-stamp alone) meant every landing shot sat out the full
  // deadline, and a wait that always times out is a wait nobody reads.
  function settle(doc, done) {
    const ids = ["s-stamp", "fetch-stamp", "rh-stamp"];
    const deadline = Date.now() + 8000;
    (function poll() {
      const nodes = ids.map((id) => doc.getElementById(id)).filter(Boolean);
      const painted = nodes.length > 0 && nodes.every((n) => n.textContent.trim().length > 0);
      if (painted || Date.now() > deadline) return done();
      setTimeout(poll, 100);
    })();
  }

  f.addEventListener("load", () => {
    const doc = f.contentDocument;
    settle(doc, () => {
      const el = sec ? doc.getElementById(sec) : null;
      const y = el ? Math.max(0, el.getBoundingClientRect().top - 24) : 0;
      f.style.top = (-y) + "px";
      f.style.height = (doc.documentElement.scrollHeight + 400) + "px";
      document.body.dataset.ready = "1";
    });
  });

  f.src = "../" + page + (q ? "?" + q : "");
</script>
`;

// Sections to capture: [name, section id, height, query string, page]. No pixel
// offsets: the crop page measures. Adding a section means adding one line here,
// and nothing below it shifts.
//
// The page is explicit because the site is two pages now: #sim and #rdo live on
// the instrument and everything else lives on the landing. The query is explicit
// because the two pages read different parameters — ?find= for the landing's
// other-chains section, ?net= for the instrument's meter — and a single "net"
// argument would have quietly done nothing on the page that reads "find",
// capturing the default chain under a name that claims otherwise.
const SECTIONS = [
  ["01-hero", null, 1000, null, "index.html"],
  // The hero again, taller. The shot above is the viewport a visitor actually
  // lands on, and it crops the noise field at its foot — correct for "what does
  // the page look like", useless for checking the field itself. This one is
  // tall enough to hold the whole hero, band included.
  ["01b-hero-full", null, 1500, null, "index.html"],
  ["02-how", "how", 1150, null, "index.html"],
  ["03-simulator", "sim", 1250, null, "app.html"],
  ["04-compare", "compare", 1250, null, "index.html"],
  ["05-other-chains", "robinhood", 1800, "find=robinhood", "index.html"],
  // The same section on the other two chains. Not decoration: this is the
  // evidence that one section serves every chain, so a chain wired into the
  // registry but broken in the paint path is visible here.
  ["05b-other-chains-base", "robinhood", 1800, "find=base", "index.html"],
  ["05c-other-chains-eth", "robinhood", 1800, "find=ethereum", "index.html"],
  ["06-access", "access", 1900, null, "index.html"],
  ["07-rdo", "rdo", 1150, null, "app.html"],
  ["08-faq", "faq", 1250, null, "index.html"],
];

// Mobile. Every shot above is 1400px wide, and a page whose columns have
// already collapsed looks perfect at 1400px — so a layout that only breaks on a
// phone is invisible to the whole run. Two sections get a narrow render: the
// hero, because the noise field is positioned against the hero's box, and the
// access grid, because it is the one section that is a real two-column grid.
//
// The crop page is reused with its iframe width rewritten, so the offsets are
// still measured from the live layout rather than hardcoded.
const MOBILE_WIDTH = 420;
const MOBILE_PAGE = CROP_PAGE.replace(`width:${WIDTH}px`, `width:${MOBILE_WIDTH}px`);
// The hero is taller at 420px than at 1400px — the meter card drops below the
// copy instead of beside it — so this window has to be tall enough to reach the
// noise field at the hero's foot. At 1200px the shot stopped above it and the
// band, which is the whole reason this capture exists, was not in the frame.
const MOBILE_SECTIONS = [
  ["01c-hero-mobile", null, 2100, "index.html"],
  ["06b-access-mobile", "access", 3150, "index.html"],
];

// One meter render per EVM chain. ?net= is what makes the figures linkable, so
// each shot also proves the link works — and a chain wired into MEASUREMENTS
// but broken in the paint path shows up here rather than in production. These
// are full renders of the instrument rather than crops, because the network is
// chosen by the page's own JavaScript and the meter is what has to be seen.
const METERS = ["robinhood", "base", "ethereum"];

async function main() {
  const browser = arg("browser", await findBrowser());
  await mkdir(OUT, { recursive: true });
  console.log(`browser ${browser}`);
  console.log(`url     ${URL_BASE}`);
  console.log(`out     ${OUT}`);
  console.log(`only    ${ONLY.length ? ONLY.join(", ") : "(everything)"}\n`);

  // Everything actually written this run. The blank check reads this rather
  // than the full section tables, so `--only` does not fail on sections it was
  // explicitly told to skip.
  const captured = [];

  // A unique profile root per run. Reusing a directory across runs is fine
  // until a previous Chrome has not fully exited, at which point the profile is
  // locked and Chrome exits having written a ZERO-BYTE png — no error, no
  // stderr, just an empty file that passes every "did the command run" check.
  // It is removed at the end of the run.
  const runId = Date.now().toString(36);
  const profileRoot = join(process.env.TEMP ?? "/tmp", "ruido-shots", runId);

  // 1. The full page, once. Kept as an overview and as a fallback if the crop
  //    page ever breaks.
  if (wants(FULLPAGE_NAME)) {
    const full = await shoot(browser, {
      name: FULLPAGE_NAME,
      url: `${URL_BASE}/`,
      height: FULL_HEIGHT,
      profile: join(profileRoot, "fullpage"),
    });
    captured.push(FULLPAGE_NAME);
    console.log(`${FULLPAGE_NAME}      ${full}`);
  }

  // 2. The crop helper, served from the shots directory next to index.html's
  //    origin. It lives under /shots/ so the site itself stays clean, and it is
  //    gitignored and excluded from the Pages artifact.
  await writeFile(join(OUT, "crop.html"), CROP_PAGE);

  // 3. Each section, measured rather than assumed.
  for (const [name, sectionId, height, q, page] of SECTIONS) {
    if (!wants(name)) continue;
    const query = new URLSearchParams({ page });
    if (sectionId) query.set("sec", sectionId);
    if (q) query.set("q", q);
    const target = await shoot(browser, {
      name,
      url: `${URL_BASE}/shots/crop.html?${query}`,
      height,
      profile: join(profileRoot, `band-${name}`),
    });
    captured.push(name);
    console.log(
      `${name.padEnd(22)} ${page}${sectionId ? `#${sectionId}` : " (top)"}`
      + `${q ? ` ?${q}` : ""}  ${target}`,
    );
  }

  // 3b. The two sections that have to survive a narrow viewport.
  await writeFile(join(OUT, "crop-mobile.html"), MOBILE_PAGE);
  for (const [name, sectionId, height, page] of MOBILE_SECTIONS) {
    if (!wants(name)) continue;
    const query = new URLSearchParams({ page });
    if (sectionId) query.set("sec", sectionId);
    const target = await shoot(browser, {
      name,
      url: `${URL_BASE}/shots/crop-mobile.html?${query}`,
      height,
      width: MOBILE_WIDTH,
      profile: join(profileRoot, `m-${name}`),
    });
    captured.push(name);
    console.log(`${name.padEnd(20)} @${MOBILE_WIDTH}px  ${target}`);
  }

  // 4. The meter with each EVM chain selected. Separate full renders rather than
  //    crops, because the network is chosen by the page's own JavaScript.
  for (const net of METERS) {
    const name = `09-meter-${net}`;
    if (!wants(name)) continue;
    const shot = await shoot(browser, {
      name,
      url: `${URL_BASE}/app.html?net=${net}`,
      height: 1150,
      profile: join(profileRoot, `meter-${net}`),
    });
    captured.push(name);
    console.log(`${name.padEnd(20)} ${shot}`);
  }

  // 5. The methodology page. Tall, because it has grown.
  if (wants("10-method")) {
    const method = await shoot(browser, {
      name: "10-method",
      url: `${URL_BASE}/method.html`,
      height: 2400,
      profile: join(profileRoot, "method"),
    });
    captured.push("10-method");
    console.log(`10-method        ${method}`);
  }

  if (!captured.length) {
    throw new Error(`--only ${ONLY.join(",")} matched nothing; check the names against SECTIONS`);
  }

  // A blank capture is a correctly-coloured PNG of nothing, and it looks fine
  // in a file listing. Check the byte sizes, because a screenshot pipeline that
  // silently produces empty images is worse than no screenshots at all.
  //
  // Freshness was already checked per attempt; this catches the case where the
  // write happened but the page rendered nothing. Both are needed: size without
  // freshness accepts last week's image, freshness without size accepts a
  // correctly-coloured frame of an empty page.
  const blanks = [];
  for (const name of captured) {
    const stats = await stat(join(OUT, `${name}.png`)).catch(() => null);
    if (!stats || stats.size < MIN_BYTES) blanks.push(`${name} (${stats?.size ?? 0} bytes)`);
  }

  if (blanks.length || captureFailures.length) {
    if (blanks.length) {
      console.error(`\nBLANK OR MISSING: ${blanks.join(", ")}`);
      console.error("A small PNG is almost always a page that rendered nothing.");
    }
    if (captureFailures.length) {
      console.error(`\nNOT REWRITTEN: ${captureFailures.join(", ")}`);
      console.error("These PNGs exist but predate this run, so whatever is on disk is");
      console.error("from an earlier capture. The browser exited 0 having written nothing,");
      console.error("which is its normal silent failure. Fix the browser, not the images.");
    }
    await rm(profileRoot, { recursive: true, force: true }).catch(() => {});
    process.exit(1);
  }

  await rm(profileRoot, { recursive: true, force: true }).catch(() => {});

  console.log("\nAll shots non-blank. crop.html and crop-mobile.html sit next to them");
  console.log("as the crop helpers; they are not part of the site and are excluded");
  console.log("from the Pages artifact.");
}

main().catch((error) => {
  console.error(`\nFAIL: ${error.message}`);
  process.exit(1);
});

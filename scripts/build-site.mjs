// Assemble the static site that gets published, and prove the manifest is complete.
//
// The published dashboard reads ./data/measurement*.json at runtime. If one of
// those files is missing from the artifact, app.js does not crash: it catches
// the failed fetch and leaves whatever was last painted on screen. For this
// project that is the worst possible failure mode — a stale number that still
// looks live, on a page whose entire argument is that its numbers are current.
//
// So the file list is not typed twice. It is derived from app.js, which is the
// only place that knows which measurements exist, and then checked against the
// filesystem. Add a network to app.js without adding its JSON and this fails
// loudly instead of deploying a dashboard with a dead selector.
//
//   node scripts/build-site.mjs          # assemble _site/
//   node scripts/build-site.mjs --check  # verify only, write nothing
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUT = "_site";

// The dashboard itself. Both pages are here because they are one site: the
// landing links to app.html and app.html links back, so shipping one without the
// other is a broken link rather than a smaller site.
const SITE_ROOT_FILES = ["index.html", "app.html", "method.html", "app.js"];

// Copied whole. `src/` is not optional: app.js imports it as ES modules at
// runtime, so a missing src/ is a blank page rather than a degraded one.
const SITE_DIRS = ["src", "assets"];

// Pull the measurement paths out of app.js. Kept as a pure function so it can
// be tested against a synthetic source, not only against the real file.
export function referencedMeasurements(source) {
  return [...source.matchAll(/file:\s*"\.\/(data\/[^"]+)"/g)].map((m) => m[1]);
}

export async function planArtifact(root = ROOT) {
  const appJs = await readFile(join(root, "app.js"), "utf8");
  const measurements = [...new Set(referencedMeasurements(appJs))].sort();

  const missing = [];
  for (const f of SITE_ROOT_FILES) if (!existsSync(join(root, f))) missing.push(f);
  for (const d of SITE_DIRS) if (!existsSync(join(root, d))) missing.push(`${d}/`);
  for (const m of measurements) if (!existsSync(join(root, m))) missing.push(m);
  if (measurements.length === 0) missing.push("app.js references no measurements");

  // A measurement on disk that nothing loads is dead weight in the artifact —
  // and, worse, it is a file that looks like a published claim but is not one.
  const dataDir = join(root, "data");
  const onDisk = existsSync(dataDir)
    ? (await readdir(dataDir)).filter((e) => /^measurement.*\.json$/.test(e)).map((e) => `data/${e}`).sort()
    : [];
  const unreferenced = onDisk.filter((f) => !measurements.includes(f));

  return { rootFiles: SITE_ROOT_FILES, dirs: SITE_DIRS, measurements, missing, unreferenced };
}

export async function buildSite(root = ROOT, outDir = OUT) {
  const plan = await planArtifact(root);
  if (plan.missing.length > 0) {
    throw new Error(`artifact is incomplete, missing: ${plan.missing.join(", ")}`);
  }

  const target = join(root, outDir);
  await rm(target, { recursive: true, force: true });
  await mkdir(join(target, "data"), { recursive: true });

  for (const f of plan.rootFiles) await cp(join(root, f), join(target, f));
  for (const d of plan.dirs) await cp(join(root, d), join(target, d), { recursive: true });
  for (const m of plan.measurements) await cp(join(root, m), join(target, m));

  // Pages serves 404s for unknown paths; without this, a typo in a link is a
  // GitHub-branded error page instead of the site. Jekyll is also disabled
  // here, because a leading underscore in `_site` would otherwise make the
  // runner skip files it is supposed to publish.
  await writeFile(join(target, ".nojekyll"), "");

  return plan;
}

const isEntry = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntry) {
  const checkOnly = process.argv.includes("--check");
  const plan = await planArtifact();

  console.log("artifact manifest");
  console.log(`  root files    ${plan.rootFiles.join(", ")}`);
  console.log(`  directories   ${plan.dirs.map((d) => `${d}/`).join(", ")}`);
  console.log(`  measurements  ${plan.measurements.length}`);
  for (const m of plan.measurements) console.log(`                  ${m}`);

  if (plan.unreferenced.length > 0) {
    console.log(`\n  unreferenced (on disk, loaded by nothing): ${plan.unreferenced.join(", ")}`);
  }

  if (plan.missing.length > 0) {
    console.error(`\nFAIL  missing: ${plan.missing.join(", ")}`);
    process.exit(1);
  }

  if (checkOnly) {
    console.log("\nok    manifest complete, nothing written");
    process.exit(0);
  }

  const built = await buildSite();
  console.log(`\nok    wrote ${OUT}/ (${built.measurements.length} measurements)`);
}

// Tests for the published artifact's manifest.
//
// The thing being protected is a silent failure. app.js loads each network's
// measurement with fetch and, on error, keeps the previously painted figures on
// screen. So a measurement missing from the deployed artifact does not produce a
// broken page — it produces a page that shows a number from a different build,
// with no visible difference. That is the one bug this project cannot afford,
// because the whole method is "these numbers are current and reproducible".

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { planArtifact, referencedMeasurements } from "../scripts/build-site.mjs";
import { cropRefusal } from "../scripts/screenshots.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("referencedMeasurements reads the paths app.js actually fetches", () => {
  const source = `
    const MEASUREMENTS = {
      sepolia: { label: "STRK20", file: "./data/measurement.json", kind: "shielded" },
      base:    { label: "Base",   file: "./data/measurement-base.json", kind: "evm" },
    };
  `;
  assert.deepEqual(referencedMeasurements(source), [
    "data/measurement.json",
    "data/measurement-base.json",
  ]);
});

test("referencedMeasurements ignores paths that are not measurements", () => {
  // A future edit that fetches an unrelated JSON must not be mistaken for a
  // claim, and must not be required in the artifact.
  const source = `
    fetch("./data/corpus.json");
    const x = { file: "./assets/logo.svg" };
    const y = { file: "./data/measurement.json" };
  `;
  assert.deepEqual(referencedMeasurements(source), ["data/measurement.json"]);
});

test("the real app.js and the real filesystem agree", async () => {
  const plan = await planArtifact(ROOT);
  assert.deepEqual(plan.missing, [], `artifact would be incomplete: ${plan.missing.join(", ")}`);
  assert.deepEqual(
    plan.unreferenced,
    [],
    `measurement on disk that nothing loads: ${plan.unreferenced.join(", ")}`,
  );
  // Five networks are published. If one is dropped this fails rather than
  // quietly shipping a dashboard with a missing chain.
  assert.equal(plan.measurements.length, 5);
  assert.ok(plan.measurements.includes("data/measurement.json"));
  assert.ok(plan.measurements.includes("data/measurement-mainnet.json"));
});

test("a missing measurement is reported, not silently skipped", async () => {
  // Non-vacuous check: build a root that is missing one measurement and assert
  // the plan names it. Without this the test above could pass on an empty plan.
  const root = await mkdtemp(join(tmpdir(), "ruido-site-"));
  try {
    await mkdir(join(root, "data"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "assets"), { recursive: true });
    for (const f of ["index.html", "app.html", "method.html"]) {
      await writeFile(join(root, f), "<html></html>");
    }
    await writeFile(
      join(root, "app.js"),
      `const M = { file: "./data/measurement.json" };`,
    );
    // measurement.json is referenced but not written.

    const plan = await planArtifact(root);
    assert.deepEqual(plan.missing, ["data/measurement.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an orphan measurement on disk is reported", async () => {
  const root = await mkdtemp(join(tmpdir(), "ruido-site-"));
  try {
    await mkdir(join(root, "data"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "assets"), { recursive: true });
    for (const f of ["index.html", "app.html", "method.html"]) {
      await writeFile(join(root, f), "<html></html>");
    }
    await writeFile(join(root, "app.js"), `const M = { file: "./data/measurement.json" };`);
    await writeFile(join(root, "data/measurement.json"), "{}");
    await writeFile(join(root, "data/measurement-solana.json"), "{}");

    const plan = await planArtifact(root);
    assert.deepEqual(plan.missing, []);
    assert.deepEqual(plan.unreferenced, ["data/measurement-solana.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The screenshot pipeline's crop guard.
//
// This is the same class of bug as the manifest above, and worse. The crop
// helper is same-origin by construction, so pointing the script at a published
// origin turns every section request into a 404 — and a 404 page is a real,
// correctly-coloured, non-blank page. It passes the size guard, and the run ends
// with eighteen captures of "File not found" and a confident "All shots
// non-blank". The guard is what stops that, so the guard is what gets tested.

test("the crop guard allows every spelling of the local machine", () => {
  // 127.0.0.0/8 is all loopback, and the bracketed IPv6 form is what a URL
  // actually carries. A guard that only knew 127.0.0.1 would refuse a perfectly
  // local server on 127.0.0.5.
  for (const base of [
    "http://127.0.0.1:8080",
    "http://127.0.0.5:8080",
    "http://localhost:8080",
    "http://[::1]:8080",
  ]) {
    assert.equal(cropRefusal(base, ["06-access"]), null, `${base} should be croppable`);
  }
});

test("the crop guard refuses a published origin and names the shots it would have faked", () => {
  const refusal = cropRefusal("https://rhansdar-coder.github.io/ruido", [
    "06-access",
    "10-method",
  ]);
  assert.notEqual(refusal, null);
  assert.equal(refusal.host, "rhansdar-coder.github.io");
  // Naming them matters: the message is the only thing that tells the reader
  // which captures were about to be photographs of an error page.
  assert.deepEqual(refusal.names, ["06-access", "10-method"]);
});

test("the crop guard refuses a base it cannot parse", () => {
  // Fail closed. A base we could not read is not a base we showed to be ours,
  // and guessing "probably local" is how a 404 ends up in shots/.
  assert.notEqual(cropRefusal("not a url", ["06-access"]), null);
  assert.notEqual(cropRefusal("", ["06-access"]), null);
});

test("the crop guard allows a run that asked for no crop shots", () => {
  // The full page, the meters and method.html are plain renders of a URL, so a
  // remote origin is fine for those. Refusing the whole run would have made the
  // guard an obstacle to the one remote check that does work.
  assert.equal(cropRefusal("https://rhansdar-coder.github.io/ruido", []), null);
});

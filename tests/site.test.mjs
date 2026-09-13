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

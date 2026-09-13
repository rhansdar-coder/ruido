#!/usr/bin/env node
// The four steps, over the real HTTP surface, in one process.
//
//   npm run verify:journey
//
// ## Why this exists next to tests/reveal.test.mjs
//
// That file tests `admitReveal`, which is the *decision*. It never opens a
// socket. So the whole route — the status codes, the JSON bodies, the client
// sending `atBlock` and `cell` at all, the provider pinning its own height —
// was covered by nothing, and the failure it produced was a `ReferenceError` at
// startup that no unit test could see.
//
// This is the same division the project already uses elsewhere: `npm test` is
// pure and fast, and the `verify:*` scripts are the ones that need a live
// process. It spawns the reference provider, drives `scripts/buy.mjs` and
// `scripts/reveal.mjs` against it as child processes, and asserts on what comes
// back. Nothing touches a chain.
//
// ## What it checks that nothing else does
//
//   1. The client refuses to publish while the window is open — exit 1, and the
//      reveal does not appear on stdout even in `--json` mode.
//   2. The provider refuses the same reveal when ITS height says the window is
//      open, even though the buyer asserted one where it had closed. The
//      interested party does not get to be the only witness.
//   3. With no `--at`, the settlement is labelled `heightSource: "buyer"` and
//      says the height was not verified.
//   4. `--json` emits one parseable object and nothing else, so a script can
//      consume it.
//   5. The order file `buy --out` writes is enough for step four to run, which
//      is what makes the four steps a journey rather than four commands.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NODE = process.execPath;

const FROM = 14_865_231;
const WIDTH = 20;
const WINDOW_TO = FROM + WIDTH;
const INSIDE = FROM + 5;
const AFTER = WINDOW_TO + 1;
const CELL = "1.93";
const RUNG = "10";

let failures = 0;
const ok = (label, detail = "") => console.log(`  \x1b[32mok\x1b[0m   ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
const bad = (label, detail = "") => {
  failures += 1;
  console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? `  ${detail}` : ""}`);
};
const check = (condition, label, detail = "") => (condition ? ok(label, detail) : bad(label, detail));
const rule = (title) => console.log(`\n\x1b[1m${title}\x1b[0m`);

/** A port nothing is listening on, so two runs never collide. */
async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Runs a child to completion and gives back its exit code and both streams. */
function run(script, args) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [join(ROOT, script), ...args], { cwd: ROOT });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

async function startProvider(port, extra = []) {
  const child = spawn(NODE, [join(ROOT, "scripts/serve-provider.mjs"), "--port", String(port), ...extra], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (c) => (log += c));
  child.stderr.on("data", (c) => (log += c));

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the provider exited before it listened:\n${log}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/terms`);
      if (response.ok) return { child, log: () => log, url: `http://127.0.0.1:${port}` };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`the provider never answered on ${port}:\n${log}`);
}

const scratch = await mkdtemp(join(tmpdir(), "ruido-journey-"));
const orderFile = join(scratch, "order.json");
const servers = [];

try {
  // --- the provider's own gate ------------------------------------------------
  // Pinned INSIDE the window, so its view disagrees with a buyer who claims the
  // window has closed. That disagreement is the whole point of the check.

  rule("A provider pinned inside the window (--at " + INSIDE + ")");

  {
    const port = await freePort();
    const server = await startProvider(port, ["--at", String(INSIDE)]);
    servers.push(server.child);

    const terms = await (await fetch(`${server.url}/terms`)).json();
    check(terms.endpoints.reveal?.includes("reveal"), "the terms advertise the reveal route", terms.endpoints.reveal ?? "—");
    check(/pinned at block/.test(terms.heightSource ?? ""), "the terms say the height is pinned", terms.heightSource ?? "—");

    // Step 2 and 3: order, and pay.
    const bought = await run("scripts/buy.mjs", [
      "--provider", server.url,
      "--cell", CELL,
      "--bits", "3",
      "--from", String(FROM),
      "--width", String(WIDTH),
      "--denomination", RUNG,
      "--tx", "0xsmoke",
      "--out", orderFile,
    ]);
    check(bought.code === 0, "npm run buy completes against the provider", `exit ${bought.code}`);
    check(/NOT SENT/.test(bought.out), "the client prints that the rung was not sent");

    const record = JSON.parse(await readFile(orderFile, "utf8"));
    check(Object.keys(record.reveal).length === 4, "the order file carries the full reveal", Object.keys(record.reveal).join(", "));
    check(record.priced?.targetCell === Number(CELL), "the order file records the cell it was priced against", String(record.priced?.targetCell));
    check(record.payment?.paid?.txHash === "0xsmoke", "the order file records the payment, not just the invoice", String(record.payment?.paid?.txHash));

    const status = await (await fetch(`${server.url}/orders/${record.order.id}`)).json();
    check(status.state === "emitted", "the provider moved the order to emitted", status.state);
    check(Array.isArray(status.plan) && status.plan.length > 0, "the plan is released once paid");
    check(!JSON.stringify(status).includes(`"denomination":${RUNG}`), "the provider's own record of the order carries no rung");

    // Step 4a: the CLIENT's gate. The buyer asks to publish on a block inside
    // the window and must be refused locally, without contacting anyone.
    const early = await run("scripts/reveal.mjs", ["--order", orderFile, "--at", String(INSIDE), "--json"]);
    check(early.code === 1, "the client exits non-zero while the window is open", `exit ${early.code}`);
    check(/REFUSING TO PUBLISH/.test(early.err), "the refusal is explained on stderr");

    // In `--json` mode the refusal is a machine-readable report on stdout, not
    // silence — a script has to be able to parse "no, and here is why". What
    // must NOT be there is the reveal: a gate that holds on the human path and
    // leaks on the one people script is not a gate.
    let refusal = null;
    try {
      refusal = JSON.parse(early.out);
      ok("--json emits a parseable refusal on stdout");
    } catch (error) {
      bad("--json emits a parseable refusal on stdout", error.message);
    }
    check(refusal?.publishable === false, "the refusal report says it is not publishable");
    check(refusal?.reveal === null, "the refusal report carries NO reveal", String(refusal?.reveal));
    check(
      refusal?.waitBlocks === WINDOW_TO + 1 - INSIDE,
      "the refusal report says how many blocks to wait",
      String(refusal?.waitBlocks),
    );

    // Step 4b: the PROVIDER's gate. The buyer asserts a height past the window;
    // the provider was pinned inside it and must not take the buyer's word.
    const overruled = await run("scripts/reveal.mjs", [
      "--order", orderFile,
      "--provider", server.url,
      "--at", String(AFTER),
      "--json",
    ]);
    check(overruled.code === 1, "the provider refuses a reveal the buyer thinks is safe", `exit ${overruled.code}`);
    check(/still open/.test(overruled.err), "the provider's refusal names the open window", overruled.err.trim().split("\n").pop() ?? "");

    server.child.kill();
  }

  // --- the honest labelling ---------------------------------------------------
  // Same journey, but the provider has no chain source. It settles on the
  // buyer's number and says so, because a check that quietly degrades into a
  // formality is worse than no check.

  rule("A provider with no chain source (no --at)");

  {
    const port = await freePort();
    const server = await startProvider(port, []);
    servers.push(server.child);

    const record = JSON.parse(await readFile(orderFile, "utf8"));
    // A fresh order: the provider above is gone and this one has never seen it.
    const bought = await run("scripts/buy.mjs", [
      "--provider", server.url,
      "--cell", CELL,
      "--bits", "3",
      "--from", String(FROM),
      "--width", String(WIDTH),
      "--denomination", RUNG,
      "--tx", "0xsmoke2",
      "--out", orderFile,
    ]);
    check(bought.code === 0, "the journey runs again against a second provider", `exit ${bought.code}`);

    const settled = await run("scripts/reveal.mjs", [
      "--order", orderFile,
      "--provider", server.url,
      "--at", String(AFTER),
      "--json",
    ]);
    check(settled.code === 0, "the reveal settles once the window has closed", `exit ${settled.code}`);

    let report = null;
    try {
      report = JSON.parse(settled.out);
      ok("--json emits one parseable object and nothing else");
    } catch (error) {
      bad("--json emits one parseable object and nothing else", error.message);
    }

    if (report) {
      const s = report.settlement?.settlement;
      check(report.settlement?.heightSource === "buyer", "the settlement says where the height came from", String(report.settlement?.heightSource));
      check(/NOT verified/.test(report.settlement?.heightNote ?? ""), "the settlement admits the height was not verified");
      check(s?.emitted === 0, "nothing was emitted, so nothing is counted", String(s?.emitted));
      check(s?.bits === 0, "no bits are credited for work that did not happen", String(s?.bits));
      check(s?.shortfall === 3, "the shortfall is the whole promise, stated as a number", String(s?.shortfall));
      check(/nothing has been emitted/.test(report.settlement?.emission ?? ""), "the emission field says the plan was never broadcast");
    }

    // Idempotent over HTTP, which is the bug the unit test found in the
    // decision: a re-send after settlement must not come back as a 409.
    const again = await run("scripts/reveal.mjs", [
      "--order", orderFile,
      "--provider", server.url,
      "--at", String(AFTER),
      "--json",
    ]);
    check(again.code === 0, "a re-sent reveal still succeeds", `exit ${again.code}`);
    let second = null;
    try {
      second = JSON.parse(again.out);
    } catch {
      // reported by the check below
    }
    check(second?.settlement?.duplicate === true, "the re-send is reported as a duplicate, not refused");

    server.child.kill();
  }

  // --- a provider asked to verify, and unable to ------------------------------
  // `--verify` is the only arrangement where the provider is not taking anyone's
  // word for the height. The property under test is what happens when it cannot
  // deliver: it must REFUSE, and must not quietly fall back to the buyer's
  // number. Falling back would leave the operator believing a check ran, which
  // is the same failure as a stale figure with a worse consequence.

  rule("A provider told to verify, with the chain unreachable");

  {
    const port = await freePort();
    // A port nothing is listening on. That is also what a public endpoint having
    // a bad day looks like from here, without depending on one having one.
    const deadPort = await freePort();
    const server = await startProvider(port, ["--verify", "--rpc", `http://127.0.0.1:${deadPort}/rpc`]);
    servers.push(server.child);

    const terms = await (await fetch(`${server.url}/terms`)).json();
    check(
      /REFUSES the settlement/.test(terms.heightSource ?? ""),
      "the terms warn that a failed read refuses",
      terms.heightSource ?? "—",
    );

    const bought = await run("scripts/buy.mjs", [
      "--provider", server.url,
      "--cell", CELL,
      "--bits", "3",
      "--from", String(FROM),
      "--width", String(WIDTH),
      "--denomination", RUNG,
      "--tx", "0xsmoke3",
      "--out", orderFile,
    ]);
    check(bought.code === 0, "the order is still accepted while the chain is unreachable", `exit ${bought.code}`);

    const refused = await run("scripts/reveal.mjs", [
      "--order", orderFile,
      "--provider", server.url,
      "--at", String(AFTER),
      "--json",
    ]);
    check(refused.code === 1, "the reveal is refused when the height cannot be read", `exit ${refused.code}`);
    check(/could not be read/.test(refused.err), "the refusal names the unreadable height");
    check(/will not fall back/.test(refused.err), "the refusal says it will not fall back to the buyer's number");

    // And nothing was settled. A refusal that still wrote a claim would let the
    // next attempt find its own decoys already taken.
    const record = JSON.parse(await readFile(orderFile, "utf8"));
    const status = await (await fetch(`${server.url}/orders/${record.order.id}`)).json();
    check(status.state === "emitted", "the order is left unsettled, not half-settled", status.state);
    check(status.settlement === null, "no settlement was recorded on a refused reveal");

    server.child.kill();
  }
} catch (error) {
  bad("the journey ran at all", error.message);
} finally {
  for (const child of servers) {
    if (child.exitCode === null) child.kill();
  }
  await rm(scratch, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? "\n\x1b[32mThe four steps close over HTTP.\x1b[0m  measure → order → transact → reveal, no chain.\n"
    : `\n\x1b[31m${failures} check${failures === 1 ? "" : "s"} failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);

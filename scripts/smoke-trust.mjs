#!/usr/bin/env node
// Who may talk to a provider, over the real HTTP surface.
//
//   npm run verify:trust
//
// ## Why this exists next to tests/trust.test.mjs
//
// That file tests the rules: what counts as loopback, what the limiter does with
// a backwards clock, which routes are public. It never opens a socket and it
// never starts a process, so it cannot see the two failures that matter most:
//
//   1. **The bind guard never runs.** `assertBindable` throwing is not the same
//      as the process refusing to start — the throw has to be reached, before
//      the socket exists, and the exit code has to be non-zero. A guard that is
//      called after `listen()` is a guard that is too late.
//   2. **The limiter is in the wrong place.** Running it after the token check
//      leaves a caller guessing a token unlimited, which is the party the
//      limiter exists for. Nothing but a live server can show the order.
//
// The `X-Forwarded-For` check below is the one worth reading twice: it is the
// difference between a limiter and a limiter-shaped decoration.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NODE = process.execPath;
const TOKEN = "s3cret-token-for-the-smoke-test";

let failures = 0;
const ok = (label, detail = "") => console.log(`  \x1b[32mok\x1b[0m   ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
const bad = (label, detail = "") => {
  failures += 1;
  console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? `  ${detail}` : ""}`);
};
const check = (condition, label, detail = "") => (condition ? ok(label, detail) : bad(label, detail));
const rule = (title) => console.log(`\n\x1b[1m${title}\x1b[0m`);

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/** Runs the provider to completion. Used for the cases where it must refuse. */
function runToExit(args) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [join(ROOT, "scripts/serve-provider.mjs"), ...args], { cwd: ROOT });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

async function startProvider(port, args = []) {
  const child = spawn(NODE, [join(ROOT, "scripts/serve-provider.mjs"), "--port", String(port), ...args], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (c) => (log += c));
  child.stderr.on("data", (c) => (log += c));

  // Waited for on the process's own announcement, NOT by polling `/health`.
  // `/health` is a request and the limiter counts requests, so a readiness probe
  // that polls would spend part of every allowance below and make each expected
  // number depend on how many times the harness happened to poll. The banner is
  // printed in the `listen` callback, so it is the honest signal.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the provider exited before it listened:\n${log}`);
    if (/listening on http:\/\//.test(log)) return { child, url: `http://127.0.0.1:${port}`, log: () => log };
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill();
  throw new Error(`the provider never announced a listener on ${port}:\n${log}`);
}

/** A request, with the token omitted unless asked for. */
const call = (url, path, { method = "GET", token = null, headers = {}, body = null } = {}) =>
  fetch(`${url}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body ? { body } : {}),
  });

const children = [];

try {
  // --- the bind guard, which has to happen before the socket exists ----------

  rule("A provider exposed without a token refuses to start");

  {
    const bare = await runToExit(["--host", "0.0.0.0", "--port", String(await freePort())]);
    check(bare.code === 1, "it exits non-zero", `exit ${bare.code}`);
    check(/refusing to listen on 0\.0\.0\.0 without a token/.test(bare.err), "and says why");
    check(/--token <secret>/.test(bare.err), "and says what to do instead");
    check(!/listening on/.test(bare.out), "and it never got as far as listening");
  }

  {
    const port = await freePort();
    const exposed = await startProvider(port, ["--host", "0.0.0.0", "--token", TOKEN]);
    children.push(exposed.child);
    check(/REACHABLE FROM OUTSIDE/.test(exposed.log()), "with a token it does start, and says it is exposed");
    check(/reachable from outside the machine/.test(exposed.log()), "and warns about what that means");
    exposed.child.kill();
  }

  {
    const loopback = await startProvider(await freePort(), []);
    children.push(loopback.child);
    check(/loopback only/.test(loopback.log()), "loopback without a token is still allowed, and labelled");
    check(/No --token: every route is open/.test(loopback.log()), "and says so out loud");
    loopback.child.kill();
  }

  // --- the doors, on a provider that has a token ----------------------------

  rule("A provider with a token serves the price list to anyone and the rest to no one");

  const port = await freePort();
  const provider = await startProvider(port, ["--token", TOKEN, "--at", "14865236", "--address", "0xabc"]);
  children.push(provider.child);

  {
    const terms = await call(provider.url, "/terms");
    check(terms.status === 200, "/terms is public, because a book has to be able to read it", `HTTP ${terms.status}`);
    const health = await call(provider.url, "/health");
    check(health.status === 200, "/health is public, so monitoring and reachability probes work", `HTTP ${health.status}`);
    const report = await health.json();
    check(report.authRequired === true, "and it reports that this provider needs a token");
    check(!("address" in report), "and it hands out no address of its own", Object.keys(report).join(","));
  }

  {
    const closed = [
      ["POST", "/orders", "{}"],
      ["GET", "/orders", null],
      ["GET", "/orders/0xabc", null],
      ["POST", "/orders/0xabc/payment", "{}"],
      ["POST", "/orders/0xabc/reveal", "{}"],
    ];
    for (const [method, path, body] of closed) {
      const response = await call(provider.url, path, { method, body });
      check(response.status === 401, `${method} ${path} needs a token`, `HTTP ${response.status}`);
    }
  }

  {
    const response = await call(provider.url, "/orders", { method: "POST", body: "{}" });
    check(/^Bearer/.test(response.headers.get("www-authenticate") ?? ""), "the refusal names the scheme", response.headers.get("www-authenticate") ?? "—");
    const body = await response.json();
    check(/Bearer <token>/.test(body.how ?? ""), "and says how to send one");
    check(body.public?.includes("/terms"), "and lists what is public, so a client is not left guessing", body.public?.join(","));
  }

  {
    const wrong = await call(provider.url, "/orders", { method: "POST", token: "not-the-token", body: "{}" });
    check(wrong.status === 401, "a wrong token is refused", `HTTP ${wrong.status}`);
    const basic = await call(provider.url, "/orders", { method: "POST", headers: { authorization: "Basic czNjcmV0" }, body: "{}" });
    check(basic.status === 401, "another scheme is refused", `HTTP ${basic.status}`);

    // Whitespace around a field value is not part of the value — that is what
    // RFC 7235 says, and trimming it is what every server does. So a token with
    // spaces after it in the header is the same token and gets past the gate.
    const padded = await call(provider.url, "/orders", { method: "POST", token: `${TOKEN}   `, body: "{}" });
    check(padded.status === 400, "whitespace around the header value is not part of the token", `HTTP ${padded.status}`);

    const offByOne = await call(provider.url, "/orders", { method: "POST", token: TOKEN.slice(0, -1), body: "{}" });
    check(offByOne.status === 401, "a token that differs by one character is refused", `HTTP ${offByOne.status}`);

    // The right token gets past auth and fails the route's OWN validation — 400
    // for an empty order, not 401. That is what proves the gate opened.
    const right = await call(provider.url, "/orders", { method: "POST", token: TOKEN, body: "{}" });
    check(right.status === 400, "the right token gets past the gate", `HTTP ${right.status}`);
  }

  // --- the limiter ----------------------------------------------------------

  rule("The limiter, and where it sits");

  {
    // Writes are limited harder than reads, so one of each limit is exercised on
    // its own server: the point is that they are separate allowances, not that
    // some number was reached.
    const port = await freePort();
    const tight = await startProvider(port, ["--token", TOKEN, "--rate", "100", "--write-rate", "2"]);
    children.push(tight.child);

    const first = await call(tight.url, "/orders", { method: "POST", token: TOKEN, body: "{}" });
    const second = await call(tight.url, "/orders", { method: "POST", token: TOKEN, body: "{}" });
    check(first.status === 400 && second.status === 400, "the write allowance covers the first two writes", `${first.status}, ${second.status}`);

    const third = await call(tight.url, "/orders", { method: "POST", token: TOKEN, body: "{}" });
    check(third.status === 429, "the third write is refused", `HTTP ${third.status}`);
    check(Number(third.headers.get("retry-after")) > 0, "and says how long to wait", third.headers.get("retry-after") ?? "—");
    const body = await third.json();
    check(/limited harder than reads/.test(body.note ?? ""), "and explains why writes are limited harder");

    // The read allowance is untouched: a spent write budget must not stop a
    // buyer from reading the price list.
    const read = await call(tight.url, "/terms");
    check(read.status === 200, "a spent write budget does not spend the read budget", `HTTP ${read.status}`);
  }

  {
    const port = await freePort();
    const reads = await startProvider(port, ["--token", TOKEN, "--rate", "3"]);
    children.push(reads.child);

    for (let i = 1; i <= 3; i += 1) {
      const response = await call(reads.url, "/terms");
      check(response.status === 200, `read ${i} of the allowance is served`, `HTTP ${response.status}`);
    }
    const fourth = await call(reads.url, "/terms");
    check(fourth.status === 429, "the read past the allowance is refused", `HTTP ${fourth.status}`);
    const body = await fourth.json();
    check(/from the socket, not from a header/.test(body.note ?? ""), "and says where the key came from");
  }

  {
    // The one that separates a limiter from a limiter-shaped decoration. If
    // `X-Forwarded-For` were honoured, each of these would be a fresh bucket and
    // the limit would be trivially bypassed by anyone who can set a header.
    const port = await freePort();
    const spoofable = await startProvider(port, ["--token", TOKEN, "--rate", "1"]);
    children.push(spoofable.child);

    const first = await call(spoofable.url, "/terms", { headers: { "x-forwarded-for": "1.1.1.1" } });
    check(first.status === 200, "the first read is served", `HTTP ${first.status}`);

    const second = await call(spoofable.url, "/terms", { headers: { "x-forwarded-for": "2.2.2.2" } });
    check(
      second.status === 429,
      "a different X-Forwarded-For does NOT get a fresh bucket",
      `HTTP ${second.status}`,
    );
    // Checked against the VALUES that were sent, not the header's name — the
    // startup banner prints a note about `X-Forwarded-For`, so searching the log
    // for the name would fail on a provider that never read it.
    const log = spoofable.log();
    check(
      !log.includes("1.1.1.1") && !log.includes("2.2.2.2"),
      "and the addresses in the header never reached the provider's log",
    );
  }

  {
    // Rate limiting runs BEFORE the token check, so guessing is limited too. If
    // it ran after, an attacker could try tokens as fast as the network allows
    // and an honest client would be the only one ever limited.
    const port = await freePort();
    const guessing = await startProvider(port, ["--token", TOKEN, "--write-rate", "2"]);
    children.push(guessing.child);

    const attempts = [];
    for (let i = 0; i < 3; i += 1) {
      attempts.push(await call(guessing.url, "/orders", { method: "POST", token: `guess-${i}`, body: "{}" }));
    }
    check(attempts[0].status === 401 && attempts[1].status === 401, "two wrong tokens are refused as wrong", attempts.map((a) => a.status).join(","));
    check(attempts[2].status === 429, "the third is refused as too many, before the token is even looked at", `HTTP ${attempts[2].status}`);
  }

  // --- and the journey still works through the gate -------------------------

  rule("The gate does not break the protocol");

  {
    // A buyer with the token has to be able to do all four steps. This is the
    // check that the auth gate is a door and not a wall.
    const port = await freePort();
    const live = await startProvider(port, ["--token", TOKEN, "--at", "14865236", "--address", "0xabc"]);
    children.push(live.child);

    const bought = await new Promise((resolve) => {
      const child = spawn(NODE, [join(ROOT, "scripts/buy.mjs"), "--provider", live.url, "--cell", "1.93", "--bits", "3",
        "--from", "14865231", "--width", "20", "--denomination", "10", "--seed", "41", "--token", TOKEN], { cwd: ROOT });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.on("close", (code) => resolve({ code, out, err }));
    });
    check(bought.code === 0, "a client with the token can order", `exit ${bought.code}${bought.err ? `: ${bought.err.trim().slice(0, 120)}` : ""}`);

    // And a client without it cannot, and is told why rather than left with a
    // silent failure.
    const refused = await new Promise((resolve) => {
      const child = spawn(NODE, [join(ROOT, "scripts/buy.mjs"), "--provider", live.url, "--cell", "1.93", "--bits", "3",
        "--from", "14865231", "--width", "20", "--denomination", "10", "--seed", "42"], { cwd: ROOT });
      let err = "";
      child.stderr.on("data", (c) => (err += c));
      child.on("close", (code) => resolve({ code, err }));
    });
    check(refused.code === 1, "a client without the token is refused", `exit ${refused.code}`);
    check(/token/i.test(refused.err), "and the refusal mentions the token", refused.err.trim().split("\n").pop()?.slice(0, 120) ?? "—");
  }
} catch (error) {
  bad("the checks ran at all", error.message);
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
}

console.log(
  failures === 0
    ? "\n\x1b[32mThe provider can be put on a host.\x1b[0m  priced publicly, everything else by token, and limited before the token is read.\n"
    : `\n\x1b[31m${failures} check${failures === 1 ? "" : "s"} failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);

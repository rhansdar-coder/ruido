// The reconciliation, run the way an operator runs it.
//
// `reconcile()` is unit-tested and `transfersTo` is unit-tested, and neither of
// those says the CLI does anything with them. What this checks is the part that
// only exists when the pieces are wired: that the tool reads a range, keeps the
// four answers apart, and — the part that matters most — that it CANNOT report a
// list of defaulters from a range it never actually read.
//
// The chain is a local fake, so this runs with no RPC and no network.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { STRK_TOKEN, TRANSFER_SELECTOR } from "../src/payment.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NODE = process.execPath;

const RUIDO = `0x${"c0".repeat(32)}`;
const PROVIDER = "0x0119f9a1e4e3f0f0c2a1b8d7e6f5a4b3c2d1e0f1a2b3c4d5e6f708192a3b4c5d";

const ok = (label, detail = "") => console.log(`  \x1b[32mok\x1b[0m   ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
let failures = 0;
const bad = (label, detail = "") => {
  failures += 1;
  console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? `  ${detail}` : ""}`);
};
const check = (condition, label, detail = "") => (condition ? ok(label, detail) : bad(label, detail));
const rule = (title) => console.log(`\n\x1b[1m${title}\x1b[0m`);

const hex = (v) => `0x${BigInt(v).toString(16)}`;

/** One `Transfer` event, in the u256 shape OZ's Cairo 1 ERC-20 emits. */
const transfer = ({ to, value, hash, block = 100 }) => ({
  from_address: STRK_TOKEN,
  keys: [TRANSFER_SELECTOR, PROVIDER, to],
  data: [hex(BigInt(value) & ((1n << 128n) - 1n)), hex(BigInt(value) >> 128n)],
  transaction_hash: hash,
  block_number: block,
});

const TAG_MOD = 10n ** 12n;
const BASE = 450_000_000_000_000_000n;
const DUE_A = BASE + 12345n;
const DUE_B = BASE + 99999n;
const DUE_C = BASE + 55555n;

// One of each answer, plus one addressed to somebody else so the local filter
// has something to drop.
const events = [
  transfer({ to: RUIDO, value: DUE_A, hash: "0xforwarded" }),
  transfer({ to: RUIDO, value: DUE_B - 12345n, hash: "0xshort" }),
  transfer({ to: RUIDO, value: 999n, hash: "0xunmatched" }),
  transfer({ to: PROVIDER, value: DUE_C, hash: "0xnot-ours" }),
];

const ordersPath = join(ROOT, "tmp-smoke-reconcile-orders.json");
const emptyPath = join(ROOT, "tmp-smoke-reconcile-empty.json");

const run = (args) =>
  new Promise((resolve) => {
    const child = spawn(NODE, [join(ROOT, "scripts/reconcile-commission.mjs"), ...args], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
  });

const rpcServer = createServer((request, response) => {
  let raw = "";
  request.on("data", (c) => (raw += c));
  request.on("end", () => {
    const body = JSON.parse(raw);
    const payload =
      body.method === "starknet_getEvents"
        ? { jsonrpc: "2.0", id: body.id, result: { events, continuation_token: null } }
        : { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "not implemented in this fake" } };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
});

try {
  await new Promise((resolve) => rpcServer.listen(0, "127.0.0.1", resolve));
  const rpc = `http://127.0.0.1:${rpcServer.address().port}/rpc`;

  await writeFile(
    ordersPath,
    JSON.stringify([
      { orderId: "0xa1", amountDue: DUE_A.toString() },
      { orderId: "0xb1", amountDue: DUE_B.toString() },
      { orderId: "0xc1", amountDue: DUE_C.toString() },
    ]),
  );

  rule("The four answers, over a range that was actually read");

  {
    const { code, out } = await run([
      "--address", RUIDO, "--orders", ordersPath, "--from-block", "1", "--to-block", "200", "--rpc", rpc,
    ]);

    check(code === 0, "the reconciliation runs", `exit ${code}`);
    check(/scanned 4 events over 1 page/.test(out), "it says how much it looked at", (out.match(/scanned [^\n]*/) ?? ["—"])[0]);
    check(/found   3 transfers to that address/.test(out), "and how many were addressed to Ruido, out of four scanned");

    check(/0xa1\s+0\.450000000000012345 STRK\s+0xforwarded/.test(out), "an exact arrival is forwarded");
    check(/0xb1\s+short by 12345 base units/.test(out), "an arrival below by less than a tag is SHORT, and says by how much");
    check(/0xc1\s+owed 0\.450000000000055555 STRK/.test(out), "an order with nothing against it is MISSING, and says what is owed");
    check(/999 base units\s+0xunmatched/.test(out), "an arrival that fits no order is UNMATCHED");
    check(!/0xnot-ours/.test(out), "and a transfer to somebody else never appears, which is the local filter working");
    check(/1 order with no forwarding, 0\.450000000000055555 STRK unforwarded/.test(out), "the finding is summarised as an amount, because the remedy is delisting");

    // The four are reported separately rather than as one "unpaid" bucket, so
    // the one that is a reason to delist is distinguishable from the two that
    // are not.
    const shortIdx = out.indexOf("short by");
    const missingIdx = out.indexOf("owed ");
    check(shortIdx > 0 && missingIdx > 0 && shortIdx !== missingIdx, "short and missing are printed as different findings");
    check(BigInt(DUE_B - 12345n) % TAG_MOD !== 0n, "the short fixture really did drop a tag rather than a round amount");
  }

  rule("The ways it must refuse to answer");

  {
    const { code, out } = await run(["--address", RUIDO, "--from-block", "1", "--to-block", "200", "--rpc", rpc]);
    check(code === 1, "without --orders it refuses", `exit ${code}`);
    check(/reconciling against an empty list reports every provider as having paid nothing/.test(out), "and says why there is no default");
  }

  {
    await writeFile(emptyPath, "[]");
    const { code, out } = await run([
      "--address", RUIDO, "--orders", emptyPath, "--from-block", "1", "--to-block", "200", "--rpc", rpc,
    ]);
    check(code === 1, "an empty list is refused too", `exit ${code}`);
    check(/must not be able to reach by accident/.test(out), "because every provider would read as unpaid");
  }

  {
    const { code, out } = await run([
      "--address", RUIDO, "--orders", ordersPath, "--from-block", "1", "--to-block", "200", "--rpc", "http://127.0.0.1:1/rpc",
    ]);
    check(code === 1, "an unreadable chain is a refusal", `exit ${code}`);
    check(/nothing can be concluded about any order/.test(out), "and it says nobody could say, rather than reporting zero arrivals");
    check(!/0 order/.test(out), "it does NOT print a list of defaulters from a range it never read");
  }

  {
    const { code, out } = await run([
      "--address", RUIDO, "--orders", ordersPath, "--from-block", "200", "--to-block", "100", "--rpc", rpc,
    ]);
    check(code === 1, "a backwards range is refused", `exit ${code}`);
    check(/the range is empty/.test(out), "and named");
  }

  {
    const { code, out } = await run(["--orders", ordersPath, "--from-block", "1", "--to-block", "200", "--rpc", rpc]);
    check(code === 1, "without --address it refuses", `exit ${code}`);
    check(/this repository publishes no receiving address/.test(out), "and says why there is no default for it either");
  }
} catch (error) {
  bad("the reconciliation ran at all", error.message);
} finally {
  rpcServer.close();
  await rm(ordersPath, { force: true });
  await rm(emptyPath, { force: true });
}

console.log(
  failures === 0
    ? "\n\x1b[32mA missing forwarding is a finding somebody can read.\x1b[0m  retroactive, not preventive.\n"
    : `\n\x1b[31m${failures} check${failures === 1 ? "" : "s"} failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);

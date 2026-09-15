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
// back.
//
// ## Why there is a fake chain in here
//
// The payment rail reads the chain, so a rail tested only against fixtures is a
// rail nobody has watched work over HTTP. `startFakeChain` below serves the two
// JSON-RPC methods the provider asks for and can be told to refuse either one,
// which is how "the chain says no" and "the chain cannot be reached" get told
// apart from the outside.
//
// The receipt it fabricates is built from the provider's OWN invoice: it asks
// `GET /orders/:id` for the amount due and the destination, and answers with the
// transfer a correct buyer would have made. That is the honest fake — it does
// not decide what "correct" means, it repeats what the provider quoted, and the
// refusals below are produced by deliberately answering something else.
//
// ## What it checks that nothing else does
//
//   1. The client refuses to publish while the window is open — exit 1, and the
//      reveal does not appear on stdout even in `--json` mode.
//   2. The provider refuses the same reveal when ITS height says the window is
//      open, even though the buyer asserted one where it had closed.
//   3. With no `--at`, the settlement is labelled `heightSource: "buyer"` and
//      says the height was not verified.
//   4. `--json` emits one parseable object and nothing else.
//   5. The order file `buy --out` writes is enough for step four to run.
//   6. A payment is accepted only when a receipt says a transfer arrived, to
//      this provider, for the exact amount quoted — and every way of being wrong
//      is refused over HTTP with its own verdict.

import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { STRK_TOKEN, TRANSFER_SELECTOR } from "../src/payment.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NODE = process.execPath;

const FROM = 14_865_231;
const WIDTH = 20;
const WINDOW_TO = FROM + WIDTH;
const INSIDE = FROM + 5;
const AFTER = WINDOW_TO + 1;
const CELL = "1.93";
const RUNG = "10";
/** Only ever used here. A provider is paid at its own address or not at all. */
const ADDRESS = "0x0119f9a1e4e3f0f0c2a1b8d7e6f5a4b3c2d1e0f1a2b3c4d5e6f708192a3b4c5d";
const BUYER = "0x0277aa11bb22cc33dd44ee55ff6600112233445566778899aabbccddeeff0011";
const ELSEWHERE = "0x0999999999999999999999999999999999999999999999999999999999999999";

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

async function startProvider(port, extra = [], { emits = true } = {}) {
  // `--emits` by default, because every provider this smoke starts is meant to
  // be one that can serve: what is under test is the door and the whole journey,
  // and both are downstream of acceptance. A provider with no emitter refuses
  // every order at the first check, which is correct and is also the reason the
  // journey would stop at step two.
  //
  // The refusing provider gets its own section at the end, reached by passing
  // `{ emits: false }` rather than by leaving a flag off. A behaviour that is
  // only reachable by omission is a behaviour nobody exercises.
  const child = spawn(
    NODE,
    [
      join(ROOT, "scripts/serve-provider.mjs"),
      "--port",
      String(port),
      ...(emits ? ["--emits"] : []),
      ...extra,
    ],
    {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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

const hex = (value) => `0x${BigInt(value).toString(16)}`;

/**
 * A Starknet, in this process, with a switchable opinion.
 *
 * `answer` decides, per transaction hash, what the chain says happened.
 * Returning `null` is the chain saying it has never seen the hash — a different
 * answer from being unreachable, and the whole point of keeping the two apart.
 */
async function startFakeChain({ answer, refuseBlockNumber = false }) {
  const port = await freePort();
  const server = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      response.writeHead(400).end("not json");
      return;
    }

    const reply = (payload) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...payload }));
    };

    if (body.method === "starknet_blockNumber") {
      // Refusing this one is how "the height cannot be read" is produced while
      // receipts keep working — two reads, two answers, which is the whole
      // reason `--payment-rpc` exists.
      if (refuseBlockNumber) return reply({ error: { code: -32000, message: "this node does not serve block numbers" } });
      return reply({ result: 1_000_000 });
    }

    if (body.method === "starknet_getTransactionReceipt") {
      const found = await answer(body.params?.[0]);
      if (!found) return reply({ error: { code: 29, message: "Transaction hash not found" } });
      // The amount arrives as a decimal STRING: the provider serialises every
      // felt that way (BigInt does not survive JSON), so coercing here is the
      // chain's job, not the verifier's. Splitting it into the u256 pair is
      // exactly what a real ERC-20 receipt does.
      const value = BigInt(found.value);
      return reply({
        result: {
          finality_status: "ACCEPTED_ON_L2",
          execution_status: "SUCCEEDED",
          block_number: 999_001,
          events: [
            {
              from_address: STRK_TOKEN,
              keys: [TRANSFER_SELECTOR, found.from, found.to],
              data: [hex(value & ((1n << 128n) - 1n)), hex(value >> 128n)],
            },
          ],
          revert_reason: null,
        },
      });
    }

    return reply({ error: { code: -32601, message: `no such method: ${body.method}` } });
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${port}/rpc` };
}

/**
 * The chain agreeing with whatever the provider currently has open.
 *
 * It reads the provider's own invoice rather than being handed the number, so
 * this cannot pass by agreeing with a fixture that has drifted from the quote.
 * The URL arrives late — the provider is started after the chain so that the
 * chain's URL can be passed to it — hence the getter.
 */
function agreesWithProvider(getProviderUrl) {
  const answered = new Set();
  return async () => {
    const url = getProviderUrl();
    if (!url) return null;
    const list = await (await fetch(`${url}/orders`)).json();
    const invoiced = list.orders.filter((o) => o.state === "invoiced");
    // The order being asked about is the newest one this fake has not answered
    // for yet — NOT "the first invoiced order". A REFUSED payment leaves its
    // order invoiced forever, so the first invoiced order is a stale quote from
    // an earlier case, and the fake would then disagree with the provider about
    // a payment that is actually correct. The fallback covers a second read of
    // the same transaction: by then there is nothing unanswered, and the newest
    // invoiced order is still the one that was just created.
    const open = (invoiced.filter((o) => !answered.has(o.id)).pop() ?? invoiced.pop());
    if (!open) return null;
    answered.add(open.id);
    const record = await (await fetch(`${url}/orders/${open.id}`)).json();
    if (!record.payment) return null;
    // The wire carries every felt as a decimal string, so the coercion belongs
    // here — at the boundary — rather than at each of the six opinions below,
    // which would each have to remember it.
    return { from: BUYER, to: record.payment.provider, value: BigInt(record.payment.amountDue) };
  };
}

const scratch = await mkdtemp(join(tmpdir(), "ruido-journey-"));
const orderFile = join(scratch, "order.json");
const children = [];
const sockets = [];

/** One provider, optionally behind a chain, with the chain's opinion settable. */
async function scaffold({ providerArgs = [], chain = null } = {}) {
  let providerUrl = null;
  let chainServer = null;
  if (chain) {
    chainServer = await startFakeChain(chain);
    sockets.push(chainServer.server);
  }
  const port = await freePort();
  const args = [...providerArgs];
  if (chainServer) args.push("--rpc", chainServer.url);
  const provider = await startProvider(port, args);
  children.push(provider.child);
  providerUrl = provider.url;
  return { provider, providerUrl: () => providerUrl, chainServer };
}

const buy = (url, seed, tx, extra = []) =>
  run("scripts/buy.mjs", [
    "--provider", url,
    "--cell", CELL,
    "--bits", "3",
    "--from", String(FROM),
    "--width", String(WIDTH),
    "--denomination", RUNG,
    "--seed", String(seed),
    "--tx", tx,
    "--out", orderFile,
    ...extra,
  ]);

try {
  // --- the provider's own gate ------------------------------------------------
  // Pinned INSIDE the window, so its view disagrees with a buyer who claims the
  // window has closed. That disagreement is the whole point of the check.

  rule(`A provider pinned inside the window (--at ${INSIDE})`);

  {
    let url = null;
    const chain = await startFakeChain({ answer: agreesWithProvider(() => url) });
    sockets.push(chain.server);
    const port = await freePort();
    const provider = await startProvider(port, ["--at", String(INSIDE), "--address", ADDRESS, "--rpc", chain.url]);
    children.push(provider.child);
    url = provider.url;

    const terms = await (await fetch(`${provider.url}/terms`)).json();
    check(terms.endpoints.reveal?.includes("reveal"), "the terms advertise the reveal route", terms.endpoints.reveal ?? "—");
    check(/pinned at block/.test(terms.heightSource ?? ""), "the terms say the height is pinned", terms.heightSource ?? "—");
    check(/unique to THIS order/.test(terms.paymentNote ?? ""), "the terms say the amount is unique to the order");
    check(/base unit off is refused/.test(terms.paymentNote ?? ""), "the terms warn that an exact amount is required");

    // Step 2 and 3: order, and pay.
    const bought = await buy(provider.url, 1, "0xsmoke");
    check(bought.code === 0, "npm run buy completes against the provider", `exit ${bought.code}`);
    check(/NOT SENT/.test(bought.out), "the client prints that the rung was not sent");

    const record = JSON.parse(await readFile(orderFile, "utf8"));
    check(Object.keys(record.reveal).length === 4, "the order file carries the full reveal", Object.keys(record.reveal).join(", "));
    check(record.priced?.targetCell === Number(CELL), "the order file records the cell it was priced against", String(record.priced?.targetCell));
    check(record.payment?.paid?.txHash === "0xsmoke", "the order file records the payment, not just the invoice", String(record.payment?.paid?.txHash));
    check(record.payment?.paid?.block === 999_001, "the payment's block comes from the receipt, not from the buyer", String(record.payment?.paid?.block));

    const status = await (await fetch(`${provider.url}/orders/${record.order.id}`)).json();
    // `paid`, not `emitted`. The old name claimed a chain nothing had touched.
    check(status.state === "paid", "the provider moved the order to paid", status.state);
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
    check(refusal?.waitBlocks === WINDOW_TO + 1 - INSIDE, "the refusal report says how many blocks to wait", String(refusal?.waitBlocks));

    // Step 4b: the PROVIDER's gate. The buyer asserts a height past the window;
    // the provider was pinned inside it and must not take the buyer's word.
    const overruled = await run("scripts/reveal.mjs", ["--order", orderFile, "--provider", provider.url, "--at", String(AFTER), "--json"]);
    check(overruled.code === 1, "the provider refuses a reveal the buyer thinks is safe", `exit ${overruled.code}`);
    check(/still open/.test(overruled.err), "the provider's refusal names the open window");

    provider.child.kill();
    chain.server.close();
  }

  // --- every way a payment can be wrong ---------------------------------------
  // Each is a different verdict, because they lead to different actions: one is
  // worth retrying, three are not, and one is the operator's problem.

  rule("The payment rail, refusing on purpose");

  {
    let url = null;
    let opinion = async () => null;
    const chain = await startFakeChain({ answer: async (txHash) => opinion(txHash) });
    sockets.push(chain.server);
    const port = await freePort();
    const provider = await startProvider(port, ["--address", ADDRESS, "--rpc", chain.url]);
    children.push(provider.child);
    url = provider.url;

    const honest = agreesWithProvider(() => url);

    // (1) The amount is not the one quoted — one base unit short. This is the tag
    //     doing its job, and why the invoice's `amount` is not what a buyer sends.
    opinion = async (txHash) => {
      const correct = await honest(txHash);
      return correct ? { ...correct, value: correct.value - 1n } : null;
    };
    const short = await buy(provider.url, 2, "0xshort");
    check(short.code === 1, "a payment one base unit short is refused", `exit ${short.code}`);
    check(/not the one this order was quoted/.test(short.err), "the refusal names the amount as the problem");

    // (2) A hash the chain has never seen. Definitive, and not worth waiting for.
    opinion = async () => null;
    const unknown = await buy(provider.url, 3, "0xnothing");
    check(unknown.code === 1, "a hash the chain never saw is refused", `exit ${unknown.code}`);
    check(/never seen this transaction hash/.test(unknown.err), "the refusal says the hash is unknown");

    // (3) A transfer to somebody else. The provider is paid at its own address or
    //     it is not paid.
    opinion = async (txHash) => {
      const correct = await honest(txHash);
      return correct ? { ...correct, to: ELSEWHERE } : null;
    };
    const misdirected = await buy(provider.url, 4, "0xelsewhere");
    check(misdirected.code === 1, "a transfer to another address is refused", `exit ${misdirected.code}`);
    check(/no tokens to this provider/.test(misdirected.err), "the refusal says the transfer went elsewhere");

    // (4) One payment presented to two orders. Pay the first honestly, then hand
    //     the same hash to a second order — the chain happily produces a matching
    //     receipt for it, and only the registry stops it.
    opinion = async () => honest("ignored");
    const first = await buy(provider.url, 5, "0xreused");
    check(first.code === 0, "an honest payment is accepted", `exit ${first.code}`);
    const second = await buy(provider.url, 6, "0xreused");
    check(second.code === 1, "the same payment cannot buy a second order", `exit ${second.code}`);
    check(/already paid another order/.test(second.err), "the refusal says the payment was already spent");

    // (5) The payment chain cannot be reached at all. This is the operator's
    //     problem and it must not read as a payment.
    const deadPort = await freePort();
    const blindPort = await freePort();
    const blind = await startProvider(blindPort, ["--address", ADDRESS, "--rpc", `http://127.0.0.1:${deadPort}/rpc`]);
    children.push(blind.child);
    const unreachable = await buy(blind.url, 7, "0xwhatever");
    check(unreachable.code === 1, "an unreadable receipt does not become a payment", `exit ${unreachable.code}`);
    check(/could not be read/.test(unreachable.err), "the refusal says the receipt could not be read");
    const blindStates = (await (await fetch(`${blind.url}/orders`)).json()).orders.map((o) => o.state);
    check(!blindStates.includes("paid"), "no order was marked paid by an unreachable chain", blindStates.join(","));

    // (6) A provider with no address cannot be paid at all, and says so rather
    //     than recording a hash it cannot check.
    const barePort = await freePort();
    const bare = await startProvider(barePort, []);
    children.push(bare.child);
    const unpaid = await buy(bare.url, 8, "0xwhatever");
    check(unpaid.code === 1, "a provider with no address refuses the payment", `exit ${unpaid.code}`);
    check(/cannot verify a payment to itself/.test(unpaid.err), "and says why");
    const bareTerms = await (await fetch(`${bare.url}/terms`)).json();
    check(/without --address/.test(bareTerms.paymentNote ?? ""), "the terms admit it cannot be paid");

    provider.child.kill();
    blind.child.kill();
    bare.child.kill();
    chain.server.close();
  }

  // --- the honest labelling ---------------------------------------------------
  // Same journey, but the provider has no chain source for the HEIGHT. It settles
  // on the buyer's number and says so, because a check that quietly degrades into
  // a formality is worse than no check.

  rule("A provider with no chain source for the height (no --at)");

  {
    let url = null;
    const chain = await startFakeChain({ answer: agreesWithProvider(() => url) });
    sockets.push(chain.server);
    const port = await freePort();
    const provider = await startProvider(port, ["--address", ADDRESS, "--rpc", chain.url]);
    children.push(provider.child);
    url = provider.url;

    const bought = await buy(provider.url, 9, "0xsmoke2");
    check(bought.code === 0, "the journey runs again against a second provider", `exit ${bought.code}`);

    const settled = await run("scripts/reveal.mjs", ["--order", orderFile, "--provider", provider.url, "--at", String(AFTER), "--json"]);
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
    const again = await run("scripts/reveal.mjs", ["--order", orderFile, "--provider", provider.url, "--at", String(AFTER), "--json"]);
    check(again.code === 0, "a re-sent reveal still succeeds", `exit ${again.code}`);
    let second = null;
    try {
      second = JSON.parse(again.out);
    } catch {
      // reported by the check below
    }
    check(second?.settlement?.duplicate === true, "the re-send is reported as a duplicate, not refused");

    provider.child.kill();
    chain.server.close();
  }

  // --- a provider asked to verify the height, and unable to --------------------
  // `--verify` is the only arrangement where the provider is not taking anyone's
  // word for the height. The property under test is what happens when it cannot
  // deliver: it must REFUSE, and must not quietly fall back to the buyer's
  // number. Falling back would leave the operator believing a check ran, which
  // is the same failure as a stale figure with a worse consequence.

  rule("A provider told to verify the height, with the chain unable to answer");

  {
    const deadPort = await freePort();
    let url = null;
    // The chain answers receipts and refuses block numbers. That is exactly the
    // situation `--payment-rpc` exists for: two reads, two machines, and only one
    // of them having a bad day. The receipts must still be honest — a chain that
    // answered `null` here would refuse the PAYMENT, and the check below would
    // then be proving nothing about the height.
    const chain = await startFakeChain({ answer: agreesWithProvider(() => url), refuseBlockNumber: true });
    sockets.push(chain.server);
    const port = await freePort();
    const provider = await startProvider(port, [
      "--verify",
      "--rpc", `http://127.0.0.1:${deadPort}/rpc`,
      "--payment-rpc", chain.url,
      "--address", ADDRESS,
    ]);
    children.push(provider.child);
    url = provider.url;

    const terms = await (await fetch(`${provider.url}/terms`)).json();
    check(/REFUSES the settlement/.test(terms.heightSource ?? ""), "the terms warn that a failed read refuses", terms.heightSource ?? "—");

    // Paid, so the order is in every other respect settleable. If the height
    // refusal came from the invoice not being paid, this would prove nothing.
    const bought = await buy(provider.url, 10, "0xsmoke3");
    check(bought.code === 0, "the order is accepted and paid while the height cannot be read", `exit ${bought.code}`);

    const record = JSON.parse(await readFile(orderFile, "utf8"));
    const before = await (await fetch(`${provider.url}/orders/${record.order.id}`)).json();
    check(before.state === "paid", "the order is paid before the reveal is attempted", before.state);

    const refused = await run("scripts/reveal.mjs", ["--order", orderFile, "--provider", provider.url, "--at", String(AFTER), "--json"]);
    check(refused.code === 1, "the reveal is refused when the height cannot be read", `exit ${refused.code}`);
    check(/could not be read/.test(refused.err), "the refusal names the unreadable height");
    check(/will not fall back/.test(refused.err), "the refusal says it will not fall back to the buyer's number");

    // And nothing was settled. A refusal that still wrote a claim would let the
    // next attempt find its own decoys already taken.
    const status = await (await fetch(`${provider.url}/orders/${record.order.id}`)).json();
    check(status.state === "paid", "the order is left unsettled, not half-settled", status.state);
    check(status.settlement === null, "no settlement was recorded on a refused reveal");

    provider.child.kill();
    chain.server.close();
  }

  // --- the provider that cannot deliver, which is every provider here today ---
  //
  // The emitter is not written, so a provider started from this repository cannot
  // broadcast. Before this section existed it would accept the order, invoice it,
  // verify a REAL on-chain payment and hand back a plan it would never emit —
  // money taken for work it could not do, with the receipt to prove it. Now it
  // refuses before an invoice exists, and this is the proof that the refusal
  // happens over HTTP and not only in the library the unit tests reach.
  {
    rule("A provider with no emitter refuses to sell, before an invoice exists");

    // Its own chain, and one that counts. The property under test is not only
    // that the order is refused — it is that the refusal happens BEFORE anything
    // on-chain is consulted. A refusal produced by a failing chain read looks
    // identical from the outside and means something else entirely: it would
    // move with the node's mood instead of being a property of the provider.
    let chainReads = 0;
    const chain = await startFakeChain({
      answer: () => {
        chainReads += 1;
        return null;
      },
    });
    sockets.push(chain.server);

    const port = await freePort();
    const provider = await startProvider(
      port,
      ["--at", String(INSIDE), "--address", ADDRESS, "--rpc", chain.url],
      { emits: false },
    );
    children.push(provider.child);

    const published = await (await fetch(`${provider.url}/terms`)).json();
    check(published.terms.emits === false, "the terms declare it cannot emit", `emits=${published.terms.emits}`);
    check(/NO EMITTER/.test(published.emitsNote ?? ""), "and the note says what that means for a buyer");

    const health = await (await fetch(`${provider.url}/health`)).json();
    check(
      health.emits === false,
      "and /health reports it beside payable",
      `emits=${health.emits} payable=${health.payable}`,
    );

    // The order this client builds is a perfectly good one — same helper, same
    // arguments as the happy path above. The refusal has to be about the
    // PROVIDER, because a buyer who reaches a provider that cannot serve them
    // has done nothing wrong, and a client-side check would put the burden on
    // the wrong party.
    const attempted = await buy(provider.url, 1, "0xsmoke");
    check(attempted.code === 1, "the client cannot place an order at all", `exit ${attempted.code}`);
    check(/refused \(422\)/.test(attempted.err), "and the provider refused it with a status, not a crash");
    check(/no emitter/.test(attempted.err), "the refusal names the missing emitter");
    check(/commitment to emit/.test(attempted.err), "and says why accepting it would have been the lie");

    // Nothing was written down, so there is no invoice for anyone to pay. This
    // is the check that matters: the failure being prevented is not a bad
    // message, it is money arriving for cover that would never be emitted.
    const recorded = await (await fetch(`${provider.url}/orders`)).json();
    check(recorded.count === 0, "no order was recorded, so no invoice exists to pay", `${recorded.count}`);

    // And the chain was never asked anything. The refusal is decided from the
    // provider's own declaration, before a single receipt is read.
    check(chainReads === 0, "the chain was never consulted, so the refusal cannot depend on a node", `${chainReads} read(s)`);

    provider.child.kill();
    chain.server.close();
  }
} catch (error) {
  bad("the journey ran at all", error.message);
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
  for (const socket of sockets) socket.close();
  await rm(scratch, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? "\n\x1b[32mThe four steps close over HTTP.\x1b[0m  measure → order → pay → reveal, no real chain.\n"
    : `\n\x1b[31m${failures} check${failures === 1 ? "" : "s"} failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);

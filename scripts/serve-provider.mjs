#!/usr/bin/env node
// A reference provider, so that "how does a customer connect and buy this" has
// an answer that runs rather than a paragraph that describes.
//
//   npm run serve:provider                 # listens on 127.0.0.1:8081
//   npm run serve:provider -- --port 9000 --margin 1 --network sepolia
//
// The buyer's client is scripts/buy.mjs, and the whole exchange is exercised
// offline by tests/provider.test.mjs. Nothing here touches a chain: accepting an
// order, invoicing it, taking payment and planning the decoys are arithmetic.
// The emission is the emitter's job and needs a node.
//
// ## Why loopback, and what that is not
//
// This binds to loopback only, like scripts/serve.mjs. That is honest for a
// reference implementation and wrong for a real provider: a public provider
// needs TLS, authentication, rate limiting, and a durable order book. None of
// those are here, and none of them are the interesting part of the protocol.
// What IS here is the part that must be got right before any of that matters:
// which half of the reveal a provider is allowed to see, and what it must check
// before it spends money.
//
// ## The one thing to not get wrong
//
// The provider receives the WINDOW proof and never the denomination. It also
// learns the buyer's window in the clear — that is the position being sold
// ("knows when, not how much") and the reason it is cheaper than aimed. A
// provider that starts logging order windows is keeping a record of when its
// customers transact, which is the product's central privacy cost and should be
// written down wherever the provider's policy lives.
//
// ## The fourth step, and why this route refuses
//
// `POST /orders/:id/reveal` is the only request in the protocol that arrives
// after the trade, and it is the only one the provider must not have been given
// earlier. The route re-runs the same check the buyer's client runs — has the
// window closed — and refuses with the number of blocks left when it has not.
//
// Note what that check is and is not. It protects the buyer from publishing
// early, and it stops this provider from signing off on a measurement that has
// not happened yet. It does NOT verify anything by itself: the height has to
// come from somewhere, and a provider with no chain source is trusting the
// buyer's number. That is said out loud in every settlement this route returns,
// under `heightSource`, because a check that quietly degrades into a formality
// is worse than no check — it reads as verified.

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { providerTerms, acceptOrder, invoiceFor, markPaid, planDecoys, summarisePlan, orderSeed } from "../src/provider.mjs";
import { parseWindowProof } from "../src/order.mjs";
import { admitReveal, resolveHeight, HEIGHT_SOURCE } from "../src/reveal.mjs";
import { endpointsFor } from "../src/blockheight.mjs";
import { mulberry32 } from "../src/rng.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
/** A switch rather than a value: `--verify` is present or it is not. */
const flag = (name) => argv.includes(`--${name}`);

const PORT = Number(arg("port", process.env.PORT ?? 8081));
const HOST = arg("host", "127.0.0.1");

const TERMS = providerTerms({
  network: arg("network", "sepolia"),
  margin: BigInt(arg("margin", "0")),
  address: arg("address", null),
});

/**
 * Where this provider gets the chain height, and how much it is trusted.
 *
 * This matters for exactly one decision: whether a reveal may be published. The
 * provider is the party that benefits from receiving a reveal early, so letting
 * it settle on a height the buyer supplied is letting the interested party be
 * the only witness. Three arrangements, in descending order of strength:
 *
 *   --at <block>   pinned by the operator. Trusted as far as the operator is,
 *                  and no further: it is a human typing a number, and it goes
 *                  stale the moment the chain moves.
 *   --verify       read from the chain. The only arrangement where the provider
 *                  is not taking anyone's word. If the read fails the route
 *                  REFUSES; it does not quietly fall back to the buyer's number,
 *                  because falling back is the check that was asked for.
 *   (neither)      the buyer's own assertion, labelled as unverified.
 *
 * `--rpc <url>` narrows `--verify` to one endpoint instead of the network's
 * public list, which is what a test or a private node wants.
 */
const AT = arg("at", process.env.RUIDO_AT ?? null);
const PROVIDER_HEIGHT = AT === null ? null : Number(AT);
const VERIFY = flag("verify") || process.env.RUIDO_VERIFY_HEIGHT === "1";
const RPC_URL = arg("rpc", null);

if (AT !== null && !Number.isInteger(PROVIDER_HEIGHT)) {
  console.error(`\n  --at must be a block number, got ${AT}\n`);
  process.exit(1);
}
if (VERIFY && AT !== null) {
  console.error(
    "\n  --at and --verify are contradictory: one says the height is already known,\n" +
      "  the other says to go and read it. Pick the one you mean.\n",
  );
  process.exit(1);
}

const HEIGHT_MODE = VERIFY ? HEIGHT_SOURCE.PROVIDER : AT !== null ? HEIGHT_SOURCE.PINNED : HEIGHT_SOURCE.BUYER;
const HEIGHT_ENDPOINTS = RPC_URL === null ? endpointsFor(TERMS.network) : [RPC_URL];

// A provider-held seed, random per run unless one is given. See `orderSeed` in
// src/provider.mjs for what it does and does not buy.
const PROVIDER_SEED = BigInt(arg("seed", `${Date.now()}${Math.floor(Math.random() * 1e6)}`));

/** BigInt does not survive JSON.stringify, and every amount here is a felt. */
const wire = (value) =>
  JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2);

/** orderId -> { order, window, invoice, plan, state } */
const orders = new Map();

/**
 * noteId -> the order id that claimed it, shared across every order this
 * provider serves. The first-claim rule is what stops one batch of decoys being
 * sold to every buyer who asks: windows overlap constantly, so a decoy landing
 * in one buyer's cell usually lands in several others' too.
 *
 * Held here because a reference provider is one process with one memory. In a
 * market with more than one provider this belongs somewhere both sides can see,
 * and the provider being its own judge is the weakest part of the arrangement —
 * see docs/ORDER.md.
 */
let CLAIMED = new Map();

function send(response, status, body) {
  const payload = typeof body === "string" ? body : wire(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    // A provider's terms and its accept/reject reasons are the interface; a
    // browser reading them cross-origin is not a threat worth blocking.
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
  });
  response.end(payload);
}

async function readJson(request, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error(`body over ${limit} bytes`);
    chunks.push(chunk);
  }
  if (!chunks.length) throw new Error("empty body");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  try {
    if (request.method === "OPTIONS") return send(response, 204, "");

    if (request.method === "GET" && (path === "/" || path === "/terms")) {
      return send(response, 200, {
        terms: TERMS,
        endpoints: {
          terms: "GET /terms",
          order: "POST /orders  { order, windowProof }",
          payment: "POST /orders/:id/payment  { txHash, block }",
          status: "GET /orders/:id",
          reveal: "POST /orders/:id/reveal  { reveal, atBlock, cell, observedDecoys? }",
        },
        note: "Send the order and the WINDOW proof. Sending the full reveal hands over the denomination, which is the one thing this split exists to protect.",
        revealNote: "The reveal is the fourth step and is only accepted once the window has closed. Publishing it earlier hands the provider the rung before it emits, so the route refuses and says how many blocks are left.",
        heightSource: {
          pinned: `pinned at block ${PROVIDER_HEIGHT} by --at; the buyer's number is ignored, and so is the chain's`,
          provider: RPC_URL === null
            ? `read from the chain on every reveal, from ${HEIGHT_ENDPOINTS.length} public endpoint(s); a read that fails REFUSES the settlement rather than falling back to the buyer`
            : `read from the chain on every reveal, from ${RPC_URL} only; a read that fails REFUSES the settlement rather than falling back to the buyer`,
          buyer:
            "no --at and no --verify: this provider will settle on the height the buyer asserts, and will label the settlement as unverified",
        }[HEIGHT_MODE],
      });
    }

    if (request.method === "GET" && path === "/orders") {
      return send(response, 200, {
        count: orders.size,
        orders: [...orders.values()].map((r) => ({
          id: r.order.id,
          state: r.state,
          decoys: r.order.decoys,
          amount: r.invoice?.amount ?? null,
        })),
      });
    }

    const statusMatch = path.match(/^\/orders\/([0-9a-fx]+)$/);
    if (request.method === "GET" && statusMatch) {
      const record = orders.get(statusMatch[1]);
      if (!record) return send(response, 404, { error: "no such order" });
      return send(response, 200, {
        id: record.order.id,
        state: record.state,
        decoys: record.order.decoys,
        bits: record.order.bits,
        window: record.window,
        invoice: record.invoice,
        // The plan is only released once the invoice is paid: the provider's
        // work is what the buyer is paying for, and handing it over first makes
        // the invoice decorative.
        plan: record.state === "emitted" ? record.plan : null,
        // A settled order keeps its verdict here. `state` alone cannot carry it:
        // "revealed" does not say whether the bits arrived.
        settlement: record.settlement ?? null,
      });
    }

    if (request.method === "POST" && path === "/orders") {
      const body = await readJson(request);
      if (!body.order || !body.windowProof) {
        return send(response, 400, { error: "an order needs both `order` and `windowProof`" });
      }

      const accepted = acceptOrder(body.order, parseWindowProof(body.windowProof), { terms: TERMS });
      if (!accepted.ok) {
        // Refused BEFORE anything is planned or emitted. This is the check that
        // stops a buyer committing to one window while naming another.
        return send(response, 422, { accepted: false, reason: accepted.reason });
      }

      if (orders.has(body.order.id)) {
        const existing = orders.get(body.order.id);
        return send(response, 200, { accepted: true, duplicate: true, invoice: existing.invoice });
      }

      const invoice = invoiceFor(body.order, TERMS);
      orders.set(body.order.id, {
        order: body.order,
        window: accepted.window,
        invoice,
        plan: null,
        state: "invoiced",
      });
      return send(response, 201, { accepted: true, duplicate: false, invoice, terms: TERMS });
    }

    const payMatch = path.match(/^\/orders\/([0-9a-fx]+)\/payment$/);
    if (request.method === "POST" && payMatch) {
      const record = orders.get(payMatch[1]);
      if (!record) return send(response, 404, { error: "no such order" });
      if (record.state === "emitted") return send(response, 409, { error: "this order is already emitted" });

      const body = await readJson(request);
      record.invoice = markPaid(record.invoice, body);

      // Planning happens at payment, and emission would happen next. The plan is
      // produced here so the shape can be inspected before any money is spent on
      // gas — `summarisePlan` is the check that every decoy is inside the window.
      const next = mulberry32(orderSeed(PROVIDER_SEED, record.order.id));
      record.plan = planDecoys({ window: record.window, decoys: record.order.decoys, next });
      record.state = "emitted";

      return send(response, 200, {
        id: record.order.id,
        state: record.state,
        paid: record.invoice.paid,
        plan: record.plan,
        summary: summarisePlan(record.plan, { ladder: TERMS.ladder }),
        // Said out loud so nobody reads "emitted" as "on chain".
        emission: "planned, NOT broadcast — broadcasting needs the emitter and a local node",
      });
    }

    // The fourth step. Everything before this was the buyer's side going out;
    // this is the reveal coming back, and it is the one request in the protocol
    // the provider must NOT have been given earlier.
    //
    // The decision itself is `admitReveal` in src/reveal.mjs, not here. A rule
    // that lives inside a server cannot be tested without starting one, and this
    // particular rule is the one the buyer's client enforces too — the two have
    // to be the same code or they will drift.
    const revealMatch = path.match(/^\/orders\/([0-9a-fx]+)\/reveal$/);
    if (request.method === "POST" && revealMatch) {
      const record = orders.get(revealMatch[1]);
      if (!record) return send(response, 404, { error: "no such order" });

      const body = await readJson(request);

      // Where the height comes from, resolved BEFORE anything is settled. A
      // provider asked to verify and unable to reach the chain refuses here: it
      // does not fall back to the buyer's number, because falling back is
      // exactly the check that was asked for.
      const resolved = await resolveHeight({
        mode: HEIGHT_MODE,
        pinned: PROVIDER_HEIGHT,
        network: TERMS.network,
        endpoints: HEIGHT_ENDPOINTS,
      });
      if (!resolved.ok) return send(response, resolved.status, resolved.body);

      // `null` from the buyer mode means "use the one in the request"; the other
      // two modes produce a number the buyer's cannot override.
      const atBlock = resolved.atBlock ?? body.atBlock;

      const admitted = admitReveal({
        order: record.order,
        state: record.state,
        planned: record.plan?.length ?? 0,
        settled: record.settlement ?? null,
        body,
        atBlock,
        heightSource: resolved.heightSource,
        network: TERMS.network,
        claimed: CLAIMED,
      });

      if (!admitted.ok) return send(response, admitted.status, admitted.body);

      CLAIMED = admitted.claimed;
      record.state = "revealed";
      record.settlement = admitted.body;
      return send(response, 200, admitted.body);
    }

    return send(response, 404, { error: `no route for ${request.method} ${path}` });
  } catch (error) {
    return send(response, 400, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ruido provider — ${TERMS.network}, ${TERMS.ladder} rungs, ${TERMS.feePerCall} STRK/call, margin ${TERMS.margin}`);
  console.log(`listening on http://${HOST}:${PORT}  (loopback only: this is a reference, not a deployment)`);
  console.log(`project root ${ROOT}`);
  console.log(`\n  GET  /terms`);
  console.log(`  POST /orders                { order, windowProof }`);
  console.log(`  POST /orders/:id/payment    { txHash, block }`);
  console.log(`  GET  /orders/:id`);
  console.log(`  POST /orders/:id/reveal     { reveal, atBlock, cell }   ← the fourth step\n`);
  console.log(
    {
      pinned: `  --at ${PROVIDER_HEIGHT}: the reveal route settles against this pinned height and\n  ignores the one the buyer sends.\n`,
      provider: `  --verify: the reveal route reads the height from the chain on every reveal\n  (${HEIGHT_ENDPOINTS.length} endpoint(s)) and ignores the buyer's. A read that fails\n  REFUSES the settlement.\n`,
      buyer:
        "  no --at and no --verify: the reveal route will settle on the buyer's block\n  height and label the settlement unverified. Pass --at <block> or --verify.\n",
    }[HEIGHT_MODE],
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

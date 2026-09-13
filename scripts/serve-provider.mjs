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

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { providerTerms, acceptOrder, invoiceFor, markPaid, planDecoys, summarisePlan, orderSeed } from "../src/provider.mjs";
import { parseWindowProof } from "../src/order.mjs";
import { mulberry32 } from "../src/rng.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PORT = Number(arg("port", process.env.PORT ?? 8081));
const HOST = arg("host", "127.0.0.1");

const TERMS = providerTerms({
  network: arg("network", "sepolia"),
  margin: BigInt(arg("margin", "0")),
  address: arg("address", null),
});

// A provider-held seed, random per run unless one is given. See `orderSeed` in
// src/provider.mjs for what it does and does not buy.
const PROVIDER_SEED = BigInt(arg("seed", `${Date.now()}${Math.floor(Math.random() * 1e6)}`));

/** BigInt does not survive JSON.stringify, and every amount here is a felt. */
const wire = (value) =>
  JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2);

/** orderId -> { order, window, invoice, plan, state } */
const orders = new Map();

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
        },
        note: "Send the order and the WINDOW proof. Sending the full reveal hands over the denomination, which is the one thing this split exists to protect.",
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
  console.log(`  GET  /orders/:id\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

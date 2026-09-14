#!/usr/bin/env node
// The order book, as a process.
//
//   npm run serve:book
//
// ## What this is
//
// A directory of providers, not a list of orders. Read the header of
// `src/orderbook.mjs` for why that distinction is the whole design; the short
// version is that a public list of *buy orders* in this market is a list of
// targets, and the fields that make it one are exactly the fields the buyer is
// paying to withhold.
//
// ## The one rule this process enforces
//
// **A registration is an endpoint, never a row.** `POST /offers { endpoint }`
// makes the book go and fetch `{endpoint}/terms` itself. A provider cannot hand
// the book a composed listing, so it cannot advertise a price it would not
// honour — and, more importantly, a provider cannot smuggle a buyer's cell into
// the book by describing itself with the wrong word. `validateOffer` still runs
// on what came back, because a provider's own terms could carry a secret too,
// and a check that only guards one of the two doors is not a check.
//
// ## What the book cannot do
//
// It cannot verify a claim. It re-reads the terms and notes whether the endpoint
// answered; everything else on a row is the provider's word, returned under
// `claimed` and labelled as such by `unverified()`. It also cannot make itself
// trustworthy: a book is a single place that sees every query, which is a worse
// position than any one provider occupies. That is why the query carries no
// window — the book cannot correlate what it never learns.

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import {
  offerFromTerms,
  offerId,
  rankOffers,
  unverified,
  bookPrivacy,
  parseBook,
  serialiseBook,
} from "../src/orderbook.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PORT = Number(arg("port", process.env.PORT ?? 8082));
const HOST = arg("host", "127.0.0.1");

/**
 * How long a row is trusted before the book re-reads the provider's terms.
 *
 * Re-read rather than cached forever, because the terms are the price and a
 * stale price is the failure mode this book is most exposed to: the buyer
 * commits to a figure the provider has already changed, and the provider refuses
 * an order it would have accepted a minute earlier. The cost is a request per
 * row per TTL, which is the right side to err on.
 */
const TTL_MS = Number(arg("ttl", process.env.RUIDO_BOOK_TTL ?? 30)) * 1000;

/** How long the book waits for a provider to answer before calling it gone. */
const PROBE_TIMEOUT_MS = Number(arg("timeout", process.env.RUIDO_BOOK_TIMEOUT ?? 5)) * 1000;

/** endpoint -> offer. The endpoint is the identity; re-registering replaces. */
const offers = new Map();

const wire = (value) =>
  JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2);

function send(response, status, body) {
  const payload = typeof body === "string" ? body : wire(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
  });
  response.end(payload);
}

async function readJson(request, limit = 64 * 1024) {
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

/** Trailing slashes removed, so `http://x/` and `http://x` are one provider. */
const normalise = (endpoint) => String(endpoint).replace(/\/+$/, "");

/**
 * Reads a provider's terms. The I/O half, kept separate from the checking half
 * so that "the provider is down" and "the provider publishes something it must
 * not" can be told apart — they are different status codes and different
 * problems, and a single try/catch collapses them into one.
 */
async function fetchTerms(endpoint) {
  const response = await fetch(`${normalise(endpoint)}/terms`, {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${endpoint} answered ${response.status} on /terms`);
  return response.json();
}

/** The pure half: terms in, a validated row out. Throws if the row is not publishable. */
function buildOffer(terms, endpoint) {
  const offer = offerFromTerms(terms, { endpoint: normalise(endpoint), registeredAt: new Date().toISOString() });
  return { ...offer, reachable: true, lastSeenAt: new Date().toISOString() };
}

/** True when a row is old enough that its price may no longer be the price. */
const stale = (offer) => Date.now() - Date.parse(offer.lastSeenAt ?? 0) > TTL_MS;

/**
 * Re-reads a stale row.
 *
 * Three outcomes, and they are not interchangeable:
 *
 *   the same row, refreshed   the provider answered and its terms are publishable
 *   the row with `reachable: false`  the provider did not answer. Kept, because
 *                             "listed, not answering" is a different fact from
 *                             "nobody sells this" — the first tells a buyer to
 *                             come back, the second tells them to go elsewhere
 *   `null`                    the provider's terms became unpublishable. The row
 *                             is withdrawn: a provider that starts publishing a
 *                             buyer's cell loses its listing, which is the only
 *                             response that does not reward it
 */
async function refresh(offer) {
  if (!stale(offer)) return offer;
  let terms;
  try {
    terms = await fetchTerms(offer.endpoint);
  } catch {
    return { ...offer, reachable: false };
  }
  try {
    return buildOffer(terms, offer.endpoint);
  } catch {
    return null;
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  try {
    if (request.method === "OPTIONS") return send(response, 204, "");

    if (request.method === "GET" && path === "/health") {
      return send(response, 200, {
        ok: true,
        offers: offers.size,
        reachable: [...offers.values()].filter((o) => o.reachable === true).length,
        bookVersion: 1,
      });
    }

    // The whole book, for a client that wants to rank it itself. Amounts are
    // felts and travel as decimal strings — the convention the provider already
    // uses, rather than a second one.
    if (request.method === "GET" && path === "/offers") {
      const network = url.searchParams.get("network");
      const bits = url.searchParams.get("bits");
      const mode = url.searchParams.get("mode") ?? "window";
      const cell = url.searchParams.get("cell");

      // Re-read every stale row, then drop the ones that came back unpublishable.
      // Probed in parallel because a book with more than a handful of providers
      // would otherwise answer in proportion to its own size.
      const settled = await Promise.all(
        [...offers.entries()].map(async ([id, offer]) => [id, await refresh(offer)]),
      );
      const rows = [];
      for (const [id, next] of settled) {
        if (next === null) {
          offers.delete(id);
          continue;
        }
        offers.set(id, next);
        rows.push(next);
      }

      // No `bits` is a browse: the book lists what is for sale without ranking
      // it, because ranking needs a size and inventing one would be the book
      // deciding what the buyer wants.
      if (bits === null) {
        return send(response, 200, {
          count: rows.length,
          offers: rows.map((o) => ({ ...o, unverified: unverified(o) })),
          privacy: bookPrivacy({ network, bits: null, mode }),
        });
      }

      const priced = rankOffers(rows, {
        targetCell: Number(cell ?? 1.93),
        bits: Number(bits),
        mode,
        network,
      });

      return send(response, 200, {
        ...priced,
        privacy: bookPrivacy({
          network,
          bits: Number(bits),
          decoys: priced.candidates[0]?.decoys ?? null,
          mode,
        }),
        // The freshness of the whole answer, so a client can say how old it is
        // rather than implying it is live.
        asOf: new Date().toISOString(),
      });
    }

    // A registration is an endpoint. The book fetches the terms itself.
    if (request.method === "POST" && path === "/offers") {
      const body = await readJson(request);
      if (!body.endpoint) {
        return send(response, 400, {
          error: "a registration is `{ endpoint }` — the book reads the terms from the provider",
          why: "accepting a composed row would let a provider advertise a price it would not honour",
        });
      }

      let terms;
      try {
        terms = await fetchTerms(body.endpoint);
      } catch (error) {
        // 502 rather than 400: the registration was well formed and the provider
        // is the thing that failed. A buyer reading this needs to know it is the
        // provider's problem, not theirs.
        return send(response, 502, {
          error: `could not read the terms of ${body.endpoint}`,
          reason: error.message,
        });
      }

      let offer;
      try {
        offer = buildOffer(terms, body.endpoint);
      } catch (error) {
        // 400, not 502: the provider answered perfectly well and what it answered
        // is not publishable. The message names the field, because the operator
        // of the provider is the only one who can fix it.
        return send(response, 400, {
          error: `${body.endpoint} publishes terms this book will not list`,
          reason: error.message,
          endpoint: normalise(body.endpoint),
        });
      }

      const id = offerId(offer);
      const replaced = offers.has(id);
      offers.set(id, offer);
      return send(response, replaced ? 200 : 201, {
        id,
        replaced,
        offer,
        unverified: unverified(offer),
      });
    }

    // A book that persists. Used to move a book between hosts without the
    // providers having to re-register — and the parse re-validates every row, so
    // a hand-edited file cannot smuggle a secret into a running book.
    if (request.method === "POST" && path === "/import") {
      const body = await readJson(request, 4 * 1024 * 1024);
      let rows;
      try {
        rows = parseBook(body);
      } catch (error) {
        // 400, not 500: a file this book will not load is the caller's problem,
        // and the message says which row and which field. The distinction is the
        // same one the registration route makes between 400 and 502.
        return send(response, 400, { error: "this book will not load that file", reason: error.message });
      }
      for (const row of rows) offers.set(offerId(row), row);
      return send(response, 200, { imported: rows.length, offers: offers.size });
    }

    if (request.method === "GET" && path === "/export") {
      return send(response, 200, serialiseBook([...offers.values()]));
    }

    return send(response, 404, { error: `no such route: ${request.method} ${path}` });
  } catch (error) {
    return send(response, 500, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\nruido — order book on http://${HOST}:${PORT}\n`);
  console.log("  GET  /offers?network=&bits=&mode=&cell=   ranked for a size");
  console.log("  GET  /offers                              everything listed, unranked");
  console.log("  POST /offers                              { endpoint } — the book reads its terms");
  console.log("  GET  /export   POST /import               a book that outlives a process");
  console.log("  GET  /health\n");

  // Said at startup rather than left in a document, because the operator of a
  // book is the one who can leak every query it receives.
  console.log(`  This book lists OFFERS, not orders: there is no window parameter anywhere in`);
  console.log(`  the API, so a buyer's cell cannot reach this process. It learns the size asked`);
  console.log(`  about and the network — both are in the question — and has no accounts, so it`);
  console.log(`  cannot say who asked. A book that logs can still correlate, and this one keeps`);
  console.log(`  no request log. Rows are re-read from each provider every ${TTL_MS / 1000}s;`);
  console.log(`  everything else on a row is the provider's word.\n`);
});

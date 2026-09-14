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
// ## The door, which is the same one the provider already has
//
// `src/trust.mjs` exists because a reference process on loopback did not need a
// door and a process on a host does. The book has the same three problems, one
// step earlier in the trade, so it takes the same three answers rather than
// inventing a second set:
//
//   1. **Listing is closed.** A registration is not a row — it is a **URL this
//      process will request**, and the row it produces is what a buyer will
//      talk to. A buyer's first message to a provider carries the window they
//      are paying to hide, so an open listing route is a stranger choosing who
//      receives it. Reading stays public: a book that needed a token to browse
//      is a book nobody uses, and the rows are a price list.
//
//   2. **Writes are limited harder than reads**, because a write is what makes
//      the book open a socket to somewhere it did not choose.
//
//   3. **`--host 0.0.0.0` with no token is refused at startup**, not warned
//      about. The operator of a book is the one who can leak every query it
//      receives, and the software will not let them do that by accident.
//
// On top of those, the endpoint itself is checked. A registration naming a
// loopback, private, link-local or non-http address is refused, and **link-local
// is refused even when private addresses are allowed** — `169.254.169.254` is
// where a cloud host answers with its own credentials, and that is not "my own
// network", which is what `--allow-private` is for. The default is decided by
// the bind: a book on loopback may fetch a provider on loopback, because that is
// the normal local case, and a book on a public interface may not.
//
// ## What the book cannot do
//
// It cannot verify a claim. It re-reads the terms and notes whether the endpoint
// answered; everything else on a row is the provider's word, returned under
// `claimed` and labelled as such by `unverified()`. It also cannot make itself
// trustworthy: a book is a single place that sees every query, which is a worse
// position than any one provider occupies. That is why the query carries no
// window — the book cannot correlate what it never learns.
//
// And it does not catch everything. The address check reads the URL's own host,
// so **a name that resolves to a private address gets through** — closing that
// needs resolve-then-connect, which is a different design. A token on the
// listing route is what closes the anonymous case; the address check is what
// stops the careless one. `src/trust.mjs` says the same thing where the check
// lives, so the two cannot drift apart.

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
import {
  assertBindable,
  tokenMatches,
  bearerOf,
  bookRequiresAuth,
  makeLimiter,
  clientKey,
  isLoopback,
  endpointRefusal,
  BOOK_PUBLIC_ROUTES,
  BOOK_NOTES,
} from "../src/trust.mjs";
import { assertRate } from "../src/commission.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const PORT = Number(arg("port", process.env.PORT ?? 8082));
const HOST = arg("host", "127.0.0.1");

/**
 * The token, and the bind guard that refuses to expose a book without one.
 *
 * Optional, because a book on loopback is a book for one operator and the smoke
 * test runs it that way. It stops being optional the moment the socket is not
 * loopback: `assertBindable` throws at startup, before the port exists, so an
 * operator who types `--host 0.0.0.0` and forgets the token gets a refusal
 * rather than an open listing service that a stranger finds first.
 */
const TOKEN = arg("token", process.env.RUIDO_BOOK_TOKEN ?? null);
const BIND = assertBindable({
  host: HOST,
  token: TOKEN,
  because:
    "anyone who can reach the port could list an endpoint in it, and the buyer who " +
    "picks that row hands over the window they are paying to hide",
  open:
    "GET /offers and GET /health are public by design so that a buyer can browse; " +
    "listing a provider needs the token.",
});

/**
 * Whether the book may fetch a provider on a private address.
 *
 * Decided by the bind, because the two are the same question asked twice: a book
 * on loopback is a local book, and the provider it lists is normally local too —
 * which is exactly what the smoke test does. A book on a public interface
 * fetching loopback or RFC 1918 addresses is a book being used as a proxy into
 * its own network. `--allow-private` and `--no-allow-private` override, for the
 * operator who really does run a private provider behind a public book.
 */
const ALLOW_PRIVATE = flag("no-allow-private")
  ? false
  : flag("allow-private")
    ? true
    : isLoopback(HOST);

/**
 * The limiter, sized per route.
 *
 * Reads are generous because browsing is the product. Writes are strict because
 * a write makes the book perform an outbound request, so the write budget is
 * also the budget for how fast this process can be aimed at somebody else's
 * network.
 */
const LIMIT_READ = makeLimiter({ perWindow: 240, windowMs: 60_000 });
const LIMIT_WRITE = makeLimiter({ perWindow: 12, windowMs: 60_000 });

/**
 * The rate this deployment charges, which every row is checked against.
 *
 * Zero by default, and it is configuration rather than a constant because the
 * book and the provider have to agree on it. A book left at zero while the
 * providers charge would refuse every honest row, and the operator would see an
 * empty book rather than the mismatch that caused it — so the refusal names both
 * numbers, and a wrong value here is loud instead of quiet.
 */
const COORDINATION_BPS = Number(arg("coordination-bps", process.env.RUIDO_COORDINATION_BPS ?? 0));
try {
  // The rule is `assertRate` in src/commission.mjs, shared with the provider and
  // with the fee arithmetic, so the three cannot drift apart about what a rate
  // may be.
  assertRate(COORDINATION_BPS);
} catch (error) {
  console.error(`\n  ${error.message}\n`);
  process.exit(1);
}

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
    "access-control-allow-headers": "content-type, authorization",
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
 *
 * The address check is the third outcome and the reason the error is marked:
 * "this book will not fetch that" is neither "the provider is down" nor "the
 * provider publishes something unpublishable", and both callers have to be able
 * to tell it from the other two.
 */
async function fetchTerms(endpoint) {
  const refusal = endpointRefusal(endpoint, { allowPrivate: ALLOW_PRIVATE });
  if (refusal) {
    const error = new Error(refusal);
    error.refused = true;
    throw error;
  }
  const response = await fetch(`${normalise(endpoint)}/terms`, {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${endpoint} answered ${response.status} on /terms`);
  return response.json();
}

/** The pure half: terms in, a validated row out. Throws if the row is not publishable. */
function buildOffer(terms, endpoint) {
  const offer = offerFromTerms(terms, {
    endpoint: normalise(endpoint),
    registeredAt: new Date().toISOString(),
    // The book's own rate, so a row that declares a different one is refused
    // rather than listed. See `readCoordination` in src/orderbook.mjs.
    coordinationRate: COORDINATION_BPS,
  });
  return { ...offer, reachable: true, lastSeenAt: new Date().toISOString() };
}

/**
 * True when a row is old enough that its price may no longer be the price.
 *
 * A timestamp this cannot read counts as **stale, not fresh**. "We have never
 * read this row" is not "we read it a moment ago", and the other direction is
 * how a provider that died keeps a `reachable: true` it earned once and never
 * has to earn again — a row that is listed, looks live, and is not.
 */
const stale = (offer) => {
  const seen = Date.parse(offer.lastSeenAt ?? "");
  return !Number.isFinite(seen) || Date.now() - seen > TTL_MS;
};

/**
 * Re-reads a stale row.
 *
 * Four outcomes, and they are not interchangeable:
 *
 *   the same row, refreshed   the provider answered and its terms are publishable
 *   the row with `reachable: false`  the provider did not answer. Kept, because
 *                             "listed, not answering" is a different fact from
 *                             "nobody sells this" — the first tells a buyer to
 *                             come back, the second tells them to go elsewhere
 *   `null`                    the provider's terms became unpublishable, OR the
 *                             endpoint is one this book will not fetch. The row
 *                             is withdrawn either way: a provider that starts
 *                             publishing a buyer's cell loses its listing, and
 *                             so does an address that should never have been
 *                             listed — which is the only response that does not
 *                             reward it
 */
async function refresh(offer) {
  if (!stale(offer)) return offer;
  let terms;
  try {
    terms = await fetchTerms(offer.endpoint);
  } catch (error) {
    // A refused endpoint is withdrawn; a provider that did not answer keeps its
    // row, flagged. "This book will not talk to that address" is not "come back
    // later", and leaving it listed would keep it in front of buyers.
    return error.refused ? null : { ...offer, reachable: false };
  }
  try {
    return buildOffer(terms, offer.endpoint);
  } catch (error) {
    // Dropped, because a row this book cannot price is worse than no row — but
    // NOT silently. The commonest cause is now a rate mismatch between this book
    // and that provider, which is a deployment misconfiguration, and a provider
    // that vanishes from the book with no explanation is the hardest kind of
    // problem to find. Registration refuses this loudly; the refresh path can
    // only say so here.
    console.error(`  dropped ${offer.endpoint}: ${error.message}`);
    return null;
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  try {
    if (request.method === "OPTIONS") return send(response, 204, "");

    // The limiter runs BEFORE the token check, and the order is the point: a
    // caller guessing a token must be limited exactly as hard as a caller that
    // has one, or the limiter is protection against the wrong party. Writes are
    // limited harder than reads because a write is what makes the book fetch.
    const writes = request.method === "POST" || request.method === "DELETE";
    const verdict = (writes ? LIMIT_WRITE : LIMIT_READ).check(clientKey(request));
    if (!verdict.ok) {
      const seconds = Math.ceil(verdict.retryAfterMs / 1000);
      response.setHeader("retry-after", String(seconds));
      return send(response, 429, {
        error: "too many requests",
        retryAfterSeconds: seconds,
        note: writes
          ? "writes are limited harder than reads: a write is what makes the book open a socket to somewhere it did not choose"
          : "reads are limited per client address; the address is taken from the socket, not from a header",
      });
    }

    // Only the routes that write. Reading a book is the product, so it is open —
    // and a book whose `/offers` needed a token would be a book nobody lists in.
    if (TOKEN && bookRequiresAuth(request.method, path)) {
      const given = bearerOf(request.headers.authorization);
      if (!tokenMatches(given, TOKEN)) {
        // 401 with the scheme named, so a client that forgot the header can tell
        // that apart from a token that is wrong. `WWW-Authenticate` is what makes
        // it a 401 rather than a 403.
        response.setHeader("www-authenticate", 'Bearer realm="ruido-book"');
        return send(response, 401, {
          error: "this book needs a token to list a provider",
          how: "send `authorization: Bearer <token>`",
          public: [...BOOK_PUBLIC_ROUTES],
        });
      }
    }

    if (request.method === "GET" && path === "/health") {
      return send(response, 200, {
        ok: true,
        offers: offers.size,
        reachable: [...offers.values()].filter((o) => o.reachable === true).length,
        bookVersion: 1,
        // The posture, so an operator can see it rather than infer it from
        // whether strangers are getting in.
        authRequired: Boolean(TOKEN),
        allowPrivate: ALLOW_PRIVATE,
        // The rate every row is checked against, for the same reason as the two
        // above: an operator should be able to see the posture rather than infer
        // it from an empty book.
        coordinationBps: COORDINATION_BPS,
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
        // A refused address is 400 and an unreachable provider is 502, and the
        // two must not collapse: the first is about what the caller asked for
        // and the second is about the provider. A buyer reading either needs to
        // know which one they got.
        if (error.refused) {
          return send(response, 400, {
            error: `this book will not fetch ${body.endpoint}`,
            reason: error.message,
            note: "a registration is a URL the book requests, so it has to be an address the book may request",
          });
        }
        // 502 rather than 400: the registration was well formed and the provider
        // is the thing that failed.
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
      // The rows are loaded as they are, including one whose endpoint this book
      // would refuse to fetch: the check happens at the fetch, so an imported
      // row that should not be there is withdrawn on its first re-read rather
      // than silently trusted. Rejecting the whole file would make one bad row
      // hide every good one.
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

  console.log(
    TOKEN
      ? `  ${BOOK_NOTES.listing}\n  ${BOOK_NOTES.fetch}`
      : "  No --token: listing is open. Fine on loopback; the bind guard refuses a\n" +
          "  public interface without one. Reading is public either way.",
  );
  console.log(
    ALLOW_PRIVATE
      ? `  Fetching a private or loopback endpoint is ALLOWED (${flag("allow-private") ? "--allow-private" : "the book is on loopback"}).\n` +
          "  Link-local is still refused: 169.254.169.254 is a cloud host's own credentials."
      : "  Fetching a private or loopback endpoint is REFUSED. Pass --allow-private for a\n" +
          "  provider on your own network.",
  );
  if (BIND.warning) console.log(`\n  ${BIND.warning}`);

  // Said at startup rather than left in a document, because the operator of a
  // book is the one who can leak every query it receives.
  console.log(`  This book lists OFFERS, not orders: there is no window parameter anywhere in`);
  console.log(`  the API, so a buyer's cell cannot reach this process. It learns the size asked`);
  console.log(`  about and the network — both are in the question — and has no accounts, so it`);
  console.log(`  cannot say who asked. A book that logs can still correlate, and this one keeps`);
  console.log(`  no request log. Rows are re-read from each provider every ${TTL_MS / 1000}s;`);
  console.log(`  everything else on a row is the provider's word.\n`);
});

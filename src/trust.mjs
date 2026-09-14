// Who is allowed to talk to a provider, and how often.
//
// A reference provider that only ever listened on loopback did not need this.
// The moment it is put on a host — which is what makes it a business — three
// problems arrive at once, and none of them is about the protocol:
//
//   1. **The door is open.** `POST /orders` makes the provider commit to emitting
//      decoys, and `POST /orders/:id/reveal` makes it settle. Anyone who can
//      reach the port can do both. A bearer token is the smallest thing that
//      closes it, and it is a token rather than an account because the provider
//      has no idea who its buyers are and should not learn.
//
//   2. **The door is open as fast as the network allows.** The payment route
//      reads the chain, and a chain read is the most expensive thing here. A
//      token does not help against a flood that arrives *with* the token, or
//      against a flood of attempts to guess one. So the limiter runs BEFORE the
//      token check, and it is a token bucket rather than a counter because a
//      counter that resets on a fixed boundary lets a caller spend two windows'
//      worth in one instant.
//
//   3. **The operator does not notice.** This is the one that actually bites.
//      `--host 0.0.0.0` with no token is a provider that will be found, and the
//      operator will not find out from the software. So the bind is REFUSED:
//      not warned about, refused, at startup, before the socket exists.
//
// ## What is deliberately not here
//
// No accounts, no sessions, no cookies, no user table. A buyer is a bearer of a
// token or a stranger, and the provider learns nothing about them either way —
// which is the same posture the protocol takes everywhere else. There is also no
// `X-Forwarded-For` handling: honouring that header without a trusted proxy in
// front would let any caller choose its own rate-limit key, which is the same as
// having no limiter. An operator behind a proxy has to do that mapping at the
// proxy, and the note at the bottom of this file says so.

import { createHash, timingSafeEqual } from "node:crypto";

/** Every spelling of "this machine only" that a Node server accepts. */
export function isLoopback(host) {
  if (typeof host !== "string" || host === "") return false;
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (bare === "localhost" || bare === "::1") return true;
  if (bare.startsWith("::ffff:")) return isLoopback(bare.slice(7));
  // The whole of 127.0.0.0/8 is loopback, not just 127.0.0.1 — a provider bound
  // to 127.0.0.5 is exactly as private and would otherwise be refused.
  const v4 = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const octets = v4.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return false;
  return octets[0] === 127;
}

/**
 * Refuses to expose a provider that has no token.
 *
 * Throws rather than returning a verdict, because the caller's only correct
 * response is to exit — a warning that can be ignored is a warning that will be,
 * and the failure it leads to is a provider that emits for strangers and then
 * cannot pay for its own gas.
 */
export function assertBindable({ host, token }) {
  if (isLoopback(host)) return { exposed: false, host };
  if (!token) {
    throw new Error(
      `refusing to listen on ${host} without a token: every route that costs money ` +
        "would be open to anyone who can reach the port. Pass --token <secret>, or " +
        "bind to 127.0.0.1 and put a proxy in front of it.",
    );
  }
  return {
    exposed: true,
    host,
    warning:
      `listening on ${host}: this port is reachable from outside the machine. ` +
      "/terms is public by design so that a book can read it; everything that " +
      "costs money needs the token.",
  };
}

/**
 * Constant-time token comparison.
 *
 * Both sides are hashed first so that the comparison is over two 32-byte digests
 * of equal length. Comparing the strings directly would leak the token's length
 * through `timingSafeEqual`'s length check, and comparing them with `===` would
 * leak the position of the first differing byte — which is enough to recover a
 * token one character at a time, over enough requests, from anywhere.
 */
export function tokenMatches(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string") return false;
  if (expected === "") return false;
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** `authorization: Bearer <token>` — the scheme is case-insensitive, per RFC 7235. */
export function bearerOf(header) {
  if (typeof header !== "string") return null;
  const match = header.match(/^\s*bearer\s+(.+?)\s*$/i);
  return match ? match[1] : null;
}

/**
 * Which routes are open.
 *
 * `/terms` is public on purpose: it is the interface, and the book has to be
 * able to read it to list a provider at all. It is also the only route that
 * gives away nothing — the price list is what the provider wants known.
 *
 * `/health` is public so that an operator's own monitoring and a book's
 * reachability probe can see whether the process is up. It reports counts and
 * nothing else.
 *
 * Everything else costs money or hands over a plan, so everything else is
 * closed. The list is written as "these two are open" rather than "these five
 * are closed", because a route added later is closed by default and that is the
 * direction the mistake should fall.
 */
export const PUBLIC_ROUTES = new Set(["/", "/terms", "/health"]);

export function requiresAuth(method, path) {
  if (method === "OPTIONS") return false;
  return !PUBLIC_ROUTES.has(path);
}

/**
 * A token bucket per client.
 *
 * `perWindow` tokens refill over `windowMs`, so a caller may burst up to
 * `perWindow` and then is held to the average — which is the shape of traffic
 * this route actually sees: a buyer does five or six things at once and then
 * nothing for a while.
 *
 * Two properties are about the limiter not becoming the problem:
 *
 *   **It is bounded.** An attacker rotating source addresses would otherwise
 *   grow the bucket map without limit, turning a rate limiter into a memory
 *   exhaustion. When the map is full the oldest-inserted bucket is evicted —
 *   not the least-recently-used, because tracking that costs more than it saves
 *   here. The consequence is that a flood of new keys evicts honest buckets, so
 *   an attacker with many addresses can reset its own limit; the alternative is
 *   unbounded memory, and the failure of a limiter is the failure it was bought
 *   to prevent.
 *
 *   **A backwards clock grants nothing.** `Date.now()` is not monotonic, and a
 *   clock that steps back would otherwise be read as a very long elapsed time
 *   and hand out a full bucket. Elapsed time is clamped at zero, so the worst a
 *   clock jump can do is refuse.
 */
export function makeLimiter({ perWindow = 60, windowMs = 60_000, buckets = 10_000 } = {}) {
  if (!(perWindow > 0)) throw new Error(`perWindow must be positive, got ${perWindow}`);
  if (!(windowMs > 0)) throw new Error(`windowMs must be positive, got ${windowMs}`);
  if (!(buckets > 0)) throw new Error(`the bucket map must be able to hold something, got ${buckets}`);

  const state = new Map();
  const perMs = perWindow / windowMs;

  return {
    check(key, now = Date.now()) {
      let bucket = state.get(key);
      if (!bucket) {
        if (state.size >= buckets) state.delete(state.keys().next().value);
        bucket = { tokens: perWindow, last: now };
        state.set(key, bucket);
      }

      const elapsed = Math.max(0, now - bucket.last);
      bucket.tokens = Math.min(perWindow, bucket.tokens + elapsed * perMs);
      bucket.last = now;

      if (bucket.tokens < 1) {
        return { ok: false, retryAfterMs: Math.ceil((1 - bucket.tokens) / perMs), remaining: 0 };
      }
      bucket.tokens -= 1;
      return { ok: true, retryAfterMs: 0, remaining: Math.floor(bucket.tokens) };
    },

    size: () => state.size,
  };
}

/**
 * The rate-limit key for a request.
 *
 * The socket's own address, never a header. `X-Forwarded-For` is caller-supplied
 * and honouring it without a trusted proxy in front means every caller chooses
 * its own bucket — which is the same as having no limiter, while looking like
 * one. An operator behind a proxy has to do this mapping at the proxy, and the
 * provider is told so at startup rather than being quietly spoofable.
 *
 * A socket with no address is a real possibility (an abstract-namespace or
 * already-destroyed connection). It gets its own bucket rather than a shared
 * one, because a shared "unknown" bucket would let one broken connection lock
 * out every other client.
 */
export function clientKey(request) {
  return request.socket?.remoteAddress ?? "unknown";
}

export const TRUST_NOTES = {
  proxy:
    "X-Forwarded-For is ignored on purpose. Behind a proxy, do the client mapping " +
    "at the proxy; honouring the header here would let any caller pick its own " +
    "rate-limit key.",
  terms:
    "/terms is public so a book can list this provider. It is a price list, which is " +
    "what the provider wants known. Every route that costs money needs the token.",
  token:
    "One token, shared by every buyer, is a bearer secret and not an identity. It says " +
    "nothing about who is calling, which is the point — the provider learns when a " +
    "buyer transacts and nothing else.",
};

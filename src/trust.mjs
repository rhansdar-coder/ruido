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

/** Four decimal octets, or `null`. Anything else is a name, not a literal. */
function octetsOf(text) {
  const parts = String(text).split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return octets.some((n) => !Number.isInteger(n) || n > 255) ? null : octets;
}

/** What an IPv4 address is, as far as a fetch is concerned. */
function ipv4Kind([a, b]) {
  if (a === 0) return "unspecified"; // 0.0.0.0/8    "this network"
  if (a === 127) return "loopback"; // 127/8        this machine
  if (a === 169 && b === 254) return "link-local"; // 169.254/16   where the metadata service answers
  if (a === 10) return "private"; // 10/8
  if (a === 172 && b >= 16 && b <= 31) return "private"; // 172.16/12
  if (a === 192 && b === 168) return "private"; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return "private"; // 100.64/10    carrier-grade NAT
  return a >= 224 ? "reserved" : "public"; // multicast and the reserved tail
}

/** What an IPv6 address is, including the IPv4-mapped form the URL parser writes in hex. */
function ipv6Kind(bare) {
  const mapped = bare.match(/^::ffff:(.+)$/);
  if (mapped) {
    const rest = mapped[1];
    const dotted = octetsOf(rest);
    if (dotted) return ipv4Kind(dotted);
    const groups = rest.split(":");
    if (groups.length === 2) {
      const hi = parseInt(groups[0], 16);
      const lo = parseInt(groups[1], 16);
      if (Number.isInteger(hi) && Number.isInteger(lo)) {
        return ipv4Kind([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
      }
    }
    // Inside the mapped range and unreadable: refused, not allowed. The
    // defaulting-open direction is the one that bites.
    return "reserved";
  }
  if (bare === "::") return "unspecified";
  if (bare === "::1") return "loopback";
  const first = parseInt(bare.split(":")[0] || "0", 16);
  if (!Number.isInteger(first)) return "reserved";
  if ((first & 0xfe00) === 0xfc00) return "private"; // fc00::/7   unique local
  if ((first & 0xffc0) === 0xfe80) return "link-local"; // fe80::/10  link-local
  return (first & 0xff00) === 0xff00 ? "reserved" : "public"; // ff00::/8   multicast
}

/**
 * What kind of address a host is.
 *
 * The kinds are not decoration — `endpointRefusal` treats them differently, and
 * the split is the whole point. Link-local and the unspecified address are never
 * a provider, so they are refused **even when private addresses are allowed**: a
 * book on a cloud host that accepts `169.254.169.254` has handed out its
 * instance credentials, and "allow private" was never meant to say that. It was
 * meant to say "my own network", which is loopback and RFC 1918.
 *
 * The URL parser has already normalised the host by the time this sees it, and
 * that is load-bearing rather than convenient: `http://127.1/`,
 * `http://0x7f.0.0.1/` and `http://2130706433/` all arrive as `127.0.0.1`, so
 * classifying the parsed host catches the obfuscated spellings that classifying
 * the raw string would wave through. The form the parser does *not* fold is the
 * IPv4-mapped IPv6 address, which it rewrites to hex —
 * `::ffff:169.254.169.254` arrives as `::ffff:a9fe:a9fe` — so that is unwrapped
 * by hand.
 *
 * A NAME that is not `localhost` comes back `"name"`, and that is a limitation
 * rather than a decision: catching `evil.example` that resolves to
 * `169.254.169.254` needs a DNS lookup, which belongs to whoever is about to
 * open the socket. See the note on `endpointRefusal`.
 */
export function addressKind(host) {
  if (typeof host !== "string" || host === "") return "unspecified";
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (bare === "localhost") return "loopback";
  if (bare.includes(":")) return ipv6Kind(bare);
  const octets = octetsOf(bare);
  return octets ? ipv4Kind(octets) : "name";
}

/** True for an address the public internet cannot route to. */
export function isPrivateHost(host) {
  const kind = addressKind(host);
  return kind !== "public" && kind !== "name";
}

/**
 * Why a URL must not be fetched, or `null` if it may be.
 *
 * This exists because the book fetches the endpoint it is handed, which makes a
 * registration a **URL the book will request**. Without a check, a caller
 * chooses what the book talks to: `http://169.254.169.254/…` is a cloud
 * metadata service, `http://127.0.0.1:6379` is whatever else is listening on the
 * host, and neither of them is a provider.
 *
 * A verdict rather than a throw, because the two callers do different things
 * with it and both need the reason: a registration is refused with it, and a row
 * already listed is withdrawn with it. `rankOffers` returns `why` for the same
 * reason.
 *
 * **What this does not catch.** The check reads the URL's own host. A name that
 * resolves to a private address passes here, and the fetch that follows is what
 * would resolve it — so closing that means resolving first and then connecting
 * to the address that was checked, which is a different design (and one that has
 * to be careful about the answer changing in between). Until then the anonymous
 * case is closed by the token on the listing route, not by this.
 */
export function endpointRefusal(endpoint, { allowPrivate = false } = {}) {
  let url;
  try {
    url = new URL(String(endpoint));
  } catch {
    return "not a URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `only http and https are fetched, and this is ${url.protocol}`;
  }
  if (url.username || url.password) {
    return "a URL carrying credentials is not fetched, because the credentials would be sent to whoever answers";
  }
  // There is no "the URL names no host" branch here, and the absence is
  // deliberate. The parser guarantees a non-empty host for every special scheme,
  // so such a check could never run — and a check that cannot run is not a
  // check, it reads like a defence and behaves like a comment. What makes the
  // guarantee true is the scheme test above running FIRST: `data:` is the shape
  // that has no host, and it is refused for its scheme before anything asks
  // about its host.

  const kind = addressKind(url.hostname);
  if (kind === "link-local") {
    return (
      `${url.hostname} is link-local, which is where a cloud host answers with its own ` +
      "credentials. It is never a provider, so it is refused even when private addresses are allowed"
    );
  }
  if (kind === "unspecified" || kind === "reserved") {
    return `${url.hostname} is not an address anything can be reached at`;
  }
  if (!allowPrivate && kind === "loopback") {
    return `${url.hostname} is loopback: this machine, not a provider. Pass --allow-private to fetch it anyway`;
  }
  if (!allowPrivate && kind === "private") {
    return `${url.hostname} is a private address, which the public internet cannot reach. Pass --allow-private to fetch it anyway`;
  }
  return null;
}

/**
 * Refuses to expose a provider that has no token.
 *
 * Throws rather than returning a verdict, because the caller's only correct
 * response is to exit — a warning that can be ignored is a warning that will be,
 * and the failure it leads to is a provider that emits for strangers and then
 * cannot pay for its own gas.
 *
 * `because` and `open` are the two sentences that differ between the two
 * processes that use this: what the door being open costs, and what is
 * deliberately public. The logic is identical and only the prose is not, so the
 * prose is what is parameterised. The defaults are the provider's wording.
 */
export function assertBindable({ host, token, because, open }) {
  if (isLoopback(host)) return { exposed: false, host };
  if (!token) {
    throw new Error(
      `refusing to listen on ${host} without a token: ` +
        (because ?? "every route that costs money would be open to anyone who can reach the port") +
        ". Pass --token <secret>, or bind to 127.0.0.1 and put a proxy in front of it.",
    );
  }
  return {
    exposed: true,
    host,
    warning:
      `listening on ${host}: this port is reachable from outside the machine. ` +
      (open ??
        "/terms is public by design so that a book can read it; everything that " +
          "costs money needs the token."),
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
 * Which of the book's routes are open.
 *
 * The book's job is to be read by buyers, so reading it is public: `GET /offers`
 * is the product, `GET /export` is the same rows in a different shape, and
 * `GET /health` is counts. A book that needed a token to browse would be a book
 * nobody uses.
 *
 * **Writing is closed.** A registration makes the book fetch a URL the caller
 * chose, and the row it produces is what a buyer will talk to — so an open
 * listing route is a stranger deciding who receives a buyer's window. That is
 * the same failure the provider's door exists to prevent, one step earlier.
 *
 * The method is part of the key here, unlike the provider's list, because
 * `GET /offers` and `POST /offers` are the same path and must not be the same
 * verdict. Written as "these are open" so a route added later is closed by
 * default — the direction the mistake should fall.
 */
export const BOOK_PUBLIC_ROUTES = new Set(["GET /health", "GET /offers", "GET /export"]);

export function bookRequiresAuth(method, path) {
  if (method === "OPTIONS") return false;
  return !BOOK_PUBLIC_ROUTES.has(`${method} ${path}`);
}

/** The book's two notes, which are not the provider's and must not be reused. */
export const BOOK_NOTES = {
  listing:
    "Listing needs the token. A book that accepts an endpoint from anyone lets a " +
    "stranger choose what a buyer talks to, and the buyer's first message carries " +
    "the window they are paying to hide.",
  fetch:
    "The book fetches the endpoint it is given, so a registration is a URL this " +
    "process will request. A non-public address is refused unless the book is " +
    "itself on loopback, where a local provider is the normal case.",
  dns:
    "The address check reads the URL's own host, so a NAME that resolves to a " +
    "private address is not caught by it. Closing that needs resolve-then-connect, " +
    "which is not what this does.",
};

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

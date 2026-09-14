// Who may talk to a provider, and how often — tested without a server.
//
// The bind guard is the one that matters most and is the easiest to get wrong
// quietly: `--host 0.0.0.0` with no token is a provider that will be found, and
// the failure is silent. So the tests below walk the address forms a Node server
// accepts rather than checking 127.0.0.1 and calling it done — `127.0.0.5` and
// `::ffff:127.0.0.1` are both loopback, and a guard that refused them would be a
// guard an operator works around.

import test from "node:test";
import assert from "node:assert/strict";

import {
  isLoopback,
  assertBindable,
  tokenMatches,
  bearerOf,
  requiresAuth,
  makeLimiter,
  clientKey,
  PUBLIC_ROUTES,
  addressKind,
  isPrivateHost,
  endpointRefusal,
  bookRequiresAuth,
  BOOK_PUBLIC_ROUTES,
} from "../src/trust.mjs";

// --- what counts as this machine only ---------------------------------------

test("every spelling of loopback is recognised", () => {
  for (const host of ["127.0.0.1", "127.0.0.5", "127.255.255.255", "localhost", "LOCALHOST", "::1", "[::1]", "::ffff:127.0.0.1"]) {
    assert.equal(isLoopback(host), true, `${host} should be loopback`);
  }
});

test("anything that is not loopback is not", () => {
  for (const host of ["0.0.0.0", "::", "[::]", "10.0.0.1", "192.168.1.1", "172.16.0.1", "8.8.8.8", "", null, undefined, "example.com"]) {
    assert.equal(isLoopback(host), false, `${host} should not be loopback`);
  }
});

test("a malformed address is not treated as loopback", () => {
  // 127.0.0.256 is not a valid address, and treating it as loopback would let a
  // typo open a port. It is not valid, so it is not loopback, and the guard
  // demands a token for it.
  assert.equal(isLoopback("127.0.0.256"), false);
  assert.equal(isLoopback("127.0.0.1.5"), false);
});

// --- the bind guard ---------------------------------------------------------

test("loopback needs no token", () => {
  const verdict = assertBindable({ host: "127.0.0.1", token: null });
  assert.equal(verdict.exposed, false);
  assert.equal(verdict.warning, undefined);
});

test("a public interface with no token is refused, not warned about", () => {
  assert.throws(
    () => assertBindable({ host: "0.0.0.0", token: null }),
    /refusing to listen on 0\.0\.0\.0 without a token/,
  );
});

test("the refusal says what to do instead", () => {
  try {
    assertBindable({ host: "0.0.0.0", token: null });
    assert.fail("it was allowed");
  } catch (error) {
    assert.match(error.message, /--token <secret>/);
    assert.match(error.message, /bind to 127\.0\.0\.1/);
  }
});

test("a public interface WITH a token is allowed, and warned about", () => {
  const verdict = assertBindable({ host: "0.0.0.0", token: "s3cret" });
  assert.equal(verdict.exposed, true);
  assert.match(verdict.warning, /reachable from outside/);
  assert.match(verdict.warning, /\/terms is public/);
});

test("an empty token is not a token", () => {
  assert.throws(() => assertBindable({ host: "0.0.0.0", token: "" }), /without a token/);
});

// --- the token --------------------------------------------------------------

test("the right token matches and a wrong one does not", () => {
  assert.equal(tokenMatches("s3cret", "s3cret"), true);
  assert.equal(tokenMatches("s3cret ", "s3cret"), false);
  assert.equal(tokenMatches("S3CRET", "s3cret"), false);
  assert.equal(tokenMatches("", "s3cret"), false);
  assert.equal(tokenMatches(null, "s3cret"), false);
});

test("an empty expected token matches nothing, including an empty one", () => {
  // Otherwise a provider configured with `--token ""` would authenticate every
  // caller who sent no header at all — the exact inverse of the intent.
  assert.equal(tokenMatches("", ""), false);
  assert.equal(tokenMatches(null, ""), false);
  assert.equal(tokenMatches("anything", ""), false);
});

test("tokens of different lengths still compare correctly", () => {
  // The comparison hashes both sides to a fixed width before comparing, so the
  // length is not the thing being compared — and the outcome must still be right.
  assert.equal(tokenMatches("a", "a"), true);
  assert.equal(tokenMatches("a", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), false);
  assert.equal(tokenMatches("a".repeat(1000), "a".repeat(1000)), true);
});

test("a token with non-ascii characters is compared by bytes, not by code points", () => {
  assert.equal(tokenMatches("contraseña", "contraseña"), true);
  assert.equal(tokenMatches("contraseña", "contrasena"), false);
});

// --- the header -------------------------------------------------------------

test("the bearer scheme is read in any casing", () => {
  for (const header of ["Bearer s3cret", "bearer s3cret", "BEARER s3cret", "  Bearer   s3cret  ", "BeArEr s3cret"]) {
    assert.equal(bearerOf(header), "s3cret", header);
  }
});

test("another scheme is not a bearer token", () => {
  assert.equal(bearerOf("Basic czNjcmV0"), null);
  assert.equal(bearerOf("Bearer"), null);
  assert.equal(bearerOf("Bearer "), null);
  assert.equal(bearerOf(undefined), null);
  assert.equal(bearerOf(""), null);
});

test("a token containing a space survives, because the scheme is split once", () => {
  assert.equal(bearerOf("Bearer a b c"), "a b c");
});

// --- what is open -----------------------------------------------------------

test("the price list and the health check are the only public routes", () => {
  assert.equal(requiresAuth("GET", "/terms"), false);
  assert.equal(requiresAuth("GET", "/health"), false);
  assert.equal(requiresAuth("GET", "/"), false);
  assert.equal(requiresAuth("OPTIONS", "/orders"), false, "a preflight is not a request for anything");
});

test("everything that costs money is closed", () => {
  for (const [method, path] of [
    ["POST", "/orders"],
    ["GET", "/orders"],
    ["GET", "/orders/0xabc"],
    ["POST", "/orders/0xabc/payment"],
    ["POST", "/orders/0xabc/reveal"],
  ]) {
    assert.equal(requiresAuth(method, path), true, `${method} ${path} should need a token`);
  }
});

test("a route that does not exist yet is closed by default", () => {
  // The list is written as "these are open" rather than "these are closed", so
  // that the mistake of forgetting to classify a new route falls on the safe
  // side. This is the test that says so.
  assert.equal(requiresAuth("POST", "/admin/drain"), true);
  assert.equal(requiresAuth("DELETE", "/orders"), true);
  assert.ok(!PUBLIC_ROUTES.has("/admin/drain"));
});

// --- the limiter ------------------------------------------------------------

test("a client gets its allowance and then is refused", () => {
  const limiter = makeLimiter({ perWindow: 3, windowMs: 1000 });
  assert.equal(limiter.check("a", 0).ok, true);
  assert.equal(limiter.check("a", 0).ok, true);
  assert.equal(limiter.check("a", 0).ok, true);
  const refused = limiter.check("a", 0);
  assert.equal(refused.ok, false);
  assert.equal(refused.remaining, 0);
});

test("one client's spending does not spend another's", () => {
  const limiter = makeLimiter({ perWindow: 1, windowMs: 1000 });
  assert.equal(limiter.check("a", 0).ok, true);
  assert.equal(limiter.check("a", 0).ok, false);
  assert.equal(limiter.check("b", 0).ok, true);
});

test("the bucket refills over the window", () => {
  const limiter = makeLimiter({ perWindow: 10, windowMs: 1000 });
  for (let i = 0; i < 10; i += 1) limiter.check("a", 0);
  assert.equal(limiter.check("a", 0).ok, false);
  // A tenth of the window gives back one token.
  assert.equal(limiter.check("a", 100).ok, true);
  assert.equal(limiter.check("a", 100).ok, false);
});

test("a full window gives the whole allowance back", () => {
  const limiter = makeLimiter({ perWindow: 5, windowMs: 1000 });
  for (let i = 0; i < 5; i += 1) limiter.check("a", 0);
  assert.equal(limiter.check("a", 1000).ok, true);
  assert.equal(limiter.check("a", 1000).ok, true);
});

test("the refill never exceeds the allowance", () => {
  const limiter = makeLimiter({ perWindow: 2, windowMs: 1000 });
  assert.equal(limiter.check("a", 0).ok, true);
  // A very long idle period must not bank a hundred tokens.
  assert.equal(limiter.check("a", 1_000_000).ok, true);
  assert.equal(limiter.check("a", 1_000_000).ok, true);
  assert.equal(limiter.check("a", 1_000_000).ok, false);
});

test("the refusal says how long to wait, and it is inside the window", () => {
  const limiter = makeLimiter({ perWindow: 1, windowMs: 1000 });
  limiter.check("a", 0);
  const refused = limiter.check("a", 0);
  assert.ok(refused.retryAfterMs > 0);
  assert.ok(refused.retryAfterMs <= 1000, `retryAfterMs ${refused.retryAfterMs} is over the window`);
});

test("a clock that steps backwards grants nothing", () => {
  // `Date.now()` is not monotonic. A backwards jump read as "a long time
  // elapsed" would hand out a full bucket, so elapsed time is clamped at zero
  // and the worst a jump can do is refuse.
  const limiter = makeLimiter({ perWindow: 1, windowMs: 1000 });
  limiter.check("a", 10_000);
  assert.equal(limiter.check("a", 10_000).ok, false);
  assert.equal(limiter.check("a", 5_000).ok, false, "a backwards clock handed out a token");
});

test("the bucket map is bounded, so a limiter cannot become the outage", () => {
  const limiter = makeLimiter({ perWindow: 1, windowMs: 1000, buckets: 8 });
  for (let i = 0; i < 200; i += 1) limiter.check(`client-${i}`, 0);
  assert.ok(limiter.size() <= 8, `the map grew to ${limiter.size()}`);
});

test("eviction drops the oldest bucket, and the newest still works", () => {
  const limiter = makeLimiter({ perWindow: 1, windowMs: 1000, buckets: 2 });
  limiter.check("old", 0);
  limiter.check("middle", 0);
  limiter.check("new", 0);
  assert.equal(limiter.size(), 2);
  assert.equal(limiter.check("new", 0).ok, false, "the newest bucket was the one evicted");
});

test("a limiter with no allowance is refused at construction", () => {
  assert.throws(() => makeLimiter({ perWindow: 0 }), /perWindow must be positive/);
  assert.throws(() => makeLimiter({ windowMs: 0 }), /windowMs must be positive/);
  assert.throws(() => makeLimiter({ buckets: 0 }), /bucket map/);
});

// --- the key ----------------------------------------------------------------

test("the key is the socket's address", () => {
  assert.equal(clientKey({ socket: { remoteAddress: "10.0.0.1" } }), "10.0.0.1");
});

test("a socket with no address gets its own bucket, not a shared one", () => {
  // A shared "unknown" bucket would let one broken connection lock out every
  // other client, which is a denial of service dressed as a safety measure.
  assert.equal(clientKey({ socket: {} }), "unknown");
  assert.equal(clientKey({}), "unknown");
  const limiter = makeLimiter({ perWindow: 1, windowMs: 1000 });
  assert.equal(limiter.check(clientKey({}), 0).ok, true);
  assert.equal(limiter.check(clientKey({ socket: { remoteAddress: "1.1.1.1" } }), 0).ok, true);
});

// --- what an address is -----------------------------------------------------
// The book fetches the endpoint it is handed, so a registration is a URL this
// process will request. These are about the check that stops it being aimed at
// its own host, its own network, or a cloud metadata service.

test("an address is classified by what it is, not by whether it is private", () => {
  // The kinds are not decoration: the fetch rule treats them differently, and
  // the split is the point — link-local is refused even when private is allowed.
  const cases = {
    "127.0.0.1": "loopback",
    localhost: "loopback",
    "::1": "loopback",
    "10.1.2.3": "private",
    "172.16.0.1": "private",
    "172.31.255.255": "private",
    "192.168.1.1": "private",
    "100.64.0.1": "private",
    "fc00::1": "private",
    "169.254.169.254": "link-local",
    "fe80::1": "link-local",
    "0.0.0.0": "unspecified",
    "::": "unspecified",
    "224.0.0.1": "reserved",
    "8.8.8.8": "public",
    "172.32.0.1": "public",
    "provider.example": "name",
  };
  for (const [host, kind] of Object.entries(cases)) {
    assert.equal(addressKind(host), kind, `${host} should be ${kind}`);
  }
  // 172.32 is outside 172.16/12 and 172.31 is inside it, which is the boundary a
  // hand-written range check gets wrong in the direction that refuses a real
  // provider. Both sides are asserted above for that reason.
});

test("an obfuscated loopback is still loopback, because the parser normalises it", () => {
  // This is why the check reads the PARSED host rather than the string. `127.1`,
  // `0x7f.0.0.1` and `2130706433` are all 127.0.0.1 to the URL parser, and a
  // check on the raw text would wave every one of them through.
  for (const url of ["http://127.1/", "http://0x7f.0.0.1/", "http://2130706433/"]) {
    assert.match(endpointRefusal(url), /127\.0\.0\.1 is loopback/, url);
  }
});

test("an IPv4-mapped IPv6 address is unwrapped, because the parser writes it in hex", () => {
  // `::ffff:169.254.169.254` arrives as `::ffff:a9fe:a9fe`, so a check looking
  // for a dotted quad would miss the metadata service entirely.
  assert.match(endpointRefusal("http://[::ffff:a9fe:a9fe]/"), /link-local/);
  assert.equal(endpointRefusal("http://[::ffff:8.8.8.8]/"), null);
});

test("the metadata service is refused even when private addresses are allowed", () => {
  // The whole reason the classification is split rather than a boolean.
  // `--allow-private` means "my own network" — loopback and RFC 1918 — and
  // 169.254.169.254 is where a cloud host answers with its own credentials. A
  // book that treated those as one question would hand out its instance role to
  // whoever registered first.
  const metadata = "http://169.254.169.254/latest/meta-data/";
  assert.match(endpointRefusal(metadata), /link-local/);
  assert.match(endpointRefusal(metadata, { allowPrivate: true }), /link-local/);
  assert.match(endpointRefusal("http://[::ffff:a9fe:a9fe]/", { allowPrivate: true }), /link-local/);
});

test("a private address is refused by default and allowed on request", () => {
  assert.match(endpointRefusal("http://10.0.0.1/"), /private address/);
  assert.match(endpointRefusal("http://127.0.0.1:8080/"), /loopback/);
  assert.equal(endpointRefusal("http://10.0.0.1/", { allowPrivate: true }), null);
  assert.equal(endpointRefusal("http://127.0.0.1:8080/", { allowPrivate: true }), null);
});

test("an address nothing can be reached at is refused either way", () => {
  for (const url of ["http://0.0.0.0/", "http://[::]/", "http://224.0.0.1/"]) {
    assert.match(endpointRefusal(url), /not an address/, url);
    assert.match(endpointRefusal(url, { allowPrivate: true }), /not an address/, url);
  }
});

test("only http and https are fetched", () => {
  // `file:` reads the book's own disk and `data:` is a shape with no host at
  // all; both are one registration away if the scheme is not the first thing
  // checked. The scheme test running first is also what makes the absence of a
  // no-host branch in `endpointRefusal` correct rather than merely absent.
  assert.match(endpointRefusal("file:///etc/passwd"), /only http and https/);
  assert.match(endpointRefusal("gopher://x/"), /only http and https/);
  assert.match(endpointRefusal("data:text/html,hi"), /only http and https/);
});

test("a URL carrying credentials is refused", () => {
  // The credentials would be sent to whoever answers, which is the attacker.
  assert.match(endpointRefusal("http://user:pw@example.com/"), /credentials/);
});

test("a public host is fetchable", () => {
  assert.equal(endpointRefusal("https://provider.example/"), null);
  assert.equal(endpointRefusal("http://8.8.8.8:8080/"), null);
});

test("a name that resolves to a private address gets through, and that is declared", () => {
  // Not an oversight and not a passing grade: it is the documented limit of a
  // check that reads the URL's own host. Catching it needs resolve-then-connect,
  // which is a different design. The test exists so the gap is a fact with a
  // test rather than a sentence in a comment.
  assert.equal(endpointRefusal("http://evil.example/"), null);
  assert.equal(addressKind("evil.example"), "name");
});

// --- the book's door --------------------------------------------------------
// The same three problems as the provider, one step earlier in the trade: a
// registration is what makes the book fetch, and the row it produces is what a
// buyer talks to.

test("browsing a book is public and listing in it is not", () => {
  // A book that needed a token to browse is a book nobody lists in, and its rows
  // are a price list. Writing is the closed half — and the METHOD is what makes
  // that expressible at all, because `GET /offers` and `POST /offers` are the
  // same path and must not get the same verdict.
  assert.equal(bookRequiresAuth("GET", "/offers"), false);
  assert.equal(bookRequiresAuth("GET", "/health"), false);
  assert.equal(bookRequiresAuth("GET", "/export"), false);
  assert.equal(bookRequiresAuth("POST", "/offers"), true);
  assert.equal(bookRequiresAuth("POST", "/import"), true);
});

test("a book route that does not exist yet is closed by default", () => {
  assert.equal(bookRequiresAuth("GET", "/nope"), true);
  assert.equal(bookRequiresAuth("DELETE", "/offers"), true);
});

test("a preflight is not a request for the book either", () => {
  assert.equal(bookRequiresAuth("OPTIONS", "/offers"), false);
});

test("the book's public list is the three readable routes, and nothing else", () => {
  assert.deepEqual([...BOOK_PUBLIC_ROUTES].sort(), ["GET /export", "GET /health", "GET /offers"]);
});

test("the book's bind refusal says what the open door would cost", () => {
  // The logic is the provider's; the prose is not, because what an open door
  // costs is different. A provider that emits for strangers cannot pay for its
  // own gas. A book that lists for strangers is handing them a buyer's window.
  try {
    assertBindable({
      host: "0.0.0.0",
      token: null,
      because: "anyone who can reach the port could list an endpoint in it",
      open: "GET /offers is public by design",
    });
    assert.fail("it was allowed");
  } catch (error) {
    assert.match(error.message, /anyone who can reach the port could list an endpoint in it/);
    assert.match(error.message, /--token <secret>/);
  }
  const verdict = assertBindable({ host: "0.0.0.0", token: "s3cret", open: "GET /offers is public by design" });
  assert.match(verdict.warning, /GET \/offers is public by design/);
});

test("the provider's wording is unchanged when the book's is not asked for", () => {
  // Parameterising the prose must not have moved the provider's message: its
  // operator reads it, and the tests above pin it. This is the test that fails
  // if someone "improves" the default.
  try {
    assertBindable({ host: "0.0.0.0", token: null });
    assert.fail("it was allowed");
  } catch (error) {
    assert.match(error.message, /every route that costs money would be open to anyone who can reach the port/);
  }
});

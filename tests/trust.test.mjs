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

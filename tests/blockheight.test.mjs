// Reading the chain's height, which sounds trivial and is the one input the
// reveal gate cannot do without.
//
// The gate's rule is a comparison against the height, so the height is either
// right, or the gate is answering about a different chain. And the failure that
// matters is not "it returned a wrong number" — it is "it could not find out and
// said zero anyway", because zero reads as "the chain has not started" to one
// caller and as "the window closed long ago" to another. Both are silent, and
// the second one hands a rung to the provider early.
//
// So the contract under test is: a number, or `undefined`. Never a throw, never
// a default. `0` is returned only when an endpoint genuinely said `0`.
//
// Every stub below is injected through the `fetch` option. Nothing here opens a
// socket — the public endpoints are somebody else's rate limit, and a test suite
// that hammers them is a test suite that fails when they throttle.

import test from "node:test";
import assert from "node:assert/strict";

import { STARKNET_RPC, endpointsFor, blockNumberFrom, readBlockHeight } from "../src/blockheight.mjs";

const SEPOLIA = STARKNET_RPC.sepolia[0];
const SEPOLIA_2 = STARKNET_RPC.sepolia[1];

/** A well-formed JSON-RPC answer. */
const ok = (result) => ({ text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result }) });

/** An answer with an error, which is a different thing from a bad answer. */
const rpcError = (message) => ({
  text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message } }),
});

/** What a proxy or captive portal returns: HTML with a 200 status. */
const html = () => ({ text: async () => "<!DOCTYPE html><html><body>Sign in</body></html>" });

/** A body that is not JSON at all. */
const garbage = () => ({ text: async () => "upstream timeout" });

const refused = () => {
  throw new Error("ECONNREFUSED");
};

/** A fetch that answers per endpoint and records what it was asked. */
function stubFetch(map) {
  const calls = [];
  const fn = async (endpoint, init) => {
    calls.push({ endpoint, init });
    if (!(endpoint in map)) throw new Error(`unexpected endpoint: ${endpoint}`);
    return map[endpoint]();
  };
  fn.calls = calls;
  return fn;
}

// --- one endpoint, one call -------------------------------------------------

test("a well-formed answer gives the height", async () => {
  assert.equal(await blockNumberFrom(SEPOLIA, { fetch: stubFetch({ [SEPOLIA]: () => ok(14_865_300) }) }), 14_865_300);
});

test("the request is a starknet_blockNumber JSON-RPC call", async () => {
  const doFetch = stubFetch({ [SEPOLIA]: () => ok(1) });
  await blockNumberFrom(SEPOLIA, { fetch: doFetch });

  assert.equal(doFetch.calls.length, 1);
  assert.equal(doFetch.calls[0].endpoint, SEPOLIA);
  assert.equal(doFetch.calls[0].init.method, "POST");
  const body = JSON.parse(doFetch.calls[0].init.body);
  assert.equal(body.method, "starknet_blockNumber");
  assert.deepEqual(body.params, []);
});

test("genesis is a value, not a failure", async () => {
  // `0` has to survive. A reader that laundered it into `undefined` would be
  // hiding a real answer, and a reader that produced it as a DEFAULT is the bug
  // this file exists to prevent — which is why the two are tested apart.
  assert.equal(await blockNumberFrom(SEPOLIA, { fetch: stubFetch({ [SEPOLIA]: () => ok(0) }) }), 0);
});

// --- the three ways an endpoint lies ----------------------------------------

test("an HTML body is refused, not parsed", async () => {
  // The proxy case: a 200 with a login page. Checked before JSON.parse, because
  // a parse error would say "invalid JSON" and the diagnosis is "you are behind
  // a captive portal".
  await assert.rejects(
    () => blockNumberFrom(SEPOLIA, { fetch: stubFetch({ [SEPOLIA]: html }) }),
    /non-JSON response \(HTML\)/,
  );
});

test("a body that is not JSON at all is refused with its own reason", async () => {
  await assert.rejects(() => blockNumberFrom(SEPOLIA, { fetch: stubFetch({ [SEPOLIA]: garbage }) }), /non-JSON response/);
});

test("a JSON-RPC error carries the endpoint's own message", async () => {
  await assert.rejects(
    () => blockNumberFrom(SEPOLIA, { fetch: stubFetch({ [SEPOLIA]: () => rpcError("method not found") }) }),
    /method not found/,
  );
});

test("a result that is not an integer is refused rather than coerced", async () => {
  // The string form is what a sloppy proxy does to numbers, and `Number("14865300")`
  // would quietly accept it. It is refused because the module's contract is a
  // number, and coercion here is how a height becomes a string somewhere else.
  for (const bad of ["14865300", null, undefined, 1.5, {}, []]) {
    await assert.rejects(
      () => blockNumberFrom(SEPOLIA, { fetch: stubFetch({ [SEPOLIA]: () => ok(bad) }) }),
      /not a block number/,
      `result ${JSON.stringify(bad)} was accepted`,
    );
  }
});

// --- rotation ---------------------------------------------------------------

test("a dead endpoint is rotated past, and not retried", async () => {
  // Rotated rather than retried: a retry storm against a rate-limited endpoint
  // makes the rate limiting worse.
  const doFetch = stubFetch({ [SEPOLIA]: refused, [SEPOLIA_2]: () => ok(14_865_400) });
  const height = await readBlockHeight({ network: "sepolia", endpoints: [SEPOLIA, SEPOLIA_2], fetch: doFetch });

  assert.equal(height, 14_865_400);
  assert.equal(doFetch.calls.length, 2, "each endpoint should be tried exactly once");
  assert.deepEqual(doFetch.calls.map((c) => c.endpoint), [SEPOLIA, SEPOLIA_2]);
});

test("every way an endpoint can fail is rotated past, not just the network one", async () => {
  const cases = { html, garbage, "rpc error": () => rpcError("nope"), "not a number": () => ok("14865300"), dead: refused };

  for (const [label, behaviour] of Object.entries(cases)) {
    const doFetch = stubFetch({ [SEPOLIA]: behaviour, [SEPOLIA_2]: () => ok(7) });
    const height = await readBlockHeight({ network: "sepolia", endpoints: [SEPOLIA, SEPOLIA_2], fetch: doFetch });
    assert.equal(height, 7, `an endpoint failing with "${label}" was not rotated past`);
  }
});

test("when every endpoint fails the answer is undefined, and NEVER zero", async () => {
  // The load-bearing test in this file. Zero is a plausible-looking number that
  // means "the chain has not started", so a caller that defaulted to it would
  // read an unreachable RPC as a window that has not opened — and a caller that
  // subtracted it would read it as a window that closed long ago. The second is
  // a rung handed over early.
  const doFetch = stubFetch({ [SEPOLIA]: refused, [SEPOLIA_2]: html });
  const height = await readBlockHeight({ network: "sepolia", endpoints: [SEPOLIA, SEPOLIA_2], fetch: doFetch });

  assert.equal(height, undefined);
  assert.notEqual(height, 0, "an unreachable chain must not look like genesis");
  assert.ok(!Number.isInteger(height), "undefined is the only value that forces the caller to decide");
});

test("it does not throw when the chain cannot be reached", async () => {
  const doFetch = stubFetch({ [SEPOLIA]: refused, [SEPOLIA_2]: refused });
  await assert.doesNotReject(() =>
    readBlockHeight({ network: "sepolia", endpoints: [SEPOLIA, SEPOLIA_2], fetch: doFetch }),
  );
});

test("a network with no endpoints is undefined, not an exception", async () => {
  // `endpointsFor` on a chain we do not serve returns an empty list, and an
  // empty list has to be a refusal rather than a crash: "we do not serve that
  // chain" and "the chain is unreachable" lead to the same refusal.
  assert.deepEqual(endpointsFor("dogecoin"), []);
  assert.equal(await readBlockHeight({ network: "dogecoin", fetch: stubFetch({}) }), undefined);
});

test("the failure is reported once, with the last error and the list tried", async () => {
  const seen = [];
  const doFetch = stubFetch({ [SEPOLIA]: refused, [SEPOLIA_2]: () => rpcError("rate limited") });
  await readBlockHeight({
    network: "sepolia",
    endpoints: [SEPOLIA, SEPOLIA_2],
    fetch: doFetch,
    onFailure: (report) => seen.push(report),
  });

  assert.equal(seen.length, 1, "onFailure should be called once, not once per endpoint");
  assert.deepEqual(seen[0].endpoints, [SEPOLIA, SEPOLIA_2]);
  // The LAST error, because that is the one that explains why the final attempt
  // failed — the first is usually just a dead host.
  assert.match(seen[0].error.message, /rate limited/);
});

test("a success reports nothing at all", async () => {
  const seen = [];
  await readBlockHeight({
    network: "sepolia",
    endpoints: [SEPOLIA],
    fetch: stubFetch({ [SEPOLIA]: () => ok(3) }),
    onFailure: (report) => seen.push(report),
  });
  assert.deepEqual(seen, []);
});

// --- the list itself --------------------------------------------------------

test("each network has a list, because public endpoints rotate out", () => {
  // A list rather than a constant: this is the reason the module exists, since
  // the same six URLs were previously copied into three scripts.
  for (const network of ["sepolia", "mainnet"]) {
    assert.ok(Array.isArray(STARKNET_RPC[network]), `${network} should carry a list`);
    assert.ok(STARKNET_RPC[network].length >= 2, `${network} needs more than one endpoint to rotate`);
    for (const url of STARKNET_RPC[network]) assert.match(url, /^https:\/\//);
  }
  assert.deepEqual(endpointsFor("sepolia"), STARKNET_RPC.sepolia);
  // No duplicates: a list with the same host twice is a list of one.
  for (const network of ["sepolia", "mainnet"]) {
    assert.equal(new Set(STARKNET_RPC[network]).size, STARKNET_RPC[network].length);
  }
});

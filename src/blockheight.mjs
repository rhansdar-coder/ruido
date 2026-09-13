// The chain's height, and the endpoints it can be read from.
//
// ## Why this is its own module
//
// The same six public URLs were written into three scripts — the corpus builder,
// the block-time measurement, and the reveal client — each with its own rotation
// loop. A public endpoint that rotates out has to be corrected in all three or
// the fix only half-lands, and the half that keeps failing is the one nobody is
// looking at. Adding a fourth copy so the provider could check the height for
// itself was the moment to stop: the list and the read live here, and the
// callers import them.
//
// What is NOT consolidated here, deliberately: the `verify:*` and `check:*`
// scripts each default to a single sepolia endpoint with a `RUIDO_RPC` override.
// That is a different pattern for a different job — a handful of one-shot calls,
// where a rotation list buys nothing — so those literals stay where they are
// rather than being forced through this module for tidiness.
//
// ## The contract that matters
//
// `readBlockHeight` returns a number, or **`undefined`** — never `0`, never a
// throw. That is not a style choice. `0` is a perfectly valid-looking answer that
// means "the chain has not started", so a caller that defaulted to it would read
// an unreachable RPC as "the window has not opened yet" and a caller that
// subtracted it would read it as "the window closed long ago". Both are silent.
// `undefined` is the only value that forces the caller to decide, and every
// caller in this repository treats it as a refusal.

/**
 * Public read endpoints per network, in the order they are tried.
 *
 * Rotated rather than retried: a retry storm against a rate-limited endpoint
 * makes the rate limiting worse, which is the same reasoning as `src/chains.mjs`
 * uses for the EVM chains.
 */
export const STARKNET_RPC = {
  sepolia: [
    "https://starknet-sepolia-rpc.publicnode.com",
    "https://starknet-sepolia.api.onfinality.io/public",
    "https://starknet-sepolia-rpc.itrocket.net",
  ],
  mainnet: [
    "https://starknet-rpc.publicnode.com",
    "https://starknet.api.onfinality.io/public",
    "https://starknet-mainnet-rpc.itrocket.net",
  ],
};

/** The endpoints for a network, or an empty list for one we do not serve. */
export function endpointsFor(network) {
  return STARKNET_RPC[network] ?? [];
}

/**
 * One endpoint, one call. Returns the block number or throws with a reason.
 *
 * The three throws are the three ways a public endpoint lies: it answers with
 * HTML (a captive portal or a proxy), it answers with a JSON-RPC error, or it
 * answers with something that is not a block number. Each is named separately
 * because "it failed" is not a diagnosis.
 */
export async function blockNumberFrom(endpoint, { fetch: doFetch = fetch, timeoutMs = 15_000 } = {}) {
  const response = await doFetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "starknet_blockNumber", params: [] }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await response.text();
  // Checked before JSON.parse, because the interesting failure is a proxy or
  // captive portal returning a login page with a 200 status.
  if (text.trim().startsWith("<")) throw new Error("non-JSON response (HTML)");

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response: ${text.slice(0, 60)}`);
  }

  if (body.error) throw new Error(body.error.message ?? "rpc error");
  if (!Number.isInteger(body.result)) throw new Error(`not a block number: ${JSON.stringify(body.result)}`);
  return body.result;
}

/**
 * The chain's height, or `undefined` if it cannot be established.
 *
 * `endpoints` is explicit rather than derived from `network` so that a caller
 * can pass one URL — which is what `serve-provider --rpc` does — and so that a
 * test can pass a list of stubs. When it is not given, the network's public list
 * is used.
 *
 * `onFailure` is called once with the last error, so a caller can log the reason
 * without this module deciding where logs go.
 */
export async function readBlockHeight({
  network,
  endpoints = endpointsFor(network),
  fetch: doFetch = fetch,
  timeoutMs = 15_000,
  onFailure = null,
} = {}) {
  const list = endpoints ?? [];
  let lastError = null;

  for (const endpoint of list) {
    try {
      return await blockNumberFrom(endpoint, { fetch: doFetch, timeoutMs });
    } catch (error) {
      lastError = error;
    }
  }

  if (onFailure) onFailure({ endpoints: list, error: lastError });
  return undefined;
}

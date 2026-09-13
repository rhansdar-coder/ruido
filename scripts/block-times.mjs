#!/usr/bin/env node
// Measure block times for every chain Ruido compares.
//
// This looks like a trivial script and it is load-bearing. The STRK20 report
// published its adversary model as "knows the block to within 10". The moment a
// second chain entered the table that unit stopped meaning anything: 10 blocks
// is 17 seconds on Starknet and 1 second on Robinhood Chain.
//
// Every window in data/measurement-robinhood.json is expressed in seconds, and
// the conversion is only honest if the block times are measured rather than
// assumed. So they are measured, from the chains, every time this runs.
//
//   node scripts/block-times.mjs

import { STARKNET_RPC } from "../src/blockheight.mjs";

const CHAINS = [
  {
    name: "STRK20 · Starknet mainnet",
    kind: "starknet",
    // Imported rather than copied: this list also lives in the corpus builder
    // and the reveal client, and one of the three going stale is a failure that
    // shows up as a timeout rather than as an error.
    rpcs: STARKNET_RPC.mainnet,
    spanBlocks: 20000,
  },
  {
    name: "Robinhood Chain · 4663",
    kind: "evm",
    rpcs: ["https://rpc.mainnet.chain.robinhood.com"],
    spanBlocks: 20000,
  },
];

async function post(rpc, method, params) {
  const r = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  if (text.trim().startsWith("<")) throw new Error("non-JSON response");
  const body = JSON.parse(text);
  if (body.error) throw new Error(body.error.message ?? JSON.stringify(body.error));
  return body.result;
}

/** Try each endpoint in turn; a public RPC that answers today may not tomorrow. */
async function call(chain, method, params) {
  let lastError = null;
  for (const rpc of chain.rpcs) {
    try {
      return await post(rpc, method, params);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`${chain.name}: ${lastError?.message}`);
}

const hex = (v) => Number(BigInt(v));

async function measure(chain) {
  if (chain.kind === "starknet") {
    const head = await call(chain, "starknet_blockNumber", []);
    const a = await call(chain, "starknet_getBlockWithTxHashes", [{ block_number: head }]);
    const b = await call(chain, "starknet_getBlockWithTxHashes", [
      { block_number: head - chain.spanBlocks },
    ]);
    return {
      head,
      from: head - chain.spanBlocks,
      tsFrom: Number(BigInt(b.timestamp)),
      tsTo: Number(BigInt(a.timestamp)),
    };
  }
  const head = hex(await call(chain, "eth_blockNumber", []));
  const to = await call(chain, "eth_getBlockByNumber", ["0x" + head.toString(16), false]);
  const from = await call(chain, "eth_getBlockByNumber", [
    "0x" + (head - chain.spanBlocks).toString(16), false,
  ]);
  return {
    head,
    from: head - chain.spanBlocks,
    tsFrom: hex(from.timestamp),
    tsTo: hex(to.timestamp),
  };
}

const results = [];
for (const chain of CHAINS) {
  const r = await measure(chain);
  const elapsed = r.tsTo - r.tsFrom;
  const blockTime = elapsed / chain.spanBlocks;
  results.push({ name: chain.name, ...r, elapsed, blockTime });
}

console.log("RUIDO · block times (the unit that makes two chains comparable)\n");
for (const r of results) {
  console.log(r.name);
  console.log(`  head             ${r.head.toLocaleString()}`);
  console.log(`  sampled          block ${r.from.toLocaleString()} → ${r.head.toLocaleString()}`);
  console.log(`  elapsed          ${r.elapsed.toLocaleString()} s`);
  console.log(`  block time       ${r.blockTime.toFixed(4)} s   (${(1 / r.blockTime).toFixed(3)} blocks/s)`);
  console.log(`  blocks per day   ${Math.round(86400 / r.blockTime).toLocaleString()}\n`);
}

// The conversion the report depends on, printed so it can be checked by eye.
const [starknet, robinhood] = results;
console.log("what a block-count window means in wall-clock time\n");
console.log(`  ${"blocks".padEnd(10)}${"Starknet".padEnd(16)}Robinhood Chain`);
for (const w of [1, 10, 100, 1000]) {
  const s = w * starknet.blockTime;
  const r = w * robinhood.blockTime;
  console.log(`  ±${String(w).padEnd(9)}${(s.toFixed(1) + " s").padEnd(16)}${r.toFixed(1)} s`);
}
console.log(`\n  the two chains differ by a factor of ${(starknet.blockTime / robinhood.blockTime).toFixed(1)}x,`);
console.log("  which is why the published windows are in seconds.");

#!/usr/bin/env node
// Index a contiguous window of any EVM chain in the registry.
//
// This is the chain-agnostic version of the indexer that started life as
// build-robinhood-corpus.mjs. Adding Base, Optimism, Arbitrum or Ethereum is a
// data change in src/chains.mjs, not a change here.
//
// Four things this script learned the hard way, each of which produced a
// silently wrong corpus before it was fixed:
//
//   1. A for-loop `continue` still runs the increment, so a failed batch both
//      retried at a smaller size AND skipped its block range. The first version
//      indexed 154 of 200 blocks and reported success. Silent block loss is the
//      exact failure mode this project exists to catch.
//   2. A 429 is not a "batch too large" error. Shrinking the batch means MORE
//      requests, which means MORE rate limiting. The second version responded
//      to a 429 by halving, walked itself to batch=1, and finished at 30
//      blocks/s while still being throttled. A 429 is answered with patience.
//   3. An address can be infrastructure. 0x…a4b05 is written once per block on
//      Arbitrum chains; left in, it becomes the most active account on the
//      network. The list is explicit in the registry, and any address whose
//      count equals the block count is reported separately so a missed entry is
//      visible rather than silently inflating the numbers.
//   4. A sample is not a census. The public RPC sustains ~20 blocks/s and the
//      chains here are tens of millions of blocks. The window, its coverage and
//      any blocks that could not be fetched are all published.
//
// Zero dependencies.
//
//   node scripts/build-evm-corpus.mjs --chain robinhood --blocks 24000
//   node scripts/build-evm-corpus.mjs --chain base --blocks 12000
//   node scripts/build-evm-corpus.mjs --chain ethereum --blocks 2000

import { writeFile, mkdir } from "node:fs/promises";
import { freemem } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ENTRYPOINTS, isSystemAddress, resolveChain } from "../src/chains.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const CHAIN_KEY = arg("chain", "robinhood");
const chain = resolveChain(CHAIN_KEY);

const BLOCKS = Number(arg("blocks", 24000));
// 25, not 50. A 50-block batch of full transactions is roughly 250 KB of JSON
// and the public endpoint starts refusing it after a few rounds.
const BATCH = Number(arg("batch", 25));
const OUT = resolve(ROOT, arg("out", `data/corpus-${CHAIN_KEY}.json`));
const TIMEOUT_MS = Number(arg("timeout", 45000));
const MAX_TXS = Number(arg("max-txs", 3000000));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// RPC pool. We rotate rather than retry a dead endpoint: public endpoints
// rate-limit by IP and a retry storm makes the throttling worse.
let rpcIndex = 0;
const currentRpc = () => chain.rpcs[rpcIndex % chain.rpcs.length];
const rotateRpc = () => { rpcIndex += 1; };

async function rpc(body, attempt = 0) {
  const url = currentRpc();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    if (text.trim().startsWith("<")) throw new Error("non-JSON response (gateway or rate limit)");
    return JSON.parse(text);
  } catch (error) {
    if (attempt >= 5) throw new Error(`rpc failed on ${url}: ${error.message}`);
    rotateRpc();
    await sleep(1000 * (attempt + 1));
    return rpc(body, attempt + 1);
  }
}

const call = async (method, params) => {
  const body = await rpc({ jsonrpc: "2.0", id: 1, method, params });
  if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result;
};

const hex = (v) => Number(BigInt(v));
const norm = (a) => (a ? String(a).toLowerCase() : null);

async function main() {
  console.log(`RUIDO · EVM index   ${chain.name}  (${chain.stack}, Chain ID ${chain.chainId})`);
  console.log(`rpc    ${currentRpc()}  (+${chain.rpcs.length - 1} fallback)`);

  const chainId = hex(await call("eth_chainId", []));
  const head = hex(await call("eth_blockNumber", []));
  if (chainId !== chain.chainId) {
    console.error(`wrong chain: ${CHAIN_KEY} reports ${chainId}, registry says ${chain.chainId}`);
    process.exit(1);
  }

  const to = Number(arg("to", head));
  const from = to - BLOCKS + 1;
  console.log(`head   ${head.toLocaleString()}`);
  console.log(`window ${from.toLocaleString()} → ${to.toLocaleString()}  (${BLOCKS.toLocaleString()} blocks)\n`);

  // --- memory guard ----------------------------------------------------------
  // The window is held in memory, so a dense chain can exhaust the heap. That
  // happened for real: Base at 12,000 blocks died with a V8 heap-limit dump
  // after 6,125 blocks, on a machine with 1.3 GB free. A crash that prints a
  // stack trace is a bad way to learn this, so it is said up front.
  //
  // The figure is measured, not guessed: Base used ~2.0 GB for 6,125 blocks,
  // which is ~0.33 MB per block. Denser chains and bigger windows cost more.
  const freeGb = freemem() / 1e9;
  const estimateGb = (BLOCKS * 0.33) / 1024;
  console.log(`free RAM ${freeGb.toFixed(1)} GB, this window needs ~${estimateGb.toFixed(1)} GB for a chain as dense as Base`);
  if (estimateGb > freeGb * 0.6) {
    console.log(`  WARNING: the window is larger than the free memory can hold.`);
    console.log(`  Re-run with a smaller --blocks (roughly ${Math.floor((freeGb * 0.6 * 1024) / 0.33).toLocaleString()} fits) or expect an out-of-memory crash.`);
  }
  console.log("");

  // --- fetch -----------------------------------------------------------------
  let batchSize = BATCH;
  const blocks = [];
  const started = Date.now();
  let lost = 0;
  let shrinkages = 0;
  let throttles = 0;

  // Inter-batch pacing, adjusted from observed throttling.
  let delayMs = Number(arg("delay", 120));
  const baseDelay = delayMs;

  const isThrottle = (payload) => {
    if (!payload || typeof payload !== "object") return false;
    const err = payload.error;
    if (!err) return false;
    return err.code === 429 || /too many requests|rate limit/i.test(String(err.message ?? ""));
  };

  let start = from;
  while (start <= to) {
    const end = Math.min(start + batchSize - 1, to);
    const requests = [];
    for (let n = start; n <= end; n += 1) {
      requests.push({
        jsonrpc: "2.0",
        id: n,
        method: "eth_getBlockByNumber",
        params: ["0x" + n.toString(16), true],
      });
    }

    let responses = null;
    let problem = null;
    let throttled = false;
    try {
      responses = await rpc(requests);
      if (!Array.isArray(responses)) {
        if (isThrottle(responses)) throttled = true;
        else problem = "non-array batch response: " + JSON.stringify(responses).slice(0, 160);
      }
    } catch (error) {
      problem = error.message;
    }

    // Rate limited: wait longer, keep the batch size, retry the same range.
    if (throttled) {
      throttles += 1;
      delayMs = Math.min(6000, Math.max(300, Math.round(delayMs * 1.7)));
      if (throttles <= 8 || throttles % 25 === 0) {
        console.log(`\n  429 throttled (#${throttles}); backing off to ${delayMs} ms between batches`);
      }
      await sleep(delayMs);
      continue;
    }

    // Genuine failure: shrink the request, but only to a floor. Below that the
    // request rate rises and we are back to being throttled.
    if (problem) {
      if (batchSize > 5) {
        batchSize = Math.max(5, Math.floor(batchSize / 2));
        shrinkages += 1;
        console.log(`\n  batch failed (${problem}); retrying same range with batch=${batchSize}`);
        continue;
      }
      lost += batchSize;
      console.log(`\n  giving up on ${start}–${end} (${problem})`);
      start = end + 1;
      await sleep(1000);
      continue;
    }

    for (const entry of responses) {
      if (entry && entry.result) blocks.push(entry.result);
      else lost += 1;
    }

    // Recover the pacing once the endpoint stops complaining.
    if (delayMs > baseDelay) delayMs = Math.max(baseDelay, Math.round(delayMs * 0.85));

    const done = Math.min(end, to) - from + 1;
    const elapsed = (Date.now() - started) / 1000;
    process.stdout.write(
      `\r  ${done.toLocaleString()}/${BLOCKS.toLocaleString()} blocks  `
      + `${blocks.length.toLocaleString()} fetched  `
      + `${(done / elapsed).toFixed(0)} blocks/s  `
      + `batch=${batchSize}  delay=${delayMs}ms  lost=${lost}      `,
    );
    start = end + 1;
    if (delayMs > 0) await sleep(delayMs);
  }
  console.log("\n");

  blocks.sort((a, b) => hex(a.number) - hex(b.number));

  if (lost > 0) {
    console.log(`  WARNING: ${lost} block(s) could not be fetched; window has holes.`);
  }
  if (shrinkages > 0) console.log(`  batch size reduced ${shrinkages} time(s); final batch=${batchSize}`);
  if (throttles > 0) console.log(`  throttled ${throttles} time(s); final inter-batch delay=${delayMs} ms`);

  // --- extract ---------------------------------------------------------------
  const addresses = [];
  const indexOfAddress = new Map();
  const intern = (addr) => {
    const a = norm(addr);
    if (a === null) return -1;
    let i = indexOfAddress.get(a);
    if (i === undefined) {
      i = addresses.length;
      addresses.push(a);
      indexOfAddress.set(a, i);
    }
    return i;
  };

  const rows = [];
  const blockRows = [];
  const systemTxs = new Map();
  const entrypointTxs = new Map();
  const typeCounts = new Map();
  let contractCreations = 0;
  let valueTransfers = 0;
  let truncated = false;

  for (const block of blocks) {
    const bn = hex(block.number);
    const ts = hex(block.timestamp);
    blockRows.push({ n: bn, ts, txs: block.transactions.length, gas: hex(block.gasUsed) });

    for (const tx of block.transactions) {
      const from = norm(tx.from);
      const to = norm(tx.to);

      if (isSystemAddress(from, CHAIN_KEY) || isSystemAddress(to, CHAIN_KEY)) {
        const key = isSystemAddress(from, CHAIN_KEY) ? from : to;
        systemTxs.set(key, (systemTxs.get(key) ?? 0) + 1);
        continue;
      }

      const ep = ENTRYPOINTS[to];
      if (ep) entrypointTxs.set(ep, (entrypointTxs.get(ep) ?? 0) + 1);

      const type = tx.type ? hex(tx.type) : 0;
      typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);

      if (to === null) contractCreations += 1;
      const value = tx.value && BigInt(tx.value) !== 0n ? BigInt(tx.value).toString() : null;
      if (value) valueTransfers += 1;

      if (rows.length >= MAX_TXS) {
        truncated = true;
        continue;
      }
      rows.push({
        b: bn,
        f: intern(from),
        t: to === null ? -1 : intern(to),
        v: value,
        ty: type,
        n: tx.nonce ? hex(tx.nonce) : 0,
        g: tx.gas ? hex(tx.gas) : 0,
      });
    }
  }

  // --- derived ---------------------------------------------------------------
  const senderCount = new Map();
  const targetCount = new Map();
  for (const row of rows) {
    senderCount.set(row.f, (senderCount.get(row.f) ?? 0) + 1);
    if (row.t >= 0) targetCount.set(row.t, (targetCount.get(row.t) ?? 0) + 1);
  }

  const timestamps = blockRows.map((b) => b.ts);
  const spanSeconds = timestamps.length ? timestamps[timestamps.length - 1] - timestamps[0] : 0;
  const blockTime = blockRows.length > 1 ? spanSeconds / (blockRows.length - 1) : 0;

  const totalTxs = blockRows.reduce((a, b) => a + b.txs, 0);
  const systemTotal = [...systemTxs.values()].reduce((a, b) => a + b, 0);

  // The heuristic that found 0x…a4b05 in the first place, kept as a REPORT
  // rather than an automatic exclusion. An address written exactly once per
  // block is almost certainly infrastructure, but "almost certainly" is not a
  // reason to silently delete a participant from an anonymity measurement.
  const suspicious = [...senderCount]
    .filter(([, c]) => c >= blockRows.length * 0.9)
    .map(([i, c]) => ({ address: addresses[i], txs: c, perBlock: Number((c / blockRows.length).toFixed(3)) }));

  const topSenders = [...senderCount].sort((a, b) => b[1] - a[1]).slice(0, 25)
    .map(([i, c]) => ({ address: addresses[i], txs: c }));
  const topTargets = [...targetCount].sort((a, b) => b[1] - a[1]).slice(0, 25)
    .map(([i, c]) => ({ address: addresses[i], txs: c }));

  const corpus = {
    chain: CHAIN_KEY,
    chainName: chain.name,
    chainId,
    kind: "evm",
    family: chain.family,
    stack: chain.stack,
    rpc: currentRpc(),
    rpcEndpoints: chain.rpcs,
    headAtFetch: head,
    fetchedAt: new Date().toISOString(),
    window: {
      from,
      to,
      blocks: blockRows.length,
      spanSeconds,
      blockTimeSeconds: Number(blockTime.toFixed(5)),
    },
    complete: false,
    completeness: {
      wholeChain: false,
      reason: "Public RPC sustains roughly 20 blocks/s with batching; these chains "
        + "are tens of millions of blocks (Ethereum 26M, Robinhood Chain 60.7M, "
        + "Arbitrum One 504M), which is weeks to years of scanning. This is a "
        + "contiguous sampled window, not a census.",
      coverageOfChainBlocks: Number((blockRows.length / head).toExponential(3)),
      chainAgeDays: blockTime ? Number(((head * blockTime) / 86400).toFixed(2)) : null,
      blocksRequested: BLOCKS,
      blocksMissing: lost,
      finalBatchSize: batchSize,
      batchShrinkages: shrinkages,
      throttleEvents: throttles,
      finalDelayMs: delayMs,
    },
    exclusions: {
      note: "Infrastructure addresses removed from identity counts, reported here instead.",
      systemAddresses: [...systemTxs].map(([address, txs]) => ({ address, txs })),
      systemTxTotal: systemTotal,
      // Not excluded, just flagged: the operator should look at these.
      suspiciousSystemCandidates: suspicious,
    },
    erc4337: {
      note: "Account abstraction, where the chain advertises it. Measured, not assumed.",
      entrypoints: [...entrypointTxs].map(([name, txs]) => ({ name, txs })),
      total: [...entrypointTxs.values()].reduce((a, b) => a + b, 0),
    },
    txTypes: Object.fromEntries([...typeCounts].sort((a, b) => b[1] - a[1])),
    totals: {
      transactions: rows.length,
      transactionsInWindow: totalTxs,
      systemTransactionsExcluded: systemTotal,
      distinctSenders: senderCount.size,
      distinctTargets: targetCount.size,
      contractCreations,
      valueTransfers,
    },
    addresses,
    blocks: blockRows,
    transactions: rows,
    topSenders,
    topTargets,
    truncated,
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(corpus));

  console.log("=== window ===");
  console.log(`chain              ${chain.name} (${chainId})`);
  console.log(`blocks             ${blockRows.length.toLocaleString()}`);
  console.log(`span               ${(spanSeconds / 60).toFixed(1)} min`);
  console.log(`block time         ${blockTime.toFixed(4)} s`);
  console.log(`transactions       ${rows.length.toLocaleString()}`);
  console.log(`distinct senders   ${senderCount.size.toLocaleString()}`);
  console.log(`distinct targets   ${targetCount.size.toLocaleString()}`);
  console.log(`contract creations ${contractCreations}`);
  console.log(`value transfers    ${valueTransfers}`);
  console.log(`system tx excluded ${systemTotal}`);
  console.log(`erc-4337 txs       ${corpus.erc4337.total}`);
  console.log(`tx types           ${JSON.stringify(corpus.txTypes)}`);
  console.log(`coverage of chain  ${corpus.completeness.coverageOfChainBlocks} of all blocks`);
  console.log(`blocks missing     ${lost}`);
  if (suspicious.length) {
    console.log("\n  addresses written nearly once per block (check the registry):");
    for (const s of suspicious) console.log(`    ${s.address}  ${s.txs} tx  ${s.perBlock}/block`);
  }
  if (truncated) console.log(`\n  WARNING: hit --max-txs ${MAX_TXS}; window is partial`);
  console.log(`\nwritten to ${OUT}`);
}

main().catch((error) => {
  console.error(`\nFAIL: ${error.message}`);
  process.exit(1);
});

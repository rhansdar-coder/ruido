#!/usr/bin/env node
// Index every event the STRK20 pool has emitted and write it to data/corpus.json.
//
// This is what turns Ruido from a calibrated model into a measurement. Until it
// runs, every anonymity number in the README is an argument about a pool we
// invented.
//
// Zero dependencies. Writes one file, overwrites it, prints a report.
//
//   node scripts/build-corpus.mjs
//   node scripts/build-corpus.mjs --network mainnet
//   node scripts/build-corpus.mjs --network mainnet --window 500000
//
// Three things this script has learned the hard way, each of which produced a
// silently wrong corpus before it was fixed:
//
//   1. An empty page is not the end. Public RPCs return zero events with a
//      continuation token for large ranges. Treating that as exhaustion reports
//      "complete: true" over an empty corpus — a false completeness claim, which
//      is the exact failure this project exists to catch.
//   2. A single ABI does not describe a pool's history. Pools get upgraded.
//   3. A request with no timeout hangs forever. Public endpoints do this rather
//      than erroring.
//
// And one it learned later, which is why amounts are kept now:
//
//   4. Dropping the payload at the RPC boundary threw away the only axis that
//      can shrink a candidate set. The first version of this script stored
//      { block, tx, key, name } and nothing else, so the denomination axis was
//      not merely unmeasured — it was unmeasurable without a re-index. Payload
//      retention is not an optimisation; it is the difference between a corpus
//      that can answer the question and one that has to be rebuilt to answer it.

import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  amountToDecimal,
  decodeEvent,
  eventDefinitions,
} from "../src/starknet-events.mjs";
import { appendAll, blockRange } from "../src/collect.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const POOLS = {
  sepolia: {
    rpcs: [
      "https://starknet-sepolia-rpc.publicnode.com",
      "https://starknet-sepolia.api.onfinality.io/public",
      "https://starknet-sepolia-rpc.itrocket.net",
    ],
    pool: "0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91",
  },
  mainnet: {
    rpcs: [
      "https://starknet-rpc.publicnode.com",
      "https://starknet.api.onfinality.io/public",
      "https://starknet-mainnet-rpc.itrocket.net",
    ],
    pool: "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a",
  },
};

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const NETWORK = arg("network", "sepolia");
const MAX = Number(arg("max", 200000));
const PAGE = 1000;
const OUT = resolve(ROOT, arg("out", `data/corpus.json`));
const TIMEOUT_MS = Number(arg("timeout", 20000));

const { rpcs, pool } = POOLS[NETWORK];
if (!rpcs) {
  console.error(`unknown network: ${NETWORK} (try sepolia or mainnet)`);
  process.exit(1);
}

// RPC pool. We rotate rather than retry a dead endpoint five times: public
// Starknet endpoints rate-limit by IP and a retry storm makes it worse.
let rpcIndex = 0;
const currentRpc = () => rpcs[rpcIndex % rpcs.length];
const rotateRpc = () => {
  rpcIndex += 1;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpcCall(method, params, attempt = 0) {
  const rpc = currentRpc();
  try {
    const response = await fetch(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      // Without this, a stalled public endpoint hangs the indexer forever.
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    if (text.trim().startsWith("<")) throw new Error("non-JSON response (gateway or rate limit)");
    const body = JSON.parse(text);
    if (body.error) throw new Error(body.error.message ?? JSON.stringify(body.error));
    return body.result;
  } catch (error) {
    if (attempt >= 5) throw new Error(`${method} failed on ${rpc}: ${error.message}`);
    rotateRpc();
    await sleep(800 * (attempt + 1));
    return rpcCall(method, params, attempt + 1);
  }
}

// Event definitions come from the deployed class ABI rather than a hardcoded
// table. The on-chain version of a pool diverges from the version in the repo
// that documents it, so a fixed table mislabels events and misreads amounts.
async function definitionsForClass(classHash) {
  const klass = await rpcCall("starknet_getClass", ["latest", classHash]);
  const abi = typeof klass.abi === "string" ? JSON.parse(klass.abi) : klass.abi;
  return eventDefinitions(abi);
}

/** Merge the definitions of every class version we have seen. */
function mergeDefinitions(byClass) {
  const defs = new Map();
  const collisions = [];
  const undecodable = new Map();
  for (const { defs: d, collisions: c, undecodable: u } of byClass.values()) {
    for (const [selector, def] of d) if (!defs.has(selector)) defs.set(selector, def);
    for (const item of c) collisions.push(item);
    for (const item of u) undecodable.set(item.name, item.reason);
  }
  return { defs, collisions, undecodable };
}

// RPC keys arrive as hex of inconsistent width. Compare canonical form or the
// lookup silently misses and every event is labelled "unknown".
const normHex = (value) => (value ? `0x${BigInt(value).toString(16)}` : null);

/**
 * Collect every event in [fromBlock, toBlock] by paging on continuation tokens.
 *
 * Scanning in windows rather than one range from block 0 is not an
 * optimisation. Several public RPCs return an empty first page with a
 * continuation token when the requested range is very large, and a naive reader
 * concludes the pool is empty.
 */
async function scanWindow(fromBlock, toBlock, defs, onProgress) {
  const collected = [];
  let token = null;
  let pages = 0;
  let mismatches = 0;
  const samples = [];

  for (;;) {
    const page = await rpcCall("starknet_getEvents", [
      {
        from_block: { block_number: fromBlock },
        to_block: { block_number: toBlock },
        address: pool,
        keys: [],
        chunk_size: PAGE,
        ...(token ? { continuation_token: token } : {}),
      },
    ]);

    pages += 1;
    const batch = page.events ?? [];
    for (const event of batch) {
      const selector = normHex(event.keys?.[0]);
      const def = defs.get(selector);

      if (def && def.decodable) {
        // Decoded here rather than after the scan. Mainnet carries 125,751
        // events; keeping every raw payload around until the end costs hundreds
        // of megabytes of strings on a machine that has under a gigabyte free.
        // Decoding in place means the bytes are dropped as soon as they are read.
        const record = { block: event.block_number, tx: event.transaction_hash, key: selector, name: def.name };
        const out = decodeEvent(def, event);
        if (out.ok) {
          for (const field of PAYLOAD_FIELDS) {
            const value = out.values[field];
            if (value === undefined || value === null) continue;
            if (field === "amount") record.amount = amountToDecimal(value);
            else record[field] = Array.isArray(value) ? value.map(normHex) : normHex(value);
          }
        } else {
          mismatches += 1;
          if (samples.length < 5) {
            samples.push({ name: def.name, consumed: out.consumed, dataLength: out.dataLength });
          }
        }
        collected.push(record);
        continue;
      }

      // Unknown selector, or a layout this script cannot size. The bytes are
      // kept so the class-history pass can explain them; a pool that has been
      // upgraded has events only the class live at that block can read.
      collected.push({
        block: event.block_number,
        tx: event.transaction_hash,
        key: selector,
        name: def?.name ?? "unknown",
        keys: event.keys ?? [],
        data: event.data ?? [],
      });
    }

    onProgress(collected.length, pages);

    // The ordering here is the fix for finding #1: an empty page carrying a
    // continuation token means "keep going", not "we are done".
    if (!page.continuation_token) return { events: collected, mismatches, samples };

    if (batch.length === 0 && token === page.continuation_token) {
      // The endpoint handed back the same token with nothing new. Refusing to
      // loop forever is better than a corpus that never finishes.
      return { events: collected, mismatches, samples };
    }
    token = page.continuation_token;
  }
}

// Fields lifted out of the decoded payload and onto the event record.
//
// These are matched by ABI member name, not against a hardcoded list of event
// names. If the pool ever renames an event but keeps its members, this keeps
// working; if it renames a member, the field simply stops appearing and the
// coverage report below shows the drop.
const PAYLOAD_FIELDS = ["amount", "token", "note_id"];

/**
 * Retry the events the current ABI could not explain, against the merged
 * definitions of every class version seen so far.
 *
 * Only events that still carry raw bytes are touched. A mismatch means the ABI
 * no longer describes the chain, so the event keeps its name and gets no amount:
 * a value read at the wrong offset is a plausible number, and a plausible number
 * is worse than a missing one.
 */
function resolveUnknown(events, defs) {
  let mismatches = 0;
  const samples = [];

  for (const event of events) {
    if (!event.keys) continue;
    const def = defs.get(event.keys[0]);
    if (!def) continue;
    event.name = def.name;
    if (!def.decodable) continue;

    const out = decodeEvent(def, { keys: event.keys, data: event.data });
    if (!out.ok) {
      mismatches += 1;
      if (samples.length < 5) {
        samples.push({ name: def.name, consumed: out.consumed, dataLength: out.dataLength });
      }
      continue;
    }

    for (const field of PAYLOAD_FIELDS) {
      const value = out.values[field];
      if (value === undefined || value === null) continue;
      if (field === "amount") event.amount = amountToDecimal(value);
      else event[field] = Array.isArray(value) ? value.map(normHex) : normHex(value);
    }
  }

  return { mismatches, samples };
}

/** Strip the raw payload arrays once they have been decoded. */
function stripRawPayload(events) {
  for (const event of events) {
    delete event.keys;
    delete event.data;
  }
}

async function main() {
  console.log(`RUIDO · corpus index   network=${NETWORK}`);
  console.log(`rpc  ${rpcs[0]}  (+${rpcs.length - 1} fallback)`);
  console.log(`pool ${pool}`);

  const head = await rpcCall("starknet_blockNumber", []);
  const classHash = await rpcCall("starknet_getClassHashAt", ["latest", pool]);

  const classes = new Map([[classHash, await definitionsForClass(classHash)]]);
  let merged = mergeDefinitions(classes);

  console.log(`head ${head}   class ${String(classHash).slice(0, 18)}…`);
  console.log(`event definitions in ABI: ${merged.defs.size}`);
  if (merged.collisions.length) {
    console.log(`  ${merged.collisions.length} short-name collision(s):`);
    for (const c of merged.collisions) console.log(`    ${c.selector.slice(0, 14)}…  ${c.names.join("  vs  ")}`);
  }

  // Window size is chosen so each range is small enough that no public endpoint
  // returns the empty-page-with-token trap, and large enough to keep the page
  // count sane.
  const WINDOW = Number(arg("window", NETWORK === "mainnet" ? 500000 : 2000000));
  const START = Number(arg("from", 0));
  console.log(`scanning blocks ${START} → ${head} in ${WINDOW.toLocaleString()}-block windows\n`);

  const events = [];
  let complete = true;
  let payloadMismatches = 0;
  const mismatchSamples = [];

  for (let start = START; start <= head; start += WINDOW) {
    if (events.length >= MAX) {
      complete = false;
      console.log(`\n  hit --max ${MAX}; corpus is partial`);
      break;
    }
    const end = Math.min(start + WINDOW - 1, head);
    const before = events.length;
    const found = await scanWindow(start, end, merged.defs, (n, pages) => {
      process.stdout.write(
        `\r  window ${start.toLocaleString()}–${end.toLocaleString()}  `
        + `+${before + n} events (${pages} pages)      `,
      );
    });
    // appendAll, never `events.push(...found)`. A single 500,000-block window on
    // mainnet yielded 55,000 events, and spreading that many arguments overflows
    // the stack. Invisible on a small pool, fatal on a real one.
    appendAll(events, found.events);
    payloadMismatches += found.mismatches;
    appendAll(mismatchSamples, found.samples);
    if (found.events.length === 0) process.stdout.write(`\r  window ${start.toLocaleString()}–${end.toLocaleString()}  no events (empty)                    `);
  }
  console.log("\n");

  // Anything still holding raw bytes is an event the class live at the head
  // could not explain. Ask which class was live at that block and merge its
  // definitions in — including its member layout, since an amount may sit at a
  // different offset in an older version.
  for (let round = 0; round < 12; round += 1) {
    const stuck = events.find((e) => e.name === "unknown" && e.keys);
    if (!stuck) break;
    const atBlock = await rpcCall("starknet_getClassHashAt", [
      { block_number: stuck.block },
      pool,
    ]);
    if (classes.has(atBlock)) {
      // The class is already known and still cannot read this event. Stop
      // instead of looping: a genuinely unexplained event is a finding.
      stuck.keys = null;
      continue;
    }
    classes.set(atBlock, await definitionsForClass(atBlock));
    merged = mergeDefinitions(classes);
    const outcome = resolveUnknown(events, merged.defs);
    payloadMismatches += outcome.mismatches;
    appendAll(mismatchSamples, outcome.samples);
    console.log(`  + class ${String(atBlock).slice(0, 18)}… at block ${stuck.block} (${merged.defs.size} definitions)`);
  }

  // Payload coverage: which events actually came away with a value, by name.
  // Reported rather than assumed, because "the amount axis exists" is only true
  // where the amounts decoded.
  const withAmount = new Map();
  const withNoteId = new Map();
  for (const event of events) {
    if (event.amount !== undefined && event.amount !== null) {
      withAmount.set(event.name, (withAmount.get(event.name) ?? 0) + 1);
    }
    if (event.note_id !== undefined) {
      withNoteId.set(event.name, (withNoteId.get(event.name) ?? 0) + 1);
    }
  }

  const counts = new Map();
  for (const event of events) counts.set(event.name, (counts.get(event.name) ?? 0) + 1);

  const blocks = events.map((e) => e.block).filter((b) => typeof b === "number");
  const created = events.filter((e) => e.name === "EncNoteCreated" || e.name === "OpenNoteCreated");
  const used = events.filter((e) => e.name === "NoteUsed");

  // The raw payload arrays have served their purpose; drop them so the corpus
  // does not carry a second copy of every event's bytes.
  stripRawPayload(events);

  const corpus = {
    network: NETWORK,
    pool,
    classHash,
    classHistory: [...classes.keys()],
    rpcEndpoints: rpcs,
    rpcUsed: currentRpc(),
    headAtFetch: head,
    fetchedAt: new Date().toISOString(),
    complete,
    windowSize: WINDOW,
    totals: {
      events: events.length,
      notesCreated: created.length,
      notesUsed: used.length,
      deposits: counts.get("Deposit") ?? 0,
      withdrawals: counts.get("Withdrawal") ?? 0,
      // How much of the corpus carries a decoded payload, and how much of it
      // could not be read at all.
      eventsWithAmount: [...withAmount.values()].reduce((a, b) => a + b, 0),
      eventsWithNoteId: [...withNoteId.values()].reduce((a, b) => a + b, 0),
      payloadMismatches,
    },
    // blockRange, not Math.min(...blocks): the same argument-count limit applies.
    blockRange: blockRange(blocks),
    byEvent: Object.fromEntries([...counts].sort((a, b) => b[1] - a[1])),
    byEventWithAmount: Object.fromEntries([...withAmount].sort((a, b) => b[1] - a[1])),
    byEventWithNoteId: Object.fromEntries([...withNoteId].sort((a, b) => b[1] - a[1])),
    // Events whose ABI declares a layout this script cannot size. Named so the
    // gap is visible instead of looking like "the event has no amount".
    undecodableEvents: [...merged.undecodable].map(([name, reason]) => ({ name, reason })),
    // Keys the deployed ABIs do not explain. Non-empty means the class history
    // is newer than our ABI extraction, and the counts above are incomplete.
    unknownKeys: [...new Set(events.filter((e) => e.name === "unknown").map((e) => e.key))],
    // Only what an adversary can see: which block each note appeared in.
    notes: created.map((e) => ({ block: e.block })),
    events,
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(corpus));

  console.log("=== corpus ===");
  console.log(`events        ${corpus.totals.events}`);
  console.log(`notes created ${corpus.totals.notesCreated}`);
  console.log(`notes used    ${corpus.totals.notesUsed}`);
  console.log(`deposits      ${corpus.totals.deposits}`);
  console.log(`withdrawals   ${corpus.totals.withdrawals}`);
  console.log(`with amount   ${corpus.totals.eventsWithAmount}`);
  console.log(`with note_id  ${corpus.totals.eventsWithNoteId}`);
  console.log(`payload errors ${corpus.totals.payloadMismatches}`);
  if (corpus.blockRange) {
    console.log(`block range   ${corpus.blockRange.first} → ${corpus.blockRange.last}  (head ${head})`);
  }
  console.log(`classes       ${corpus.classHistory.length}`);
  console.log(`complete      ${corpus.complete}`);
  console.log("\nby event type");
  for (const [name, count] of Object.entries(corpus.byEvent)) {
    console.log(`  ${name.padEnd(26)} ${count}`);
  }
  if (corpus.unknownKeys.length) {
    console.log(`\n  ${corpus.unknownKeys.length} unexplained key(s): ${corpus.unknownKeys.join(", ")}`);
  }

  // The payload report. Without this the corpus looks identical whether the
  // amounts decoded or silently came back empty.
  console.log("\npayload coverage (events that came away with a value)");
  console.log(`  ${"event".padEnd(26)}${"count".padEnd(9)}with amount`);
  for (const [name, count] of Object.entries(corpus.byEvent)) {
    const amounts = corpus.byEventWithAmount[name] ?? 0;
    console.log(`  ${name.padEnd(26)}${String(count).padEnd(9)}${amounts || "-"}`);
  }
  if (corpus.undecodableEvents.length) {
    console.log("\n  events this script cannot size (reported, not approximated):");
    for (const item of corpus.undecodableEvents) console.log(`    ${item.name}: ${item.reason}`);
  }
  if (payloadMismatches) {
    console.log(`\n  ${payloadMismatches} event(s) decoded to the wrong felt count — no amount kept for those:`);
    for (const s of mismatchSamples) console.log(`    ${s.name}  consumed ${s.consumed} of ${s.dataLength}`);
  }
  console.log(`\nwritten to ${OUT}`);
}

main().catch((error) => {
  console.error(`\nFAIL: ${error.message}`);
  process.exit(1);
});

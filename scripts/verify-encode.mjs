// Does the calldata encoder actually reproduce the pool's call?
//
// The decoder is validated by *exact consumption* against real transactions. The
// encoder is validated by round-tripping through that decoder: decode a real
// `apply_actions`, re-encode it, and require the felts to come back identical.
//
// That is the strongest check available without a node, and it is stronger than
// a fixture suite, because the fixtures would be written by the same hand that
// wrote the encoder. A round-trip over real transactions fails if the two
// directions disagree about ANY shape the pool actually uses: Span lengths,
// Option variant order, tuple member order, u256 width, enum payloads, struct
// member order.
//
// What it does NOT prove: that the ABI's variant *names* match the chain's. Both
// directions read the same table, so a permuted table would still round-trip.
// Exact consumption is what covers that, and it is covered separately — a
// permuted variant order would move the felt widths, and `verify:actions` would
// go red.
//
// Sampling is stratified across the block range on purpose. The first N
// transactions of the corpus are all from the oldest implementation, so a
// positional sample would validate the encoder against code that is no longer
// deployed — the same mistake `check:screening` already made once.
//
//   node scripts/verify-encode.mjs [--sample 60]
import { readFileSync } from "node:fs";
import { decodeCall, encodeCall, unwrapExecute } from "../src/actions.mjs";
import { selectorHex } from "../src/keccak.mjs";

const argv = process.argv.slice(2);
const sampleArg = argv.indexOf("--sample");
const SAMPLE = sampleArg === -1 ? 60 : Number(argv[sampleArg + 1]);
// A stratified sample over the whole corpus is right for "does the encoder
// handle every shape", and wrong for "does it handle the class that is deployed
// now": the live class owns well under 1% of the block range, so a whole-range
// sample reaches it about once. `--from` aims the sample at it deliberately.
const fromArg = argv.indexOf("--from");
const FROM = fromArg === -1 ? 0 : Number(argv[fromArg + 1]);

const POOL = "0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91";
const RPC = process.env.RUIDO_RPC ?? "https://starknet-sepolia-rpc.publicnode.com";
const APPLY_ACTIONS = selectorHex("apply_actions");

const sameAddr = (a, b) =>
  String(a).replace(/^0x0*/, "0x").toLowerCase() === String(b).replace(/^0x0*/, "0x").toLowerCase();

/** Felts arrive as hex strings on one side and BigInt on the other. */
const norm = (arr) => arr.map((f) => BigInt(f).toString());

async function call(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 200)}`);
  return j.result;
}

const abiCache = new Map();
async function abiFor(classHash) {
  if (abiCache.has(classHash)) return abiCache.get(classHash);
  const klass = await call("starknet_getClass", ["latest", classHash]);
  const abi = typeof klass.abi === "string" ? JSON.parse(klass.abi) : klass.abi;
  abiCache.set(classHash, abi);
  return abi;
}

const classAtCache = new Map();
async function classAt(block) {
  if (classAtCache.has(block)) return classAtCache.get(block);
  const h = await call("starknet_getClassHashAt", [{ block_number: block }, POOL]);
  classAtCache.set(block, h);
  return h;
}

// --- the sample -------------------------------------------------------------
const corpus = JSON.parse(readFileSync("data/corpus.json", "utf8"));
const seen = new Set();
const all = [];
for (const e of corpus.events) {
  if (seen.has(e.tx)) continue;
  seen.add(e.tx);
  all.push({ tx: e.tx, block: e.block });
}
all.sort((a, b) => a.block - b.block);

const pool = FROM ? all.filter((t) => t.block >= FROM) : all;
if (pool.length === 0) {
  console.error(`no hay transacciones en el corpus desde el bloque ${FROM}`);
  process.exit(1);
}

// Evenly spaced across the sorted range, so every era of the pool is in the
// sample rather than whichever era happens to be first in the file.
const step = Math.max(1, Math.floor(pool.length / SAMPLE));
const txs = pool.filter((_, i) => i % step === 0).slice(0, SAMPLE);

console.log(`rpc      ${RPC}`);
console.log(`corpus   ${all.length} distinct transactions, blocks ${all[0].block}-${all[all.length - 1].block}`);
if (FROM) console.log(`desde    bloque ${FROM} -> ${pool.length} transacciones en la ventana`);
console.log(`muestra  ${txs.length} estratificada (paso ${step})\n`);

// --- the round-trip ---------------------------------------------------------
const perClass = new Map();
let notApply = 0;
let unreadable = 0;
let decodeNotExact = 0;
let identical = 0;
let mismatch = null;

for (const [i, { tx: hash, block }] of txs.entries()) {
  process.stdout.write(`\r  ${i + 1}/${txs.length} ...                    `);
  try {
    const classHash = await classAt(block);
    const abi = await abiFor(classHash);
    const tx = await call("starknet_getTransactionByHash", [hash]);
    const calls = unwrapExecute(tx.calldata ?? []);
    const poolCall = calls.find((c) => c.selector === APPLY_ACTIONS && sameAddr(c.to, POOL));
    if (!poolCall) {
      notApply += 1;
      continue;
    }

    const out = decodeCall(abi, "apply_actions", poolCall.args);
    const bucket = perClass.get(classHash) ?? { exact: 0, roundtrip: 0, blocks: [] };
    bucket.blocks.push(block);

    if (!out.ok) {
      // A layout the decoder does not understand cannot be re-encoded, and
      // counting it as a round-trip success would be a lie.
      decodeNotExact += 1;
      perClass.set(classHash, bucket);
      continue;
    }
    bucket.exact += 1;

    const reencoded = norm(encodeCall(abi, "apply_actions", out.args));
    const original = norm(poolCall.args);

    if (reencoded.length === original.length && reencoded.every((v, k) => v === original[k])) {
      identical += 1;
      bucket.roundtrip += 1;
    } else if (!mismatch) {
      // First failure only, with the felt-level diff — the index is the whole
      // diagnosis, because a shift by one felt is the signature of a layout bug.
      let at = 0;
      while (at < Math.min(reencoded.length, original.length) && reencoded[at] === original[at]) at += 1;
      mismatch = {
        hash,
        block,
        classHash,
        at,
        expected: original[at],
        got: reencoded[at],
        lenExpected: original.length,
        lenGot: reencoded.length,
      };
    }
    perClass.set(classHash, bucket);
  } catch {
    unreadable += 1;
  }
}
process.stdout.write("\r".padEnd(50) + "\r");

// --- result -----------------------------------------------------------------
console.log("=== round-trip por clase (el ABI tiene que ser el de su bloque) ===");
console.log("   clase                                         decodif.  identicas   bloques");
for (const [hash, b] of [...perClass].sort((a, b) => a[1].blocks[0] - b[1].blocks[0])) {
  const range = `${Math.min(...b.blocks)}-${Math.max(...b.blocks)}`;
  console.log(
    `   ${hash.slice(0, 44).padEnd(44)} ${String(b.exact).padStart(8)}  ${String(b.roundtrip).padStart(9)}   ${range}`,
  );
}

console.log(`\n  transacciones decodificadas     ${perClass.size ? [...perClass.values()].reduce((n, b) => n + b.exact, 0) : 0}`);
console.log(`  sin apply_actions al pool       ${notApply}`);
console.log(`  no se pudieron leer             ${unreadable}`);
console.log(`  decodificadas NO exactas        ${decodeNotExact}`);
console.log(`  round-trip identico             ${identical}`);

if (mismatch) {
  console.log("\n=== primera discrepancia ===");
  console.log(`tx     ${mismatch.hash}`);
  console.log(`bloque ${mismatch.block}  clase ${mismatch.classHash}`);
  console.log(`felt   ${mismatch.at}  (primer indice que difiere)`);
  console.log(`  calldata real  ${mismatch.expected}`);
  console.log(`  re-codificado  ${mismatch.got}`);
  console.log(`  longitudes     ${mismatch.lenExpected} real / ${mismatch.lenGot} re-codificado`);
}

const decoded = [...perClass.values()].reduce((n, b) => n + b.exact, 0);
const pass = decoded > 0 && decodeNotExact === 0 && identical === decoded;
console.log(
  pass
    ? "\n  OK  el encoder reproduce el calldata real felt por felt en toda la muestra"
    : "\n  FALLA  el encoder y el decoder no coinciden en alguna forma del ABI",
);
process.exit(pass ? 0 : 1);

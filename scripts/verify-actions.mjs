// Does the calldata decoder actually describe the pool's call?
//
// Decode real `apply_actions` transactions out of the corpus and require that
// the decoder consumes **exactly** every felt. A layout that is off by one
// usually still decodes into plausible values and leaves a felt unread, so the
// exact-consumption count is the only number here that means anything.
//
// This script exists in its current shape because the first version was wrong
// in a way worth writing down. It read the *current* class's ABI and decoded
// every transaction in the corpus against it. Sepolia has run three pool
// implementations (`0x715b22ab` -> `0x30b8c540` -> `0x6d163f2b`), so a
// transaction from block 8,276,431 was being read with a later class's layout.
// The decoder did not throw. It returned `consumed 4 of 55` — a wrong answer
// wearing the clothes of a right one.
//
// So the ABI is resolved per block, and the per-class results are reported
// separately. A class whose transactions all decode exactly is evidence the
// layout is understood; a class with failures is a layout still to read.
//
//   node scripts/verify-actions.mjs [--sample 25]
import { readFileSync } from "node:fs";
import { decodeCall, unwrapExecute, findFunction, typeRegistry, splitGeneric } from "../src/actions.mjs";
import { selectorHex } from "../src/keccak.mjs";
import { STRK20_POOL } from "../src/pool.mjs";

const argv = process.argv.slice(2);
const sampleArg = argv.indexOf("--sample");
const SAMPLE = sampleArg === -1 ? 25 : Number(argv[sampleArg + 1]);

const POOL = STRK20_POOL.sepolia;
const RPC = "https://starknet-sepolia-rpc.publicnode.com";
const APPLY_ACTIONS = selectorHex("apply_actions");
const sameAddr = (a, b) => String(a).replace(/^0x0*/, "0x") === String(b).replace(/^0x0*/, "0x");

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

// A class hash does not identify a network, and it does not identify an ABI
// either unless you ask for the ABI of that exact hash.
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

console.log("=== 1. la firma en la clase ACTUAL ===");
const currentHash = await call("starknet_getClassHashAt", ["latest", POOL]);
const currentAbi = await abiFor(currentHash);
const fn = findFunction(currentAbi, "apply_actions");
console.log("classHash", currentHash);
for (const i of fn.inputs ?? []) console.log(`   ${i.name}: ${i.type}`);

const reg = typeRegistry(currentAbi);
const variants = reg.enums.get("privacy::actions::ServerAction") ?? [];
console.log("\n=== 2. ServerAction, anchos segun el ABI ===");
console.log("   (variable = contiene un Span, no se puede sumar de antemano)");
for (const [i, v] of variants.entries()) {
  const { head, inner } = splitGeneric(v.type ?? "");
  const variable = head === "core::array::Span" || head === "core::array::Array";
  const members = reg.structs.get(v.type);
  const shape = variable
    ? `variable (Span<${inner}>)`
    : members
      ? members.map((m) => m.name).join(", ")
      : "1 felt";
  console.log(`   [${String(i).padStart(2)}] ${v.name.padEnd(22)} ${shape}`);
}

console.log(`\n=== 3. decodificando ${SAMPLE} transacciones reales ===`);
const corpus = JSON.parse(readFileSync("data/corpus.json", "utf8"));
const seen = new Set();
const txs = [];
for (const e of corpus.events) {
  if (seen.has(e.tx)) continue;
  seen.add(e.tx);
  txs.push({ tx: e.tx, block: e.block });
  if (txs.length >= SAMPLE) break;
}

// Results grouped by the class that was live when the transaction ran.
const perClass = new Map();
const variantCounts = new Map();
let notApply = 0;
let unreadable = 0;
let example = null;

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
    const bucket = perClass.get(classHash) ?? { exact: 0, short: 0, long: 0, blocks: [] };
    if (out.ok) bucket.exact += 1;
    else if (out.consumed < out.length) bucket.short += 1;
    else bucket.long += 1;
    bucket.blocks.push(block);
    perClass.set(classHash, bucket);

    for (const a of Array.isArray(out.args.actions) ? out.args.actions : []) {
      variantCounts.set(a.variant, (variantCounts.get(a.variant) ?? 0) + 1);
    }
    if (!example && out.ok) example = { hash, block, classHash, out };
  } catch (error) {
    unreadable += 1;
  }
}
process.stdout.write("\r".padEnd(50) + "\r");

console.log("\n=== 4. resultado por clase (el ABI tiene que ser el de su bloque) ===");
console.log("   clase                                         exactas  cortas  largas   bloques");
let totalExact = 0;
let totalDecoded = 0;
for (const [hash, b] of [...perClass].sort((a, b) => a[1].blocks[0] - b[1].blocks[0])) {
  const decoded = b.exact + b.short + b.long;
  totalExact += b.exact;
  totalDecoded += decoded;
  const range = `${Math.min(...b.blocks)}-${Math.max(...b.blocks)}`;
  console.log(
    `   ${hash.slice(0, 44).padEnd(44)} ${String(b.exact).padStart(6)}  ${String(b.short).padStart(6)}  ${String(b.long).padStart(6)}   ${range}`,
  );
}
console.log(`\n  transacciones decodificadas   ${totalDecoded}`);
console.log(`  sin apply_actions al pool     ${notApply}`);
console.log(`  no se pudieron leer           ${unreadable}`);
console.log(`  consumo EXACTO                ${totalExact}`);

const allExact = totalDecoded > 0 && totalExact === totalDecoded;
console.log(
  allExact
    ? "\n  OK  el layout describe el calldata real en todas las muestras"
    : "\n  FALLA  hay clases cuyo layout aun no se entiende",
);

if (variantCounts.size > 0) {
  console.log("\n=== 5. variantes de ServerAction observadas ===");
  const total = [...variantCounts.values()].reduce((a, b) => a + b, 0);
  for (const [name, n] of [...variantCounts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${(100 * n / total).toFixed(1).padStart(5)}%  ${name}`);
  }
  console.log(`  ${String(total).padStart(5)}  acciones en total`);
}

if (example) {
  console.log("\n=== 6. un ejemplo decodificado ===");
  console.log(`tx ${example.hash}  bloque ${example.block}`);
  console.log(`clase ${example.classHash}`);
  console.log(`acciones ${example.out.args.actions.length}   screening ${example.out.args.screening === null ? "None" : "Some"}`);
  console.log(JSON.stringify(example.out.args.actions.slice(0, 4), null, 2));
}

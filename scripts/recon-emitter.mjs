// Reconnaissance for the decoy emitter: what does the pool actually accept?
//
// The emitter's job is to turn salts into a real apply_actions call. Before
// writing an encoder, read the deployed interface and one real transaction that
// used it — an encoder built from a guess about the ABI is exactly the kind of
// invention this project refuses.
//
// Two things this script had to learn the hard way, both recorded because they
// would otherwise be re-learned:
//
//   1. The pool's ABI exposes *interfaces* (`privacy::interface::IClient`), and
//      the entrypoints live in their `items`. A top-level scan finds zero
//      functions and looks like "the pool has no entrypoints".
//   2. A v3 INVOKE carries the account's `__execute__` envelope, not the pool
//      calldata. `tx.calldata` is [calls_len, to, selector, calldata_len, ...].
//      Reading it as if it were the pool's arguments decodes nonsense.
//
//   node scripts/recon-emitter.mjs
import { readFileSync } from "node:fs";
import { feltWidth, structTable, eventDefinitions } from "../src/starknet-events.mjs";
import { STRK20_POOL } from "../src/pool.mjs";

const POOL = STRK20_POOL.sepolia;
const RPC = "https://starknet-sepolia-rpc.publicnode.com";

async function call(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 300)}`);
  return j.result;
}

/** Flatten interfaces so their entrypoints are reachable by name. */
function allFunctions(abi) {
  const out = [];
  for (const item of abi) {
    if (item.type === "function") out.push({ ...item, from: "(top level)" });
    if (item.type === "interface") {
      for (const sub of item.items ?? []) {
        if (sub.type === "function") out.push({ ...sub, from: item.name });
      }
    }
  }
  return out;
}

const classHash = await call("starknet_getClassHashAt", ["latest", POOL]);
const klass = await call("starknet_getClass", ["latest", classHash]);
const abi = typeof klass.abi === "string" ? JSON.parse(klass.abi) : klass.abi;

console.log("=== 1. entrypoints del pool (interfaces expandidas) ===");
console.log("classHash", classHash);
const fns = allFunctions(abi);
console.log(`funciones alcanzables: ${fns.length}\n`);
for (const f of fns) {
  const inputs = (f.inputs ?? []).map((i) => `${i.name}: ${i.type}`).join(", ");
  const outs = (f.outputs ?? []).map((o) => o.type).join(", ");
  console.log(`  ${f.name}(${inputs})${outs ? ` -> ${outs}` : ""}`);
  console.log(`      [${f.state_mutability ?? "?"}] en ${f.from}`);
}

console.log("\n=== 2. todo lo que toque acciones/notas ===");
for (const f of fns) {
  if (!/action|note|deposit|withdraw|channel|settle|transfer/i.test(f.name ?? "")) continue;
  console.log(`\n--- ${f.name} ---`);
  console.log(JSON.stringify(f, null, 2).split("\n").slice(0, 40).join("\n"));
}

console.log("\n=== 3. anchos de felt de los tipos del ABI ===");
const structs = structTable(abi);
console.log(`structs/enums definidos: ${structs.size}`);
for (const [name] of structs) {
  const w = feltWidth(name, structs);
  console.log(`  ${w === null ? "??" : String(w).padStart(3)} felts  ${name}`);
}

console.log("\n=== 4. una transaccion real, desempaquetada ===");
const corpus = JSON.parse(readFileSync("data/corpus.json", "utf8"));
const deposit = corpus.events.find((e) => e.name === "Deposit");
const tx = await call("starknet_getTransactionByHash", [deposit.tx]);
console.log("tx", deposit.tx);
console.log("tipo", tx.type, "version", tx.version, "sender", tx.sender_address ?? tx.contract_address);

const cd = tx.calldata ?? [];
const callCount = Number(BigInt(cd[0]));
console.log(`\nenvoltura __execute__: ${callCount} llamada(s)`);
let cursor = 1;
for (let i = 0; i < callCount; i += 1) {
  const to = cd[cursor];
  const selector = cd[cursor + 1];
  const len = Number(BigInt(cd[cursor + 2]));
  const args = cd.slice(cursor + 3, cursor + 3 + len);
  console.log(`  llamada ${i}: to=${to}`);
  console.log(`              selector=${selector}`);
  console.log(`              ${args.length} felts de argumentos`);
  console.log(`              args[0..3] = ${args.slice(0, 4).join(", ")}`);
  cursor += 3 + len;
}
console.log(`felts consumidos: ${cursor} de ${cd.length}`);

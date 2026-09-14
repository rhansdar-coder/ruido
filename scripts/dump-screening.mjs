// Dump the exact screening field for a given block, felt by felt.
//
// The tool you reach for when a screening decode looks wrong. It prints where
// the `screening` parameter starts, the variant felt, and every felt after it,
// so the layout can be checked by hand against the ABI's struct members.
// It is how the inverted `Option` variant was confirmed: `None` is a lone
// trailing `0x1`, and `Some` is `0x0` followed by
// `issued_at` + `sig_r` + `sig_s`.
//
//   node scripts/dump-screening.mjs 12203908 13246118 13753346
import { readFileSync } from "node:fs";
import { decodeCall, unwrapExecute, typeRegistry, decodeValue } from "../src/actions.mjs";
import { selectorHex } from "../src/keccak.mjs";
import { STRK20_POOL } from "../src/pool.mjs";

const POOL = STRK20_POOL.sepolia;
const RPC = "https://starknet-sepolia-rpc.publicnode.com";
const APPLY = selectorHex("apply_actions");
const norm = (s) => String(s).replace(/^0x0*/, "0x").toLowerCase();

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

const corpus = JSON.parse(readFileSync("data/corpus.json", "utf8"));
const want = new Set(process.argv.slice(2).map(Number));
const byBlock = new Map();
for (const e of corpus.events) if (want.has(e.block)) byBlock.set(e.block, e.tx);

for (const [block, hash] of byBlock) {
  const classHash = await call("starknet_getClassHashAt", [{ block_number: block }, POOL]);
  const k = await call("starknet_getClass", ["latest", classHash]);
  const abi = typeof k.abi === "string" ? JSON.parse(k.abi) : k.abi;
  const tx = await call("starknet_getTransactionByHash", [hash]);
  const pc = unwrapExecute(tx.calldata ?? []).find(
    (c) => c.selector === APPLY && norm(c.to) === norm(POOL),
  );
  if (!pc) {
    console.log(`${block}: no apply_actions call`);
    continue;
  }
  const args = pc.args;

  // Where does the screening param start, per the ABI?
  const fn = abi
    .flatMap((x) => x.items ?? [])
    .find((x) => x.name === "apply_actions" && x.type === "function");
  console.log(`\n=== block ${block} ===`);
  console.log(`class ${classHash}`);
  console.log(`params: ${fn.inputs.map((i) => `${i.name}: ${i.type}`).join(" | ")}`);
  console.log(`args.length = ${args.length}`);

  // Decode only `actions` to find the offset of `screening`.
  const reg = typeRegistry(abi);
  const actionsType = fn.inputs[0].type;
  const a = decodeValue(actionsType, args, 0, reg);
  console.log(`actions consumed = ${a.consumed}  (${a.value.length} actions)`);
  const off = a.consumed;
  console.log(`screening starts at index ${off}, variant felt = ${norm(args[off])}`);
  console.log(`felts from ${off}: ${args.slice(off).map(norm).join(" ")}`);
  const st = fn.inputs[1].type.replace(/^core::option::Option::<|>$/g, "");
  console.log(`screening payload type = ${st}`);
  const members = reg.structs.get(st);
  console.log(
    `  members = ${members ? members.map((m) => `${m.name}: ${m.type}`).join(", ") : "(not a struct in this ABI)"}`,
  );
  const out = decodeCall(abi, "apply_actions", args);
  console.log(`decodeCall: ok=${out.ok} consumed=${out.consumed}/${out.length}`);
}

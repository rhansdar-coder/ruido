// Every type the deployed pool's ABI mentions must be one the decoder knows.
//
// Why this exists: `decodeValue` used to fall back to "one felt" for any type it
// did not recognise. That is a silent wrong answer, and it hid two real bugs —
// a dead tuple branch and a `u256` that decoded as one felt. The fallback is now
// a throw, and this script is what keeps the throw from firing in production:
// it walks the whole ABI, recursively through struct members and enum payloads,
// and fails if any type would reach the decoder's `cannot decode type` branch.
//
// It is a static check over the ABI. It touches no transaction and no key.
//
//   node scripts/check-abi-types.mjs
import { typeRegistry } from "../src/actions.mjs";
import { STRK20_POOL } from "../src/pool.mjs";

const RPC = process.env.RUIDO_RPC ?? "https://starknet-sepolia-rpc.publicnode.com";
const POOL = STRK20_POOL.sepolia;

// Mirrors the decoder's own tables. Duplicated deliberately: if someone edits
// the decoder's tables without teaching this script, the check fails rather
// than silently agreeing.
const PRIMITIVES = new Set([
  "core::felt252",
  "core::integer::u8",
  "core::integer::u16",
  "core::integer::u32",
  "core::integer::u64",
  "core::integer::u128",
  "core::integer::usize",
  "core::bool",
  "core::starknet::contract_address::ContractAddress",
  "core::starknet::class_hash::ClassHash",
  "core::starknet::eth_address::EthAddress",
  "core::starknet::storage_access::StorageAddress",
  "core::bytes_31::bytes31",
]);
const WIDE = new Set(["core::integer::u256"]);

/** Types the decoder resolves by head, before it ever looks in the registry. */
const SHADOWED_BY_DISPATCH = new Set([
  "core::array::Span",
  "core::array::Array",
  "core::option::Option",
]);

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

/** The head of a generic type, with the `::` before `<` stripped, as the decoder does. */
function headOf(type) {
  const open = type.indexOf("<");
  if (open === -1) return type.trim();
  return type.slice(0, open).replace(/::\s*$/, "").trim();
}

function innerOf(type) {
  const open = type.indexOf("<");
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < type.length; i += 1) {
    if (type[i] === "<") depth += 1;
    else if (type[i] === ">") {
      depth -= 1;
      if (depth === 0) return type.slice(open + 1, i).trim();
    }
  }
  return type.slice(open + 1, -1).trim();
}

function splitTopLevel(source) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (c === "<" || c === "(" || c === "[") depth += 1;
    else if (c === ">" || c === ")" || c === "]") depth -= 1;
    else if (c === "," && depth === 0) {
      parts.push(source.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

const klass = await call("starknet_getClassAt", ["latest", POOL]);
const abi = typeof klass.abi === "string" ? JSON.parse(klass.abi) : klass.abi;
const reg = typeRegistry(abi);

const unknown = new Map(); // type -> where it was referenced
const seen = new Set();

function check(type, where, depth = 0) {
  if (depth > 64) throw new Error(`nesting too deep at ${type}`);
  // `Option::None` has no payload. The ABI renders it as a blank type.
  if (!type || !type.trim()) return;
  if (PRIMITIVES.has(type) || WIDE.has(type)) return;
  const head = headOf(type);
  if (head === "core::array::Span" || head === "core::array::Array") {
    const inner = innerOf(type);
    if (inner) check(inner, where, depth + 1);
    return;
  }
  if (head === "core::option::Option") {
    const inner = innerOf(type);
    if (inner) check(inner, where, depth + 1);
    return;
  }
  if (type.startsWith("(") && type.endsWith(")")) {
    for (const p of splitTopLevel(type.slice(1, -1))) check(p.trim(), where, depth + 1);
    return;
  }
  if (reg.structs.has(type)) {
    if (seen.has(type)) return;
    seen.add(type);
    for (const m of reg.structs.get(type)) check(m.type, `${type}.${m.name}`, depth + 1);
    return;
  }
  if (reg.enums.has(type)) {
    if (seen.has(type)) return;
    seen.add(type);
    for (const v of reg.enums.get(type)) if (v.type) check(v.type, `${type}::${v.name}`, depth + 1);
    return;
  }
  if (!unknown.has(type)) unknown.set(type, where);
}

for (const item of abi) {
  if (item.type === "function" || item.type === "constructor") {
    for (const i of item.inputs ?? []) check(i.type, `${item.name}(${i.name})`);
    for (const o of item.outputs ?? []) check(o.type, `${item.name}->`);
  } else if (item.type === "interface") {
    for (const f of item.items ?? []) {
      for (const i of f.inputs ?? []) check(i.type, `${f.name}(${i.name})`);
      for (const o of f.outputs ?? []) check(o.type, `${f.name}->`);
    }
  } else if (item.type === "struct") {
    // The ABI also ships a struct entry for `Span`/`Array`/`Option` themselves,
    // whose members are `snapshot: @Array<T>` — a rendering artefact, not a wire
    // type. The decoder dispatches on those heads *before* consulting the
    // registry, so it never reads those members. Mirror that order here, or the
    // check reports a gap that cannot be reached.
    // The ABI names these structs with their generic already applied —
    // `core::array::Span::<core::felt252>` — so match on the head, not the name.
    if (SHADOWED_BY_DISPATCH.has(headOf(item.name))) continue;
    for (const m of item.members ?? []) check(m.type, `${item.name}.${m.name}`);
  } else if (item.type === "enum") {
    for (const v of item.variants ?? []) if (v.type) check(v.type, `${item.name}::${v.name}`);
  }
}

const structs = [...reg.structs.keys()].length;
const enums = [...reg.enums.keys()].length;
console.log(`ABI: ${structs} structs, ${enums} enums`);
console.log(`types reachable from the ABI and walked: ${seen.size + unknown.size}`);

if (unknown.size === 0) {
  console.log("\nok    every ABI type is one the decoder handles");
} else {
  console.log(`\nFAIL  ${unknown.size} type(s) would reach the decoder's throw:`);
  for (const [t, where] of unknown) console.log(`        ${t}   (${where})`);
  process.exitCode = 1;
}

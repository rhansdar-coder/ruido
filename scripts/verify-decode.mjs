// Verify the event decoder against the live chain.
//
// The decoder's claim is that it can read every event the pool emits, and that
// its felt arithmetic is right. Both are checkable, so they are checked rather
// than asserted: this runs over live pages of events and counts how many
// selectors it fails to resolve and how many payloads it consumes the wrong
// number of felts on. Zero of each is the bar.
//
//   node scripts/verify-decode.mjs                       # sepolia
//   node scripts/verify-decode.mjs <pool> <rpc>          # any pool
//
// It also prints the derived member layout of the money events, which is the
// part worth reading: Withdrawal.amount is data[3], not data[0], because
// EncUserAddr is a three-felt struct. Reading data[0] there returns a fragment
// of the recipient's encrypted address and looks exactly like an amount.
import { eventDefinitions, decodeEvent, feltToDecimal } from "../src/starknet-events.mjs";

const POOL = process.argv[2] ?? "0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91";
const RPC = process.argv[3] ?? "https://starknet-sepolia-rpc.publicnode.com";

async function call(m, p) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }),
  });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 200));
  return j.result;
}

const classHash = await call("starknet_getClassHashAt", ["latest", POOL]);
const klass = await call("starknet_getClass", ["latest", classHash]);
const abi = typeof klass.abi === "string" ? JSON.parse(klass.abi) : klass.abi;

const { defs, collisions, undecodable } = eventDefinitions(abi);
console.log(`event definitions   ${defs.size}`);
console.log(`selector collisions ${collisions.length}`);
for (const c of collisions) console.log(`   COLLISION ${c.selector.slice(0, 14)}…  ${c.names.join("  vs  ")}`);
console.log(`undecodable events  ${undecodable.length}`);
for (const u of undecodable) console.log(`   UNDECODABLE ${u.name}: ${u.reason}`);

// The two events that carry money, with their derived member layout.
console.log("\n--- derived layouts for the money events ---");
for (const name of ["Deposit", "Withdrawal", "OpenNoteDeposited", "OpenNoteCreated", "EncNoteCreated"]) {
  const def = [...defs.values()].find((d) => d.name === name);
  if (!def) {
    console.log(`  ${name}: NOT DEFINED`);
    continue;
  }
  const layout = def.members.map((m) => `${m.name}(${m.kind},${m.width})`).join(" ");
  const dataIdx = def.members.filter((m) => m.kind === "data").map((m) => `${m.name}->data[${def.members.filter((x) => x.kind === "data").slice(0, def.members.filter((x) => x.kind === "data").indexOf(m)).reduce((a, x) => a + x.width, 0)}]`);
  console.log(`  ${name.padEnd(18)} ${layout}`);
  console.log(`  ${" ".repeat(18)} ${dataIdx.join(" ")}`);
}

// Live verification.
const head = await call("starknet_blockNumber", []);
let checked = 0;
let unknownSelector = 0;
let widthMismatch = 0;
const unknownKeys = new Set();
const amounts = [];

for (const span of [30000, 120000, 300000, 700000, 1400000]) {
  const page = await call("starknet_getEvents", [{
    from_block: { block_number: Math.max(0, head - span - 4000) },
    to_block: { block_number: Math.max(0, head - span) },
    address: POOL,
    keys: [],
    chunk_size: 200,
  }]);
  for (const raw of page.events ?? []) {
    const sel = raw.keys?.[0];
    const def = defs.get(sel);
    if (!def) {
      unknownSelector += 1;
      unknownKeys.add(sel);
      continue;
    }
    const out = decodeEvent(def, raw);
    checked += 1;
    if (!out.ok) {
      widthMismatch += 1;
      if (widthMismatch <= 4) {
        console.log(`\n  MISMATCH ${def.name}  consumed=${out.consumed} dataLength=${out.dataLength}`);
        console.log(`    data=${JSON.stringify(raw.data)}`);
      }
      continue;
    }
    if ((def.name === "Deposit" || def.name === "Withdrawal" || def.name === "OpenNoteDeposited") && amounts.length < 8) {
      amounts.push({
        name: def.name,
        amount: feltToDecimal(out.values.amount),
        token: String(out.values.token ?? "").slice(0, 12),
        noteId: out.values.note_id ? String(out.values.note_id).slice(0, 14) : undefined,
      });
    }
  }
}

console.log("\n--- live verification ---");
console.log(`  events decoded       ${checked}`);
console.log(`  unknown selectors    ${unknownSelector}${unknownKeys.size ? `  (${[...unknownKeys].map((k) => String(k).slice(0, 14)).join(", ")})` : ""}`);
console.log(`  width mismatches     ${widthMismatch}`);
console.log("\n  decoded money events:");
for (const a of amounts) console.log("   ", JSON.stringify(a));

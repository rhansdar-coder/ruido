// Check whether EncNoteCreated.packed_value carries the amount.
//
// This decides how much of the pool the denomination axis can see, so it is
// worth a script rather than an assumption. If packed_value encoded the amount,
// the axis would cover 100% of notes instead of 34% on Sepolia.
//
// It does not. The measured magnitude sits 55 orders of magnitude above the
// amounts it would have to encode, which makes it a commitment rather than a
// plaintext amount. The result is a negative finding, and negative findings are
// published: this one bounds the axis, and a future ABI change that moves the
// amount into packed_value would falsify it.
//
// The method is a correlation, not a decode. For transactions with one Deposit
// and one EncNoteCreated, the deposit amount is put next to packed_value.
// Guessing a bit layout from an ABI that does not describe it would be exactly
// the kind of invention this project refuses.
//
//   node scripts/check-packed-value.mjs
import { eventDefinitions, decodeEvent, amountToDecimal } from "../src/starknet-events.mjs";

const POOL = "0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91";
const RPC = "https://starknet-sepolia-rpc.publicnode.com";

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
const { defs } = eventDefinitions(abi);

const head = await call("starknet_blockNumber", []);
const byTx = new Map();
let scanned = 0;

for (const span of [20000, 80000, 200000, 450000, 900000]) {
  const page = await call("starknet_getEvents", [{
    from_block: { block_number: Math.max(0, head - span - 5000) },
    to_block: { block_number: Math.max(0, head - span) },
    address: POOL,
    keys: [],
    chunk_size: 250,
  }]);
  for (const raw of page.events ?? []) {
    const def = defs.get(raw.keys?.[0]);
    if (!def || !def.decodable) continue;
    const out = decodeEvent(def, raw);
    if (!out.ok) continue;
    scanned += 1;
    if (!byTx.has(raw.transaction_hash)) byTx.set(raw.transaction_hash, []);
    byTx.get(raw.transaction_hash).push({ name: def.name, values: out.values });
  }
}

console.log(`events scanned ${scanned}   transactions ${byTx.size}`);

// Transactions carrying exactly one deposit and exactly one encrypted note:
// the pairing is unambiguous, so any relation between the two numbers is real.
let pairs = 0;
let exactEqual = 0;
let offByOneWei = 0;
const rows = [];

for (const [, items] of byTx) {
  const dep = items.filter((i) => i.name === "Deposit");
  const enc = items.filter((i) => i.name === "EncNoteCreated");
  if (dep.length !== 1 || enc.length !== 1) continue;
  pairs += 1;

  const amount = amountToDecimal(dep[0].values.amount);
  const packed = enc[0].values.packed_value;
  const packedDec = amountToDecimal(packed);

  if (packedDec === amount) exactEqual += 1;
  if (BigInt(packedDec ?? 0) + 1n === BigInt(amount ?? 0)) offByOneWei += 1;

  if (rows.length < 14) {
    rows.push({
      amount,
      packed_value: String(packed),
      packedDec,
      // Does packed_value even have the same magnitude as the amount?
      ratio: amount && packedDec ? (Number(packedDec) / Number(amount)).toExponential(3) : "-",
    });
  }
}

console.log(`\nunambiguous (1 deposit, 1 encrypted note) pairs: ${pairs}`);
console.log(`  packed_value == deposit amount        ${exactEqual}`);
console.log(`  packed_value + 1 wei == deposit amount ${offByOneWei}`);
console.log("\n  amount               packed_value            packedDec            ratio");
for (const r of rows) {
  console.log(`  ${String(r.amount).padEnd(21)}${String(r.packed_value).padEnd(23)}${String(r.packedDec).padEnd(21)}${r.ratio}`);
}

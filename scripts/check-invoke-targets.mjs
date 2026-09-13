// Which contracts do the pool's invokes target, and does screening apply to them?
//
// The invoke path was the last open case in the screening measurement: an
// `Invoke`/`InvokeWithComputation` acquires a screening subject when the call
// returns deposits to open notes AND the target's
// `open_note_depositor_screening_policies` is not `Exempt`. The policy is pool
// state, so it can be read directly — no local node, no new data.
//
// So this script answers the question from two things already in hand:
//   - the corpus, for which contracts are actually invoked;
//   - the pool's own view, for what policy each of them carries.
//
//   node scripts/check-invoke-targets.mjs [--sample 120]
import { readFileSync } from "node:fs";
import { decodeCall, unwrapExecute } from "../src/actions.mjs";
import { selectorHex } from "../src/keccak.mjs";

const argv = process.argv.slice(2);
const sampleArg = argv.indexOf("--sample");
const SAMPLE = sampleArg === -1 ? 120 : Number(argv[sampleArg + 1]);

const RPC = process.env.RUIDO_RPC ?? "https://starknet-sepolia-rpc.publicnode.com";
const POOL = "0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91";
const APPLY = selectorHex("apply_actions");
const POLICY = selectorHex("get_open_note_screening_policy");
const norm = (s) => String(s).replace(/^0x0*/, "0x").toLowerCase();

const POLICY_NAME = { 0: "Required", 1: "Exempt", 2: "Delegated" };
const INVOKE_VARIANTS = new Set(["Invoke", "InvokeWithComputation"]);

async function call(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 160)}`);
  return j.result;
}

const abiCache = new Map();
async function abiFor(classHash) {
  if (!abiCache.has(classHash)) {
    const k = await call("starknet_getClass", ["latest", classHash]);
    abiCache.set(classHash, typeof k.abi === "string" ? JSON.parse(k.abi) : k.abi);
  }
  return abiCache.get(classHash);
}

const corpus = JSON.parse(readFileSync("data/corpus.json", "utf8"));
const seen = new Set();
const all = [];
for (const e of corpus.events) {
  if (seen.has(e.tx)) continue;
  seen.add(e.tx);
  all.push({ tx: e.tx, block: e.block });
}
all.sort((a, b) => a.block - b.block);
const stride = Math.max(1, Math.floor(all.length / SAMPLE));
const txs = all.filter((_, i) => i % stride === 0).slice(0, SAMPLE);
console.log(`corpus: ${all.length} transacciones distintas`);
console.log(`muestra estratificada: ${txs.length} (paso ${stride})\n`);

const perTarget = new Map(); // target -> { some, none, blocks: [] }
let invokeTxs = 0;
let decoded = 0;

for (const [i, { tx: hash, block }] of txs.entries()) {
  process.stdout.write(`\r  ${i + 1}/${txs.length} ...          `);
  try {
    const classHash = await call("starknet_getClassHashAt", [{ block_number: block }, POOL]);
    const abi = await abiFor(classHash);
    const tx = await call("starknet_getTransactionByHash", [hash]);
    const poolCall = unwrapExecute(tx.calldata ?? []).find(
      (c) => c.selector === APPLY && norm(c.to) === norm(POOL),
    );
    if (!poolCall) continue;
    const out = decodeCall(abi, "apply_actions", poolCall.args);
    if (!out.ok || !Array.isArray(out.args.actions)) continue;
    decoded += 1;

    const invokes = out.args.actions.filter((a) => INVOKE_VARIANTS.has(a.variant));
    if (invokes.length === 0) continue;
    invokeTxs += 1;
    const screened = out.args.screening !== null ? "some" : "none";

    for (const inv of invokes) {
      const target = norm(inv.value.contract_address);
      if (!perTarget.has(target)) perTarget.set(target, { some: 0, none: 0, blocks: [] });
      const t = perTarget.get(target);
      t[screened] += 1;
      t.blocks.push(block);
    }
  } catch {
    // Not evidence either way; verify-actions.mjs counts the unreadable ones.
  }
}
process.stdout.write("\r".padEnd(40) + "\r");

console.log(`=== invokes, ${decoded} transacciones decodificadas, ${invokeTxs} con invoke ===\n`);

// The policy is pool state, so it is read once per distinct target.
console.log("  contrato invocado                     politica     invokes  Some / None   bloques");
const rows = [...perTarget.entries()].sort((a, b) => b[1].some + b[1].none - (a[1].some + a[1].none));
const policies = new Map();
for (const [target, t] of rows) {
  let policy = "?";
  try {
    const out = await call("starknet_call", [
      { contract_address: POOL, entry_point_selector: POLICY, calldata: [target] },
      "latest",
    ]);
    policy = POLICY_NAME[Number(BigInt(out[0]))] ?? `?${out[0]}`;
  } catch (e) {
    policy = `error`;
  }
  policies.set(target, policy);
  const span = `${Math.min(...t.blocks)}-${Math.max(...t.blocks)}`;
  console.log(
    `  ${target.slice(0, 20)}…  ${policy.padEnd(11)} ${String(t.some + t.none).padStart(5)}  ` +
      `${String(t.some).padStart(4)} / ${String(t.none).padEnd(6)} ${span}`,
  );
}

console.log("\n=== lectura ===");
const byPolicy = new Map();
for (const [target, t] of rows) {
  const p = policies.get(target);
  if (!byPolicy.has(p)) byPolicy.set(p, { some: 0, none: 0, targets: 0 });
  const b = byPolicy.get(p);
  b.some += t.some;
  b.none += t.none;
  b.targets += 1;
}
for (const [p, b] of byPolicy) {
  console.log(`  politica ${p.padEnd(10)} ${b.targets} contrato(s)   screening Some ${b.some} / None ${b.none}`);
}
const exempt = byPolicy.get("Exempt");
const req = byPolicy.get("Required");
if (exempt && exempt.some === 0) {
  console.log("\n  Los targets Exempt NO traen atestacion, ni una vez: coincide con");
  console.log("  `_apply_invoke_and_deposits`, que los exime explicitamente.");
}
if (req && req.some > 0) {
  console.log("  Los targets Required SI traen atestacion: tambien coincide. La politica");
  console.log("  del contrato invocado es la que decide, y se puede leer antes de invocar.");
}
if (byPolicy.has("Delegated")) {
  console.log("  Hay targets Delegated: ahi decide el proveedor de screening, no nosotros.");
}

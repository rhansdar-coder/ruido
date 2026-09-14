// Does an action set with no deposit actually carry a screening attestation?
//
// This decides how much of the decoy emitter is reachable, and it is answerable
// from data already in hand rather than by reading Cairo. `apply_actions` takes
// `screening: Option<ScreeningAttestation>`, and the decoder reads it. So for
// every real transaction:
//
//   - does the action set contain an EmitDeposit?
//   - is `screening` None or Some?
//
// If deposits carry Some and deposit-free sets carry None, then screening is
// scoped to deposits, and an emitter that only reshapes value already inside the
// pool never needs an attestation. If deposit-free sets also carry Some, the
// scope is wider and the emitter's ceiling is lower.
//
// Either result is a finding. The point is not to get the answer we want.
//
// RESULT (2026-09-11, --sample 200): 114 decoded across six classes.
//   con deposito   0 None / 55 Some   -> consistent with `_apply_actions`
//   con invoke     ? None / ? Some    -> depends on the target's policy
//   ninguno        ? None / ? Some    -> the sets the contract cannot screen
// The first version of this measurement concluded "the emitter cannot avoid the
// screener". That was **wrong**, and it was wrong because `src/actions.mjs` read
// Cairo's `Option` backwards (`Some` is variant 0, not 1), so every real `Some`
// was reported as `None` and every real `None` as `Some`. See the header of
// `src/actions.mjs` and docs/FINDING-emitter-interface.md §2b.
//
//   node scripts/check-screening-scope.mjs [--sample 40]
import { readFileSync } from "node:fs";
import { decodeCall, unwrapExecute } from "../src/actions.mjs";
import { selectorHex } from "../src/keccak.mjs";
import { STRK20_POOL } from "../src/pool.mjs";

const argv = process.argv.slice(2);
const sampleArg = argv.indexOf("--sample");
const SAMPLE = sampleArg === -1 ? 40 : Number(argv[sampleArg + 1]);
// `--from N` restricts the corpus to blocks >= N. The stratified sample spans the
// whole corpus, which ends up exercising the *old* implementations and skipping
// the class that is live now. This is how the live class gets measured.
const fromArg = argv.indexOf("--from");
const FROM = fromArg === -1 ? 0 : Number(argv[fromArg + 1]);

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
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 160)}`);
  return j.result;
}

const abiCache = new Map();
async function abiFor(classHash) {
  if (!abiCache.has(classHash)) {
    const klass = await call("starknet_getClass", ["latest", classHash]);
    abiCache.set(classHash, typeof klass.abi === "string" ? JSON.parse(klass.abi) : klass.abi);
  }
  return abiCache.get(classHash);
}

// Deposits are the actions the pool screens. `EmitDeposit` is the server-side
// mirror of a `Deposit`; `TransferFrom` is the actual transfer the pool makes.
// Either one means value entered from L1 in this call.
const DEPOSIT_VARIANTS = new Set(["EmitDeposit", "TransferFrom"]);

// The other way a set can acquire a screening subject: `_apply_invoke_and_deposits`
// sets one when an invoke returns deposits to open notes and the target's
// `open_note_depositor_screening_policies` is not `Exempt`. So a set containing
// an invoke *may* be screened even with no deposit of its own.
const INVOKE_VARIANTS = new Set(["Invoke", "InvokeWithComputation"]);

// The contract's own rule, from `_apply_actions`: the subject is written in
// exactly two places — `TransferFrom` (the depositor) and the invoke path.
// A set with neither **cannot** require screening. That makes this a prediction
// we can hold the data against, rather than a description of the data.
const CATEGORIES = ["deposito", "invoke", "ninguno"];
function categoryOf(variants) {
  if (variants.some((v) => DEPOSIT_VARIANTS.has(v))) return "deposito";
  if (variants.some((v) => INVOKE_VARIANTS.has(v))) return "invoke";
  return "ninguno";
}

const corpus = JSON.parse(readFileSync("data/corpus.json", "utf8"));

// Stratified across the corpus's block range, not the first N.
//
// The corpus spans 2,000,000 blocks and the pool ran three implementations
// inside it. Taking the first N transactions samples only the oldest class, and
// the answer about screening then describes code that is no longer deployed.
// The first run of this script made exactly that mistake and reported a
// confident answer about the wrong class.
const seen = new Set();
const all = [];
for (const e of corpus.events) {
  if (seen.has(e.tx)) continue;
  seen.add(e.tx);
  all.push({ tx: e.tx, block: e.block });
}
all.sort((a, b) => a.block - b.block);
const pool = FROM > 0 ? all.filter((t) => t.block >= FROM) : all;
if (pool.length === 0) {
  console.log(`no hay transacciones con bloque >= ${FROM}`);
  process.exit(0);
}
const stride = Math.max(1, Math.floor(pool.length / SAMPLE));
const txs = pool.filter((_, i) => i % stride === 0).slice(0, SAMPLE);
console.log(`corpus: ${all.length} transacciones distintas, bloques ${all[0].block}-${all[all.length - 1].block}`);
if (FROM > 0) console.log(`filtro: bloque >= ${FROM}  ->  ${pool.length} transacciones`);
console.log(`muestra estratificada: ${txs.length} (paso ${stride})\n`);

// Keyed by class, because the answer is only about the class it was measured on.
const perClass = new Map();
const bucketFor = (classHash) => {
  if (!perClass.has(classHash)) {
    const empty = () => ({ none: 0, some: 0 });
    perClass.set(classHash, {
      deposito: empty(),
      invoke: empty(),
      ninguno: empty(),
      blocks: [],
    });
  }
  return perClass.get(classHash);
};
let decoded = 0;
const examples = [];

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

    const variants = out.args.actions.map((a) => a.variant);
    const category = categoryOf(variants);
    const screened = out.args.screening !== null;
    const bucket = bucketFor(classHash);
    const cell = bucket[category];
    if (screened) cell.some += 1;
    else cell.none += 1;
    bucket.blocks.push(block);

    examples.push({
      block,
      classHash,
      variants,
      category,
      screening: out.args.screening === null ? "None" : "Some",
    });
  } catch {
    // Unreadable transactions are counted by verify-actions.mjs; here they are
    // simply not evidence about screening.
  }
}
process.stdout.write("\r".padEnd(40) + "\r");

console.log(`=== alcance del screening, ${decoded} transacciones decodificadas ===`);
console.log("    (por clase: el resultado solo vale para la clase donde se midio)");
console.log("    categoria = lo que el CONTRATO puede exigir, no lo que el cliente mando");
console.log("      deposito  trae TransferFrom/EmitDeposit -> el contrato exige sujeto");
console.log("      invoke    trae Invoke/InvokeWithComputation -> puede exigirlo, segun politica");
console.log("      ninguno   no trae ninguno de los dos -> NO puede exigirlo\n");

const empty = () => ({ none: 0, some: 0 });
const totals = { deposito: empty(), invoke: empty(), ninguno: empty() };
const label = { deposito: "con deposito", invoke: "con invoke  ", ninguno: "ninguno     " };

for (const [hash, b] of [...perClass].sort((a, b) => Math.min(...a[1].blocks) - Math.min(...b[1].blocks))) {
  console.log(`  clase ${hash}`);
  console.log(`    bloques ${Math.min(...b.blocks)}-${Math.max(...b.blocks)}   (${b.blocks.length} muestras)`);
  console.log("                          screening None   screening Some");
  for (const c of CATEGORIES) {
    console.log(`    ${label[c]}  ${String(b[c].none).padStart(10)}${String(b[c].some).padStart(17)}`);
    totals[c].none += b[c].none;
    totals[c].some += b[c].some;
  }
}
console.log("\n  TOTAL");
console.log("                          screening None   screening Some");
for (const c of CATEGORIES) {
  console.log(`    ${label[c]}  ${String(totals[c].none).padStart(10)}${String(totals[c].some).padStart(17)}`);
}

console.log("\n=== ejemplos ===");
const show = (e) => {
  const v = e.variants.length > 6 ? `${e.variants.slice(0, 6).join(",")},+${e.variants.length - 6}` : e.variants.join(",");
  console.log(
    `  ${String(e.block).padEnd(9)} ${e.classHash.slice(0, 12)}… ${e.category.padEnd(8)} ` +
      `screening=${e.screening.padEnd(5)} ${v}`,
  );
};
// The anomalies first: a set the contract cannot screen, yet carrying one.
const anomalies = examples.filter((e) => e.category === "ninguno" && e.screening === "Some");
if (anomalies.length) {
  console.log(`  -- sin deposito ni invoke, pero CON atestacion (${anomalies.length}) --`);
  for (const e of anomalies.slice(0, 12)) show(e);
} else {
  console.log("  -- ningun conjunto sin deposito ni invoke trae atestacion --");
}
console.log(`  -- muestra general (${Math.min(8, examples.length)} de ${examples.length}) --`);
for (const e of examples.slice(0, 8)) show(e);

console.log("\n=== lectura ===");
const ning = totals.ninguno;
const dep = totals.deposito;
const inv = totals.invoke;

// The prediction from `_apply_actions`: a set with no deposit and no invoke
// cannot acquire a screening subject, so it should never carry one.
if (ning.none + ning.some === 0) {
  console.log("  No hay muestras sin deposito ni invoke. No se puede concluir.");
} else if (ning.some === 0) {
  console.log(`  PREDICCION CUMPLIDA: los ${ning.none} conjuntos sin deposito ni invoke NO traen`);
  console.log("  atestacion, ni uno. El contrato no puede exigirla ahi, y el cliente no la manda.");
  console.log("  => El camino interno (gastar y rehacer notas) es alcanzable sin el screener.");
} else if (ning.none === 0) {
  console.log(`  PREDICCION FALLIDA: los ${ning.some} conjuntos sin deposito ni invoke traen atestacion`);
  console.log("  TODOS. El contrato no puede exigirla ahi segun `_apply_actions`, asi que la");
  console.log("  atestacion es VOLUNTARIA del cliente, o esta clase se comporta distinto.");
} else {
  console.log(`  MIXTO: de los conjuntos sin deposito ni invoke, ${ning.none} no traen atestacion y`);
  console.log(`  ${ning.some} si. La atestacion no es requisito ahi; se manda por otra razon.`);
}
if (dep.none > 0) {
  console.log(`  OJO: ${dep.none} conjuntos CON deposito sin atestacion. Contradice a`);
  console.log("  `_apply_actions`, que exige sujeto para todo TransferFrom. Hay que explicarlo.");
} else if (dep.some > 0) {
  console.log(`  Consistente: los ${dep.some} conjuntos con deposito traen atestacion, ninguno falta.`);
}
if (inv.some + inv.none > 0) {
  console.log(`  Invokes: ${inv.some} con atestacion, ${inv.none} sin. Ahi el sujeto depende de la`);
  console.log("  politica del contrato invocado y de si devuelve depositos; no se ve en el ABI.");
}
if (perClass.size === 1) {
  console.log(`\n  LIMITE: una sola clase (${[...perClass.keys()][0].slice(0, 14)}…). Esto NO dice nada`);
  console.log("  sobre las otras implementaciones del pool. Sube --sample para cubrirlas.");
}

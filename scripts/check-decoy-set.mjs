// Verify the decoy set's WIRE FORMAT against the deployed pool.
//
// This is the check that turns "we wrote the encoder from a reading of the
// source" into "the deployed contract parses what we build". It is the closest
// thing to an emitter test that does not need a node, and it is worth having
// because of what it distinguishes.
//
// ## The two failures that look alike
//
// A set that is wrongly encoded and a set that is correctly encoded both revert.
// What separates them is WHERE:
//
//   "Failed to deserialize param #3"  -> the contract could not read our calldata
//   "SUBCHANNEL_NOT_FOUND"            -> the contract read it and went looking
//                                        for state
//
// Only the second one means the wire format is right. So the check asserts the
// second, AND runs a deliberately short payload to confirm the first still
// exists — a check that cannot fail is not a check, and if the contract ever
// started answering the same thing to both, this script has to say so.
//
// ## What this does NOT verify, and the evidence is in the output
//
// The **order rules as applied to this set**. `[CreateEncNote, UseNote]` is out
// of order — phase 5 then 4 — and the contract answers `SUBCHANNEL_NOT_FOUND`,
// not `ACTIONS_OUT_OF_ORDER`. So the subchannel lookup runs BEFORE the order
// check, and a set without a subchannel never reaches it. The rules ARE verified
// for `[Deposit]` and `[Deposit, SetViewingKey]`, which need no subchannel, and
// this script re-asserts that too so the contrast is visible rather than
// remembered.
//
// The **expansion** of the two actions is likewise still unobserved: it needs
// real subchannel and note state. See `docs/RUNBOOK-emitter.md`.
//
// ## Why a throwaway key is safe here
//
// `compile_actions` takes the pool's *viewing* key, and handing that to a public
// RPC hands over the ability to decrypt every note it protects. The scalar below
// is generated here, printed here, never funded and never registered — it
// controls nothing, so disclosing it discloses nothing. That is the difference
// between verifying the interface and leaking a capability, and it is the whole
// reason this script has the shape it has.
//
// Every call is `starknet_call` — a view. No transaction, no fee, no state.
//
//   node scripts/check-decoy-set.mjs

import {
  CLIENT_ACTION_ORDER,
  PHASE,
  assembleDecoySet,
  checkSet,
  compileCalldata,
  emissionNotes,
  encodeSet,
} from "../src/emitter.mjs";
import { selectorHex } from "../src/keccak.mjs";
import { STRK20_POOL, STRK_TOKEN } from "../src/pool.mjs";

const RPC = process.env.RUIDO_RPC ?? "https://starknet-sepolia-rpc.publicnode.com";
const POOL = STRK20_POOL.sepolia;
const COMPILE = selectorHex("compile_actions");

// A throwaway identity. Not a secret: it is printed in this file.
const KEY = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcde";
const FRESH = "0x4f1e4b2a9c7d3805e6a1b4c9d2e5f8091a3b6c7d8e9f0a1b2c3d4e5f6071829";

// The shapes the emitter's assembler assumes. Read from the deployed ABI below
// and compared field by field, because a fixture that drifts from the chain is
// a fixture that makes the offline tests agree with a contract that no longer
// exists.
const EXPECTED = {
  "privacy::actions::UseNoteInput": ["channel_key", "token", "index"],
  "privacy::actions::CreateEncNoteInput": [
    "recipient_addr", "recipient_public_key", "token", "amount", "index", "salt",
  ],
};

async function call(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) {
    const err = new Error(j.error.message ?? "rpc error");
    err.data = j.error.data;
    throw err;
  }
  return j.result;
}

/** Cairo short-string errors arrive as ASCII packed into a felt. */
const ascii = (felt) => {
  let hex = BigInt(felt).toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const text = (hex.match(/../g) ?? []).map((b) => String.fromCharCode(parseInt(b, 16))).join("");
  return /^[\x20-\x7e]+$/.test(text) ? text : null;
};

const errorNames = (data) => {
  const raw = typeof data === "string" ? data : data?.revert_error ?? "";
  return raw.split(",").map((s) => ascii(s.trim())).filter(Boolean);
};

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? `   ${detail}` : ""}`);
  if (!ok) failures += 1;
};

// ---------------------------------------------------------------------------
const klass = await call("starknet_getClassAt", ["latest", POOL]);
const abi = typeof klass.abi === "string" ? JSON.parse(klass.abi) : klass.abi;

/** The RPC takes felts as `0x`-prefixed hex; the encoder returns BigInt. */
const hx = (felt) => `0x${BigInt(felt).toString(16)}`;

async function compile(addr, actions) {
  const calldata = compileCalldata(abi, { userAddr: addr, viewingKey: KEY, actions });
  try {
    const out = await call("starknet_call", [
      { contract_address: POOL, entry_point_selector: COMPILE, calldata: calldata.map(hx) },
      "latest",
    ]);
    return { ok: true, out };
  } catch (e) {
    return { ok: false, errors: errorNames(e.data), message: e.message };
  }
}

/** The raw attempt, for the negative control that has to bypass the assembler. */
async function compileRaw(addr, rawActions) {
  const calldata = [addr, KEY, hx(rawActions.length), ...rawActions.flat().map(hx)];
  try {
    const out = await call("starknet_call", [
      { contract_address: POOL, entry_point_selector: COMPILE, calldata },
      "latest",
    ]);
    return { ok: true, out };
  } catch (e) {
    return { ok: false, errors: errorNames(e.data), message: e.message };
  }
}

// ---------------------------------------------------------------------------
console.log("=== 1. el ABI desplegado sigue diciendo lo que el codigo asume ===\n");

const client = abi.find((x) => x.type === "enum" && x.name === "privacy::actions::ClientAction");
const liveOrder = client.variants.map((v) => v.name);
check(
  "el orden de las variantes no se movio",
  JSON.stringify(liveOrder) === JSON.stringify(CLIENT_ACTION_ORDER),
  liveOrder.join(", "),
);

const index = Object.fromEntries(liveOrder.map((n, i) => [n, i]));
check(
  "el indice del enum NO es la fase",
  index.CreateEncNote !== PHASE.CreateEncNote && index.Deposit !== PHASE.Deposit,
  `CreateEncNote: variante ${index.CreateEncNote} / fase ${PHASE.CreateEncNote}`,
);

for (const [name, fields] of Object.entries(EXPECTED)) {
  const s = abi.find((x) => x.type === "struct" && x.name === name);
  const live = s ? s.members.map((m) => m.name) : [];
  check(
    `${name.replace(/^.*::/, "")} conserva sus campos y su orden`,
    JSON.stringify(live) === JSON.stringify(fields),
    live.join(", ") || "(no esta en el ABI)",
  );
}

// The parameter NAMES, not just the types. `encodeCall` matches on name, so a
// rename is a hard failure — and it is a failure this file has already caught
// once: the offline fixture said `actions` and the deployed contract says
// `client_actions`. A fixture cannot catch that, because the fixture is what
// declares the name.
const compileFn = abi
  .flatMap((x) => (x.type === "interface" ? x.items ?? [] : [x]))
  .find((x) => x.type === "function" && x.name === "compile_actions");
const liveInputs = (compileFn?.inputs ?? []).map((i) => i.name);
check(
  "compile_actions conserva los nombres de sus parametros",
  JSON.stringify(liveInputs) === JSON.stringify(["user_addr", "user_private_key", "client_actions"]),
  liveInputs.join(", ") || "(no esta en el ABI)",
);

// ---------------------------------------------------------------------------
console.log("\n=== 2. el conjunto del emisor, contra el contrato ===\n");

const actions = assembleDecoySet({
  channelKey: "0x1",
  token: STRK_TOKEN,
  spendIndex: 0,
  notes: emissionNotes({ firstIndex: 1, decoys: 1, denomination: 100n, changeAmount: 50n }),
  recipient: FRESH,
  recipientKey: "0x2",
  salts: [3n, 4n],
});

check("el conjunto pasa sus propias reglas antes de salir", checkSet(actions).ok,
  checkSet(actions).violations.join("; "));

const encoded = encodeSet(abi, actions);
check(
  "codifica al numero de felts que implican las formas",
  encoded.length === 1 + 4 + 7 + 7,
  `${encoded.length} felts`,
);

const live = await compile(FRESH, actions);
check(
  "el contrato LEE el conjunto y busca estado (SUBCHANNEL_NOT_FOUND)",
  !live.ok && live.errors.includes("SUBCHANNEL_NOT_FOUND"),
  live.errors?.join(" | ") ?? `COMPILO -> ${live.out?.length} felts`,
);
check(
  "y NO falla deserializando",
  !live.ok && !live.errors.some((e) => /deserialize/i.test(e)),
  live.errors?.join(" | ") ?? "",
);

// ---------------------------------------------------------------------------
console.log("\n=== 3. el control negativo: un payload corto SI falla al leer ===\n");

// Variant 6 is UseNote and it takes three fields. Sending one is the shape that
// the first probe used, and it must still be rejected at the reader — otherwise
// the assertion above means nothing, because the contract would be answering
// SUBCHANNEL_NOT_FOUND to everything.
const short = await compileRaw(FRESH, [["0x6", "0x1"]]);
check(
  "un UseNote con un solo campo -> falla la deserializacion",
  !short.ok && short.errors.some((e) => /deserialize/i.test(e)),
  short.errors?.join(" | ") ?? short.message,
);
check(
  "y ese fracaso NO es el mismo mensaje que el conjunto correcto",
  !short.ok && !short.errors.includes("SUBCHANNEL_NOT_FOUND"),
);

// ---------------------------------------------------------------------------
console.log("\n=== 4. las reglas de orden: verificadas, y NO por esta via ===\n");

const deposit = await compileRaw(FRESH, [[`0x${index.Deposit.toString(16)}`, STRK_TOKEN, "0x64"]]);
check(
  "[Deposit] sin accion que escriba -> NO_REPLAY_PROTECTION",
  !deposit.ok && deposit.errors.includes("NO_REPLAY_PROTECTION"),
  deposit.errors?.join(" | ") ?? deposit.message,
);

const outOfOrder = await compileRaw(FRESH, [
  [`0x${index.Deposit.toString(16)}`, STRK_TOKEN, "0x64"],
  [`0x${index.SetViewingKey.toString(16)}`, "0x7"],
]);
check(
  "[Deposit, SetViewingKey] (fase 3 -> 0) -> ACTIONS_OUT_OF_ORDER",
  !outOfOrder.ok && outOfOrder.errors.includes("ACTIONS_OUT_OF_ORDER"),
  outOfOrder.errors?.join(" | ") ?? outOfOrder.message,
);

// The same rule, on the decoy set, where the contract never gets there.
const decoyOutOfOrder = await compileRaw(FRESH, [
  [`0x${index.CreateEncNote.toString(16)}`, FRESH, "0x2", STRK_TOKEN, "0x64", "0x0", "0x3"],
  [`0x${index.UseNote.toString(16)}`, "0x1", STRK_TOKEN, "0x0"],
]);
check(
  "[CreateEncNote, UseNote] (fase 5 -> 4) NO llega al chequeo de orden",
  !decoyOutOfOrder.ok && decoyOutOfOrder.errors.includes("SUBCHANNEL_NOT_FOUND"),
  decoyOutOfOrder.errors?.join(" | ") ?? decoyOutOfOrder.message,
);
check(
  "...asi que el orden de ESTE conjunto queda sin verificar contra el contrato",
  !decoyOutOfOrder.ok && !decoyOutOfOrder.errors.includes("ACTIONS_OUT_OF_ORDER"),
  "lo cubre checkSet en src/emitter.mjs, leido de la fuente",
);

// ---------------------------------------------------------------------------
console.log(
  failures === 0
    ? "\nel formato de cable del conjunto de señuelos esta verificado contra el pool desplegado"
    : `\n${failures} verificacion(es) fallaron`,
);
console.log("lo que sigue sin observarse: la expansion de UseNote y CreateEncNote");
process.exitCode = failures === 0 ? 0 : 1;

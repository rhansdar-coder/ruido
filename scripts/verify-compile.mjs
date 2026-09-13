// Verify the pool's action-compilation contract against the deployed pool.
//
// This closes the "ClientAction -> ServerAction is not reproduced" gap: the
// deployed pool compiles a synthetic action set for us, and we check the output
// against the source's own expansion.
//
// WHY THIS IS SAFE WITHOUT A LOCAL NODE
//
// `compile_actions` takes a `user_private_key`, which is the pool's *viewing*
// key — handing that to a public RPC hands over the ability to decrypt your
// notes. So every call here uses a **throwaway scalar generated in this file**:
// never funded, never registered, controlling nothing. Disclosing it discloses
// nothing. That is the difference between verifying the interface and leaking a
// capability, and it is the whole reason this script exists in this shape.
//
// Every call is `starknet_call` — a view. No transaction, no fee, no state.
//
//   node scripts/verify-compile.mjs
import { decodeValue, typeRegistry } from "../src/actions.mjs";
import { selectorHex } from "../src/keccak.mjs";

const RPC = process.env.RUIDO_RPC ?? "https://starknet-sepolia-rpc.publicnode.com";
const POOL = "0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91";
const COMPILE = selectorHex("compile_actions");
const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

// A throwaway identity. Not a secret: it is printed in this file.
const KEY = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcde";
const FRESH = "0x4f1e4b2a9c7d3805e6a1b4c9d2e5f8091a3b6c7d8e9f0a1b2c3d4e5f6071829";
// A real address from the corpus, already registered in the pool.
const REGISTERED = "0x41c9dbe8ab9b414fa0ec4d22b7a41d80a3911b77a2c9c819ce949faa5edb9f9";

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
  const bytes = hex.match(/../g) ?? [];
  const text = bytes.map((b) => String.fromCharCode(parseInt(b, 16))).join("");
  return /^[\x20-\x7e]+$/.test(text) ? text : null;
};

const errorNames = (data) => {
  const raw = typeof data === "string" ? data : data?.revert_error ?? "";
  return raw
    .split(",")
    .map((s) => ascii(s.trim()))
    .filter(Boolean);
};

const hx = (n) => `0x${n.toString(16)}`;

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? `   ${detail}` : ""}`);
  if (!ok) failures += 1;
};

// ---------------------------------------------------------------------------
// 1. The ABI's variant order, which is NOT the phase order
// ---------------------------------------------------------------------------
const klass = await call("starknet_getClassAt", ["latest", POOL]);
const abi = typeof klass.abi === "string" ? JSON.parse(klass.abi) : klass.abi;
const clientVariants = abi
  .find((x) => x.type === "enum" && x.name === "privacy::actions::ClientAction")
  .variants.map((v) => v.name);

// Pinned from the deployed ABI. If an upgrade reorders it, this fails loudly
// instead of silently building sets with the wrong variant index.
const ABI_ORDER = [
  "SetViewingKey", "OpenChannel", "OpenSubchannel", "CreateEncNote", "CreateOpenNote",
  "Deposit", "UseNote", "Withdraw", "InvokeExternal", "ComputeAndInvoke",
];
const V = Object.fromEntries(ABI_ORDER.map((n, i) => [n, i]));

// From `sdk/rs/src/actions.rs` `pub mod phase`. Deliberately a different table
// from the ABI order, because they genuinely disagree: `CreateEncNote` is variant
// 3 but phase 5, and `Deposit` is variant 5 but phase 3. Assuming they matched
// would produce a set that is out of order in a way that is not obvious.
const PHASE = {
  SetViewingKey: 0, OpenChannel: 1, OpenSubchannel: 2, Deposit: 3,
  UseNote: 4, CreateEncNote: 5, CreateOpenNote: 5, Withdraw: 6,
  InvokeExternal: 7, ComputeAndInvoke: 7,
};

console.log("=== 1. orden del enum contra orden de fase ===");
check("el ABI lista ClientAction en el orden esperado", JSON.stringify(clientVariants) === JSON.stringify(ABI_ORDER));
check(
  "el indice del enum NO es la fase (la trampa)",
  PHASE.CreateEncNote !== V.CreateEncNote && PHASE.Deposit !== V.Deposit,
  `CreateEncNote: variante ${V.CreateEncNote} / fase ${PHASE.CreateEncNote}`,
);

// ---------------------------------------------------------------------------
// 2. The ordering rules, held against the deployed contract
// ---------------------------------------------------------------------------
console.log("\n=== 2. reglas de orden, contra el contrato desplegado ===");

const deposit = [hx(V.Deposit), STRK, "0x64"]; // DepositInput { token, amount }
const setKey = [hx(V.SetViewingKey), "0x7"]; // SetViewingKeyInput { random }

async function attempt(addr, actions) {
  const calldata = [addr, KEY, hx(actions.length), ...actions.flat()];
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

const noReplay = await attempt(REGISTERED, [deposit]);
check(
  "[Deposit] sin accion que escriba -> NO_REPLAY_PROTECTION",
  !noReplay.ok && noReplay.errors.includes("NO_REPLAY_PROTECTION"),
  noReplay.errors?.join(" | ") ?? noReplay.message,
);

const empty = await attempt(REGISTERED, []);
check(
  "[] vacio -> NO_REPLAY_PROTECTION",
  !empty.ok && empty.errors.includes("NO_REPLAY_PROTECTION"),
  empty.errors?.join(" | ") ?? empty.message,
);

const outOfOrder = await attempt(REGISTERED, [deposit, setKey]);
check(
  "[Deposit, SetViewingKey] (fase 3 -> 0) -> ACTIONS_OUT_OF_ORDER",
  !outOfOrder.ok && outOfOrder.errors.includes("ACTIONS_OUT_OF_ORDER"),
  outOfOrder.errors?.join(" | ") ?? outOfOrder.message,
);

const reregister = await attempt(REGISTERED, [setKey]);
check(
  "[SetViewingKey] sobre una direccion ya registrada -> NON_ZERO_VALUE",
  !reregister.ok && reregister.errors.includes("NON_ZERO_VALUE"),
  reregister.errors?.join(" | ") ?? reregister.message,
);

// ---------------------------------------------------------------------------
// 3. A real compile, decoded with our own decoder
// ---------------------------------------------------------------------------
console.log("\n=== 3. ClientAction -> ServerAction, compilado por el pool ===");

const reg = typeRegistry(abi);
const first = await attempt(FRESH, [setKey]);
check("compila para una identidad virgen", first.ok, first.message ?? "");

if (first.ok) {
  const decoded = decodeValue("core::array::Span::<privacy::actions::ServerAction>", first.out, 0, reg);
  check(
    "consumo exacto de la salida del contrato",
    decoded.consumed === first.out.length,
    `${decoded.consumed}/${first.out.length} felts`,
  );

  const variants = decoded.value.map((a) => a.variant);
  check(
    "expande a WriteOnce, WriteOnce, EmitViewingKeySet",
    JSON.stringify(variants) === JSON.stringify(["WriteOnce", "WriteOnce", "EmitViewingKeySet"]),
    variants.join(", "),
  );

  // `set_viewing_key` computes `enc_private_key` once and reuses it in both the
  // WriteOnce and the event. If those two disagreed, one of them would be wrong.
  // The WriteOnce stores it as a bare felt span; the event as a named struct.
  const [, writeOnceEnc, event] = decoded.value;
  const [wAuditor, wEphemeral, wEnc] = writeOnceEnc.value.value;
  const e = event.value.enc_private_key;
  check(
    "el enc_private_key del WriteOnce y del evento coinciden",
    wAuditor === e.auditor_public_key && wEphemeral === e.ephemeral_pubkey && wEnc === e.enc_private_key,
    `${wEnc?.slice(0, 12)}… vs ${e.enc_private_key?.slice(0, 12)}…`,
  );
  check(
    "el public_key del WriteOnce y del evento coinciden",
    decoded.value[0].value.value[0] === event.value.public_key,
  );

  const second = await attempt(FRESH, [setKey]);
  check(
    "la segunda llamada tambien compila (es una view, no persiste)",
    second.ok && JSON.stringify(second.out) === JSON.stringify(first.out),
  );
}

console.log(
  failures === 0
    ? "\ntodo verificado contra el contrato desplegado"
    : `\n${failures} verificacion(es) fallaron`,
);
process.exitCode = failures === 0 ? 0 : 1;

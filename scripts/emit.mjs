#!/usr/bin/env node
// The emitter's entry point — and it deliberately stops one step short.
//
//   node scripts/emit.mjs                       a dry run with the defaults
//   node scripts/emit.mjs --decoys 3 --denomination 25
//   node scripts/emit.mjs --json                machine-readable
//   node scripts/emit.mjs --submit              REFUSED, and says why
//
// ## What this does
//
// It assembles the decoy set, checks the three rules, encodes it, and prints the
// calldata it WOULD submit. That is a real thing to have: an operator about to
// spend 2 STRK per call should be able to read the actions first, and a tool
// that prints them cannot flatter the set.
//
// ## What it refuses, and why the refusal is the honest shape
//
// `--submit` is refused outright rather than half-built. Submitting means the
// seven-step pipeline in `docs/CONNECT.md`, and steps 2 through 5 carry the pool
// viewing key — step 2 in the calldata to the preflight RPC, step 4 in plaintext
// at `calldata[5]` to the prover. Both endpoints must therefore be inside the
// operator's trust boundary, which is a running Juno node and a local prover,
// neither of which this repository can assume exists.
//
// The refusal is not "not implemented". It names the two endpoints and the
// reason, because a tool that silently degrades into a public-RPC call is a tool
// that hands over the ability to decrypt every note the key protects — and it
// would look like it worked.
//
// ## The unit, which is the one thing here that can go wrong quietly
//
// `DENOMINATIONS` is the ladder in **whole STRK**. `CreateEncNote.amount` is a
// `u128` in the token's **base units**. A rung passed straight through would
// mint a note worth 10 wei, which is not an error the chain reports — it is a
// note nobody else has, which is a smaller anonymity set and looks fine.
//
// So the conversion happens here and only here, and the rung is checked against
// the ladder first: a number that is not a rung is a note nobody else is
// holding, which is the whole thing the ladder exists to prevent.
//
// ## Why the ABI read is safe over a public RPC
//
// Reading the deployed ABI discloses nothing: it is a public artifact of a
// public contract. It is the only network call this script makes, and the pool
// viewing key never appears in it.

import { isLoopback } from "../src/trust.mjs";
import { STRK20_POOL, STRK_TOKEN, baseToStrk, strkToBase } from "../src/pool.mjs";
import { DENOMINATIONS, FEE_PER_CALL } from "../src/cover.mjs";
import {
  WRITE_ONCE_PRODUCERS,
  assembleDecoySet,
  checkSet,
  compileCalldata,
  emissionNotes,
  encodeSet,
  phasesOf,
} from "../src/emitter.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const die = (message) => {
  console.error(`emit: ${message}`);
  process.exit(1);
};

// ---------------------------------------------------------------------------
// The refusal, before anything else happens
// ---------------------------------------------------------------------------

if (flag("submit")) {
  const rpc = arg("rpc", "http://127.0.0.1:6060/v0_10");
  const prover = arg("prover", "http://127.0.0.1:3000");
  const hostOf = (url) => {
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  };

  // Both default to loopback, so this guards an operator who overrode one —
  // not a formality, and the message says what is at stake rather than "invalid".
  for (const [label, url] of [["--rpc", rpc], ["--prover", prover]]) {
    const host = hostOf(url);
    if (host === null) die(`${label} is not a URL: ${url}`);
    if (!isLoopback(host)) {
      die(
        `${label} points at ${host}, which is not this machine.\n` +
          "  The preflight calldata carries the pool viewing key, and the prover\n" +
          "  receives it in plaintext at calldata[5]. A third-party operator who\n" +
          "  sees either one can decrypt every note that key protects. Both\n" +
          "  endpoints must be inside the operator's trust boundary.",
      );
    }
  }

  die(
    "the submit path is not built, and building it is not the next step.\n" +
      `  It needs ${rpc} (a synced Juno node) and ${prover} (a local prover) to exist,\n` +
      "  and a funded Starknet Sepolia account holding a note in the pool to spend.\n" +
      "  Steps 1 and 2 of the seven are built and verified: this set is assembled,\n" +
      "  checked and encoded, and `npm run check:decoy` confirms the deployed pool\n" +
      "  reads the wire format. Steps 3 through 7 need the host.\n" +
      "  See docs/CONNECT.md and docs/RUNBOOK-emitter.md.\n" +
      "\n" +
      "  Run without --submit to see what would be sent.",
  );
}

// ---------------------------------------------------------------------------
// The dry run
// ---------------------------------------------------------------------------

const DECOYS = Number(arg("decoys", "1"));
const NETWORK = arg("network", "sepolia");
const RPC = arg("rpc", process.env.RUIDO_RPC ?? "https://starknet-sepolia-rpc.publicnode.com");
const POOL = STRK20_POOL[NETWORK];
if (!POOL) die(`no pool known for ${NETWORK}; try sepolia or mainnet`);
if (!Number.isInteger(DECOYS) || DECOYS < 1) die(`--decoys must be a positive integer, got ${DECOYS}`);

// The ladder is whole STRK and the wire is base units. One conversion, here.
const RUNG = BigInt(arg("denomination", String(DENOMINATIONS[3])));
if (!DENOMINATIONS.includes(RUNG)) {
  die(
    `--denomination must be one of ${DENOMINATIONS.join(", ")} (whole STRK), got ${RUNG}.\n` +
      "  A rung off the ladder is a note nobody else is holding, which is a smaller\n" +
      "  anonymity set rather than an error the chain would report.",
  );
}
const DENOMINATION = strkToBase(RUNG.toString());
const CHANGE = strkToBase(arg("change", String(RUNG / 2n)));

const notes = emissionNotes({
  firstIndex: Number(arg("first-index", "1")),
  decoys: DECOYS,
  denomination: DENOMINATION,
  changeAmount: CHANGE,
});

const CHANNEL = arg("channel", "0x1");
const actions = assembleDecoySet({
  channelKey: CHANNEL,
  token: STRK_TOKEN,
  spendIndex: Number(arg("spend-index", "0")),
  notes,
  // The emitter creates its own cover, so the recipient is the emitter. That is
  // an architecture requirement, not a detail: see docs/RUNBOOK-emitter.md on
  // why the decoy account is never a client's.
  recipient: arg("recipient", CHANNEL),
  recipientKey: arg("recipient-key", "0x2"),
  salts: notes.map((_, i) => BigInt(i + 2)),
});

const check = checkSet(actions);
if (!check.ok) die(`the set is not submittable:\n  ${check.violations.join("\n  ")}`);

// The ABI, from a public RPC. Read-only, no key, discloses nothing.
const abiRes = await fetch(RPC, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "starknet_getClassAt",
    params: ["latest", POOL],
  }),
});
const abiBody = await abiRes.json();
if (abiBody.error) die(`could not read the pool ABI: ${abiBody.error.message}`);
const rawAbi = abiBody.result?.abi;
if (!rawAbi) die(`the pool at ${POOL} answered with no ABI`);
const abi = typeof rawAbi === "string" ? JSON.parse(rawAbi) : rawAbi;

const encoded = encodeSet(abi, actions);
const calldata = compileCalldata(abi, {
  userAddr: arg("address", "0x0"),
  viewingKey: "0x0",
  actions,
});

// The pool's fee is whole STRK — the one figure in the protocol that is whole by
// nature rather than by convention — so it is NOT run through `baseToStrk`.
const fee = FEE_PER_CALL[NETWORK] ?? FEE_PER_CALL.sepolia;
const phases = phasesOf(actions);

if (flag("json")) {
  console.log(
    JSON.stringify(
      {
        network: NETWORK,
        pool: POOL,
        token: STRK_TOKEN,
        ladder: DENOMINATIONS.map(String),
        rung: RUNG.toString(),
        phases,
        actions: actions.map((a) => ({
          variant: a.variant,
          ...Object.fromEntries(
            Object.entries(a.value ?? {}).map(([k, v]) => [
              k,
              typeof v === "bigint" ? v.toString() : String(v),
            ]),
          ),
        })),
        encodedFelts: encoded.length,
        compileCalldataFelts: calldata.length,
        feePerCallStrk: fee.toString(),
        calls: 1,
        totalFeeStrk: fee.toString(),
        screening: null,
        note: "one call per decoy, deliberately — see costEstimate in src/cover.mjs",
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const line = (label, value) => console.log(`  ${String(label).padEnd(24)} ${value}`);

console.log(`\nruido — emitter dry run (${NETWORK})\n`);
console.log("The set");
line("pool", POOL);
line("token", STRK_TOKEN);
line("rung", `${RUNG} STRK   (the ladder is ${DENOMINATIONS.join(", ")})`);
line("actions", actions.length);
for (const [i, action] of actions.entries()) {
  const index = action.value?.index !== undefined ? `  index ${action.value.index}` : "";
  const amount =
    action.value?.amount !== undefined ? `  amount ${baseToStrk(action.value.amount)} STRK` : "";
  console.log(`    ${i}  ${action.variant.padEnd(15)} phase ${phases[i]}${index}${amount}`);
}
console.log();
console.log("The rules");
line(
  "phase never drops",
  phases.every((p, i) => i === 0 || p >= phases[i - 1]) ? "ok" : "NO",
);
line("at most one invoke", phases.filter((p) => p === 7).length <= 1 ? "ok" : "NO");
line(
  "a WriteOnce producer",
  actions.some((a) => WRITE_ONCE_PRODUCERS.has(a.variant)) ? "ok  (UseNote)" : "NO",
);
line("screening", "None — no deposit, no invoke, so no subject and no attestation");
console.log();
console.log("The cost");
line("pool fee, per call", `${fee} STRK`);
line("calls", "1   one per decoy, deliberately");
line("total", `${fee} STRK`);
console.log();
console.log("The wire");
line("encoded felts", `${encoded.length}   (1 span length + 4 UseNote + ${notes.length} x 7 CreateEncNote)`);
line("compile calldata", `${calldata.length} felts`);
console.log();
console.log("Not sent. Nothing was signed, and no key was used.");
console.log("Run `npm run check:decoy` to confirm the deployed pool reads this format.\n");

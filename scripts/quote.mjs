#!/usr/bin/env node
// Ruido's customer-facing entry point: turn "I want N bits of anonymity" into an
// order a provider can act on and a reveal the buyer keeps.
//
// This runs entirely offline. No node, no RPC, no key, no wallet — which is the
// whole point of the customer path: everything below it is the emitter's
// problem, and the emitter is not what a buyer touches.
//
//   node scripts/quote.mjs --cell 1.93 --bits 3 --mode window --from 14865231
//
// The output has three parts on purpose, and confusing them is the failure mode:
//
//   ORDER   public. Goes to the provider, who needs the window to emit in time.
//   REVEAL  secret. Kept until the window closes, then published. It is the only
//           thing that proves which cell the buyer committed to.
//
// Publishing the reveal early hands the provider the denomination before it
// emits, which is exactly what the split commitment exists to prevent.

import { buildOrder, serialiseOrder, serialiseReveal } from "../src/order.mjs";
import { quote } from "../src/quote.mjs";
import { mulberry32, randomInt } from "../src/rng.mjs";
import { DENOMINATIONS, FEE_PER_CALL } from "../src/cover.mjs";

const args = new Map(
  process.argv.slice(2).reduce((acc, value, index, all) => {
    if (value.startsWith("--")) acc.push([value.slice(2), all[index + 1]]);
    return acc;
  }, []),
);

const die = (message) => {
  console.error(`quote: ${message}`);
  process.exit(1);
};

const MODES = ["aimed", "window", "blind"];
const mode = args.get("mode") ?? "window";
if (!MODES.includes(mode)) die(`--mode must be one of ${MODES.join(", ")}, got ${mode}`);

const network = args.get("network") ?? "sepolia";
const bits = Number(args.get("bits") ?? 3);
const ladder = DENOMINATIONS.length;
const width = Number(args.get("width") ?? 21);
const blockSpan = Number(args.get("span") ?? 5000);

// `--cell` is required rather than defaulted. The cell size is a measurement of a
// specific pool at a specific time, and hardcoding one here would be the exact
// hand-copied number this project exists to catch. `npm run measure` prints it as
// "cell before any cover".
if (!args.has("cell")) {
  die("--cell is required (your current candidate-set size).\n"
    + "       Run `npm run measure` and read the line `cell before any cover`.");
}
const targetCell = Number(args.get("cell"));

const from = Number(args.get("from") ?? 0);
if (!Number.isInteger(from) || from <= 0) {
  die("--from must be the first block of the window you will transact in");
}
const to = from + width - 1;

const seed = Number(args.get("seed") ?? 20260912);
const next = mulberry32(seed);

// Which rung is the buyer's is fixed by their own deposit leg, not chosen here.
// In production it is read off that deposit; as a stand-in it is drawn from the
// same seeded stream so the whole order stays reproducible from `--seed`.
const denomination = args.has("denomination")
  ? BigInt(args.get("denomination"))
  : DENOMINATIONS[randomInt(next, 0, ladder)];
if (!DENOMINATIONS.includes(denomination)) {
  die(`--denomination must be one of ${DENOMINATIONS.join(", ")}, got ${denomination}`);
}

const q = quote({ targetCell, bits, mode, network, ladder, windowWidth: width, blockSpan });
const { order, reveal } = buildOrder({
  network, from, to, denomination, decoys: q.decoys, bits, next,
});

const fee = FEE_PER_CALL[network] ?? FEE_PER_CALL.sepolia;
const pad = (label, value) => console.log(`  ${label.padEnd(22)}${value}`);

console.log(`RUIDO · order quote   ${network} · ${mode}`);
console.log("");
pad("cell before cover", `${targetCell} candidates`);
pad("bits requested", q.bitsRequested);
pad("decoys required", q.decoys);
pad("landing rate", `1 in ${Math.round(1 / q.landingRate)}`);
pad("pool fee", `${q.cost} STRK  (${q.decoys} calls x ${fee})`);
pad("bits delivered", `${q.bitsDelivered}  (rounding is in your favour)`);

console.log("\nORDER · send this to the provider");
console.log(JSON.stringify(serialiseOrder(order), null, 2));

console.log("\nWINDOW · the provider must know this to emit in time");
console.log(`  blocks ${from}..${to}  (${width} blocks around your transaction)`);
console.log("  Given away by construction: cover that lands after the spend protects nobody.");

console.log("\nREVEAL · KEEP THIS. Do not send it before the window closes.");
console.log(JSON.stringify(serialiseReveal(reveal), null, 2));
console.log("  After the window closes, publish it. Anyone can then recompute both halves");
console.log("  against the commitments above and count the decoys that landed in your cell.");

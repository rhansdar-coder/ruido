#!/usr/bin/env node
// The buyer's client: connect to a provider and acquire cover.
//
//   npm run buy -- --provider http://127.0.0.1:8081 \
//                  --cell 1.93 --bits 3 --mode window \
//                  --from 14865231 --denomination 10
//
//   npm run buy -- --provider ... --tx 0xabc123   # also record the payment
//
//   npm run buy -- --provider ... --out orders/mi-orden.json
//
// `--out` writes the order and the reveal to a file, which is what the fourth
// step (`npm run reveal`) reads. Without it the reveal is only printed, and a
// terminal is not a place to keep the one secret the trade depends on: losing
// it means the order can never be settled.
//
// scripts/quote.mjs prices an order locally and prints it; this one sends it
// somewhere and comes back with an invoice. That difference is the whole point:
// a quote with no counterparty is a calculator.
//
// ## What leaves this process, and what does not
//
// The provider is sent the public order and the WINDOW proof. It is NOT sent the
// denomination or its salt. The CLI prints the exact bytes it posted, under
// `SENT`, precisely so that this can be checked instead of believed — the
// failure mode being guarded against is a client that "helpfully" sends the
// whole reveal so the provider can verify the order, and hands over the rung in
// the process.
//
// The full reveal is printed at the end and is the buyer's to keep until the
// window closes. Losing it means the order cannot be settled; publishing it
// early means the provider learns the rung before it emits.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { buildOrder, serialiseOrder, serialiseWindowProof, serialiseReveal } from "../src/order.mjs";
import { quote } from "../src/quote.mjs";
import { DENOMINATIONS } from "../src/cover.mjs";
import { baseToStrk } from "../src/pool.mjs";
import { mulberry32 } from "../src/rng.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

/**
 * The provider's bearer token, if it has one.
 *
 * A reference provider on loopback does not; a provider on a host does, and the
 * client has to be able to reach it. `fetch` is wrapped rather than a header
 * threaded through each call site, so that a call added later cannot forget the
 * token and fail in a way that looks like the provider being broken.
 *
 * The token is never written into the order file. That file is what step four
 * reads, and a secret in it would be a secret on disk.
 */
const TOKEN = arg("token", process.env.RUIDO_PROVIDER_TOKEN ?? null);
const call = (url, options = {}) =>
  fetch(url, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
  });

const PROVIDER = (arg("provider", process.env.RUIDO_PROVIDER ?? "http://127.0.0.1:8081")).replace(/\/+$/, "");
const CELL = arg("cell", null);
const BITS = Number(arg("bits", "3"));
const MODE = arg("mode", "window");
const NETWORK = arg("network", "sepolia");
const FROM = arg("from", null);
const WIDTH = Number(arg("width", "20"));
const DENOMINATION = arg("denomination", null);
const TX = arg("tx", null);
const SEED = Number(arg("seed", "1"));
const OUT = arg("out", null);

function die(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

if (CELL === null) {
  die(
    "an order needs the cell it is buying cover for: --cell <candidates>\n" +
      "  Run `npm run measure` and read the \"cell before any cover\" line.\n" +
      "  There is no default: a hardcoded cell would be the hand-copied number\n" +
      "  this project exists to catch.",
  );
}
if (FROM === null) {
  die(
    "an order needs the block the spend is planned for: --from <block>\n" +
      "  Cover that lands after the spend protects nobody, so the window has to\n" +
      "  contain the spend. The window is --from .. --from + --width.",
  );
}
if (DENOMINATION === null) {
  die(
    "an order needs the rung it is hiding: --denomination <one of " +
      DENOMINATIONS.map(String).join(", ") + ">\n" +
      "  This is the buyer's own amount. Guessing it would hide the wrong rung.",
  );
}
if (!DENOMINATIONS.includes(BigInt(DENOMINATION))) {
  die(`--denomination ${DENOMINATION} is not a rung of this ladder: ${DENOMINATIONS.map(String).join(", ")}`);
}

const from = Number(FROM);
const to = from + WIDTH;

// 1. Ask the provider what it is offering, before building anything. A quote
//    built against assumed terms is a quote against the wrong ladder.
let terms;
try {
  const response = await call(`${PROVIDER}/terms`);
  if (!response.ok) die(`${PROVIDER}/terms answered ${response.status}`);
  ({ terms } = await response.json());
} catch (error) {
  die(`could not reach a provider at ${PROVIDER}: ${error.message}\n  Start one with \`npm run serve:provider\`.`);
}

// 2. Price the order locally, against the ladder the provider actually runs.
//    The buyer's own measurement is the input; the provider cannot check it and
//    does not price it (it sells decoys, not bits).
const priced = quote({
  targetCell: Number(CELL),
  bits: BITS,
  mode: MODE,
  network: terms.network,
  ladder: terms.ladder,
});

// 3. Commit.
const next = mulberry32(SEED);
const { order, reveal } = buildOrder({
  network: terms.network,
  from,
  to,
  denomination: BigInt(DENOMINATION),
  decoys: priced.decoys,
  bits: BITS,
  next,
});

// 4. Send the order and the WINDOW half. Never the reveal.
const orderOnWire = serialiseOrder(order);
const proofOnWire = serialiseWindowProof(reveal);

let reply;
try {
  const response = await call(`${PROVIDER}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ order: orderOnWire, windowProof: proofOnWire }),
  });
  reply = await response.json();
  if (!response.ok) {
    console.error(`\n  refused (${response.status}): ${reply.reason ?? reply.error}\n`);
    process.exit(1);
  }
} catch (error) {
  die(`the order could not be delivered: ${error.message}`);
}

const line = (label, value) => console.log(`  ${String(label).padEnd(16)} ${value}`);
const rule = (title) => console.log(`\n\x1b[1m${title}\x1b[0m`);
const indent = (value) =>
  JSON.stringify(value, null, 2)
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");

// The payment is recorded before anything is printed, so that `--json` can emit
// one object and nothing else. A "machine-readable" mode that also prints prose
// is not machine-readable, and a client that shells out to this would have to
// strip the human report before parsing — which is how the two drift apart.
let payment = null;
if (TX) {
  const response = await call(`${PROVIDER}/orders/${order.id}/payment`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Only the hash. The buyer's own block number is not evidence of anything —
    // the provider reads the block from the receipt, and a client that asserted
    // one would be the party that benefits from an early credit asserting it.
    body: JSON.stringify({ txHash: TX }),
  });
  payment = await response.json();
  if (!response.ok) {
    // Which class of refusal, what happened, and what to do about it — in that
    // order, and all three printed. `not-yet` is worth retrying and `wrong` is
    // not, so the verdict is named rather than folded into prose; and a refusal
    // that carries a remedy (the 503 for a provider with no address) must not
    // have its reason thrown away in favour of a generic sentence.
    const parts = [payment.verdict, payment.error, payment.reason].filter(Boolean);
    die(`the payment was refused (${response.status}): ${parts.join(" — ")}`);
  }
}

const revealOnWire = serialiseReveal(reveal);

// Persist what the fourth step needs, before anything is printed — so a run
// that is piped into `head` or interrupted still leaves a usable order file.
//
// No timestamp is written. The whole order is reproducible from `--seed`, and a
// field that is not would be the first thing in this file a reader could not
// re-derive; the window's own block numbers already say when it applies.
if (OUT) {
  const record = {
    order: orderOnWire,
    reveal: revealOnWire,
    provider: PROVIDER,
    terms: {
      network: terms.network,
      ladder: terms.ladder,
      feePerCall: terms.feePerCall.toString(),
      margin: terms.margin.toString(),
    },
    // The invoice as issued, and the payment as recorded — two different facts.
    // Writing only the first meant the order file described an unpaid order even
    // after it had been paid, so the fourth step could not tell from the file
    // whether there was anything to settle. It is the buyer's own record, so it
    // has to carry what the buyer actually did, not what was quoted to them.
    invoice: reply.invoice,
    payment: payment ?? null,
    priced: {
      mode: MODE,
      targetCell: priced.targetCell,
      decoys: priced.decoys,
      bitsRequested: priced.bitsRequested,
      bitsDelivered: priced.bitsDelivered,
      landingRate: priced.landingRate,
    },
  };
  const dir = dirname(OUT);
  if (dir && dir !== ".") await mkdir(dir, { recursive: true });
  await writeFile(OUT, `${JSON.stringify(record, null, 2)}\n`);
}

if (flag("json")) {
  console.log(JSON.stringify({ provider: terms, order: orderOnWire, windowProof: proofOnWire, invoice: reply.invoice, payment, reveal: revealOnWire }, null, 2));
  process.exit(0);
}

console.log(`\nruido — order sent to ${PROVIDER}`);

rule("PROVIDER");
line("network", terms.network);
line("ladder", `${terms.ladder} rungs`);
line("fee per call", `${terms.feePerCall} STRK`);
line("margin", `${baseToStrk(terms.margin)} STRK per decoy`);

rule("ORDER  (public)");
line("id", order.id);
line("window", `${order.window.from}..${order.window.to}  (${order.window.to - order.window.from + 1} blocks)`);
line("decoys", `${order.decoys}  (${MODE}, cell ${priced.targetCell})`);
line("bits", `${order.bits} requested, ${priced.bitsDelivered} delivered`);
line("window commit", order.windowCommitment);
line("denom commit", order.denominationCommitment);

// The point of printing this: the buyer can see that the denomination is absent
// from what left the machine, rather than trusting that it is.
rule("SENT  (exactly what the provider received)");
console.log(indent({ order: orderOnWire, windowProof: proofOnWire }));
line("denomination", "NOT SENT — kept until the window closes");

rule("INVOICE");
line("invoice id", reply.invoice.id);
line("amount", `${baseToStrk(reply.invoice.amount)} STRK`);
line("for", `${reply.invoice.decoys} decoys at ${reply.invoice.feePerCall} STRK/call`);
line("state", reply.duplicate ? "already invoiced — this order id was seen before" : "accepted");
line("pay", `POST ${PROVIDER}/orders/${order.id}/payment  { "txHash": "0x…" }`);

if (payment) {
  rule("PAYMENT RECORDED");
  line("tx", payment.paid?.txHash ?? TX);
  if (payment.summary) {
    line("plan", `${payment.summary.decoys} decoys over blocks ${payment.summary.from}..${payment.summary.to}`);
    line("rungs used", `${payment.summary.rungsUsed} of ${payment.summary.ladder}`);
  }
  if (payment.emission) line("emission", payment.emission);
}

rule("KEEP SECRET  (publish only after the window closes)");
console.log(indent(revealOnWire));
console.log(
  "\n  This is what settlement runs on. Publishing it early tells the provider\n" +
    "  which rung was the buyer's before it emits; losing it means the order can\n" +
    "  never be settled.\n",
);

if (OUT) {
  console.log(`  Written to ${OUT} — publish it with:\n`);
  console.log(`    npm run reveal -- --order ${OUT}\n`);
}

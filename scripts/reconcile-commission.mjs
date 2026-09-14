// What Ruido is owed, and what actually arrived.
//
// The commission is a second transfer on the same rail, forwarded by the
// provider (docs/ORDER.md §"The commission"). Nothing can make a provider
// forward — that is the honest limit of the arrangement — but a forwarding is a
// transfer on a public rail, so a forwarding that never happened is a fact
// somebody can read. This is the reading.
//
// Two inputs, and no third:
//
//   the orders     what each order's second leg was for, in the shape
//                  `reconcile()` already takes
//   the transfers  what arrived at Ruido's address, read from the chain
//
// The first is a FILE rather than something this script derives, and that is the
// seam worth naming out loud: Ruido learns which orders exist from the public
// reveal — step 6 publishes the order id — and nothing in this repository indexes
// reveals. So the expected list has to be handed over. Deriving it would mean
// inventing a registry that does not exist, and a tool that quietly reconciles
// against an empty list reports every provider as having paid nothing.
//
//   npm run reconcile:commission -- \
//     --address 0x… --orders orders.json --from-block 14865231 --to-block 14900000

import { readFile } from "node:fs/promises";

import { reconcile } from "../src/commission.mjs";
import { transfersTo } from "../src/payment.mjs";
import { endpointsFor } from "../src/blockheight.mjs";
import { baseToStrk } from "../src/pool.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

const ADDRESS = arg("address");
const ORDERS_PATH = arg("orders");
const FROM = Number(arg("from-block"));
const TO = Number(arg("to-block"));
const NETWORK = arg("network", "sepolia");
const RPC = arg("rpc");

const die = (message) => {
  console.error(`\n  ${message}\n`);
  process.exit(1);
};

if (!ADDRESS) {
  die(
    "--address is the address the fees are forwarded to, and there is no default: " +
      "this repository publishes no receiving address, so the operator supplies one.",
  );
}
if (!ORDERS_PATH) {
  die(
    "--orders is the list of second legs that should have been forwarded, as JSON: " +
      '`[{ "orderId": "0x…", "amountDue": "…" }]`. It is required rather than defaulted, ' +
      "because reconciling against an empty list reports every provider as having paid nothing.",
  );
}
if (!Number.isInteger(FROM) || !Number.isInteger(TO)) {
  die(`--from-block and --to-block are required, and there is no default range: got ${FROM}..${TO}`);
}
if (FROM > TO) die(`the range is empty: ${FROM}..${TO}`);

let expected;
try {
  expected = JSON.parse(await readFile(ORDERS_PATH, "utf8"));
} catch (error) {
  die(`could not read --orders ${ORDERS_PATH}: ${error.message}`);
}
if (!Array.isArray(expected)) die(`--orders must be a JSON array, got ${typeof expected}`);
if (expected.length === 0) {
  die(
    `--orders ${ORDERS_PATH} is an empty list. Reconciling against nothing would report every ` +
      "provider as having paid nothing, which is a conclusion this tool must not be able to reach by accident.",
  );
}
for (const [i, row] of expected.entries()) {
  if (!row?.orderId || row.amountDue === undefined) {
    die(`--orders row ${i} needs both \`orderId\` and \`amountDue\`, got ${JSON.stringify(row)}`);
  }
}

const endpoints = RPC ? [RPC] : endpointsFor(NETWORK);
if (endpoints.length === 0) die(`no endpoints are known for ${NETWORK}; pass --rpc <url>`);

console.log(`\nreading ${endpoints.length} endpoint${endpoints.length === 1 ? "" : "s"} for transfers of`);
console.log(`  the STRK token  →  ${ADDRESS}`);
console.log(`  blocks          ${FROM}..${TO}`);
console.log(`  against         ${expected.length} second leg${expected.length === 1 ? "" : "s"} from ${ORDERS_PATH}\n`);

const read = await transfersTo(ADDRESS, {
  network: NETWORK,
  fromBlock: FROM,
  toBlock: TO,
  endpoints,
  onFailure: (reason) => console.error(`  endpoint failed: ${reason}`),
});

if (read === undefined) {
  // Nobody could say. NOT "nothing arrived" — that is the whole distinction this
  // tool exists to keep, and the same one `verifyPayment` keeps for a payment.
  console.error("  no endpoint could be read, so nothing can be concluded about any order.\n");
  process.exit(1);
}

const { transfers, scanned, pages } = read;
console.log(`scanned ${scanned} event${scanned === 1 ? "" : "s"} over ${pages} page${pages === 1 ? "" : "s"}`);
console.log(`found   ${transfers.length} transfer${transfers.length === 1 ? "" : "s"} to that address\n`);

// The guard that keeps "nobody forwarded" apart from "nobody looked". A range
// that scanned nothing is a wrong range or a wrong endpoint, and reporting a
// list of defaulters from it would be the worst thing this tool could do.
if (scanned === 0) {
  console.error(
    "  the range contained no events at all, so this is a range or an endpoint problem and NOT\n" +
      "  evidence that anyone withheld a fee. Widen the range or check --network / --rpc.\n",
  );
  process.exit(1);
}

const verdict = reconcile({ expected, transfers });

const show = (label, rows, detail) => {
  console.log(`${label}  ${rows.length}`);
  for (const row of rows) console.log(`   ${detail(row)}`);
};

console.log("--- forwarded ------------------------------------------------------------");
show("  ", verdict.forwarded, (r) => `${r.orderId}  ${baseToStrk(r.amountDue)} STRK  ${r.transfer.txHash ?? "(no hash)"}`);

console.log("\n--- short: the tag was dropped -------------------------------------------");
show("  ", verdict.short, (r) => `${r.orderId}  short by ${r.shortBy} base units  ${r.transfer.txHash ?? "(no hash)"}`);

console.log("\n--- missing: nothing arrived ---------------------------------------------");
show("  ", verdict.missing, (r) => `${r.orderId}  owed ${baseToStrk(r.amountDue)} STRK`);

console.log("\n--- unmatched: arrived, fits no order ------------------------------------");
show("  ", verdict.unmatched, (r) => `${r.value} base units  ${r.txHash ?? "(no hash)"}`);

// The remedy is delisting, so the finding has to be actionable rather than a
// number: an order with nothing against it is the one that goes in the report.
const owed = verdict.missing.reduce((sum, r) => sum + BigInt(r.amountDue), 0n);
console.log(
  `\n${verdict.missing.length} order${verdict.missing.length === 1 ? "" : "s"} with no forwarding, ` +
    `${baseToStrk(owed)} STRK unforwarded.`,
);
console.log(
  "A missing forwarding is a publishable finding and delisting is the remedy — retroactive, not\n" +
    "preventive. Nothing here proves intent: an unreadable timestamp or a mis-sent transfer lands in\n" +
    "the same bucket, which is why `short` and `unmatched` are printed rather than folded in.\n",
);

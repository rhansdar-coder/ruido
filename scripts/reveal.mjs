#!/usr/bin/env node
// The buyer's fourth step: publish the reveal, after the window closes.
//
//   npm run reveal -- --order orders/mi-orden.json
//   npm run reveal -- --order orders/mi-orden.json --provider http://127.0.0.1:8081
//   npm run reveal -- --order orders/mi-orden.json --at 14865300   # offline check
//
// The cell the order was priced against is read back out of the order file, so
// the number settlement uses is the number the quote was built from rather than
// one retyped at the end. `--cell` overrides it, and the override is printed.
//
// ## What this refuses to do, and why that is the point
//
// It will not publish a reveal while the window is still open. The provider was
// given the window and never the denomination, and that split is the whole
// design; handing over the rung before the provider emits lets it aim the cover
// straight at the buyer's cell — or simply keep the fee and emit nothing. The
// check is against the chain's height, not against the buyer's confidence, and
// it lives in `src/reveal.mjs` rather than here so a CLI cannot be the only
// thing standing between a buyer and that mistake.
//
// It also **fails closed**: if the current block cannot be established, this
// exits non-zero instead of assuming the window has passed. A missing RPC is a
// refusal, because the alternative is silent and irreversible.
//
// ## What it does not do
//
// It does not count decoys. Settlement counts emissions that LANDED, and a note
// id only exists once one does — the emitter is what puts them on chain, and it
// is not built. So the provider settles against what it has observed, which
// today is nothing, and says so out loud instead of counting its own plan as if
// the work were done.

import { readFile } from "node:fs/promises";

import { parseReveal, serialiseReveal } from "../src/order.mjs";
import { checkReveal, blocksUntilReveal } from "../src/reveal.mjs";
import { readBlockHeight } from "../src/blockheight.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const ORDER_FILE = arg("order", null);
const PROVIDER = arg("provider", null)?.replace(/\/+$/, "") ?? null;
const AT = arg("at", null);
const CELL = arg("cell", null);

function die(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

const line = (label, value) => console.log(`  ${String(label).padEnd(20)} ${value}`);
const rule = (title) => console.log(`\n\x1b[1m${title}\x1b[0m`);

if (!ORDER_FILE) {
  die(
    "revealing needs the order it belongs to: --order <file>\n" +
      "  `npm run buy -- --out <file>` writes it, and it holds the reveal.\n" +
      "  There is no way to reconstruct it from the provider's side: the\n" +
      "  denomination half was never sent there, which is the point.",
  );
}

let record;
try {
  record = JSON.parse(await readFile(ORDER_FILE, "utf8"));
} catch (error) {
  die(`could not read ${ORDER_FILE}: ${error.message}`);
}

const order = record.order;
const reveal = parseReveal(record.reveal);
const network = record.terms?.network ?? order.network;

/**
 * The cell the order was priced against.
 *
 * It comes out of the order file rather than from a flag, because settlement
 * turns a decoy count into bits with it: a retyped number would quietly reprice
 * the order at the last step, and `order.bits` would stop being the claim that
 * was quoted. `--cell` exists for an order file written before the field did,
 * and when it is used the run says so.
 */
const cell = CELL !== null ? Number(CELL) : (record.priced?.targetCell ?? null);
const cellSource = CELL !== null ? "--cell" : "order file";
if (!(cell > 0)) {
  die(
    `this order file does not carry the cell it was priced against.\n` +
      "  Pass it explicitly with --cell <candidates>; `npm run buy` records it\n" +
      "  under `priced.targetCell` in files written from now on.",
  );
}

/**
 * The chain's height, or `undefined` if it cannot be established.
 *
 * Undefined is a legitimate answer here and is handled as a refusal by
 * `checkReveal`; swallowing the error and returning 0 would turn an unreachable
 * RPC into "the window closed long ago". The read itself lives in
 * `src/blockheight.mjs`, shared with the provider, because the list of public
 * endpoints was previously copied into three scripts.
 */
const atBlock = AT !== null
  ? Number(AT)
  : await readBlockHeight({
      network,
      onFailure: ({ endpoints, error }) =>
        console.error(
          `\n  could not read the chain height from ${endpoints.length} endpoint(s): ${error?.message ?? `no endpoints configured for ${network}`}`,
        ),
    });
if (AT !== null && !Number.isInteger(atBlock)) die(`--at must be a block number, got ${AT}`);

const check = checkReveal(order, reveal, { network, atBlock });

/**
 * The machine-readable form of this run, filled in as the run proceeds and
 * emitted exactly once.
 *
 * `reveal` is deliberately absent until the check passes. A `--json` mode that
 * printed the reveal on a refusal would hand over the rung through the very
 * flag someone would reach for to script this — the gate has to hold in the
 * machine path too, not only in the one a human reads.
 */
const report = {
  order: order.id,
  network,
  window: order.window,
  cell,
  atBlock: Number.isInteger(atBlock) ? atBlock : null,
  verdict: check.verdict,
  publishable: check.publishable,
  reason: check.reason,
  waitBlocks: check.waitBlocks,
  reveal: null,
  provider: PROVIDER,
  settlement: null,
};

/** One object and nothing else on stdout, or the human report. */
function emit(status) {
  if (flag("json")) console.log(JSON.stringify(report, null, 2));
  process.exit(status);
}

if (!flag("json")) {
  console.log(`\nruido — revealing order ${order.id}`);

  rule("ORDER");
  line("id", order.id);
  line("window", `${order.window.from}..${order.window.to}  (${order.window.to - order.window.from + 1} blocks)`);
  line("decoys bought", order.decoys);
  line("bits asked for", order.bits);
  line("cell", `${cell}  (from the ${cellSource})`);

  rule("REVEAL  (the half the provider never saw)");
  line("denomination", reveal.denomination.toString());
  line("window salt", `0x${BigInt(reveal.windowSalt).toString(16).slice(0, 16)}…`);
  line("denom salt", `0x${BigInt(reveal.denominationSalt).toString(16).slice(0, 16)}…`);

  rule("CHECK");
  line("window commitment", check.verdict.windowOk ? "opens" : "DOES NOT OPEN");
  line("denom commitment", check.verdict.denominationOk ? "opens" : "DOES NOT OPEN");
  line("order id", check.verdict.idOk ? "derived" : "NOT DERIVED");
  line("block now", Number.isInteger(atBlock) ? atBlock : "unknown");
}

if (!check.publishable) {
  // Always on stderr, so that `--json` leaves stdout parseable while the reason
  // still reaches whoever is watching the run.
  console.error(`\n  REFUSING TO PUBLISH: ${check.reason}`);
  if (check.waitBlocks !== null && check.waitBlocks > 0) {
    console.error(
      `\n  ${check.waitBlocks} more block${check.waitBlocks === 1 ? "" : "s"} have to pass.\n` +
        "  Publishing now would hand the provider the rung before it emits, and the\n" +
        "  split commitment is the only reason it does not already have it.\n",
    );
  } else {
    console.error("");
  }
  emit(1);
}

const revealOnWire = serialiseReveal(reveal);
report.reveal = revealOnWire;

if (!PROVIDER) {
  if (!flag("json")) {
    rule("NOT PUBLISHED  (no --provider given)");
    console.log(JSON.stringify(revealOnWire, null, 2));
    console.log(
      "\n  The reveal is valid and the window is closed. Send it to the provider\n" +
        `  with \`--provider <url>\` to settle the order.\n`,
    );
  }
  emit(0);
}

let settlement;
try {
  const response = await fetch(`${PROVIDER}/orders/${order.id}/reveal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // The height goes with the reveal rather than being left to the provider to
    // look up: this client already established it to make its own decision, and
    // sending a different one than it checked would mean the local gate and the
    // remote one were answering about two different chains. The cell goes too,
    // because settlement turns a decoy count into bits with it.
    body: JSON.stringify({ reveal: revealOnWire, atBlock, cell }),
  });
  settlement = await response.json();
  if (!response.ok) {
    // Both lines when both are present: `error` names what happened and `reason`
    // explains why, and a refusal needs the pair. A provider that could not read
    // the chain says that in one field and says it will not fall back in the
    // other, so printing only the second loses the cause.
    const detail = [settlement.error, settlement.reason].filter(Boolean).join(" — ");
    die(`the reveal was refused (${response.status}): ${detail}`);
  }
} catch (error) {
  die(`the reveal could not be delivered to ${PROVIDER}: ${error.message}`);
}

report.settlement = settlement;

if (!flag("json")) {
  rule("SETTLEMENT");
  if (settlement.settlement) {
    const s = settlement.settlement;
    line("decoys in the plan", settlement.planned ?? "—");
    line("decoys observed", s.emitted);
    line("in the revealed cell", s.inCell.length);
    line("bits delivered", `${s.bits}  (asked for ${order.bits})`);
    line("shortfall", s.shortfall === null ? "—" : s.shortfall);
    if (s.rejected?.length) line("already claimed", `${s.rejected.length} decoy(s) by another order`);
    if (settlement.heightSource) line("height", `${settlement.atBlock} (from the ${settlement.heightSource})`);
  }

  if (settlement.duplicate) line("state", "already settled — this reveal was sent before, and the verdict is unchanged");
  if (settlement.heightNote) line("note", settlement.heightNote);
  if (settlement.emission) line("emission", settlement.emission);

  console.log(
    "\n  What just happened, precisely: the buyer's half of the trade is closed.\n" +
      "  The reveal opens both commitments in public, so the cell is now checkable\n" +
      "  by anyone. The other half — counting the decoys that landed in it — has\n" +
      "  nothing to count, because nothing has been emitted.\n",
  );
}

emit(0);

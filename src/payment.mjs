// The payment rail: prepaid in STRK, verified by reading the chain rather than
// by someone glancing at a transaction hash.
//
// ## Why the rail is thin, on purpose
//
// TOKEN.md §5 says to run the market with **no token** — invoiced, or prepaid in
// STRK — and to discover the margin rather than assume one. So there is no
// escrow here, no custody and no refund path: a rail nobody has used is a rail
// nobody can size. What there IS is the part that has to be right before any of
// that matters: **a payment that has been checked**.
//
// `markPaid` used to take a `{ txHash, block }` and write it down. That is not a
// payment rail, it is a form. This module is what makes the difference: the only
// thing that can mark an invoice paid is the output of `verifyPayment`, and
// `verifyPayment` will not produce it without a receipt that says the transfer
// happened, to this provider, for this amount, once.
//
// ## The binding problem, which is the whole difficulty
//
// An ERC-20 transfer carries no memo. `transfer(to, amount)` says who and how
// much and nothing else, so nothing on chain says **which order** a transfer
// pays. Three ways to fix that, and two of them need something this project
// deliberately does not have:
//
//   a payment contract         needs a deployment, a fee, and a trust story
//   a per-order address        needs HD derivation and a wallet's worth of infra
//   a per-order unique amount  needs nothing
//
// So the invoice asks for an amount unique to the order and the provider matches
// on the exact value. The tag is a few base units — 10^-6 STRK at the default
// width — and it is derived from a HASH of the order id rather than from the id
// itself, so the amount paid does not disclose the order it pays.
//
// ## What a collision costs, and why that is the safe direction
//
// Two orders can be quoted the same amount with the same tag. Then one transfer
// satisfies both, and the first-claim registry gives it to whichever order asked
// first and REFUSES the second. The buyer who loses that race is told their
// payment is already spent, which is true — it is spent on the other order. The
// failure is a refusal, never a credit, and that is the direction to fail in.
//
// ## Why this fails CLOSED, and why "unreadable" is not "not yet"
//
// An unreachable RPC is a refusal, not "probably fine". The tempting default —
// treat an unreadable receipt as "not paid yet, retry later" — is a wait, and a
// wait is survivable. Treating it as PAID is not: the provider would plan, and
// eventually emit, cover it was never paid for. So four answers are kept apart,
// because they lead to four different actions:
//
//   unreadable     nobody can say        → refuse, and the operator looks at the RPC
//   not yet        RECEIVED, no block    → wait; the money may still land
//   wrong          reverted / not this provider / not this amount → refuse, do not wait
//   paid           accepted, matching, unclaimed → mark it paid
//
// Only one of those four is a wait, and collapsing them is how a rail that
// refuses correctly turns into one that credits hopefully.

import { DOMAIN, hashFelt } from "./commitment.mjs";
import { keccak256 } from "./keccak.mjs";
import { endpointsFor } from "./blockheight.mjs";
import { STRK_TOKEN, STRK_DECIMALS } from "./pool.mjs";

/**
 * The asset the rail settles in, and its scale — re-exported, not declared.
 *
 * These lived here, and the token address was a second copy of a fact that is
 * really about the POOL: the same address appears in `scripts/verify-compile.mjs`
 * and in both corpora, and two copies of an address are two things to update on a
 * redeployment. See `src/pool.mjs` for the evidence behind the value.
 *
 * They are re-exported rather than moved silently so that every existing import
 * of `STRK_TOKEN` from this module keeps working — the rail is where a reader
 * looks for them, and the module that owns the fact is one hop away.
 */
export { STRK_TOKEN, STRK_DECIMALS, UNIT } from "./pool.mjs";

/**
 * How wide the per-order tag is, in base units.
 *
 * This started at 10,000, and a test found out why that was too narrow: 200
 * order ids produced 199 distinct tags. That is the birthday bound doing its
 * arithmetic — at 10,000 the chance of a collision among 200 orders is about
 * 86%, so collisions would be the NORMAL case rather than the exception, and
 * every one of them is a legitimate buyer being told their payment "already paid
 * another order". A width that collides is a width that refuses honest money.
 *
 * 10^12 base units is 10^-6 STRK, which is economically nothing against a 2 STRK
 * pool fee, and it puts the collision chance among ten thousand concurrent orders
 * at about 0.005%. Collisions are still possible in principle and still resolve
 * by refusal rather than by miscrediting (see the header) — this makes them rare,
 * it does not make them impossible, and the difference is worth stating.
 */
export const TAG_MOD = 10n ** 12n;

/** `starknet_keccak("Transfer")`, computed rather than pasted. */
export const TRANSFER_SELECTOR = `0x${keccak256(Buffer.from("Transfer", "ascii")).toString("hex")}`;

/**
 * The amount an invoice bills, in the token's base units — the unit the chain
 * moves, and the unit the tag is denominated in.
 *
 * This used to be `wholeStrk`, which multiplied by `UNIT` and so required every
 * invoice to be a whole number of STRK. The requirement was invisible until it
 * met a margin: on a 2 STRK pool fee the only whole-STRK margins are 0, 1 and 2,
 * so a provider could charge 0%, 50% or 100% and nothing in between. Scaling
 * here instead lets the invoice say what the work actually costs.
 */
export function baseAmount(invoice) {
  if (invoice.amount === undefined || invoice.amount === null) {
    throw new Error("an invoice without an amount cannot be paid");
  }
  return BigInt(invoice.amount);
}

/**
 * The tag that makes an amount unique to one order.
 *
 * Derived from a hash of the order id, not the id itself: an amount is public
 * the moment it is paid, and `amount - tag` would otherwise hand over the order
 * it belongs to. In [1, mod], so the tag is never zero — a zero tag would make
 * two different orders with the same fee indistinguishable for free.
 */
export function paymentTag(orderId, { mod = TAG_MOD } = {}) {
  if (mod < 2n) throw new Error(`a tag needs somewhere to live, got mod ${mod}`);
  const mixed = BigInt(hashFelt(DOMAIN.payment, orderId));
  return 1n + (mixed % (mod - 1n));
}

/**
 * The exact amount the buyer must send, in the token's base units.
 *
 * The invoice's own amount is already in base units and already leaves the low
 * `TAG_MOD` digits free — `invoiceFor` refuses to make one that does not — so the
 * tag is added rather than packed in. The two figures differ only below 10^-6
 * STRK, which is the point: what the buyer pays discloses nothing about which
 * order it pays that the tag does not already hide.
 *
 * `tag` is injectable so that a collision can be constructed in a test rather
 * than waited for.
 */
export function amountDue(invoice, { orderId, tag = null, mod = TAG_MOD } = {}) {
  return baseAmount(invoice) + (tag ?? paymentTag(orderId, { mod }));
}

/**
 * The invoice as the buyer needs to see it: how much, in what, to whom, by when.
 *
 * Separate from the invoice because they answer different questions. The invoice
 * is what the provider bills; this is what the buyer's wallet has to be told, and
 * the amount here is the one with the tag in it — which is the only value that
 * will verify. Quoting `invoice.amount` to a buyer would produce a payment the
 * provider refuses.
 *
 * Both amounts are in base units and `decimals` says what a base unit is, because
 * a wallet needs that and the mistake this field pair invites is scaling one of
 * them and not the other.
 */
export function paymentRequest(invoice, { orderId, provider, expiresAt = null, mod = TAG_MOD } = {}) {
  if (!provider) throw new Error("a payment request needs a destination address");
  const tag = paymentTag(orderId, { mod });
  return {
    invoiceId: invoice.id,
    orderId,
    network: invoice.network,
    token: STRK_TOKEN,
    decimals: STRK_DECIMALS,
    provider,
    // Both figures, because they are both useful and confusing them is the
    // mistake: `amount` is what the invoice bills, `amountDue` is what to send.
    amount: baseAmount(invoice),
    tag,
    amountDue: amountDue(invoice, { orderId, tag }),
    expiresAt,
  };
}

/**
 * Decodes one `Transfer` event, or returns null if it is not one.
 *
 * Two things are checked rather than assumed:
 *
 *   1. **The event must come from the token contract.** An event with the right
 *      shape emitted by some other contract is not a transfer of this token, and
 *      a provider that matched on shape alone would credit payments it cannot
 *      spend.
 *   2. **The value is a `u256`, so its data is two felts, not one.** This is the
 *      same class of trap as the pool's felt widths: OZ's Cairo 1 ERC-20 emits
 *      `value.low, value.high`, and reading `data[0]` alone silently truncates
 *      any amount above 2^128. Legacy Cairo 0 tokens emitted a single felt, so
 *      both widths are accepted and the width is what decides.
 */
export function decodeTransfer(event, { token = STRK_TOKEN } = {}) {
  if (!event) return null;
  if (String(event.from_address ?? "").toLowerCase() !== token.toLowerCase()) return null;
  const keys = event.keys ?? [];
  const data = event.data ?? [];
  if (keys.length < 3) return null;
  if (BigInt(keys[0]) !== BigInt(TRANSFER_SELECTOR)) return null;

  let value;
  if (data.length >= 2) {
    value = BigInt(data[0]) + (BigInt(data[1]) << 128n);
  } else if (data.length === 1) {
    value = BigInt(data[0]);
  } else {
    return null;
  }

  return { token, from: keys[1], to: keys[2], value };
}

/** Every `Transfer` of `token` in a normalised receipt. */
export function transfersIn(receipt, { token = STRK_TOKEN } = {}) {
  return (receipt?.events ?? []).map((event) => decodeTransfer(event, { token })).filter(Boolean);
}

/**
 * Normalises a `starknet_getTransactionReceipt` response.
 *
 * Kept separate from the reading so the four verdicts can be tested against
 * fixtures rather than against a live chain — the same reason `admitReveal` is
 * not inside the route.
 */
export function normaliseReceipt(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    finality: raw.finality_status ?? null,
    execution: raw.execution_status ?? null,
    block: raw.block_number ?? null,
    events: Array.isArray(raw.events) ? raw.events : [],
    revertReason: raw.revert_reason ?? null,
  };
}

/** The statuses that mean "this is in a block and it is not coming back". */
export const SETTLED_FINALITY = new Set(["ACCEPTED_ON_L1", "ACCEPTED_ON_L2"]);

/**
 * Reads one receipt from the chain, rotating endpoints like `readBlockHeight`.
 *
 * Returns a normalised receipt, or `undefined` when nobody could say. A hash the
 * chain has never seen is NOT `undefined`: the RPC answers `TXN_HASH_NOT_FOUND`,
 * which is a definitive "no such transaction" and is normalised to `NOT_RECEIVED`
 * so a caller can tell "your hash is wrong" from "the RPC is down".
 */
export async function readReceipt({
  network,
  txHash,
  endpoints = endpointsFor(network),
  fetch: doFetch = fetch,
  timeoutMs = 15_000,
  onFailure = null,
} = {}) {
  let lastError = null;

  for (const endpoint of endpoints) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let text;
      try {
        const response = await doFetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "starknet_getTransactionReceipt",
            params: [txHash],
          }),
          signal: controller.signal,
        });
        text = await response.text();
      } finally {
        clearTimeout(timer);
      }

      // A proxy or captive portal answers HTML with a 200. Parsing it would throw
      // a syntax error that looks like a bug in this file rather than a network
      // that is lying, so it is caught here by shape, before JSON.parse.
      if (text.trim().startsWith("<")) {
        lastError = `endpoint answered HTML, not JSON: ${endpoint}`;
        continue;
      }

      let body;
      try {
        body = JSON.parse(text);
      } catch {
        lastError = `endpoint answered something that is not JSON: ${endpoint}`;
        continue;
      }

      if (body.error) {
        if (body.error.code === 29 || body.error.code === 25) {
          // TXN_HASH_NOT_FOUND. Definitive, and not a reason to try elsewhere.
          return { finality: "NOT_RECEIVED", execution: null, block: null, events: [], revertReason: null };
        }
        lastError = `endpoint refused: ${body.error.message ?? body.error.code}`;
        continue;
      }

      const normalised = normaliseReceipt(body.result);
      if (normalised) return normalised;
      lastError = `endpoint returned a receipt this reader does not understand: ${endpoint}`;
    } catch (error) {
      lastError = `${endpoint}: ${error.message}`;
    }
  }

  if (onFailure && lastError) onFailure(lastError);
  return undefined;
}

/**
 * The verdict on one payment.
 *
 * Every failure carries its own `status`, because they are not interchangeable:
 * `unreadable` and `not-yet` both mean "ask again later", but `wrong` means
 * asking again is pointless and the buyer needs to be told which of the three
 * ways their payment is wrong.
 */
export function verifyPayment({ invoice, request, receipt, consumed = new Map() }) {
  const refuse = (status, reason) => ({ ok: false, status, reason, payment: null });

  // No hash, no check. Refused rather than thrown, so that a caller cannot turn a
  // missing field into an unhandled exception on a payment route — and so that
  // the reason says which field was missing rather than "internal error".
  if (!request?.txHash) {
    return refuse("unreadable", "no transaction hash was given, so there is nothing to check");
  }

  // Nobody can say. Not a wait: an RPC that is down is an operator problem.
  if (!receipt) {
    return refuse(
      "unreadable",
      "the transaction could not be read from the chain, so the payment cannot be shown to have happened",
    );
  }

  if (receipt.finality === "NOT_RECEIVED") {
    return refuse("wrong", "the chain has never seen this transaction hash");
  }
  if (receipt.finality === "REJECTED") {
    return refuse("wrong", "the transaction was rejected");
  }
  if (receipt.execution === "REVERTED") {
    return refuse("wrong", `the transaction reverted${receipt.revertReason ? `: ${receipt.revertReason}` : ""}`);
  }
  // RECEIVED means it is in the sequencer and not yet in a block. The money may
  // still land, so this one IS a wait — and it is the only one.
  if (!SETTLED_FINALITY.has(receipt.finality)) {
    return refuse("not-yet", `the transaction is not in a block yet (finality ${receipt.finality ?? "unknown"})`);
  }

  const transfers = transfersIn(receipt, { token: request.token });
  if (transfers.length === 0) {
    return refuse("wrong", `the transaction carries no transfer of ${request.token}`);
  }

  const toProvider = transfers.filter((t) => String(t.to).toLowerCase() === String(request.provider).toLowerCase());
  if (toProvider.length === 0) {
    return refuse("wrong", "the transaction transfers no tokens to this provider");
  }

  const exact = toProvider.filter((t) => t.value === BigInt(request.amountDue));
  if (exact.length === 0) {
    // The amounts are named in the reason, because "wrong amount" is useless to a
    // buyer who needs to know whether they sent too little or the tag was lost.
    const seen = toProvider.map((t) => t.value.toString()).join(", ");
    return refuse(
      "wrong",
      `the amount is not the one this order was quoted: expected ${request.amountDue}, found ${seen}`,
    );
  }

  const owner = consumed.get(String(request.txHash ?? "").toLowerCase());
  if (owner !== undefined && owner !== request.orderId) {
    return refuse("wrong", `this payment already paid another order (${owner})`);
  }

  const match = exact[0];
  return {
    ok: true,
    status: "paid",
    reason: null,
    payment: {
      invoiceId: invoice.id,
      orderId: request.orderId,
      txHash: String(request.txHash ?? "").toLowerCase(),
      block: receipt.block,
      finality: receipt.finality,
      token: request.token,
      from: match.from,
      to: match.to,
      amountDue: request.amountDue,
      amount: request.amount,
      tag: request.tag,
    },
  };
}

/**
 * Applies a verified payment to the registry and returns the new one.
 *
 * Separate from `verifyPayment` so a verdict can be computed, inspected and
 * discarded without mutating anything — the same shape as `claim` in
 * `settlement.mjs`, and for the same reason: a dispute needs to be re-runnable.
 */
export function consume(consumed, payment) {
  if (!payment?.txHash) throw new Error("only a verified payment can be consumed");
  const key = payment.txHash.toLowerCase();
  const owner = consumed.get(key);
  if (owner !== undefined && owner !== payment.orderId) {
    throw new Error(`payment ${key} is already consumed by order ${owner}`);
  }
  const next = new Map(consumed);
  next.set(key, payment.orderId);
  return next;
}

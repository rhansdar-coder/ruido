// The payment rail, tested without a chain.
//
// The four verdicts are the point. "Unreadable", "not yet", "wrong" and "paid"
// lead to four different actions, and the one that must never happen is a
// hopeful credit — so the tests below try to make the verifier credit something
// it should not: a transfer to a different provider, an amount one base unit off,
// a payment already spent, an event from a contract that is not the token.
//
// The last test is the structural one: `markPaid` used to accept a bare
// `{ txHash }`, and it must not any more.

import test from "node:test";
import assert from "node:assert/strict";

import {
  STRK_TOKEN,
  STRK_DECIMALS,
  UNIT,
  TAG_MOD,
  TRANSFER_SELECTOR,
  SETTLED_FINALITY,
  baseAmount,
  paymentTag,
  amountDue,
  paymentRequest,
  decodeTransfer,
  transfersIn,
  normaliseReceipt,
  readReceipt,
  verifyPayment,
  consume,
} from "../src/payment.mjs";
import { invoiceFor, markPaid, providerTerms } from "../src/provider.mjs";

const hex = (value) => `0x${BigInt(value).toString(16)}`;

const PROVIDER = "0x0119f9a1e4e3f0f0c2a1b8d7e6f5a4b3c2d1e0f1a2b3c4d5e6f708192a3b4c5d";
const BUYER = "0x0277aa11bb22cc33dd44ee55ff6600112233445566778899aabbccddeeff0011";
const ORDER_ID = `0x${"ab".repeat(32)}`;
const OTHER_ORDER = `0x${"cd".repeat(32)}`;

const TERMS = providerTerms({ network: "sepolia", margin: 0n });

function invoiceForOrder({ decoys = 3, id = ORDER_ID } = {}) {
  return invoiceFor({ id, network: "sepolia", decoys, bits: 1 }, TERMS);
}

function requestFor({ decoys = 3, id = ORDER_ID, txHash = "0xfeed", provider = PROVIDER } = {}) {
  const invoice = invoiceForOrder({ decoys, id });
  return {
    invoice,
    request: { ...paymentRequest(invoice, { orderId: id, provider }), txHash },
  };
}

/** One `Transfer` event, in the u256 shape OZ's Cairo 1 ERC-20 emits. */
function transferEvent({ from = BUYER, to = PROVIDER, value, token = STRK_TOKEN }) {
  const low = value & ((1n << 128n) - 1n);
  const high = value >> 128n;
  return { from_address: token, keys: [TRANSFER_SELECTOR, from, to], data: [hex(low), hex(high)] };
}

function receiptWith({ transfers = [], finality = "ACCEPTED_ON_L2", execution = "SUCCEEDED", block = 4_200_000 } = {}) {
  return { finality, execution, block, events: transfers, revertReason: null };
}

// --- the tag -------------------------------------------------------------

test("the tag lives in [1, mod] and is never zero", () => {
  for (let i = 0; i < 500; i += 1) {
    const tag = paymentTag(`0x${i.toString(16).padStart(64, "0")}`);
    assert.ok(tag >= 1n, `tag ${tag} is below 1`);
    assert.ok(tag < TAG_MOD, `tag ${tag} is not below ${TAG_MOD}`);
  }
});

test("the same order always gets the same tag", () => {
  assert.equal(paymentTag(ORDER_ID), paymentTag(ORDER_ID));
  assert.equal(paymentTag(ORDER_ID, { mod: 64n }), paymentTag(ORDER_ID, { mod: 64n }));
});

test("two hundred orders do not collide on a tag", () => {
  // A regression, not a tautology. At the original width of 10,000 this failed:
  // 200 ids produced 199 tags, because the birthday bound puts a collision among
  // 200 draws at about 86%. Every collision is an honest buyer refused with
  // "already paid another order", so the width has to be wide.
  const tags = new Set();
  for (let i = 0; i < 200; i += 1) tags.add(paymentTag(`0x${(i * 7919).toString(16).padStart(64, "0")}`));
  assert.equal(tags.size, 200, "a tag width that collides at 200 orders refuses honest payments");
});

test("the width is what decides collisions, and a collision is a refusal", () => {
  // The narrow width is reachable through `mod`, which is how the collision path
  // gets exercised instead of waited for.
  const narrow = { mod: 4n };
  const tags = ["0x1", "0x2", "0x3", "0x4", "0x5"].map((id) => paymentTag(id, narrow));
  assert.ok(new Set(tags).size < tags.length, "at mod 4, five ids must collide");
  // Two orders that collide on both tag and fee are satisfied by the same
  // transfer, so the registry gives it to the first and refuses the second —
  // "a payment already spent on another order is refused", below. Refused, never
  // credited twice.
});

test("the tag does not order with the order id, so the amount does not leak it", () => {
  // Adjacent order ids must not produce adjacent tags. If they did, a paid amount
  // would say something about which order it belongs to.
  let decreases = 0;
  let previous = null;
  for (let i = 1; i <= 200; i += 1) {
    const tag = paymentTag(`0x${i.toString(16).padStart(64, "0")}`);
    if (previous !== null && tag < previous) decreases += 1;
    previous = tag;
  }
  assert.ok(decreases > 0, "the tag increased monotonically with the order id");
});

test("a tag needs somewhere to live", () => {
  assert.throws(() => paymentTag(ORDER_ID, { mod: 1n }), /somewhere to live/);
});

// --- the amount ----------------------------------------------------------

test("amountDue is in the token's base units and carries the tag", () => {
  const invoice = invoiceForOrder({ decoys: 3 });
  // Three decoys at the 2 STRK pool fee. The invoice is already in base units;
  // it used to be whole STRK and this line had to scale it.
  assert.equal(baseAmount(invoice), 6n * UNIT);
  const tag = paymentTag(ORDER_ID);
  assert.equal(amountDue(invoice, { orderId: ORDER_ID }), 6n * UNIT + tag);
});

test("two orders quoting the same fee are still paid differently", () => {
  const a = amountDue(invoiceForOrder(), { orderId: ORDER_ID });
  const b = amountDue(invoiceForOrder(), { orderId: OTHER_ORDER });
  assert.notEqual(a, b, "the same amount for two orders means nothing binds a transfer to one of them");
});

test("an invoice without an amount cannot be priced", () => {
  assert.throws(() => baseAmount({ id: "0x1" }), /cannot be paid/);
});

// --- the request ---------------------------------------------------------

test("a payment request names both the billed amount and the amount due", () => {
  const invoice = invoiceForOrder({ decoys: 2 });
  const request = paymentRequest(invoice, { orderId: ORDER_ID, provider: PROVIDER });
  assert.equal(request.amount, 4n * UNIT, "the invoice bills four STRK, in base units");
  assert.equal(request.amountDue, 4n * UNIT + request.tag, "and the tag is added to what is sent");
  assert.notEqual(request.amount, request.amountDue, "the two figures are different and confusing them is the mistake");
  assert.equal(request.token, STRK_TOKEN);
  assert.equal(request.decimals, STRK_DECIMALS);
  assert.equal(request.provider, PROVIDER);
});

test("a payment request without a destination is refused", () => {
  assert.throws(() => paymentRequest(invoiceForOrder(), { orderId: ORDER_ID }), /destination address/);
});

// --- decoding a transfer -------------------------------------------------

test("a Transfer event from another contract is not a transfer of this token", () => {
  const event = transferEvent({ value: 10n, token: "0x0999" });
  assert.equal(decodeTransfer(event, { token: STRK_TOKEN }), null);
});

test("an event whose first key is not the Transfer selector is ignored", () => {
  const event = { from_address: STRK_TOKEN, keys: [`0x${"11".repeat(32)}`, BUYER, PROVIDER], data: [hex(5n), hex(0n)] };
  assert.equal(decodeTransfer(event), null);
});

test("the u256 width is read as two felts, so a value above 2^128 survives", () => {
  // The trap this guards: reading data[0] alone. A u256 is low + high, and the
  // low word of a large amount looks like a perfectly plausible small amount.
  const huge = (1n << 128n) + 5n;
  const decoded = decodeTransfer(transferEvent({ value: huge }));
  assert.equal(decoded.value, huge);
  assert.notEqual(decoded.value, 5n, "reading only the low felt would have returned 5");
});

test("a legacy single-felt value still decodes", () => {
  const event = { from_address: STRK_TOKEN, keys: [TRANSFER_SELECTOR, BUYER, PROVIDER], data: [hex(7n)] };
  assert.equal(decodeTransfer(event).value, 7n);
});

test("an event with no value data is not a transfer", () => {
  const event = { from_address: STRK_TOKEN, keys: [TRANSFER_SELECTOR, BUYER, PROVIDER], data: [] };
  assert.equal(decodeTransfer(event), null);
});

test("transfersIn keeps only the real transfers", () => {
  const receipt = receiptWith({
    transfers: [
      transferEvent({ value: 1n }),
      { from_address: "0x0999", keys: [TRANSFER_SELECTOR, BUYER, PROVIDER], data: [hex(1n), hex(0n)] },
      { from_address: STRK_TOKEN, keys: [`0x${"22".repeat(32)}`, BUYER, PROVIDER], data: [hex(1n)] },
    ],
  });
  assert.equal(transfersIn(receipt).length, 1);
});

// --- reading a receipt ---------------------------------------------------

const fakeFetch = (responses) => {
  let index = 0;
  return async () => {
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (response.throws) throw new Error(response.throws);
    return { text: async () => response.body };
  };
};

test("an endpoint answering HTML is not a receipt", async () => {
  const fetchImpl = fakeFetch([{ body: "<!doctype html><h1>Blocked by proxy</h1>" }]);
  const receipt = await readReceipt({ network: "sepolia", txHash: "0x1", endpoints: ["http://a"], fetch: fetchImpl });
  assert.equal(receipt, undefined, "HTML with a 200 must not be mistaken for a chain answer");
});

test("an endpoint answering something that is not JSON is not a receipt", async () => {
  const fetchImpl = fakeFetch([{ body: "rate limited, try later" }]);
  const receipt = await readReceipt({ network: "sepolia", txHash: "0x1", endpoints: ["http://a"], fetch: fetchImpl });
  assert.equal(receipt, undefined);
});

test("a hash the chain never saw is NOT_RECEIVED, not unreadable", async () => {
  // The distinction matters: a wrong hash is the buyer's problem and waiting will
  // not fix it. An unreachable RPC is the operator's, and waiting might.
  const fetchImpl = fakeFetch([
    { body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 29, message: "Transaction hash not found" } }) },
  ]);
  const receipt = await readReceipt({ network: "sepolia", txHash: "0xdead", endpoints: ["http://a"], fetch: fetchImpl });
  assert.equal(receipt.finality, "NOT_RECEIVED");
});

test("a refused endpoint rotates to the next one", async () => {
  const good = { result: { finality_status: "ACCEPTED_ON_L2", execution_status: "SUCCEEDED", block_number: 7, events: [] } };
  const fetchImpl = fakeFetch([
    { throws: "connection reset" },
    { body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "busy" } }) },
    { body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...good }) },
  ]);
  const receipt = await readReceipt({
    network: "sepolia",
    txHash: "0x1",
    endpoints: ["http://a", "http://b", "http://c"],
    fetch: fetchImpl,
  });
  assert.equal(receipt.block, 7);
});

test("when every endpoint fails the reader returns undefined and reports the last error once", async () => {
  const seen = [];
  const fetchImpl = fakeFetch([{ throws: "boom-1" }, { throws: "boom-2" }]);
  const receipt = await readReceipt({
    network: "sepolia",
    txHash: "0x1",
    endpoints: ["http://a", "http://b"],
    fetch: fetchImpl,
    onFailure: (message) => seen.push(message),
  });
  assert.equal(receipt, undefined, "never a fake success");
  assert.equal(seen.length, 1, "the failure is reported once, not once per endpoint");
  assert.match(seen[0], /boom-2/, "and it reports the LAST failure, not the first");
});

test("normaliseReceipt keeps the fields the verifier reads", () => {
  const receipt = normaliseReceipt({
    finality_status: "ACCEPTED_ON_L1",
    execution_status: "SUCCEEDED",
    block_number: 9,
    events: [],
    revert_reason: null,
  });
  assert.deepEqual(receipt, {
    finality: "ACCEPTED_ON_L1",
    execution: "SUCCEEDED",
    block: 9,
    events: [],
    revertReason: null,
  });
  assert.equal(normaliseReceipt(null), null);
});

test("both accepted finalities settle, and RECEIVED does not", () => {
  assert.ok(SETTLED_FINALITY.has("ACCEPTED_ON_L1"));
  assert.ok(SETTLED_FINALITY.has("ACCEPTED_ON_L2"));
  assert.ok(!SETTLED_FINALITY.has("RECEIVED"));
});

// --- the four verdicts ---------------------------------------------------

test("no hash, no check", () => {
  const { invoice, request } = requestFor();
  const verdict = verifyPayment({ invoice, request: { ...request, txHash: null }, receipt: receiptWith() });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, "unreadable");
  assert.match(verdict.reason, /no transaction hash/);
});

test("an unreadable receipt is a refusal, not a wait and not a payment", () => {
  const { invoice, request } = requestFor();
  const verdict = verifyPayment({ invoice, request, receipt: undefined });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, "unreadable");
  assert.equal(verdict.payment, null, "an RPC that is down must never produce a payment");
});

test("a transaction still in the sequencer is a wait", () => {
  const { invoice, request } = requestFor();
  const verdict = verifyPayment({ invoice, request, receipt: receiptWith({ finality: "RECEIVED" }) });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, "not-yet", "this is the only one of the four that is worth retrying");
});

test("a reverted transaction is wrong, not a wait", () => {
  const { invoice, request } = requestFor();
  const verdict = verifyPayment({
    invoice,
    request,
    receipt: receiptWith({ execution: "REVERTED" }),
  });
  assert.equal(verdict.status, "wrong");
});

test("a transaction the chain rejected is wrong", () => {
  const { invoice, request } = requestFor();
  const verdict = verifyPayment({ invoice, request, receipt: receiptWith({ finality: "REJECTED" }) });
  assert.equal(verdict.status, "wrong");
  assert.match(verdict.reason, /rejected/);
});

test("a transaction with no transfer at all is wrong", () => {
  const { invoice, request } = requestFor();
  const verdict = verifyPayment({ invoice, request, receipt: receiptWith({ transfers: [] }) });
  assert.equal(verdict.status, "wrong");
  assert.match(verdict.reason, /no transfer/);
});

test("a transfer to somebody else does not pay this provider", () => {
  const { invoice, request } = requestFor();
  const receipt = receiptWith({ transfers: [transferEvent({ to: BUYER, value: request.amountDue })] });
  const verdict = verifyPayment({ invoice, request, receipt });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, "wrong");
  assert.match(verdict.reason, /no tokens to this provider/);
});

test("the exact amount is required, to the base unit", () => {
  // This is the tag doing its job. A payment without the tag is not a payment for
  // this order, even though it is the amount the invoice bills.
  const { invoice, request } = requestFor();
  const untagged = baseAmount(invoice);
  const receipt = receiptWith({ transfers: [transferEvent({ value: untagged })] });
  const verdict = verifyPayment({ invoice, request, receipt });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, "wrong");
  assert.match(verdict.reason, /not the one this order was quoted/);
  assert.match(verdict.reason, new RegExp(String(request.amountDue)), "the reason names the amount expected");
});

test("one base unit off is not a payment", () => {
  const { invoice, request } = requestFor();
  const receipt = receiptWith({ transfers: [transferEvent({ value: request.amountDue - 1n })] });
  assert.equal(verifyPayment({ invoice, request, receipt }).ok, false);
});

test("a correct payment is accepted and names what it saw", () => {
  const { invoice, request } = requestFor();
  const receipt = receiptWith({ transfers: [transferEvent({ value: request.amountDue })] });
  const verdict = verifyPayment({ invoice, request, receipt });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.status, "paid");
  assert.equal(verdict.payment.from, BUYER);
  assert.equal(verdict.payment.to, PROVIDER);
  assert.equal(verdict.payment.amountDue, request.amountDue);
  assert.equal(verdict.payment.block, 4_200_000);
  assert.equal(verdict.payment.orderId, ORDER_ID);
});

test("a payment already spent on another order is refused", () => {
  const { invoice, request } = requestFor();
  const receipt = receiptWith({ transfers: [transferEvent({ value: request.amountDue })] });
  const consumed = new Map([[String(request.txHash).toLowerCase(), OTHER_ORDER]]);
  const verdict = verifyPayment({ invoice, request, receipt, consumed });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, "wrong");
  assert.match(verdict.reason, /already paid another order/);
});

test("the same order may present the same payment twice", () => {
  // Idempotent: settling twice is not a double sale, it is the same sale. Same
  // rule as the claim registry in settlement.mjs.
  const { invoice, request } = requestFor();
  const receipt = receiptWith({ transfers: [transferEvent({ value: request.amountDue })] });
  const consumed = new Map([[String(request.txHash).toLowerCase(), ORDER_ID]]);
  assert.equal(verifyPayment({ invoice, request, receipt, consumed }).ok, true);
});

// --- the registry --------------------------------------------------------

test("consume returns a new map and refuses a second owner", () => {
  const { request } = requestFor();
  const payment = { txHash: "0xabc", orderId: ORDER_ID };
  const before = new Map();
  const after = consume(before, payment);
  assert.equal(before.size, 0, "the original registry is not mutated");
  assert.equal(after.get("0xabc"), ORDER_ID);
  assert.equal(consume(after, payment).size, 1, "the same order re-consuming is idempotent");
  assert.throws(() => consume(after, { txHash: "0xabc", orderId: OTHER_ORDER }), /already consumed/);
});

test("only a payment with a hash can be consumed", () => {
  assert.throws(() => consume(new Map(), { orderId: ORDER_ID }), /verified payment/);
});

// --- and the structural one ---------------------------------------------

test("a bare transaction hash can no longer mark an invoice paid", () => {
  // The old shape was `markPaid(invoice, { txHash, block })`, and it recorded the
  // hash without checking anything. That shape must now throw: a form is not a
  // rail, and the difference has to be enforced by the code rather than by a
  // comment asking people to be careful.
  const invoice = invoiceForOrder();
  assert.throws(() => markPaid(invoice, { txHash: "0xdead", block: 1 }), /only be marked paid from the output of verifyPayment/);
  assert.throws(() => markPaid(invoice, { ok: false, payment: null }), /only be marked paid/);
  assert.throws(() => markPaid(invoice, undefined), /only be marked paid/);
});

test("a verified payment marks the invoice paid, and it cannot be paid twice", () => {
  const { invoice, request } = requestFor();
  const receipt = receiptWith({ transfers: [transferEvent({ value: request.amountDue })] });
  const verdict = verifyPayment({ invoice, request, receipt });
  const paid = markPaid(invoice, verdict);
  assert.equal(paid.paid.txHash, String(request.txHash).toLowerCase());
  assert.equal(paid.paid.block, 4_200_000);
  assert.throws(() => markPaid(paid, verdict), /already paid/);
});

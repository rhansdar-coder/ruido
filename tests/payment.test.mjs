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
  transfersTo,
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
// The address a commission would be forwarded to. This repository publishes
// none, so it is a fixture like the others — see docs/ORDER.md §"The commission".
const RUIDO = `0x${"c0".repeat(32)}`;
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

// --- what arrived, which is the reconciliation's other half -----------------
//
// `transfersTo` reads the chain for arrivals at one address. The tests below are
// about its FAILURE DIRECTIONS rather than its happy path, because every way it
// can go wrong points the same way: an empty or truncated answer reads as "no
// provider ever forwarded", which is an accusation against every honest provider
// in the book. So the interesting cases are the ones where it must refuse to
// answer rather than answer wrongly.

/** A fake endpoint that answers `starknet_getEvents` from a list of pages. */
function eventsEndpoint(pages) {
  const calls = [];
  const fetch = async (_endpoint, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const page = pages[calls.length - 1] ?? { events: [] };
    return { text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result: page }) };
  };
  return { fetch, calls };
}

const withHash = (event, txHash, block = 100) => ({ ...event, transaction_hash: txHash, block_number: block });

const readFor = (pages, extra = {}) =>
  transfersTo(RUIDO, {
    network: "sepolia",
    fromBlock: 1,
    toBlock: 2,
    endpoints: ["http://127.0.0.1:1/rpc"],
    fetch: eventsEndpoint(pages).fetch,
    ...extra,
  });

test("it returns the transfers TO the address, and counts what it scanned", () => {
  const endpoint = eventsEndpoint([
    { events: [withHash(transferEvent({ to: RUIDO, value: 7n }), "0xa1")], continuation_token: null },
  ]);
  return transfersTo(RUIDO, {
    network: "sepolia",
    fromBlock: 1,
    toBlock: 2,
    endpoints: ["http://x"],
    fetch: endpoint.fetch,
  }).then((read) => {
    assert.equal(read.transfers.length, 1);
    assert.equal(read.transfers[0].value, 7n);
    assert.equal(read.transfers[0].txHash, "0xa1");
    assert.equal(read.scanned, 1, "it says how many events it looked at");
    assert.equal(read.pages, 1);
  });
});

test("a transfer to somebody else is SCANNED and not returned, and the difference is visible", () => {
  // This is the local filter. The point of counting `scanned` separately is that
  // "nothing arrived" and "nothing was examined" are the same empty list and
  // completely different findings.
  const endpoint = eventsEndpoint([
    {
      events: [
        withHash(transferEvent({ to: PROVIDER, value: 7n }), "0xb1"),
        withHash(transferEvent({ to: RUIDO, value: 9n }), "0xb2"),
      ],
      continuation_token: null,
    },
  ]);
  return transfersTo(RUIDO, {
    network: "sepolia",
    fromBlock: 1,
    toBlock: 2,
    endpoints: ["http://x"],
    fetch: endpoint.fetch,
  }).then((read) => {
    assert.equal(read.transfers.length, 1, "only the one addressed to Ruido");
    assert.equal(read.transfers[0].txHash, "0xb2");
    assert.equal(read.scanned, 2, "but both were looked at");
  });
});

test("a page that is empty is distinguishable from a range that held nothing", () => {
  return readFor([{ events: [], continuation_token: null }]).then((read) => {
    assert.deepEqual(read.transfers, []);
    assert.equal(read.scanned, 0, "zero examined is the signal the caller needs");
  });
});

test("pagination follows the continuation token and collects every page", () => {
  const endpoint = eventsEndpoint([
    { events: [withHash(transferEvent({ to: RUIDO, value: 1n }), "0xc1")], continuation_token: "next" },
    { events: [withHash(transferEvent({ to: RUIDO, value: 2n }), "0xc2")], continuation_token: null },
  ]);
  return transfersTo(RUIDO, {
    network: "sepolia",
    fromBlock: 1,
    toBlock: 2,
    endpoints: ["http://x"],
    fetch: endpoint.fetch,
  }).then((read) => {
    assert.equal(read.transfers.length, 2);
    assert.equal(read.pages, 2);
    assert.equal(endpoint.calls[1].params[0].continuation_token, "next");
  });
});

test("an event from a contract that is not the token is scanned but not counted as a transfer", () => {
  const impostor = { ...transferEvent({ to: RUIDO, value: 5n }), from_address: "0x0999" };
  return readFor([{ events: [withHash(impostor, "0xd1")], continuation_token: null }]).then((read) => {
    assert.equal(read.scanned, 1);
    assert.equal(read.transfers.length, 0, "the shape is right and the contract is not");
  });
});

test("an HTML answer is refused rather than read as an empty page", () => {
  // The trap `readReceipt` already guards. Here it is worse: a proxy that answers
  // `{}` would yield an empty page, and an empty page is a false accusation.
  const fetch = async () => ({ text: async () => "<html>captive portal</html>" });
  return readFor([], { fetch }).then((read) => {
    assert.equal(read, undefined, "nobody could say");
  });
});

test("a page the reader does not understand is refused, not treated as empty", () => {
  const fetch = async (_endpoint, init) => {
    const body = JSON.parse(init.body);
    return { text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { unexpected: true } }) };
  };
  return readFor([], { fetch }).then((read) => assert.equal(read, undefined));
});

test("when no endpoint can be read it returns undefined, NOT an empty list", () => {
  // The single most important direction in this file. `[]` would mean "nobody
  // forwarded"; `undefined` means "nobody could say", and only one of those is
  // true when the RPC is down.
  const failing = async () => {
    throw new Error("connect ECONNREFUSED");
  };
  return readFor([], { fetch: failing }).then((read) => {
    assert.equal(read, undefined);
    assert.notDeepEqual(read, { transfers: [], scanned: 0 });
  });
});

test("a walk that fails part way restarts on the next endpoint, never resuming", () => {
  // A set assembled from two endpoints' pages is a set nobody has verified, and
  // a truncated set is a list of missing forwards that are not missing.
  const seen = [];
  const fetch = async (endpoint, init) => {
    const body = JSON.parse(init.body);
    seen.push(endpoint);
    if (endpoint === "http://first/rpc") {
      if (body.params[0].continuation_token === "page2") throw new Error("died mid-walk");
      return {
        text: async () =>
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { events: [withHash(transferEvent({ to: RUIDO, value: 1n }), "0xe1")], continuation_token: "page2" },
          }),
      };
    }
    return {
      text: async () =>
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { events: [withHash(transferEvent({ to: RUIDO, value: 2n }), "0xe2")], continuation_token: null },
        }),
    };
  };

  return transfersTo(RUIDO, {
    network: "sepolia",
    fromBlock: 1,
    toBlock: 2,
    endpoints: ["http://first/rpc", "http://second/rpc"],
    fetch,
  }).then((read) => {
    assert.equal(read.transfers.length, 1, "only the second endpoint's set, complete");
    assert.equal(read.transfers[0].txHash, "0xe2");
    assert.ok(seen.includes("http://first/rpc") && seen.includes("http://second/rpc"));
  });
});

test("more pages than the ceiling is refused rather than truncated", async () => {
  // The endpoint keeps offering another page forever, which is what a range
  // somebody got wrong looks like from here.
  const fetch = async (_endpoint, init) => {
    const body = JSON.parse(init.body);
    return {
      text: async () =>
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { events: [], continuation_token: "always-more" },
        }),
    };
  };
  const read = await transfersTo(RUIDO, {
    network: "sepolia",
    fromBlock: 1,
    toBlock: 2,
    endpoints: ["http://x"],
    fetch,
    maxPages: 3,
  });
  assert.equal(read, undefined, "a truncated list must not be returned");
});

test("a range that is empty or backwards is refused before any request", async () => {
  const fetch = async () => {
    throw new Error("should never be called");
  };
  // `assert.rejects`, not `assert.throws`: the function is async, so its
  // refusals are rejections and a synchronous check would pass vacuously.
  await assert.rejects(
    transfersTo(RUIDO, { network: "sepolia", fromBlock: 9, toBlock: 1, endpoints: ["http://x"], fetch }),
    /empty range/,
  );
  await assert.rejects(
    transfersTo(RUIDO, { network: "sepolia", fromBlock: 1, toBlock: 2.5, endpoints: ["http://x"], fetch }),
    /needs a block range/,
  );
  await assert.rejects(transfersTo(null, { network: "sepolia", fromBlock: 1, toBlock: 2 }), /needs the address/);
});

test("only the selector is pushed into the RPC filter, never the recipient", () => {
  // A recipient in `keys` would be compared numerically by the node, so a
  // formatting difference or an ignored filter produces the same empty page as
  // nobody having forwarded. The filter stays unambiguous and the comparison
  // stays here.
  const endpoint = eventsEndpoint([{ events: [], continuation_token: null }]);
  return transfersTo(RUIDO, {
    network: "sepolia",
    fromBlock: 1,
    toBlock: 2,
    endpoints: ["http://x"],
    fetch: endpoint.fetch,
  }).then(() => {
    const filter = endpoint.calls[0].params[0].filter;
    assert.deepEqual(filter.keys, [[TRANSFER_SELECTOR]]);
    assert.equal(filter.address, STRK_TOKEN);
    assert.equal(filter.from_block.block_number, 1);
    assert.equal(filter.to_block.block_number, 2);
    assert.ok(
      !JSON.stringify(filter).includes(RUIDO),
      "the recipient must not appear in the request at all",
    );
  });
});

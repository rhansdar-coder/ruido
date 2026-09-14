// The coordination fee: what Ruido would be paid, and how the claim is checked.
//
// Two properties carry this module and both are tested by construction rather
// than by description:
//
//   1. **The two legs share a tag and differ in amount.** The tag is what binds
//      a transfer to an order; the amount is what keeps the two legs apart. A
//      commission that reused the buyer's amount would be indistinguishable from
//      it, and a commission that derived its own tag would bind to nothing.
//   2. **`reconcile` keeps four answers apart.** `short` and `missing` are the
//      pair worth separating: a forward that dropped the tag lands within one
//      `TAG_MOD` of the figure due, and "you forgot the tag" is not the same
//      finding as "you kept the fee" — only one of them is a reason to delist.
//
// The default rate is zero and that is asserted, because a test that only ever
// runs at a non-zero rate would not notice the default changing.

import test from "node:test";
import assert from "node:assert/strict";

import {
  BPS_SCALE,
  COORDINATION_FEE_BPS,
  assertRate,
  coordinationTerms,
  commissionInvoiceId,
  commissionFor,
  commissionRequest,
  commissionOwed,
  commissionDisclosure,
  reconcile,
} from "../src/commission.mjs";
import { TAG_MOD, paymentRequest, amountDue } from "../src/payment.mjs";

const UNIT = 10n ** 18n;
const STRK = (n) => BigInt(n) * UNIT;

const ORDER = "0xa1";
const PROVIDER = "0x00b1";
const RUIDO = "0x00a1";
/** Three decoys at a 2 STRK pool fee plus a 1 STRK margin: 9 STRK. */
const amount = 3n * (2n * UNIT + 1n * UNIT);
const invoice = { id: "0xb1", network: "sepolia", amount };

// --- the rate, and the default that charges nothing --------------------------

test("the default rate is zero, so nothing in this repository charges anything", () => {
  assert.equal(COORDINATION_FEE_BPS, 0);
  assert.equal(commissionFor(amount), 0n);
  assert.equal(commissionDisclosure().charged, false);
});

test("the rate is expressed against basis points, not against one", () => {
  assert.equal(BPS_SCALE, 10_000n);
  assert.equal(commissionFor(STRK(2), { bps: 10_000 }), STRK(2));
});

// --- the amount, and the two floors that make it honest ----------------------

test("the fee is the stated fraction of the invoice, floored", () => {
  assert.equal(commissionFor(STRK(2), { bps: 100 }), (STRK(2) * 100n) / BPS_SCALE);
  assert.equal(commissionFor(STRK(2), { bps: 500 }), (STRK(2) * 500n) / BPS_SCALE);
  assert.equal(commissionFor(STRK(2), { bps: 1000 }), (STRK(2) * 1000n) / BPS_SCALE);
});

test("the fee is floored in the SAME direction twice, so it can never exceed the rate", () => {
  // A rate that rounded up would charge the buyer more than the provider
  // published, which is the one direction a fee must not fail in.
  for (const bps of [1, 7, 13, 250, 499, 3333, 9999]) {
    for (const base of [1n, 999n, STRK(2), STRK(9) + 7n, 12_345_678_901_234_567_890n]) {
      const fee = commissionFor(base, { bps });
      assert.ok(
        fee <= (base * BigInt(bps)) / BPS_SCALE,
        `${bps} bps of ${base} produced ${fee}, more than the rate`,
      );
    }
  }
});

test("the fee is quantised to TAG_MOD so the second leg has room for its tag", () => {
  for (const bps of [1, 100, 500, 1000, 4321]) {
    assert.equal(commissionFor(amount, { bps }) % TAG_MOD, 0n);
  }
});

test("an amount that rounds the fee away gives zero, which is not an error here", () => {
  // The two questions are different: "what is the fee" has the answer "nothing",
  // while "what do I ask for" has no answer at all. See the request tests below.
  assert.equal(commissionFor(1n, { bps: 500 }), 0n);
  assert.equal(commissionFor(TAG_MOD - 1n, { bps: 10_000 }), 0n);
});

test("a rate that is not a non-negative whole number of basis points is refused", () => {
  assert.throws(() => commissionFor(amount, { bps: -1 }), /non-negative whole number of basis points/);
  assert.throws(() => commissionFor(amount, { bps: 1.5 }), /non-negative whole number of basis points/);
  assert.throws(() => commissionFor(amount, { bps: "500" }), /non-negative whole number of basis points/);
});

test("a rate above the whole payment is refused, because that is not a fee", () => {
  assert.throws(() => commissionFor(amount, { bps: 10_001 }), /more than the whole payment/);
  assert.throws(() => commissionFor(amount, { bps: 50_000 }), /more than the whole payment/);
});

test("a commission on a negative amount is refused rather than returned as a negative fee", () => {
  assert.throws(() => commissionFor(-1n, { bps: 100 }), /negative amount is not a commission/);
});

// --- the rate rule, in one place ---------------------------------------------

test("assertRate is the one place that decides what a rate may be", () => {
  // Three callers need this rule — the arithmetic, the offer row, and the book's
  // own startup — and written three times the copies would disagree eventually,
  // with the disagreeing one being the one nobody looked at.
  assert.equal(assertRate(0), 0);
  assert.equal(assertRate(500), 500);
  assert.equal(assertRate(10_000), 10_000);

  assert.throws(() => assertRate(-1), /non-negative whole number of basis points/);
  assert.throws(() => assertRate(1.5), /non-negative whole number of basis points/);
  assert.throws(() => assertRate("500"), /non-negative whole number of basis points/);
  assert.throws(() => assertRate(NaN), /non-negative whole number of basis points/);
  assert.throws(() => assertRate(10_001), /more than the whole payment/);
});

test("the arithmetic and the disclosure refuse exactly the rates the rule refuses", () => {
  for (const bps of [-1, 1.5, NaN, 10_001, 99_999]) {
    assert.throws(() => commissionFor(amount, { bps }), Error, `commissionFor accepted ${bps}`);
    assert.throws(() => commissionDisclosure({ bps }), Error, `commissionDisclosure accepted ${bps}`);
  }
});

// --- the terms a provider publishes ------------------------------------------

test("a provider charging nothing publishes no fee, rather than a fee of zero", () => {
  // A fee of zero and no fee are the same fact, and `{ bps: 0 }` would say it
  // twice. `readCoordination` reads an absent field as "no cut in this price".
  assert.equal(coordinationTerms(), null);
  assert.equal(coordinationTerms({ bps: 0 }), null);
  assert.equal(coordinationTerms({ bps: 0, address: RUIDO }), null, "an address with no rate declares nothing");
});

test("a provider that charges publishes the rate and where it goes", () => {
  assert.deepEqual(coordinationTerms({ bps: 500, address: RUIDO }), { bps: 500, address: RUIDO });
});

test("a rate with nowhere to go is refused before anything is published", () => {
  // The failure this prevents is silent and late: the row would disclose a rate
  // and `commissionOwed` would only throw at payment time — after a buyer had
  // been quoted a price with a fee inside it that nobody could be sent.
  assert.throws(
    () => coordinationTerms({ bps: 500 }),
    /needs the address it is forwarded to/,
  );
  assert.throws(() => coordinationTerms({ bps: 500, address: "" }), /needs the address/);
  assert.throws(() => coordinationTerms({ bps: 500, address: null }), /needs the address/);
});

test("the terms rule and the book's rule agree, because they are one rule", () => {
  // If these two ever disagreed, a provider could publish terms the book would
  // refuse for a reason the provider could not reproduce.
  for (const bps of [-1, 2.5, NaN, 10_001]) {
    const fromTerms = (() => {
      try {
        coordinationTerms({ bps, address: RUIDO });
        return null;
      } catch (error) {
        return error.message;
      }
    })();
    const fromBook = (() => {
      try {
        assertRate(bps);
        return null;
      } catch (error) {
        return error.message;
      }
    })();
    assert.equal(fromTerms, fromBook, `the two rules disagree about ${bps}`);
  }
});


// --- the second invoice, derived rather than reused ---------------------------

test("the commission's invoice id is derived from the provider's, not equal to it", () => {
  const id = commissionInvoiceId(invoice.id);
  assert.notEqual(id, invoice.id);
  assert.match(id, /^0x[0-9a-f]{64}$/);
  assert.equal(id, commissionInvoiceId(invoice.id), "the derivation is deterministic");
});

test("two different orders cannot share a commission invoice id", () => {
  assert.notEqual(commissionInvoiceId("0xb1"), commissionInvoiceId("0xb2"));
});

// --- the two legs ------------------------------------------------------------

test("both legs carry the same tag, and their amounts differ", () => {
  const buyer = paymentRequest(invoice, { orderId: ORDER, provider: PROVIDER });
  const ruido = commissionRequest(invoice, { orderId: ORDER, address: RUIDO, bps: 500 });

  assert.equal(buyer.tag, ruido.tag, "the tag is what binds both legs to the same order");
  assert.equal(buyer.orderId, ruido.orderId);
  assert.notEqual(buyer.amountDue, ruido.amountDue, "the amounts are what keep the legs apart");
  assert.notEqual(buyer.invoiceId, ruido.invoiceId, "two amounts cannot claim to be one bill");
});

test("the second leg pays Ruido and the first pays the provider", () => {
  const buyer = paymentRequest(invoice, { orderId: ORDER, provider: PROVIDER });
  const ruido = commissionRequest(invoice, { orderId: ORDER, address: RUIDO, bps: 500 });
  assert.equal(buyer.provider, PROVIDER);
  assert.equal(ruido.provider, RUIDO);
});

test("the second leg's amount is the fee plus the same tag, so the rail still verifies it", () => {
  const ruido = commissionRequest(invoice, { orderId: ORDER, address: RUIDO, bps: 500 });
  assert.equal(ruido.amountDue, commissionFor(amount, { bps: 500 }) + ruido.tag);
  assert.equal(ruido.amount, commissionFor(amount, { bps: 500 }));
  // The property `verifyPayment` relies on: the amount leaves the tag's room free.
  assert.equal(ruido.amount % TAG_MOD, 0n);
});

test("a commission that rounds to nothing is refused, because there is no leg to ask for", () => {
  // A request whose amount is zero would still carry a tag, so it would ask for
  // a few base units and verify against them — an amount that looks like a
  // rounding error. Refused loudly instead.
  assert.throws(
    () => commissionRequest({ ...invoice, amount: 1n }, { orderId: ORDER, address: RUIDO, bps: 500 }),
    /rounds to nothing, so there is no second leg to ask for/,
  );
  assert.throws(
    () => commissionRequest(invoice, { orderId: ORDER, address: RUIDO }),
    /rounds to nothing/,
    "the default rate of zero charges nothing, so there is nothing to ask for",
  );
});

test("a commission with nowhere to be sent is refused", () => {
  assert.throws(
    () => commissionRequest(invoice, { orderId: ORDER, bps: 500 }),
    /needs somewhere to be sent/,
  );
  assert.throws(
    () => commissionRequest(invoice, { orderId: ORDER, address: null, bps: 500 }),
    /needs somewhere to be sent/,
  );
});

// --- what a provider owes, read from its own terms ---------------------------

test("terms that declare no fee owe nothing, and owe it as null rather than zero", () => {
  // "There is no second leg" and "there is a second leg for nothing" are
  // different states, and only the first of them is expressible.
  assert.equal(commissionOwed(invoice, { id: ORDER }, {}), null);
  assert.equal(commissionOwed(invoice, { id: ORDER }, { coordination: null }), null);
  assert.equal(commissionOwed(invoice, { id: ORDER }), null);
});

test("terms that declare a fee produce the second leg, priced from the invoice", () => {
  const owed = commissionOwed(invoice, { id: ORDER }, { coordination: { bps: 500, address: RUIDO } });
  assert.notEqual(owed, null);
  assert.equal(owed.provider, RUIDO);
  assert.equal(owed.orderId, ORDER);
  assert.equal(owed.amount, commissionFor(amount, { bps: 500 }));
  assert.equal(owed.amountDue, owed.amount + owed.tag);
});

test("the owed leg shares the buyer's tag, which is what binds it to the same order", () => {
  const buyer = paymentRequest(invoice, { orderId: ORDER, provider: PROVIDER });
  const owed = commissionOwed(invoice, { id: ORDER }, { coordination: { bps: 500, address: RUIDO } });
  assert.equal(owed.tag, buyer.tag);
  assert.notEqual(owed.amountDue, buyer.amountDue);
});

test("a fee that rounds to nothing is refused here too, not returned as a token request", () => {
  assert.throws(
    () => commissionOwed({ ...invoice, amount: 1n }, { id: ORDER }, { coordination: { bps: 500, address: RUIDO } }),
    /rounds to nothing/,
  );
});

test("a declared fee with no address is refused rather than owed to nobody", () => {
  assert.throws(
    () => commissionOwed(invoice, { id: ORDER }, { coordination: { bps: 500 } }),
    /needs somewhere to be sent/,
  );
});


// --- the disclosure in the offer row ----------------------------------------

test("a row charging nothing says so, rather than staying silent", () => {
  const d = commissionDisclosure();
  assert.deepEqual(d, {
    bps: 0,
    charged: false,
    address: null,
    note: "no coordination fee is charged, and a row would say so if one were",
  });
});

test("a charged row names the rate and the address, and says the fee is inside the price", () => {
  const d = commissionDisclosure({ bps: 500, address: RUIDO });
  assert.equal(d.charged, true);
  assert.equal(d.bps, 500);
  assert.equal(d.address, RUIDO);
  assert.match(d.note, /5%/);
  assert.match(d.note, new RegExp(RUIDO));
  // The comparability claim: a buyer comparing two providers must not have to
  // add a fee on top of the quoted price to compare them.
  assert.match(d.note, /part of the price above, not added to it/);
});

test("a fee with no destination is refused, because the row would disclose nothing", () => {
  assert.throws(
    () => commissionDisclosure({ bps: 500 }),
    /needs the address it is forwarded to/,
  );
});

test("the disclosure validates its rate the same way the arithmetic does", () => {
  assert.throws(() => commissionDisclosure({ bps: -1 }), /non-negative whole number of basis points/);
  assert.throws(() => commissionDisclosure({ bps: 2.5 }), /non-negative whole number of basis points/);
});

// --- reconcile: four answers, four actions ----------------------------------

test("reconcile separates forwarded, short, missing and unmatched", () => {
  const due = 450_000_816_715_701_763n;
  const { forwarded, short, missing, unmatched } = reconcile({
    expected: [
      { orderId: "0xa1", amountDue: due },
      { orderId: "0xb1", amountDue: due + 1000n },
      { orderId: "0xc1", amountDue: due + 2000n },
      { orderId: "0xd1", amountDue: due + 3000n },
    ],
    transfers: [
      { value: due, txHash: "0xt1" },
      { value: due + 1000n - 7n, txHash: "0xt2" },
      { value: 999_999_999_999_999n, txHash: "0xt4" },
    ],
  });

  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].orderId, "0xa1");
  assert.equal(forwarded[0].transfer.txHash, "0xt1");

  assert.equal(short.length, 1);
  assert.equal(short[0].orderId, "0xb1");
  assert.equal(short[0].shortBy, 7n);
  assert.match(short[0].why, /the tag is the part that is missing/);

  assert.deepEqual(missing.map((m) => m.orderId), ["0xc1", "0xd1"]);
  assert.deepEqual(unmatched.map((u) => u.txHash), ["0xt4"]);

  assert.equal(
    forwarded.length + short.length + missing.length,
    4,
    "every expected order lands in exactly one of the three answers",
  );
});

test("a short forward is a dropped tag, and a gap of a whole tag is NOT short", () => {
  const due = 100n * TAG_MOD + 1234n;
  // One base unit below: the tag was dropped. "You forgot the tag".
  const oneBelow = reconcile({
    expected: [{ orderId: "0xa1", amountDue: due }],
    transfers: [{ value: due - 1n, txHash: "0xt1" }],
  });
  assert.equal(oneBelow.short.length, 1);
  assert.equal(oneBelow.short[0].shortBy, 1n);

  // A whole tag below is outside the window, so it is a missing forwarding
  // rather than a tagless one. The boundary is what decides which finding it is.
  const tagBelow = reconcile({
    expected: [{ orderId: "0xa1", amountDue: due }],
    transfers: [{ value: due - TAG_MOD, txHash: "0xt1" }],
  });
  assert.equal(tagBelow.short.length, 0);
  assert.equal(tagBelow.missing.length, 1);
  assert.equal(tagBelow.unmatched.length, 1);
});

test("a transfer of the buyer's amount does not settle the commission", () => {
  // This is the property that makes the two legs separable at all: the buyer's
  // payment is a transfer to the PROVIDER, and the commission is a different
  // figure, so a reconciliation reading the buyer's leg finds nothing.
  const buyer = paymentRequest(invoice, { orderId: ORDER, provider: PROVIDER });
  const ruido = commissionRequest(invoice, { orderId: ORDER, address: RUIDO, bps: 500 });

  const verdict = reconcile({
    expected: [{ orderId: ORDER, amountDue: ruido.amountDue }],
    transfers: [{ value: buyer.amountDue, txHash: "0xbuyer" }],
  });
  assert.equal(verdict.forwarded.length, 0);
  assert.equal(verdict.missing.length, 1);
  assert.equal(verdict.unmatched.length, 1);
});

test("one forwarding cannot pay two orders, and the loser is told it is missing", () => {
  // The same collision direction as the rail's: the failure is a missing
  // forwarding, never a credit for a transfer that only happened once.
  const due = 5n * TAG_MOD + 9n;
  const verdict = reconcile({
    expected: [
      { orderId: "0xa1", amountDue: due },
      { orderId: "0xb1", amountDue: due },
    ],
    transfers: [{ value: due, txHash: "0xt1" }],
  });
  assert.equal(verdict.forwarded.length, 1);
  assert.equal(verdict.missing.length, 1);
  assert.equal(verdict.unmatched.length, 0, "the transfer was spent, not left over");
});

test("an overpayment is unmatched rather than accepted, because the rail matches exactly", () => {
  const due = 1000n * TAG_MOD;
  const verdict = reconcile({
    expected: [{ orderId: "0xa1", amountDue: due }],
    transfers: [{ value: due + 1n, txHash: "0xt1" }],
  });
  assert.equal(verdict.forwarded.length, 0);
  assert.equal(verdict.missing.length, 1);
  assert.equal(verdict.unmatched.length, 1);
});

test("reconcile with nothing expected and nothing transferred is four empty lists", () => {
  assert.deepEqual(reconcile(), { forwarded: [], short: [], missing: [], unmatched: [] });
  assert.deepEqual(reconcile({ expected: [], transfers: [] }), {
    forwarded: [],
    short: [],
    missing: [],
    unmatched: [],
  });
});

test("every transfer is accounted for exactly once across the four answers", () => {
  const due = 700n * TAG_MOD;
  const { forwarded, short, missing, unmatched } = reconcile({
    expected: [
      { orderId: "0xa1", amountDue: due },
      { orderId: "0xb1", amountDue: due },
      { orderId: "0xc1", amountDue: due + 500n },
    ],
    transfers: [
      { value: due, txHash: "0xt1" },
      { value: due - 3n, txHash: "0xt2" },
      { value: 1n, txHash: "0xt3" },
    ],
  });
  assert.equal(forwarded.length + short.length + unmatched.length, 3, "three transfers, three answers");
  assert.equal(missing.length, 1, "the third order got nothing");
  assert.equal(forwarded.length + short.length + missing.length, 3, "three orders, three answers");
});

test("a tagless forward cannot be attributed, and the rule is the order of the list", () => {
  // Two orders with the same base amount differ only in their tags, so a
  // forwarding that dropped the tag is within `TAG_MOD` below BOTH of them and
  // the transfer itself says nothing about which one it pays. The attribution is
  // therefore the first order in `expected`, and this test exists so that the
  // rule is a fact rather than an accident of iteration order.
  //
  // The finding is unaffected either way: a tagless forward arrived, which is
  // what the operator acts on. Which order it belongs to is a question the
  // transfer does not answer, and `short` does not pretend otherwise.
  const due = 700n * TAG_MOD + 42n;
  const verdict = reconcile({
    expected: [
      { orderId: "0xa1", amountDue: due },
      { orderId: "0xb1", amountDue: due },
    ],
    transfers: [{ value: due - 42n, txHash: "0xt1" }],
  });

  assert.equal(verdict.short.length, 1);
  assert.equal(verdict.short[0].orderId, "0xa1", "the first order in the list takes it");
  assert.equal(verdict.short[0].shortBy, 42n);
  assert.equal(verdict.missing.length, 1, "the other order is missing, not forwarded");
  assert.equal(verdict.missing[0].orderId, "0xb1");
  assert.equal(verdict.unmatched.length, 0, "the tagless transfer was spent on one of them");
});

// The order book, tested without a chain and without a server.
//
// Two properties are worth a test file rather than a comment, because both are
// the kind that fails silently:
//
//   1. **A buyer's cell cannot reach the book.** Not "the book does not store
//      it" — that is a promise — but "the book refuses an offer that carries it,
//      by name, at any depth". The first test below walks the whole forbidden
//      list rather than spot-checking one field, because a spot check passes
//      while the other eleven leak.
//   2. **Ranking is by what the buyer pays for THEIR size.** The price is a
//      curve, so a book that ranked on a single STRK-per-bit figure ranks
//      wrongly — and the test that proves it constructs two providers whose
//      order flips between one decoy and fifty.

import test from "node:test";
import assert from "node:assert/strict";

import {
  OFFER_FORBIDDEN,
  offerFromTerms,
  validateOffer,
  offerId,
  offerQuote,
  rankOffers,
  unverified,
  readCoordination,
  bookPrivacy,
  serialiseBook,
  parseBook,
} from "../src/orderbook.mjs";
import { providerTerms, invoiceFor } from "../src/provider.mjs";
import { quote } from "../src/quote.mjs";
import { UNIT } from "../src/pool.mjs";

const ADDRESS = "0x0119f9a1e4e3f0f0c2a1b8d7e6f5a4b3c2d1e0f1a2b3c4d5e6f708192a3b4c5d";

// A margin is in BASE UNITS per decoy and must be a multiple of 10^12, so the
// payment tag has somewhere to live. 0.2 STRK on a 2 STRK pool fee is a 10% cut
// — the kind of margin the field could not express at all while it was whole
// STRK, when the only available cuts were 0%, 50% and 100%.
const MARGIN = 2n * 10n ** 17n;

const termsFor = (over = {}) => providerTerms({ network: "sepolia", address: ADDRESS, ...over });

const offerFor = (endpoint, over = {}) =>
  offerFromTerms(termsFor(over.terms), { endpoint, registeredAt: "2026-09-13T00:00:00Z" });

// --- what an offer is -------------------------------------------------------

test("an offer is built from the provider's own terms, not from a row it composed", () => {
  const offer = offerFor("http://127.0.0.1:8081");
  assert.equal(offer.network, "sepolia");
  assert.equal(offer.ladder, 7);
  assert.equal(offer.feePerCall, 2n);
  assert.equal(offer.maxDecoys, 100_000);
  assert.equal(offer.address, ADDRESS);
  assert.equal(offer.payable, true);
  assert.equal(offer.reachable, null, "the book has not checked yet, and null says so");
});

test("an offer carries no field that is specific to one buyer's order", () => {
  const offer = offerFor("http://127.0.0.1:8081");
  const keys = Object.keys(offer).map((k) => k.toLowerCase());
  for (const forbidden of OFFER_FORBIDDEN) {
    assert.ok(!keys.includes(forbidden), `a fresh offer carries \`${forbidden}\``);
  }
});

test("a provider with no address is listed, and marked unpayable", () => {
  const offer = offerFromTerms(providerTerms({ network: "sepolia" }), { endpoint: "http://x" });
  assert.equal(offer.address, null);
  assert.equal(offer.payable, false);
});

test("a fee and a margin survive the round trip through the terms as felts", () => {
  const offer = offerFor("http://x", { terms: { margin: MARGIN } });
  assert.equal(offer.margin, MARGIN);
  assert.equal(typeof offer.feePerCall, "bigint");
});

// --- the leak, refused ------------------------------------------------------

test("every forbidden field is refused, by name, at the top level", () => {
  for (const field of OFFER_FORBIDDEN) {
    const offer = { ...offerFor("http://x"), [field]: "anything" };
    assert.throws(
      () => validateOffer(offer),
      new RegExp(field, "i"),
      `an offer carrying \`${field}\` was accepted`,
    );
  }
});

test("the refusal is case-insensitive, because a wire format does not promise casing", () => {
  const offer = { ...offerFor("http://x"), Denomination: "10" };
  assert.throws(() => validateOffer(offer), /Denomination/);
});

test("a secret nested one level down is still a secret", () => {
  // The realistic shape of this mistake: the provider echoes back the request it
  // was sent, so the buyer's window arrives inside a `request` sub-object rather
  // than at the top level.
  const offer = { ...offerFor("http://x"), request: { order: { window: { from: 1, to: 2 } } } };
  assert.throws(() => validateOffer(offer), /request\.order\.window/);
});

test("a secret inside an array is found too", () => {
  const offer = { ...offerFor("http://x"), extras: [{ noteId: "0x1" }] };
  assert.throws(() => validateOffer(offer), /extras\.0\.noteId/);
});

test("a nested `claimed` bag is checked like anything else", () => {
  const offer = { ...offerFor("http://x"), claimed: { ordersServed: 4, denomination: "10" } };
  assert.throws(() => validateOffer(offer), /claimed\.denomination/);
});

test("the refusal says which field, so an operator can act on it", () => {
  try {
    validateOffer({ ...offerFor("http://x"), denominationSalt: "0x1" });
    assert.fail("the offer was accepted");
  } catch (error) {
    assert.match(error.message, /denominationSalt/);
    assert.match(error.message, /publishes its customers/);
  }
});

// --- what the book refuses to accept as an offer at all ---------------------

test("an offer with no endpoint is not an offer", () => {
  assert.throws(() => offerFromTerms(termsFor(), {}), /needs the endpoint/);
});

test("an offer with no network is not an offer", () => {
  assert.throws(() => validateOffer({ endpoint: "http://x", ladder: 7, feePerCall: 2n, maxDecoys: 10 }), /network/);
});

test("an offer with no rungs is not an offer", () => {
  assert.throws(() => validateOffer({ ...offerFor("http://x"), ladder: 0 }), /at least one rung/);
});

test("an offer with a negative fee is not an offer", () => {
  assert.throws(() => validateOffer({ ...offerFor("http://x"), feePerCall: -1n }), /non-negative/);
});

test("an offer with no cap is not an offer", () => {
  assert.throws(() => validateOffer({ ...offerFor("http://x"), maxDecoys: 0 }), /positive cap/);
});

test("terms that declare another version, or none, are refused rather than guessed at", () => {
  // `margin` changed unit in provider version 2 — whole STRK before, base units
  // now — so a v1 margin of 1 read by this reader quotes 2 STRK per decoy
  // instead of 3: an undercharge of a third, arrived at silently, in the
  // direction nobody reports. The version was already being copied onto the row,
  // and copying a version is not reading it; this is the test that makes the
  // refusal a fact rather than an intention.
  const older = { ...termsFor(), providerVersion: 1 };
  assert.throws(
    () => offerFromTerms(older, { endpoint: "http://x" }),
    /provider version 1/,
    "a document that names a version this reader does not speak was accepted",
  );

  // Absent is not a synonym for "current". A provider that never declared a
  // version is a provider whose margin unit is unknown, and the tempting default
  // is the number that looks like an answer.
  const silent = { ...termsFor() };
  delete silent.providerVersion;
  assert.throws(
    () => offerFromTerms(silent, { endpoint: "http://x" }),
    /provider version \(none\)/,
    "a document with no declared version was accepted",
  );

  // The refusal has to name both versions, or an operator cannot tell which side
  // has to move.
  try {
    offerFromTerms(older, { endpoint: "http://x" });
    assert.fail("the terms were accepted");
  } catch (error) {
    assert.match(error.message, /speaks 2/);
    assert.match(error.message, /unit of `margin` changed/);
  }
});

// --- identity ---------------------------------------------------------------

test("the endpoint is the identity, so re-registering replaces instead of duplicating", () => {
  assert.equal(offerId(offerFor("http://x:8081")), offerId(offerFor("http://X:8081/")));
});

test("two providers are two offers", () => {
  assert.notEqual(offerId(offerFor("http://a")), offerId(offerFor("http://b")));
});

// --- pricing ----------------------------------------------------------------

test("an offer is priced with the provider's own fee, not the network default", () => {
  const cheap = offerFor("http://cheap", { terms: { feePerCall: undefined } });
  const dear = { ...cheap, feePerCall: 5n };
  const a = offerQuote(cheap, { targetCell: 1.93, bits: 3, mode: "aimed" });
  const b = offerQuote(dear, { targetCell: 1.93, bits: 3, mode: "aimed" });
  assert.ok(b.total > a.total, "a higher fee must cost more");
  assert.equal(a.cost, BigInt(a.decoys) * 2n);
});

test("the margin is charged per decoy, which is what the invoice charges", () => {
  // This test used to assert `total === cost + margin`, and that assertion WAS
  // the bug. The provider's invoice charges the margin per decoy — one
  // `apply_actions` call per decoy, so one margin per decoy — while the book
  // added it once. At an 11 STRK margin on a 14-decoy order the book quoted 39
  // STRK against an invoice of 182: a 4.7× understatement, published as a price.
  //
  // Nothing caught it because the reference provider's margin is zero, and zero
  // is the single value where adding once and adding per decoy agree. A test
  // written against the implementation rather than against the invoice is how a
  // bug gets a name and a green tick.
  const offer = offerFor("http://x", { terms: { margin: MARGIN } });
  const priced = offerQuote(offer, { targetCell: 1.93, bits: 3, mode: "aimed" });
  assert.equal(priced.margin, MARGIN);
  assert.equal(priced.marginTotal, MARGIN * BigInt(priced.decoys));
  assert.equal(priced.total, priced.cost * UNIT + MARGIN * BigInt(priced.decoys));
  assert.ok(priced.decoys > 1, "a one-decoy order is the case where the bug hides");
});

test("the book's total is the amount the provider's invoice asks for", () => {
  // The two prices a buyer sees — the row in the book and the invoice that
  // arrives — have to be the same number, or the market advertises one price and
  // charges another. Checked against `invoiceFor` rather than against arithmetic
  // repeated here, because arithmetic repeated here is what drifted.
  const offer = offerFor("http://x", { terms: { margin: MARGIN } });
  const priced = offerQuote(offer, { targetCell: 1.93, bits: 3, mode: "aimed" });
  const invoice = invoiceFor(
    { id: "0xabc", network: offer.network, decoys: priced.decoys },
    termsFor({ margin: MARGIN }),
  );
  assert.equal(priced.total, invoice.amount, "the book and the invoice must agree on the price");
});

test("window-only costs the ladder width for the same bits, up to the rounding", () => {
  const offer = offerFor("http://x");
  const aimed = offerQuote(offer, { targetCell: 1.93, bits: 3, mode: "aimed" });
  const windowOnly = offerQuote(offer, { targetCell: 1.93, bits: 3, mode: "window" });
  // Exactly `ladder` times the decoys, except that a decoy is atomic: the count
  // is rounded up, so the product lands within one rounding of the width rather
  // than on it. Both bounds are asserted, because "seven times" is the kind of
  // claim that is 40% wrong once and never noticed — the repository has already
  // published one of those.
  assert.ok(windowOnly.decoys <= offer.ladder * aimed.decoys, "more than the ladder width");
  assert.ok(windowOnly.decoys > offer.ladder * (aimed.decoys - 1), "less than the ladder width, by more than the rounding");
  assert.ok(windowOnly.total <= BigInt(offer.ladder) * aimed.total);
});

test("the price of a bit rises with the order, which is why a rate is not a price", () => {
  const offer = offerFor("http://x");
  const perBit = (q) => Number(q.total) / q.bitsDelivered;
  const one = offerQuote(offer, { targetCell: 1.93, bits: 1, mode: "aimed" });
  const five = offerQuote(offer, { targetCell: 1.93, bits: 5, mode: "aimed" });
  assert.ok(
    perBit(five) > perBit(one),
    `the marginal bit must get dearer, not cheaper: ${perBit(one)} -> ${perBit(five)}`,
  );
});

test("the price of an offer is recomputed from the terms, never stored", () => {
  // Same offer, two sizes, two different prices — which is what a stored figure
  // would have got wrong.
  const offer = offerFor("http://x");
  const small = offerQuote(offer, { targetCell: 1.93, bits: 1, mode: "aimed" });
  const large = offerQuote(offer, { targetCell: 1.93, bits: 5, mode: "aimed" });
  assert.notEqual(small.total, large.total);
  // `total` is in base units and `cost` is in whole STRK, because the pool
  // charges whole STRK per call. With no margin the two agree once scaled.
  assert.equal(small.total, quote({ targetCell: 1.93, bits: 1, mode: "aimed", feePerCall: 2n }).cost * UNIT);
});

test("an order over the provider's cap is flagged, not silently priced", () => {
  const offer = { ...offerFor("http://x"), maxDecoys: 5 };
  const priced = offerQuote(offer, { targetCell: 1.93, bits: 3, mode: "aimed" });
  assert.equal(priced.overCap, true);
});

// --- ranking ----------------------------------------------------------------

test("ranking is by what the buyer pays for their size, cheapest first", () => {
  const dear = { ...offerFor("http://dear"), feePerCall: 9n };
  const cheap = { ...offerFor("http://cheap"), feePerCall: 2n };
  const { candidates } = rankOffers([dear, cheap], { targetCell: 1.93, bits: 3, mode: "aimed" });
  assert.deepEqual(candidates.map((c) => c.endpoint), ["http://cheap", "http://dear"]);
});

test("the same two providers swap places between aimed and window-only", () => {
  // Not a contrived pair. The ladder does not enter aimed pricing at all — the
  // provider emits straight into the cell — and it is the entire multiplier for
  // window-only, where every rung has to be emitted. So a provider with a cheap
  // fee and a WIDE ladder is the cheapest aimed and the dearest window-only.
  // A book that ranked on one figure would send one of the two modes wrong.
  const narrow = { ...offerFor("http://narrow"), ladder: 2, feePerCall: 2n };
  const wide = { ...offerFor("http://wide"), ladder: 20, feePerCall: 1n };

  const aimed = rankOffers([narrow, wide], { targetCell: 1.93, bits: 3, mode: "aimed" });
  assert.equal(
    aimed.candidates[0].endpoint,
    "http://wide",
    "with the ladder out of the picture the cheaper fee must win",
  );

  const windowOnly = rankOffers([narrow, wide], { targetCell: 1.93, bits: 3, mode: "window" });
  assert.equal(
    windowOnly.candidates[0].endpoint,
    "http://narrow",
    "once every rung must be emitted the narrow ladder must win",
  );
});

test("an unreachable provider is excluded, and the reason is returned", () => {
  const gone = { ...offerFor("http://gone"), reachable: false };
  const live = offerFor("http://live");
  const { candidates, excluded } = rankOffers([gone, live], { targetCell: 1.93, bits: 3, mode: "aimed" });
  assert.deepEqual(candidates.map((c) => c.endpoint), ["http://live"]);
  assert.match(excluded[0].why, /did not answer/);
});

test("a provider that cannot be paid is excluded, with that reason", () => {
  const unpaid = offerFromTerms(providerTerms({ network: "sepolia" }), { endpoint: "http://unpaid" });
  const { candidates, excluded } = rankOffers([unpaid], { targetCell: 1.93, bits: 3, mode: "aimed" });
  assert.equal(candidates.length, 0);
  assert.match(excluded[0].why, /no payment address/);
});

test("a provider on another network is excluded, and says which one it serves", () => {
  const mainnet = offerFromTerms(providerTerms({ network: "mainnet", address: ADDRESS }), { endpoint: "http://m" });
  const { candidates, excluded } = rankOffers([mainnet], { targetCell: 1.93, bits: 3, mode: "aimed", network: "sepolia" });
  assert.equal(candidates.length, 0);
  assert.match(excluded[0].why, /serves mainnet/);
});

test("a provider whose cap is below the order is excluded, and the numbers are named", () => {
  const small = { ...offerFor("http://small"), maxDecoys: 2 };
  const { candidates, excluded } = rankOffers([small], { targetCell: 1.93, bits: 3, mode: "aimed" });
  assert.equal(candidates.length, 0);
  assert.match(excluded[0].why, /caps at 2 decoys and this order needs/);
});

test("`nobody sells this` and `everybody is unreachable` are different answers", () => {
  const empty = rankOffers([], { targetCell: 1.93, bits: 3, mode: "aimed" });
  assert.deepEqual(empty.candidates, []);
  assert.deepEqual(empty.excluded, []);

  const allGone = rankOffers([{ ...offerFor("http://a"), reachable: false }], { targetCell: 1.93, bits: 3, mode: "aimed" });
  assert.equal(allGone.candidates.length, 0);
  assert.equal(allGone.excluded.length, 1);
});

test("a truncated list says how many it hid", () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ ...offerFor(`http://p${i}`), feePerCall: BigInt(i + 1) }));
  const { candidates, truncated } = rankOffers(many, { targetCell: 1.93, bits: 3, mode: "aimed", max: 2 });
  assert.equal(candidates.length, 2);
  assert.equal(truncated, 3);
});

test("a full list is not reported as truncated", () => {
  const two = [offerFor("http://a"), offerFor("http://b")];
  assert.equal(rankOffers(two, { targetCell: 1.93, bits: 3, mode: "aimed", max: 5 }).truncated, 0);
});

test("ranking never mutates the offers it was handed", () => {
  const offers = [{ ...offerFor("http://a"), feePerCall: 9n }, offerFor("http://b")];
  const before = offers.map((o) => o.feePerCall);
  rankOffers(offers, { targetCell: 1.93, bits: 3, mode: "aimed" });
  assert.deepEqual(offers.map((o) => o.feePerCall), before);
});

// --- what is hearsay --------------------------------------------------------

test("a provider's own numbers are returned as claims, not as facts", () => {
  const offer = offerFor("http://x");
  assert.deepEqual(unverified(offer), ["reachable"]);
  assert.ok(unverified({ ...offer, claimed: { ordersServed: 400 } }).includes("claimed"));
});

// --- what the book learns ---------------------------------------------------

test("the privacy note names what the book learns and what it cannot", () => {
  const privacy = bookPrivacy({ network: "sepolia", bits: 3, mode: "window" });
  assert.deepEqual(Object.keys(privacy.learned), ["network", "bits", "decoys", "mode"]);
  assert.ok(privacy.notLearned.includes("window"));
  assert.ok(privacy.notLearned.includes("denomination"));
  assert.match(privacy.note, /never learns the window/);
  assert.match(privacy.note, /no parameter for it/);
});

test("the book has no parameter for a window anywhere in its API", () => {
  // The structural claim, tested as a structural claim: `rankOffers` is handed a
  // window and must ignore it, and no window must appear in what comes back.
  // A book that could accept one would eventually be given one.
  const offer = offerFor("http://x");
  const withWindow = rankOffers([offer], { targetCell: 1.93, bits: 3, mode: "aimed", window: { from: 1, to: 2 } });
  const without = rankOffers([offer], { targetCell: 1.93, bits: 3, mode: "aimed" });
  assert.deepEqual(withWindow.candidates, without.candidates);

  const named = (value) => Object.keys(value).map((k) => k.toLowerCase());
  assert.ok(!named(withWindow).includes("window"), "the result grew a window field");
  for (const candidate of withWindow.candidates) {
    assert.ok(!named(candidate).includes("window"), "a candidate carries a window");
  }
  assert.ok(!named(bookPrivacy({ network: "sepolia", bits: 3 })).includes("window"));
});

// --- the wire ---------------------------------------------------------------

test("a book survives the round trip through JSON", () => {
  const offers = [offerFor("http://a"), offerFor("http://b", { terms: { margin: MARGIN } })];
  const back = parseBook(serialiseBook(offers));
  assert.equal(back.length, 2);
  assert.equal(back[1].margin, MARGIN);
  assert.equal(back[0].feePerCall, 2n);
  assert.equal(typeof back[0].feePerCall, "bigint", "a felt that came back a string compares equal to nothing");
});

test("an amount does not lose precision on the wire", () => {
  const huge = 10n ** 30n + 7n;
  const back = parseBook(serialiseBook([{ ...offerFor("http://x"), feePerCall: huge }]));
  assert.equal(back[0].feePerCall, huge);
});

test("a parsed book is validated, so a hand-written one cannot smuggle a secret in", () => {
  assert.throws(() => parseBook({ offers: [{ ...offerFor("http://x"), denomination: "10" }] }), /denomination/);
});

test("a book that is neither an array nor an object with offers is refused", () => {
  assert.throws(() => parseBook({ nope: true }), /array of offers/);
});

test("the serialised form carries no BigInt literal, because JSON has none", () => {
  const text = serialiseBook([offerFor("http://x")]);
  assert.doesNotMatch(text, /\d+n/);
  assert.match(text, /"feePerCall": "2"/);
});

// --- the projection, which is the defence that does the work ----------------
// The refusal above is the visible half. This is the half that matters: the row
// is a fixed projection of the terms, so a provider cannot leak through a field
// the book never reads. The distinction is worth testing separately, because
// "refused" and "never copied" fail in different ways — a refusal has to be
// reached, and a projection has to be complete.

test("a provider's terms are projected, so a secret in them is never republished", () => {
  // A realistic terms document: the pricing half, the routes beside it, and a
  // provider that has helpfully echoed a buyer's order back at the book.
  const document = {
    terms: termsFor(),
    endpoints: { terms: "GET /terms", order: "POST /orders", reveal: "POST /orders/:id/reveal" },
    heightSource: "pinned",
    denomination: "10",
    windowSalt: "0xdead",
    lastRequest: { order: { window: { from: 1, to: 2 } } },
  };
  const offer = offerFromTerms(document, { endpoint: "http://x" });

  // The row exists — nothing was refused — and it carries none of it.
  assert.equal(offer.network, "sepolia");
  const flat = JSON.stringify(offer, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  for (const secret of ["denomination", "windowSalt", "0xdead", "lastRequest", "window", '"10"']) {
    assert.ok(!flat.includes(secret), `the row republished \`${secret}\`: ${flat}`);
  }
});

test("the routes a provider advertises do not become fields on its row", () => {
  const offer = offerFromTerms({ terms: termsFor(), endpoints: { order: "POST /orders" } }, { endpoint: "http://x" });
  assert.deepEqual(Object.keys(offer).sort(), [
    "address", "claimed", "coordination", "endpoint", "feePerCall", "ladder", "lastSeenAt",
    "margin", "maxDecoys", "network", "orderVersion", "payable", "providerVersion",
    "reachable", "registeredAt",
  ]);
});

// --- the fee disclosure, which is where comparability lives ------------------

test("a row always says whether it charges a coordination fee, rather than staying silent", () => {
  const offer = offerFor("http://127.0.0.1:8081");
  assert.deepEqual(offer.coordination, {
    bps: 0,
    charged: false,
    address: null,
    note: "no coordination fee is charged, and a row would say so if one were",
  });
  assert.ok(
    !unverified(offer).includes("coordination"),
    "a row that charges nothing has nothing unverified to declare",
  );
});

test("the RATE is the protocol's, so a row that declares its own is refused", () => {
  // The fee comes out of the price the buyer pays, so a provider left to declare
  // its own rate could understate the cut inside its price — and that failure is
  // invisible by construction. This is the check that stops it.
  assert.throws(
    () => readCoordination({ coordination: { bps: 500, address: ADDRESS } }),
    /the rate is the protocol's, not the provider's/,
  );
});

test("once a rate is set, a row that does not say where it forwards is refused", () => {
  // Absent is honest while nothing is charged. Once something is, silence is an
  // undisclosed cut inside a price the buyer is comparing against another's.
  assert.throws(
    () => readCoordination({}, { rate: 500 }),
    /must say where it is forwarded/,
  );
  assert.throws(
    () => readCoordination({ coordination: null }, { rate: 500 }),
    /must say where it is forwarded/,
  );
});

test("a row that declares the deployment's own rate, with a destination, is disclosed", () => {
  const disclosure = readCoordination(
    { coordination: { bps: 500, address: ADDRESS } },
    { rate: 500 },
  );
  assert.equal(disclosure.charged, true);
  assert.equal(disclosure.bps, 500);
  assert.equal(disclosure.address, ADDRESS);
  assert.match(disclosure.note, /part of the price above, not added to it/);
});

test("a declared rate with no destination is refused, because the row would disclose nothing", () => {
  assert.throws(
    () => readCoordination({ coordination: { bps: 500 } }, { rate: 500 }),
    /needs the address it is forwarded to/,
  );
});

test("a rate that is not a whole number of basis points is refused by the arithmetic's own rule", () => {
  assert.throws(() => readCoordination({ coordination: { bps: 1.5 } }), /non-negative whole number/);
  assert.throws(() => readCoordination({ coordination: { bps: -1 } }), /non-negative whole number/);
});

test("a disclosed fee is named as unverified, because the book cannot see the forwarding", () => {
  // The book checks the RATE against its own; it cannot see whether the money
  // moved. Only a transfer on the rail shows that, so the field is hearsay and
  // is labelled as such rather than ranked on.
  const offer = offerFor("http://127.0.0.1:8081");
  assert.ok(unverified({ ...offer, coordination: { charged: true } }).includes("coordination"));
  assert.ok(!unverified({ ...offer, coordination: { charged: false } }).includes("coordination"));
});

test("the `claimed` bag IS copied, so a secret in it is refused", () => {
  // This is the one place the projection does not reach: `claimed` is the
  // provider's own words, carried whole, so the refusal has to do the work.
  assert.throws(
    () => offerFromTerms({ ...termsFor(), claimed: { ordersServed: 4, noteId: "0xabc" } }, { endpoint: "http://x" }),
    /claimed\.noteId/,
  );
});

test("a clean `claimed` bag is carried through, so the numbers can be labelled", () => {
  const offer = offerFromTerms({ ...termsFor(), claimed: { ordersServed: 4 } }, { endpoint: "http://x" });
  assert.deepEqual(offer.claimed, { ordersServed: 4 });
  assert.ok(unverified(offer).includes("claimed"));
});

test("the flat terms shape is accepted too, because it is the same facts", () => {
  const flat = offerFromTerms(termsFor(), { endpoint: "http://x" });
  const wrapped = offerFromTerms({ terms: termsFor() }, { endpoint: "http://x" });
  assert.equal(flat.network, wrapped.network);
  assert.equal(flat.ladder, wrapped.ladder);
});

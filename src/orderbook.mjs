// The order book — a directory of standing OFFERS, and deliberately not a list
// of orders.
//
// ## Why this is a directory and not a book of orders
//
// Every other order book in every other market lists *demand*: somebody wants to
// buy, here is what and how much. In this market that list IS the attack. A row
// saying "a buyer is moving size through rung 10 during blocks 14,865,231–251"
// is a target with a timestamp, published by the people selling the anonymity.
// There is no redaction that fixes it, because the window and the size are
// exactly the fields the buyer is paying to withhold.
//
// So what this module knows how to publish is the other side: what a provider
// **sells**. An offer is a price list — a ladder, a fee, a cap, an address to pay
// — and none of it is specific to anybody's order. The consequence is worth
// stating plainly, because it is the whole reason the module exists:
//
//   **A buyer's cell never reaches the book, because the book has nowhere to put
//   it.** There is no window parameter, no denomination parameter, no order id.
//
// Two defences hold that up, and they are not the same defence twice.
//
//   1. **The projection.** `offerFromTerms` copies a fixed set of fields out of
//      the provider's terms. Everything else is dropped. A provider cannot leak
//      through a field this module does not read, because a field it does not
//      read is not republished — you cannot publish what you never copied. This
//      is the structural one, and it is why a provider whose terms carry a
//      `denomination` is listed anyway: the row does not have it.
//
//   2. **The refusal.** `validateOffer` refuses, by name and at any depth, an
//      offer carrying one of the fields in `OFFER_FORBIDDEN`. This covers the
//      two places the projection does not reach: the `claimed` bag, which is
//      copied wholesale because it is the provider's own words, and a row
//      arriving through `parseBook` from a file somebody edited.
//
// The list is deliberately generous, and that is a choice about which mistake to
// make. A false refusal is loud — a provider is told which field, and fixes it —
// while a false acceptance is silent and is the failure this whole module exists
// to prevent. So an ambiguous name like `order` stays on the list even though it
// could be a route label, because the cost of being wrong is not symmetric.
//
// ## What the book does learn, and why it is said out loud
//
// A buyer asking "who sells three bits on Sepolia" has told the book the size.
// The book has no accounts, so it cannot say *who* asked, but it can say *that*
// somebody asked — and a book that keeps that log can correlate. That is a real
// leak and it is smaller than the one it replaces, which is the only defence
// worth making: the provider learns the window (it has to, or it cannot deliver
// in time) and the book learns the size. Neither learns both.
//
// `bookPrivacy()` returns that trade in a shape a page can render, rather than
// leaving it to be discovered from a privacy policy.
//
// ## What a book cannot check
//
// Nothing here verifies a claim. A provider that says it has served four hundred
// orders is saying so, and this module's job is to keep that word — `claimed` —
// apart from what the book itself observed, which is only ever whether the
// endpoint answered. `unverified()` names the fields that are hearsay so a
// client can label them instead of ranking on them.

import { quote, MODES } from "./quote.mjs";
import { PROVIDER_VERSION } from "./provider.mjs";
import { UNIT } from "./pool.mjs";
import { COORDINATION_FEE_BPS, assertRate, commissionDisclosure } from "./commission.mjs";

/**
 * Field names that must never appear in an offer, matched case-insensitively and
 * at any depth.
 *
 * These are the per-order secrets. Every one of them is a fact about a
 * *particular* buyer's order, so an offer carrying one is not an offer — it is a
 * target, and the book would be publishing it. Kept as a list rather than as a
 * comment because a comment does not fail a build.
 */
export const OFFER_FORBIDDEN = [
  // the two halves of the split commitment, and their openings
  "denomination",
  "denominationsalt",
  "windowsalt",
  "window",
  "reveal",
  "commitment",
  "windowcommitment",
  "denominationcommitment",
  // the binding and everything derived from it
  "orderid",
  "order",
  "invoiceid",
  // what the chain would show, which is the thing being hidden
  "noteid",
  "noteids",
  "txhash",
  "transactionhash",
  // the buyer
  "buyer",
  "from",
  "observeddecoys",
  "cell",
];

/** BigInt does not survive JSON and every amount here is a felt. */
export const wireNumber = (value) => (typeof value === "bigint" ? value.toString() : value);

/**
 * The coordination fee a row discloses, read from the provider's terms.
 *
 * The RATE is checked against this deployment's own, and that check is the
 * point: the rate is the protocol's business, not a provider's. The fee comes
 * out of the price the buyer pays, so a provider left to declare its own rate
 * could either understate the cut inside its price or set a rate nobody agreed
 * to — and the first of those is invisible by construction, which is why the
 * disclosure exists at all.
 *
 * What remains unverifiable is whether the money actually moved. That is named
 * in `unverified()` rather than implied here: the book checks the rate and can
 * say so, and it cannot see the forwarding and says that too.
 *
 * `rate` is injectable so the branches that only run once a rate is set can be
 * tested rather than waited for — this deployment charges nothing, and a rule
 * that has never executed is a rule nobody has checked. Same reason `tag` is a
 * parameter of `amountDue`.
 */
export function readCoordination(terms, { rate = COORDINATION_FEE_BPS } = {}) {
  // The rate is validated HERE rather than trusted, because this function is
  // reachable from a caller that never went through a startup check — and a
  // negative rate used to fall straight through the `rate > 0` branch below and
  // return a disclosure of zero. A book that silently believed it charged
  // nothing is the failure this whole disclosure exists to prevent.
  assertRate(rate);

  const declared = terms?.coordination ?? null;

  // Absent is honest only while nothing is charged. Once a rate is set, a row
  // that does not say where the fee is forwarded is a row with an undisclosed
  // cut inside its price — the one thing the disclosure is for.
  if (!declared) {
    if (rate > 0) {
      throw new Error(
        `this deployment charges a ${rate} basis point coordination fee, so a row ` +
          "must say where it is forwarded — a price with an undisclosed cut in it is a price a " +
          "buyer cannot compare against another provider's",
      );
    }
    return commissionDisclosure();
  }

  const disclosure = commissionDisclosure({
    bps: declared.bps ?? rate,
    address: declared.address ?? null,
  });

  if (disclosure.bps !== rate) {
    throw new Error(
      `this row declares a ${disclosure.bps} basis point coordination fee and this deployment ` +
        `charges ${rate}: the rate is the protocol's, not the provider's`,
    );
  }
  return disclosure;
}

/**
 * A provider's published terms, turned into one row of the book.
 *
 * `endpoint` is the only thing added: the terms are what a provider already
 * publishes at `GET /terms`, and re-deriving the row from them — rather than
 * accepting a row the provider composed — means a provider cannot advertise a
 * price it would not honour. The book holds the URL, the provider holds the
 * terms, and the quote the buyer sees is recomputed from the terms every time.
 * `coordinationRate` is the deployment's own rate, and it is a parameter rather
 * than read from the constant because the book and the provider have to agree on
 * it: a book that assumed zero would refuse every honest row from a deployment
 * that charges. Both processes take it from their own configuration, and a
 * mismatch is a misconfiguration that shows up as a named refusal rather than as
 * an empty book.
 */
export function offerFromTerms(
  document,
  { endpoint, registeredAt = null, coordinationRate = COORDINATION_FEE_BPS } = {},
) {
  if (!endpoint) throw new Error("an offer needs the endpoint it can be reached at");
  if (!document || typeof document !== "object") throw new Error("an offer needs the provider's terms");

  // `GET /terms` answers with a DOCUMENT, not with the pricing terms alone: the
  // numbers sit under `terms`, and the routes and the height policy sit beside
  // them. The book wants the pricing half, and it reads it from where the
  // provider puts it rather than from where the book would have put it. Both
  // shapes are accepted, because a provider publishing the flat form is
  // publishing the same facts and refusing it would be this module inventing a
  // convention the protocol never had.
  const terms = document.terms ?? document;
  if (!terms.network) throw new Error("the terms do not name a network");

  // `margin` changed unit in provider version 2: whole STRK before, base units
  // now. A v1 margin of 1 read here as 1 base unit quotes 2 STRK per decoy
  // instead of 3 — an undercharge of a third, arrived at silently, in the
  // direction nobody reports. So a document that declares a different version, or
  // none, is refused rather than guessed at. An unknown unit is a refusal the
  // same way an unknown block height is, and for the same reason: the tempting
  // default is a number that looks like an answer.
  const declared = terms.providerVersion ?? null;
  if (declared !== PROVIDER_VERSION) {
    throw new Error(
      `the terms declare provider version ${declared ?? "(none)"}, and this reader speaks ` +
        `${PROVIDER_VERSION} — the unit of \`margin\` changed between them, so a margin read ` +
        `at the wrong version is wrong by 10^18`,
    );
  }

  const offer = {
    endpoint,
    network: terms.network,
    providerVersion: terms.providerVersion ?? null,
    orderVersion: terms.orderVersion ?? null,
    ladder: Number(terms.ladder),
    feePerCall: BigInt(terms.feePerCall),
    margin: BigInt(terms.margin ?? 0n),
    maxDecoys: Number(terms.maxDecoys),
    address: terms.address ?? null,
    // Derived rather than copied: a provider with no address cannot be paid, and
    // a row that omitted the fact would send a buyer to a dead end.
    payable: Boolean(terms.address),
    // Derived rather than copied, for the same reason: a price with an
    // undisclosed cut inside it is a price that cannot be compared, and the row
    // is where comparability lives. Always present, so "charges nothing" is a
    // statement the row makes rather than a field a reader has to notice is
    // missing.
    coordination: readCoordination(terms, { rate: coordinationRate }),
    registeredAt,
    // Everything a provider asserts about itself and the book cannot check. Kept
    // in its own bag so that a reader has to reach for it deliberately.
    claimed: terms.claimed ?? null,
    // The book's own observation, which is only ever "did it answer".
    reachable: null,
    lastSeenAt: null,
  };

  validateOffer(offer);
  return offer;
}

/** Walks an object and returns the forbidden key paths it finds. */
function forbiddenPaths(value, path = "", found = []) {
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value)) {
    const here = path ? `${path}.${key}` : key;
    if (OFFER_FORBIDDEN.includes(key.toLowerCase())) found.push(here);
    forbiddenPaths(child, here, found);
  }
  return found;
}

/**
 * Throws if an offer is not publishable.
 *
 * Throws rather than returning a verdict because there is no useful partial
 * acceptance: an offer that carries a buyer's window must not reach the list at
 * all, and a caller that had to remember to check a boolean would eventually
 * forget. The message names the offending field path, because "invalid offer" is
 * not something an operator can act on.
 */
export function validateOffer(offer) {
  if (!offer || typeof offer !== "object") throw new Error("an offer must be an object");
  if (!offer.endpoint) throw new Error("an offer needs an endpoint");
  if (!offer.network) throw new Error("an offer needs a network");
  if (!Number.isInteger(offer.ladder) || offer.ladder < 1) {
    throw new Error(`an offer needs a ladder of at least one rung, got ${offer.ladder}`);
  }
  if (!(BigInt(offer.feePerCall ?? -1n) >= 0n)) {
    throw new Error(`an offer needs a non-negative fee, got ${offer.feePerCall}`);
  }
  if (!Number.isInteger(offer.maxDecoys) || offer.maxDecoys < 1) {
    throw new Error(`an offer needs a positive cap on decoys, got ${offer.maxDecoys}`);
  }

  const leaked = forbiddenPaths(offer);
  if (leaked.length > 0) {
    throw new Error(
      `an offer may not carry ${leaked.join(", ")} — ` +
        "those are facts about one buyer's order, and a book that publishes them publishes its customers",
    );
  }
  return offer;
}

/**
 * The identity of an offer is its endpoint.
 *
 * Re-registering replaces rather than appends, so a provider that restarts with
 * new prices does not appear twice at two prices — which would let a buyer pick
 * the stale row and then be refused by a provider that has moved on.
 */
export function offerId(offer) {
  return String(offer.endpoint).replace(/\/+$/, "").toLowerCase();
}

/**
 * What this offer would cost a buyer for a given size and placement.
 *
 * Recomputed from the terms on every read rather than stored, so a stored price
 * cannot outlive the terms that produced it. `mode` is the buyer's choice and it
 * matters: the provider's ladder is exactly the multiplier that makes
 * window-only cost what it costs.
 */
export function offerQuote(offer, { targetCell, bits, mode = "window" } = {}) {
  validateOffer(offer);
  if (!MODES.includes(mode)) throw new Error(`unknown placement mode: ${mode}`);
  const q = quote({
    targetCell,
    bits,
    mode,
    network: offer.network,
    ladder: offer.ladder,
    feePerCall: BigInt(offer.feePerCall),
  });
  // The provider's own cut, in BASE UNITS per decoy. Zero for the reference
  // provider; a market price once there is more than one of them.
  //
  // Charged PER DECOY, which is what the pool fee already does and what the
  // provider's own invoice does. It used to be added once here, which made the
  // book quote less than the invoice would charge — by `margin × (decoys − 1)`,
  // so by 4.7× at a 11 STRK margin on a 14-decoy order. Nothing caught it
  // because the reference provider's margin is zero, and zero is the one value
  // where adding once and adding per decoy agree; the test that pinned the
  // behaviour asserted the behaviour.
  const margin = BigInt(offer.margin ?? 0n);
  const marginTotal = margin * BigInt(q.decoys);

  return {
    ...q,
    margin,
    marginTotal,
    // `q.cost` is in whole STRK, because the pool charges whole STRK per call.
    // `total` is what the buyer actually pays, so it is in base units — the only
    // unit both parts can be added in.
    total: q.cost * UNIT + marginTotal,
    overCap: q.decoys > offer.maxDecoys,
  };
}

/**
 * The offers that can actually serve a given order, cheapest first.
 *
 * Excluded rows come back with the reason rather than being dropped, because
 * "nobody sells this" and "everybody who sells this is unreachable" are
 * different answers and a buyer needs to know which one they got.
 *
 * Ordering is by what the buyer pays **for their size and their placement**. Both
 * have to enter, and for different reasons.
 *
 * The mode is the sharp one. The ladder is invisible to aimed cover — the
 * provider emits straight into the cell — and it is the whole multiplier for
 * window-only, where every rung has to be emitted. So two providers routinely
 * swap places between the two modes: a narrow ladder with a higher fee is dearer
 * aimed and cheaper window-only, and a book that ranked on one figure would send
 * half its buyers to the wrong provider.
 *
 * The size enters because a rate quoted at one size does not describe another.
 * Cost grows linearly in decoys while bits grow logarithmically, so the average
 * price of a bit rises with the order, and two figures taken at different sizes
 * are not comparable. The ranking between two offers is driven by ladder × fee
 * and is therefore size-independent — which is exactly why a book that published
 * a rate would be *nearly* right, and therefore never noticed.
 */
export function rankOffers(offers, { targetCell, bits, mode = "window", network = null, max = 20 } = {}) {
  const eligible = [];
  const excluded = [];

  for (const offer of offers) {
    let why = null;
    if (network && offer.network !== network) why = `serves ${offer.network}, not ${network}`;
    else if (!offer.payable) why = "publishes no payment address, so it cannot be paid";
    else if (offer.reachable === false) why = "did not answer when the book last checked";

    if (why) {
      excluded.push({ endpoint: offer.endpoint, why });
      continue;
    }

    const priced = offerQuote(offer, { targetCell, bits, mode });
    if (priced.overCap) {
      excluded.push({
        endpoint: offer.endpoint,
        why: `caps at ${offer.maxDecoys} decoys and this order needs ${priced.decoys}`,
      });
      continue;
    }
    eligible.push({ offer, priced });
  }

  eligible.sort((a, b) => (a.priced.total < b.priced.total ? -1 : a.priced.total > b.priced.total ? 1 : 0));

  return {
    mode,
    network,
    bits,
    candidates: eligible.slice(0, max).map(({ offer, priced }) => ({
      endpoint: offer.endpoint,
      id: offerId(offer),
      network: offer.network,
      ladder: offer.ladder,
      decoys: priced.decoys,
      bitsDelivered: priced.bitsDelivered,
      cost: priced.cost,
      margin: priced.margin,
      total: priced.total,
      address: offer.address,
      reachable: offer.reachable,
      claimed: offer.claimed,
    })),
    excluded,
    // How many were dropped by `max` — said out loud so a truncated list is not
    // mistaken for the whole market.
    truncated: Math.max(0, eligible.length - max),
  };
}

/**
 * The fields on an offer that are the provider's word rather than the book's.
 *
 * A client that ranks on these is ranking on hearsay, and the point of returning
 * them by name is that a page can label them instead of hiding the problem.
 */
export function unverified(offer) {
  const hearsay = [];
  if (offer.claimed) hearsay.push("claimed");
  // A row that discloses a fee has declared something the book cannot see. The
  // book checks the RATE against its own, but not whether the forwarding ever
  // happened — only a transfer on the rail shows that, and reading Ruido's own
  // address is a different job from reading a provider's terms.
  if (offer.coordination?.charged) hearsay.push("coordination");
  // `reachable` is the book's own observation, but it is one observation of one
  // endpoint at one moment, and it says nothing about whether the provider will
  // still be there when the window opens.
  hearsay.push("reachable");
  return hearsay;
}

/**
 * What a query tells the book, in a shape a page can render.
 *
 * The honest answer is not "nothing". The size and the network are given away by
 * the question itself, and a book that pretended otherwise would be the same
 * failure as a provider that claimed not to learn the window.
 */
export function bookPrivacy({ network, bits, decoys = null, mode = "window" } = {}) {
  return {
    learned: { network, bits, decoys, mode },
    notLearned: ["window", "denomination", "order id", "who is asking", "any address"],
    note:
      "The book learns the size you are buying and the network, because the question " +
      "carries both. It has no accounts, so it cannot tell who asked — but it can tell " +
      "that somebody did, and a book that logs can correlate. It never learns the window: " +
      "there is no parameter for it, so the cell cannot reach this process at all. " +
      "The provider you pick learns the window and never the size. Neither learns both.",
  };
}

/**
 * A book on the wire, and back.
 *
 * Amounts are felts and do not survive JSON, so they travel as decimal strings —
 * the same convention the provider already uses, rather than a second one.
 */
export function serialiseBook(offers) {
  return JSON.stringify(
    { offers: offers.map((o) => ({ ...o, feePerCall: wireNumber(o.feePerCall), margin: wireNumber(o.margin) })) },
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
}

export function parseBook(text) {
  const raw = typeof text === "string" ? JSON.parse(text) : text;
  const list = Array.isArray(raw) ? raw : raw.offers;
  if (!Array.isArray(list)) throw new Error("a book is an array of offers, or an object with an `offers` array");
  return list.map((o) => {
    // `feePerCall` and `margin` are the only felts, and they are the only fields
    // that have to come back as BigInt — a string that stayed a string would
    // compare equal to nothing and silently lose every price comparison.
    const offer = { ...o, feePerCall: BigInt(o.feePerCall), margin: BigInt(o.margin ?? 0n) };
    validateOffer(offer);
    return offer;
  });
}

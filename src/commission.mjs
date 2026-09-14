// The coordination fee: what Ruido would be paid, and how the claim is checked.
//
// `docs/ORDER.md` §"The commission" derives this from the rail's own limits. The
// short version, because the obvious answer is wrong:
//
//   **A commission cannot be a slice of the buyer's payment.** The rail moves one
//   amount to one payee and proves it by matching the exact figure. Tokens do not
//   split on arrival, a contract that splits on receipt would need a deployment
//   and would put a contract back between the buyer and the provider, and a
//   provider that collected everything and owed Ruido a share would be holding a
//   receivable rather than making a payment.
//
// So the commission is **a second transfer on the same rail**. Nothing here is a
// new mechanism: `paymentRequest` already takes the payee as an argument, and
// `verifyPayment` already refuses any transfer not addressed to its own payee. The
// second leg is an instance of the first.
//
// ## Who sends the second leg, and why it is the provider
//
// The buyer could pay both legs. The provider forwarding is better, and the
// reason is not convenience: **a check a provider is motivated to skip is not an
// enforcement mechanism.** A provider that stopped verifying the buyer's second
// leg would make its own orders cheaper and nobody could tell — Ruido cannot see
// which orders were placed. A forwarding, by contrast, is a transfer on a public
// rail, so non-payment becomes a **publishable finding** rather than an invisible
// one, and delisting from the book is the remedy.
//
// That is retroactive and not preventive, which is the honest limit of the
// arrangement. What it buys is that the buyer's flow stays one payee and one
// transaction — Ruido does not sit in the buyer's path.
//
// ## The rate, and why the default charges nothing
//
// `COORDINATION_FEE_BPS` is **zero**. Nothing in this repository charges or
// receives anything, and that stays true by default rather than by promise: a
// rate is a business decision, and `TOKEN.md` §5 says to run the market and
// discover the margin rather than assume one. The mechanism exists so that a rate
// can be set and disclosed; it is not set here.
//
// ## The amount is a fraction of the INVOICE, and it is quantised
//
// ```
// fee = floor(invoice.amount × bps / 10_000 / TAG_MOD) × TAG_MOD
// ```
//
// Written as arithmetic rather than as "5%", because two implementations of "5%"
// that round differently disagree about the amount and the buyer is who finds
// out. Floored twice and in the same direction, so the fee can never exceed the
// rate that was published. Quantised to `TAG_MOD` because the second leg needs
// the same room for its tag that the first one does — which is also why the
// invoice had to move to base units before a commission was expressible at all.

import { DOMAIN, hashFelt } from "./commitment.mjs";
import { baseAmount, paymentRequest, TAG_MOD } from "./payment.mjs";

/** Basis points in one whole. A rate is expressed against this, not against 1. */
export const BPS_SCALE = 10_000n;

/**
 * The rate Ruido charges, in basis points of the provider's invoice.
 *
 * Zero, and it is zero on purpose rather than because nobody got round to it. A
 * rate that is set here would be a rate published in a repository, which is a
 * promise; the market is supposed to discover the margin before anyone sets one.
 * A deployment that charges sets this, and the offer row then says so.
 */
export const COORDINATION_FEE_BPS = 0;

/**
 * The id of the commission's own invoice.
 *
 * Derived rather than reused: the two legs belong to the same order, and giving
 * the second one the first one's id would make two different amounts claim to be
 * the same bill. Derived in the same scheme as everything else, so "the id is a
 * hash of what it is about" stays one convention.
 */
export function commissionInvoiceId(invoiceId) {
  return hashFelt(DOMAIN.commission, invoiceId);
}

/**
 * The fee on an amount, in base units.
 *
 * Returns zero when the rate rounds the fee away — which is not an error here and
 * is one for `commissionRequest`, because the two questions are different: "what
 * is the fee" has the answer "nothing", while "what do I ask for" has no answer
 * at all when the amount is nothing.
 */
export function commissionFor(amount, { bps = COORDINATION_FEE_BPS } = {}) {
  if (!Number.isInteger(bps) || bps < 0) {
    throw new Error(`a coordination fee is a non-negative whole number of basis points, got ${bps}`);
  }
  if (BigInt(bps) > BPS_SCALE) {
    throw new Error(
      `a coordination fee of ${bps} basis points is more than the whole payment, ` +
        `which is not a fee. The ceiling is ${BPS_SCALE}`,
    );
  }
  const base = BigInt(amount);
  if (base < 0n) throw new Error(`a commission on a negative amount is not a commission, got ${base}`);

  const raw = (base * BigInt(bps)) / BPS_SCALE;
  return (raw / TAG_MOD) * TAG_MOD;
}

/**
 * The second leg, as the provider needs to send it.
 *
 * Both legs come from the same order id, so **both carry the same tag** and both
 * bind to the same order. The amounts differ, and that is what keeps the two
 * apart: `verifyPayment` matches on the exact figure, so a transfer of the
 * commission cannot be mistaken for the buyer's payment or the other way round.
 *
 * A zero fee throws rather than returning a request for nothing. A request whose
 * amount is zero would still carry a tag, so it would ask for a payment of a few
 * base units and verify against it — an amount that looks like a rounding error
 * and is not worth anyone's attention, which is exactly the kind of thing that
 * should be refused loudly instead.
 */
export function commissionRequest(invoice, { orderId, address, bps = COORDINATION_FEE_BPS, expiresAt = null } = {}) {
  if (!address) {
    throw new Error(
      "a commission needs somewhere to be sent: pass the address it is forwarded to, " +
        "or do not charge one",
    );
  }
  const billed = baseAmount(invoice);
  const amount = commissionFor(billed, { bps });
  if (amount === 0n) {
    throw new Error(
      `a ${bps} basis point commission on ${billed} base units rounds to nothing, so there ` +
        "is no second leg to ask for",
    );
  }

  return paymentRequest(
    { id: commissionInvoiceId(invoice.id), network: invoice.network, amount },
    { orderId, provider: address, expiresAt },
  );
}

/**
 * What a provider owes for one paid order, read from its own published terms.
 *
 * Returns `null` rather than a request for nothing when the terms declare no
 * fee, because "there is no second leg" and "there is a second leg for nothing"
 * are different states and `commissionRequest` refuses to express the second.
 *
 * Computed and returned, not sent. That split is the honest one: the arithmetic
 * needs no node, while SENDING the second leg needs a signed transaction and a
 * key — the same deferral as the emission, and for the same reason. So the
 * provider's obligation is expressed here, and `reconcile()` above is what turns
 * a forwarding that never arrived into a finding.
 *
 * The rate comes from the terms, and the terms' rate is checked by the book
 * (`readCoordination` in src/orderbook.mjs) against the protocol's own — so a
 * provider cannot arrive here having quietly agreed to a different one.
 */
export function commissionOwed(invoice, order, terms) {
  const declared = terms?.coordination ?? null;
  if (!declared) return null;
  return commissionRequest(invoice, {
    orderId: order.id,
    address: declared.address,
    bps: declared.bps ?? COORDINATION_FEE_BPS,
  });
}

/**
 * What an offer row says about the fee, so a buyer can compare two providers.
 *
 * A price with an undisclosed cut inside it is a price a buyer cannot compare
 * against another provider's, and being comparable is what the book is for. So a
 * non-zero rate with no address is refused here: it would disclose a fee with no
 * destination, which is a disclosure that says nothing.
 */
export function commissionDisclosure({ bps = COORDINATION_FEE_BPS, address = null } = {}) {
  if (!Number.isInteger(bps) || bps < 0) {
    throw new Error(`a coordination fee is a non-negative whole number of basis points, got ${bps}`);
  }
  const charged = bps > 0;
  if (charged && !address) {
    throw new Error(
      `a ${bps} basis point coordination fee needs the address it is forwarded to, or the ` +
        "row discloses a fee that goes nowhere",
    );
  }
  return {
    bps,
    charged,
    address: charged ? address : null,
    note: charged
      ? `the price includes a ${bps / 100}% coordination fee, forwarded to ${address} by the ` +
        "provider once the window closes. It is part of the price above, not added to it."
      : "no coordination fee is charged, and a row would say so if one were",
  };
}

/**
 * Which orders actually paid their commission.
 *
 * Four answers, because they lead to four different actions and collapsing them
 * loses the only evidence there is — the same reason `verifyPayment` keeps four
 * apart rather than two:
 *
 *   forwarded   a transfer of exactly the amount due        → nothing to do
 *   short       a transfer below it, by less than `TAG_MOD`  → the tag was dropped
 *   missing     no transfer for this order at all            → the provider kept it
 *   unmatched   a transfer to Ruido that fits no order       → a payment nobody can attribute
 *
 * `short` is separate from `missing` because the tag is the only part of the
 * amount below `TAG_MOD`, so a forwarding that dropped it lands within `TAG_MOD`
 * of the figure due. "You forgot the tag" and "you kept the fee" are different
 * findings, and only one of them is a reason to delist.
 *
 * Matching is on the amount alone. The sender is not checked because it is not
 * known: a provider's published address is where it is *paid*, not where it pays
 * from, and the rail's whole binding trick is that the amount carries the
 * identity rather than the parties.
 *
 * ## The one thing this cannot attribute, said out loud
 *
 * Two orders with the same base amount differ only in their tags. A forwarding
 * that dropped the tag is therefore within `TAG_MOD` below **both** of them, and
 * the transfer itself says nothing about which one it pays — so the first order
 * in `expected` takes it and the other is reported missing. The finding is
 * unaffected, because the actionable part is "a tagless forward arrived" either
 * way; which order it belongs to is a question the transfer does not answer, and
 * `short` does not pretend otherwise. Pinned by a test, because an attribution
 * rule that is only an accident of iteration order is not a rule.
 */
export function reconcile({ expected = [], transfers = [] } = {}) {
  const forwarded = [];
  const short = [];
  const missing = [];
  const matched = new Set();

  for (const want of expected) {
    const due = BigInt(want.amountDue);

    const exact = transfers.find((t) => !matched.has(t) && BigInt(t.value) === due);
    if (exact) {
      matched.add(exact);
      forwarded.push({ ...want, transfer: exact });
      continue;
    }

    const near = transfers.find(
      (t) => !matched.has(t) && BigInt(t.value) < due && due - BigInt(t.value) < TAG_MOD,
    );
    if (near) {
      matched.add(near);
      short.push({
        ...want,
        transfer: near,
        shortBy: due - BigInt(near.value),
        why: "the transfer is below the amount due by less than one tag, so the tag is the part that is missing",
      });
      continue;
    }

    missing.push({ ...want });
  }

  return {
    forwarded,
    short,
    missing,
    unmatched: transfers.filter((t) => !matched.has(t)),
  };
}

// The fourth step: publishing the reveal, and the one rule that protects it.
//
// The reveal is the half the buyer keeps. It carries both salts and the rung,
// and it is the evidence settlement runs on — so publishing it is not a
// formality, it is the act that closes the buyer's side of the trade.
//
// ## The hazard is publishing it too early
//
// The provider is given the window and never the denomination. That split is the
// entire design: the denomination is the only axis a buyer can withhold, and
// withholding it is priced at exactly the ladder width (see docs/CUSTOMER.md).
// Publishing the reveal while the window is still open hands the provider the
// rung **before it emits** — and the cover it then emits can be aimed straight
// at the buyer's cell, or worse, the provider can simply not emit at all and
// keep the fee. The buyer's window is the blocks the adversary searches; until
// the last of those blocks is behind us, the reveal is still a secret.
//
// So the rule is not "publish after you transact". It is: **the reveal is
// publishable only once the window has closed**, and that is a comparison
// against the chain's height, not a matter of the buyer's judgement.
//
// ## Why this fails CLOSED
//
// A caller who cannot say what block we are at cannot be told "go ahead". The
// tempting default — treat an unknown height as "probably fine" — turns a
// missing RPC into a rung handed over early, which is silent and irreversible.
// An unknown height is a refusal here, and the CLI surfaces it as one.
//
// ## Validity and publishability are different questions
//
// A reveal can open both commitments and still be unpublishable, because the
// window has not closed. Collapsing the two into one boolean would lose the only
// thing the buyer needs to know in that moment: not "is my reveal wrong" but
// "how long do I have to wait".

import { verifyReveal } from "./commitment.mjs";
import { claim, settle } from "./settlement.mjs";
import { parseReveal } from "./order.mjs";
import { readBlockHeight } from "./blockheight.mjs";

/** The block range a reveal's window covers, inclusive at both ends. */
export function revealWindow(reveal) {
  return { from: reveal.window.from, to: reveal.window.to };
}

/**
 * Whether the window is behind us at a given block height.
 *
 * `atBlock` is inclusive-of-now: if the chain is at the window's last block, a
 * decoy can still land in it, so the window is still open. The comparison is
 * therefore strictly greater, and the off-by-one is the difference between
 * protecting the buyer and not.
 *
 * Returns `null` — not `false` — when the height is unknown, because "we do not
 * know" and "not yet" lead to different actions and only one of them is a wait.
 */
export function windowHasClosed(reveal, atBlock) {
  if (!Number.isInteger(atBlock)) return null;
  return atBlock > reveal.window.to;
}

/** How many more blocks have to pass before the reveal may be published. */
export function blocksUntilReveal(reveal, atBlock) {
  if (!Number.isInteger(atBlock)) return null;
  // The first block at which publishing is safe is `to + 1`, so the wait is
  // measured from the current height to that block.
  return Math.max(0, reveal.window.to + 1 - atBlock);
}

/**
 * The full verdict on a reveal: does it open the order, and may it be published.
 *
 * Both parts are returned even when the first fails, so a caller can tell a
 * buyer whose reveal is wrong from one who simply has to wait. `reason` names
 * the first thing that stops publication, and `publishable` is the single
 * boolean a caller should branch on.
 */
export function checkReveal(order, reveal, { network, atBlock }) {
  const verdict = verifyReveal(order, reveal, { network });

  if (!verdict.ok) {
    return {
      publishable: false,
      reason: !verdict.windowOk
        ? "the reveal does not open the order's window commitment"
        : !verdict.denominationOk
          ? "the reveal does not open the order's denomination commitment"
          : "the reveal's order id is not derived from this order's commitments",
      verdict,
      closed: null,
      waitBlocks: null,
    };
  }

  const closed = windowHasClosed(reveal, atBlock);

  if (closed === null) {
    return {
      publishable: false,
      reason: "the current block height is unknown, so the window cannot be shown to have closed",
      verdict,
      closed: null,
      waitBlocks: null,
    };
  }

  if (!closed) {
    return {
      publishable: false,
      reason: `the window is still open at block ${atBlock} (it runs to ${reveal.window.to})`,
      verdict,
      closed: false,
      waitBlocks: blocksUntilReveal(reveal, atBlock),
    };
  }

  return { publishable: true, reason: null, verdict, closed: true, waitBlocks: 0 };
}

/**
 * Where the height a settlement runs against comes from.
 *
 * Three sources, and the difference between them is **who is trusted** — which
 * is why the settlement records it rather than quietly using whichever number
 * was to hand:
 *
 *   `pinned`   the operator said what block it is (`--at`). Trusted as far as
 *              the operator is trusted, and no further: it is a human typing a
 *              number, and it goes stale the moment the chain moves.
 *   `provider` read from the chain by this provider. The strongest of the three,
 *              and the only one where the provider is not taking anyone's word.
 *   `buyer`    the buyer's own assertion. Unverified, and labelled as such.
 *
 * The provider is the party that **benefits** from receiving a reveal early, so
 * `buyer` is the weakest arrangement: it makes the interested party the only
 * witness. That is why it is the default only for a provider with no chain
 * source, and why the settlement says so in words.
 */
export const HEIGHT_SOURCE = { PINNED: "pinned", PROVIDER: "provider", BUYER: "buyer" };

/** The sentence that goes in the settlement for each source. */
export function heightNoteFor(source) {
  if (source === HEIGHT_SOURCE.PINNED) {
    return "pinned by the operator with --at; the buyer's number is ignored, and so is the chain's";
  }
  if (source === HEIGHT_SOURCE.PROVIDER) {
    return "read from the chain by this provider; the buyer's number is ignored";
  }
  return "the height was taken from the buyer and NOT verified — this provider has no chain source; a real one reads its own node";
}

/**
 * Resolves the height for one reveal, or refuses.
 *
 * `mode` is `"pinned"`, `"verify"` or `"buyer"`, and it is the operator's
 * declared intent rather than a guess. The important case is `"verify"`: when
 * the read fails this **refuses**, and it does not fall back to the buyer's
 * number. An operator who asked for a check and got a formality instead has been
 * told something untrue about their own settlement — which is the same failure
 * as a stale figure, with a worse consequence.
 *
 * Returns `{ ok: true, atBlock, heightSource }` — where `atBlock` is `null` for
 * the `buyer` mode, meaning "use the one in the request" — or
 * `{ ok: false, status, body }` for a refusal the route should send as-is.
 *
 * `read` is injectable so the three modes can be tested without a network.
 */
export async function resolveHeight({ mode = HEIGHT_SOURCE.BUYER, pinned = null, network, endpoints, read = readBlockHeight } = {}) {
  if (mode === HEIGHT_SOURCE.PINNED) {
    if (!Number.isInteger(pinned)) {
      // Refused rather than treated as unset: an operator who asked for a pinned
      // height and got a typo should not silently fall through to the buyer's.
      return {
        ok: false,
        status: 500,
        body: { error: `--at must be a block number, got ${JSON.stringify(pinned)}` },
      };
    }
    return { ok: true, atBlock: pinned, heightSource: HEIGHT_SOURCE.PINNED };
  }

  if (mode === HEIGHT_SOURCE.PROVIDER) {
    const height = await read({ network, endpoints });
    if (!Number.isInteger(height)) {
      return {
        ok: false,
        status: 400,
        body: {
          error: "the chain height could not be read, so the window cannot be shown to have closed",
          reason:
            "this provider was asked to verify the height and could not, and it will not fall back to the buyer's number — falling back is exactly the check that was asked for",
          endpoints: endpoints ?? null,
        },
      };
    }
    return { ok: true, atBlock: height, heightSource: HEIGHT_SOURCE.PROVIDER };
  }

  return { ok: true, atBlock: null, heightSource: HEIGHT_SOURCE.BUYER };
}

/**
 * The provider's side of the fourth step, as a decision rather than a route.
 *
 * This is the whole of `POST /orders/:id/reveal` minus the HTTP: it takes the
 * record's state, the request body and the claim registry, and returns the
 * status and body the route should send. It lives here rather than in the
 * script for the same reason `order.mjs` owns the wire format — a rule that
 * only exists inside a server cannot be tested without starting one, and a rule
 * that cannot be tested is a rule that drifts away from the one the buyer runs.
 *
 * Note the order of the checks. The window is asked about **last**, after the
 * reveal has been shown to open the commitments, because "your reveal is wrong"
 * and "your reveal is right but early" are different answers and only one of
 * them is worth waiting for.
 *
 * `heightSource` records where `atBlock` came from. A provider that read it from
 * its own node and one that took the buyer's word are in different positions,
 * and the settlement says which one this is instead of implying a check that
 * did not happen.
 */
export function admitReveal({
  order,
  state,
  planned = 0,
  settled = null,
  body,
  atBlock,
  heightSource = "buyer",
  network,
  claimed = new Map(),
}) {
  // Idempotent, and checked BEFORE the state guard. Settling moves the record to
  // `revealed`, so a guard that only admits `emitted` would answer a re-send
  // with "the invoice is not paid, so there is nothing to settle" — a 409 about
  // a paid invoice, sent to a buyer whose order is already settled. The more
  // specific fact wins: if there is a settlement, this is a duplicate.
  if (settled) {
    return { ok: true, status: 200, body: { ...settled, duplicate: true }, claimed };
  }

  if (state !== "emitted") {
    return {
      ok: false,
      status: 409,
      body: { error: "the invoice is not paid, so there is nothing to settle", state },
      claimed,
    };
  }

  if (!body?.reveal) {
    return { ok: false, status: 400, body: { error: "a reveal is required" }, claimed };
  }

  if (!Number.isInteger(atBlock)) {
    // Settling without knowing the window closed is settling blind: a decoy is
    // only in the cell if the window it landed in has passed.
    return {
      ok: false,
      status: 400,
      body: { error: "atBlock is required — settlement has to know the window has closed" },
      claimed,
    };
  }

  if (!(Number(body.cell) > 0)) {
    return {
      ok: false,
      status: 400,
      body: { error: "cell is required — the candidate count the order was priced against" },
      claimed,
    };
  }

  // A malformed reveal must be a refusal, not an exception. `parseReveal` calls
  // `BigInt()` on four fields and throws on any that is missing, so the window
  // proof — which is exactly the right thing to send at order time and has no
  // denomination — would take the provider down instead of being turned away.
  let reveal;
  try {
    reveal = parseReveal(body.reveal);
  } catch (error) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "the reveal is malformed",
        reason: error.message,
        // Named because it is the mistake this route is most likely to see: the
        // window proof is a subset of the reveal, so sending it here is the
        // natural error, and it is a refusal rather than a settlement.
        hint: "a reveal carries `denomination` and `denominationSalt` as well as the window half; a window proof does not, and cannot settle anything",
      },
      claimed,
    };
  }

  const check = checkReveal(order, reveal, { network, atBlock });
  if (!check.publishable) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "the reveal is not publishable",
        reason: check.reason,
        verdict: check.verdict,
        // The wait is the useful part of this refusal: the reveal is fine, it is
        // simply early, and the number of blocks left is what to act on.
        waitBlocks: check.waitBlocks,
      },
      claimed,
    };
  }

  // The emissions to count. Empty today, and that is the honest value: a note id
  // only exists once an emission lands, and the emitter is what puts one there.
  // `observedDecoys` is the seam it will fill; counting the plan would be
  // claiming bits for work not done.
  const observed = Array.isArray(body.observedDecoys) ? body.observedDecoys : [];

  const settlement = settle({
    order,
    reveal,
    decoys: observed,
    claimed,
    targetCell: Number(body.cell),
    network,
  });

  if (!settlement.ok) {
    return {
      ok: false,
      status: 400,
      body: { error: "settlement failed", reason: settlement.reason, verdict: settlement.verdict },
      claimed,
    };
  }

  // `claim` is the tested version of "write these note ids down", and it throws
  // if the registry disagrees with the settlement about who owns one. Reaching
  // into the Map directly would skip that check, and the check is the only thing
  // standing between one batch of decoys and being sold twice.
  const next = claim(claimed, order, settlement);

  return {
    ok: true,
    status: 200,
    body: {
      id: order.id,
      state: "revealed",
      planned,
      settlement,
      atBlock,
      heightSource,
      // One place builds the sentence, so a source cannot exist without a
      // description of what trusting it means.
      heightNote: heightNoteFor(heightSource),
      emission: observed.length === 0
        ? "nothing has been emitted, so nothing could land — the plan is real, the emission is a stand-in for the emitter"
        : "settled against the emissions presented",
    },
    claimed: next,
  };
}

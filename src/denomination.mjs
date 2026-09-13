// The denomination axis: which notes have a publicly derivable amount, and how
// small that makes the candidate set.
//
// Extracted from the measurement script because the join had a real bug and a
// bug in a join is invisible. The first version treated every money-in event as
// evidence about every note in its transaction, which meant an open-note deposit
// was broadcast to the encrypted notes sitting beside it in the same batch. 470
// transactions and 513 notes were affected, and nothing about the resulting
// numbers looked wrong. The fix is that the two routes are now separate and
// named, so a test can pin each one.
//
// Route A, explicit: an open note publishes note_id, and OpenNoteDeposited
// publishes the same note_id with an amount. Verified on the deployed pool: 730
// created, 730 deposited, 730/730 in the same transaction, note_id unique on
// both sides, no orphans in either direction. The pairing is exact.
//
// Route B, transaction: the note's transaction carries exactly one distinct
// Deposit. Only Deposit counts. An OpenNoteDeposited is not evidence about any
// other note in the transaction.
//
// Everything else stays unknown. A change note minted by spending an existing
// note has no deposit anywhere in its transaction, and its amount is
// unobservable — EncNoteCreated.packed_value was tested for it and does not
// carry it.

/** Events that mint a note. */
export const NOTE_EVENTS = new Set(["EncNoteCreated", "OpenNoteCreated"]);

/** The bucket a note belongs to: same token and same amount is the same bucket. */
export const amountKey = (note) => `${note.token}|${note.amount}`;

/**
 * Assign an amount to every note that has one, and a route name to every note.
 *
 * Mutates `notes`, adding `token`, `amount` and `amountRoute`. Returns how many
 * notes came by each route, so coverage is reported rather than assumed.
 */
export function assignAmounts(events, notes) {
  // note_id -> { token, amount } from the open-note deposit event.
  const openNoteAmount = new Map();
  for (const e of events) {
    if (e.name === "OpenNoteDeposited" && e.amount) {
      openNoteAmount.set(e.note_id, { token: e.token ?? null, amount: e.amount });
    }
  }

  // tx -> Map("token|amount" -> { token, amount }) over Deposits only.
  const depositByTx = new Map();
  for (const e of events) {
    if (e.name !== "Deposit" || !e.amount) continue;
    if (!depositByTx.has(e.tx)) depositByTx.set(e.tx, new Map());
    depositByTx.get(e.tx).set(`${e.token}|${e.amount}`, { token: e.token ?? null, amount: e.amount });
  }

  const routes = { explicit: 0, transaction: 0, unknown: 0 };

  for (const note of notes) {
    const explicit = note.noteId ? openNoteAmount.get(note.noteId) : null;
    if (explicit) {
      note.token = explicit.token;
      note.amount = explicit.amount;
      note.amountRoute = "explicit";
      routes.explicit += 1;
      continue;
    }

    const inTx = depositByTx.get(note.tx);
    if (inTx && inTx.size === 1) {
      const [only] = [...inTx.values()];
      note.token = only.token;
      note.amount = only.amount;
      note.amountRoute = "transaction";
      routes.transaction += 1;
      continue;
    }

    note.amountRoute = "unknown";
    routes.unknown += 1;
  }

  return routes;
}

/** How many notes share each (token, amount). A round denomination is a small bucket. */
export function bucketSizes(visible) {
  const buckets = new Map();
  for (const note of visible) buckets.set(amountKey(note), (buckets.get(amountKey(note)) ?? 0) + 1);
  return buckets;
}

/** Index of the first note with block >= value. `blocks` must be sorted. */
export function lowerBound(blocks, value) {
  let lo = 0;
  let hi = blocks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Notes within `window` blocks of `target` that share its denomination. */
export function amountInWindow(visible, blocks, target, window) {
  const key = amountKey(target);
  let count = 0;
  for (let i = lowerBound(blocks, target.block - window); i < visible.length; i += 1) {
    if (visible[i].block > target.block + window) break;
    if (amountKey(visible[i]) === key) count += 1;
  }
  return count;
}

const bits = (n) => (n > 0 ? Math.log2(n) : 0);
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const fraction = (values, test) => (values.length ? values.filter(test).length / values.length : 0);
const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * The models. `amount` is the global same-denomination set; `timing+amount` adds
 * the block window.
 *
 * The target list must be drawn from `visible`. A note whose amount is unknown
 * cannot be a target of this attack, because the attack starts from knowing the
 * amount.
 */
export function denominationModels(targets, visible, buckets, windows) {
  if (!targets.length) return [];
  const out = [];

  const global = targets.map((t) => buckets.get(amountKey(t)) ?? 1);
  out.push({
    model: "amount",
    description: "Adversary knows the amount. Set is every note in the pool of the same denomination.",
    candidates: Number(mean(global).toFixed(2)),
    median: median(global),
    bits: Number(bits(mean(global)).toFixed(3)),
    fractionAlone: Number(fraction(global, (c) => c <= 1).toFixed(3)),
  });

  const blocks = visible.map((n) => n.block);
  for (const window of windows) {
    const counts = targets.map((t) => amountInWindow(visible, blocks, t, window));
    out.push({
      model: `timing+amount ±${window}`,
      description: `Adversary knows the amount and the block to within ${window}.`,
      candidates: Number(mean(counts).toFixed(2)),
      median: median(counts),
      bits: Number(bits(mean(counts)).toFixed(3)),
      fractionAlone: Number(fraction(counts, (c) => c <= 1).toFixed(3)),
    });
  }

  return out;
}

/**
 * Evenly spread samples across a list, without replacement.
 *
 * Spreading matters: the notes cluster in bursts, and a prefix sample would
 * measure the busiest burst and call it the pool.
 */
export function sampleOf(list, limit) {
  if (list.length <= limit) return [...list];
  const step = Math.max(1, Math.floor(list.length / limit));
  const out = [];
  for (let i = 0; i < list.length && out.length < limit; i += step) out.push(list[i]);
  return out;
}

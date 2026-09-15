// What a provider must be able to do before it may sell.
//
// This module imports nothing, and that is the reason it is a module at all. The
// same sentence is read by two sides running in two different runtimes: the
// provider decides with it in Node, and the screen a buyer reads decides with it
// in a browser. `src/provider.mjs` reaches `src/payment.mjs` for `TAG_MOD`, and
// `payment.mjs` evaluates `Buffer.from("Transfer", "ascii")` at module scope for
// the transfer selector — so importing the decision from there drags the whole
// payment rail, and a Node global, into the page.
//
// The two ways out are both worse. Duplicating the sentence lets the two copies
// drift into two claims that disagree, and the reader has no way to tell which is
// true. Porting `keccak.mjs` off `Buffer` is worth doing and is a change to a
// core module, not a prerequisite for showing a buyer one line of text. A module
// with no imports is neither.

/**
 * Why a provider with no emitter cannot sell, in the words both sides use.
 *
 * One constant rather than a sentence in each place, because the same fact is
 * now read in three: the provider refuses with it, the book lists it, and the
 * screen refuses to hand over a command over it.
 */
export const NO_EMITTER =
  "this provider has no emitter, so it cannot accept an order it could not fulfil — " +
  "and accepting one IS the commitment to emit. The emitter is the piece this " +
  "repository has not written yet";

/**
 * Whether a provider described by these terms can serve a buyer at all.
 *
 * This is the buyer's-side mirror of `acceptOrder`'s first check, and it exists
 * so the two cannot drift apart. It answers the question BEFORE an order is
 * built, which is the point: a buyer who learns the provider cannot deliver
 * after making a transfer has learned it too late, and a transfer is not
 * reversible.
 *
 * Deliberately narrower than "will this order be accepted". Terms cannot answer
 * that — the order's version, network, decoy count and window proof are not in
 * them. It answers only the part that is a property of the provider, so that a
 * refusal can be attributed to the right party.
 *
 * Only an explicit `true` counts. `terms.emits` is a boolean when this repository
 * serves it, but these terms arrive over HTTP from whoever is at the URL, and the
 * string `"false"` is truthy. Every other value — absent, `null`, `0`, `"false"`,
 * `"no"` — is not a declaration that the provider can deliver, and the failure
 * this guards against is a buyer transferring money for cover nobody will emit.
 * An ambiguous answer is a no.
 */
export function canSell(terms) {
  if (terms?.emits !== true) return { ok: false, reason: NO_EMITTER };
  return { ok: true, reason: null };
}

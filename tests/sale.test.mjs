// The gate that decides whether a provider may sell at all.
//
// It is small enough to look obviously correct, and it is the check that decides
// whether a buyer's screen hands over a command or a warning. Three things about
// it are worth pinning:
//
//   1. Only an explicit `true` counts. These terms arrive over HTTP from whoever
//      is at the URL, and the string "false" is truthy — so a gate written as
//      `if (!terms.emits)` would let a provider that cannot deliver straight
//      through, on a page whose whole job is to stop exactly that.
//   2. The provider's refusal and the buyer's verdict are the same sentence. Two
//      copies of one claim drift, and a reader has no way to tell which is true.
//   3. The book's row and the gate agree. A row that read the string as a yes
//      would list a provider that cannot deliver as one that can, while the gate
//      refused it — two facts about one provider, on one page, disagreeing.

import test from "node:test";
import assert from "node:assert/strict";

import { NO_EMITTER, canSell } from "../src/sale.mjs";
import { acceptOrder, providerTerms } from "../src/provider.mjs";
import { offerFromTerms } from "../src/orderbook.mjs";

const ADDRESS = "0x0111";

test("a provider that declares it can emit passes the gate", () => {
  const verdict = canSell(providerTerms({ network: "sepolia", emits: true }));
  assert.equal(verdict.ok, true);
  assert.equal(verdict.reason, null);
});

test("a provider that declares it cannot emit is refused, with the reason", () => {
  const verdict = canSell(providerTerms({ network: "sepolia", emits: false }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, NO_EMITTER);
});

test("only an explicit true passes, because no other value is a declaration", () => {
  // `"false"` is the one that matters: it is what a provider written in another
  // language sends when its boolean is a string, and it is truthy.
  for (const emits of [undefined, null, 0, 1, "", "false", "true", "no", {}, []]) {
    const verdict = canSell({ emits });
    assert.equal(verdict.ok, false, `emits=${JSON.stringify(emits)} passed the gate`);
    assert.equal(verdict.reason, NO_EMITTER);
  }
});

test("terms that are not there at all are refused rather than throwing", () => {
  for (const terms of [undefined, null]) {
    assert.equal(canSell(terms).ok, false);
  }
});

test("the provider's refusal and the buyer's verdict are the same sentence", () => {
  // The invariant. `acceptOrder` refuses on the first check, before it reads the
  // order, so an empty order is enough to reach it.
  const terms = providerTerms({ network: "sepolia", address: ADDRESS, emits: false });
  const refused = acceptOrder({}, null, { terms });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, canSell(terms).reason);
});

test("the book's row and the gate agree about a provider that sends \"false\"", () => {
  const terms = { ...providerTerms({ network: "sepolia", address: ADDRESS }), emits: "false" };
  const offer = offerFromTerms(terms, {
    endpoint: "http://127.0.0.1:8081",
    registeredAt: "2026-09-14T00:00:00Z",
  });
  assert.equal(offer.emits, false);
  assert.equal(canSell(offer).ok, false);
});

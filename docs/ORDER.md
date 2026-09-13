# How a customer places an order

This is the customer's side of Ruido, and it is the side that does not need the
node. No RPC, no prover, no pool key, no wallet connection, no STRK in the
customer's hands until they choose to pay. Everything in this document runs
offline and is implemented in `src/commitment.mjs`, `src/quote.mjs`,
`src/order.mjs`, `src/settlement.mjs` — plus `src/provider.mjs`, which is the
counterparty, because a protocol with one side is a monologue.

Both commands in this document run, and the exchange between them is exercised
end to end by `tests/provider.test.mjs` without touching a chain.

```bash
npm run measure                                  # read "cell before any cover"
npm run quote -- --cell 1.93 --bits 3 --mode window --from 14865231

# Or actually place one, against a provider:
npm run serve:provider                           # in one shell, on :8081
npm run buy -- --provider http://127.0.0.1:8081 \
               --cell 1.93 --bits 3 --mode window \
               --from 14865231 --denomination 10
```

## The trade in six steps

| # | step | who | what it costs them |
|---|---|---|---|
| 1 | **Measure** | buyer | nothing. Public RPC, no wallet, no account |
| 2 | **Order** | buyer → provider | nothing yet. An order is two commitments and a window |
| 3 | **Pay** | buyer → provider | the invoice, in STRK — one `apply_actions` call per decoy |
| 4 | **Emit** | provider, inside the window | the pool fee and the gas. **This is the work being bought** |
| 5 | **Transact** | buyer, their own wallet | their normal transaction, untouched |
| 6 | **Reveal** | buyer → public | the preimage, after the window closes |

The buyer's own transaction is unmodified — Ruido does not wrap it, proxy it, or
sit in its path. Step 4 is the only step that needs a node, and it is the
provider's, not the customer's.

## Step 2 and 3: what the provider is given

The order carries the window **in the clear**, as a courtesy copy, because the
provider has to emit inside that window. A plaintext field the other side acts
on is a claim, not a commitment, so the buyer also sends the **window proof**:
the window preimage, which the provider checks against the window commitment
*before* it spends anything.

That check is the provider's only defence, and it has to run at accept time.
A buyer who commits to one window while naming another gets the work done for
free: the provider emits in the named window, the reveal opens the committed one,
the cell is empty, and settlement returns `window-mismatch` on an order that has
already been paid for.

The proof is its own function — `serialiseWindowProof` in `src/order.mjs` —
with its own key set, because the failure it prevents is a client that
"helpfully" sends the whole reveal so the provider can verify the order. That
sends the denomination too, and the split commitment was for nothing. The exact
key set is asserted by a test, not by a comment.

The provider also never learns the **cell** the buyer priced against. It sells
**decoys**; the buyer buys **bits**, and the conversion between them is the
buyer's own measurement. A buyer who understates the cell pays less and receives
fewer bits, which settlement reports as a shortfall — so the incentive runs the
right way and the provider does not need to audit a number it cannot see.

### The reference implementation

| endpoint | body | returns |
|---|---|---|
| `GET /terms` | — | network, ladder, fee per call, margin, address, cap |
| `POST /orders` | `{ order, windowProof }` | `201` with the invoice, or `422` with the reason |
| `POST /orders/:id/payment` | `{ txHash, block }` | the decoy plan, and `emitted` |
| `GET /orders/:id` | — | state, invoice, and the plan **once paid** |

`scripts/serve-provider.mjs` is that service on loopback, and
`scripts/buy.mjs` is the client. What is deliberately missing from it: TLS,
authentication, rate limiting, and a durable order book. Those are not the
interesting part of the protocol, but a public provider needs all four.

## Step 2 is where the design lives: the split commitment

The buyer commits to a **cell** — a block window and a denomination — and the
provider needs one half of it.

**It needs the window.** Cover that lands after the spend protects nobody, so a
provider that does not know *when* cannot deliver anything in time. Timing is a
precondition of the service, not a secret the buyer can keep.

**It must not get the denomination.** That is the only axis a buyer can withhold,
and the measurement prices withholding it.

A single `H(window, denomination, nonce)` cannot express that split, because
opening the window opens the denomination with it. So there are two commitments:

```
C_w = keccak("ruido.window.v1" ‖ network ‖ from ‖ to ‖ windowSalt)
C_d = keccak("ruido.denom.v1"  ‖ network ‖ denomination ‖ denominationSalt)
id  = keccak("ruido.order.v1"  ‖ network ‖ C_w ‖ C_d ‖ decoys)
```

`C_w` is published and its preimage goes to the provider, so the window is bound
*and* known. `C_d` is published and its preimage is kept until the window closes.
The order id is **derived**, not assigned, so both sides compute the same value
from the same published order and there is no identifier to disagree about.

Two details in there are load-bearing rather than hygiene, and both have tests:

- **Domain separation.** Both halves hash small integers. Without the tags, a
  window edge of `10` and a denomination of `10` commit to the same value and a
  reveal could be replayed against the wrong half.
- **Full-width salts.** A denomination is one of seven values. With a short
  nonce, anyone can brute-force the commitment in seven tries and read the rung
  straight off the order book — which is the one thing the split exists to
  prevent. `tests/order.test.mjs` breaks an unsalted commitment and then fails to
  break a real one, so the argument is demonstrated rather than asserted.

## What the order costs: ask for bits, not decoys

The price per bit is a **curve**, not a number: bits grow logarithmically while
cost grows linearly, so the marginal bit gets dearer and there is no volume
discount. Quoting one figure is not quoting a price — that mistake was made in
public in this repository, twice.

So the order form asks how many **bits** the buyer wants, and the model is
inverted exactly:

```
bits   = log2((cell + landed) / cell)
landed = cell * (2**bits - 1)
decoys = ceil(landed / landingRate)
```

`landingRate` is the fraction of emitted decoys that land in the cell the
adversary actually searches, and it is geometry, not statistics:

| position | provider knows | landing rate | decoys for 3 bits | cost |
|---|---|---|---|---|
| **aimed** | window + denomination | 1 in 1 | 14 | 28 STRK |
| **window-only** | window only | 1 in 7 | 95 | 190 STRK |
| **blind** | nothing | 1 in 1,709 | 22,517 | 45,034 STRK |

Against a cell of 1.93 candidates. **For the same anonymity, withholding the
denomination costs exactly the ladder width** — you have to emit every rung to
hide which one is yours — and blind cover costs `1/landingRate`.

Note what those numbers are *not*. They are the same-bits comparison, which is
what a buyer asks. The measurement's placement table compares at the same
*budget*, where window-only looks like 3.5× rather than 7× — both are true, they
answer different questions, and conflating them is how "300×" once got published
here. `docs/CUSTOMER.md` has both, labelled.

## Step 6 and settlement

At reveal the buyer publishes `{ from, to, windowSalt, denomination,
denominationSalt }`. Anyone can then recompute `C_w`, `C_d` and the order id, and
count the decoys that landed in the cell. No trust in the buyer, the provider, or
us.

Note that this is the **first** time the denomination half becomes public. The
provider had the window from step 2 and still does not know which decoy was the
buyer's — the plan draws every rung uniformly, so the rung it was never told
stays indistinguishable from the ones it emitted.

Settlement reports two different numbers on purpose:

- **emitted** — every decoy the provider presents. This is the work, and it is
  verifiable from the chain.
- **claimable** — the decoys in the revealed cell that no other order has already
  claimed. This is the value.

They differ whenever the position is window-only, and collapsing them into one
"payout" figure would hide a decision that belongs in a contract, not a library.

### The double-sell guard is the part that gets skipped

Windows overlap constantly — the buyer's window is a handful of blocks around a
block the adversary already knows — so **a decoy in one buyer's cell is usually
in several others' too**. Without a first-claim rule, one batch of decoys can be
sold to every buyer who asks and the market is a fiction.

The registry is a map from note id to the order id that claimed it, and first
write wins. Re-settling the *same* order is idempotent rather than a second sale,
which matters because a settlement has to be safe to recompute during a dispute.

A failed settlement keeps its reason apart — `window-mismatch` versus
`denomination-mismatch`. Those are different attacks, and collapsing them into
`false` throws away the only evidence the process has.

## What is built, and what is not

| piece | state |
|---|---|
| the split commitment | **built and tested** |
| the quote (bits → decoys → STRK) | **built and tested** |
| the order wire format | **built and tested**, including the JSON round trip |
| the window proof a provider is given | **built and tested**, with its key set asserted |
| settlement + the double-sell guard | **built and tested** |
| a CLI a buyer can actually run | **built** — `npm run quote` prices, `npm run buy` places |
| a provider that reads, prices and plans an order | **built** — `src/provider.mjs`, tested end to end |
| a provider that **broadcasts** the plan | **not built.** This is the emitter, and it needs the local node. The plan is real; the emission is a stand-in |
| a payment rail | **not built.** An invoice, a tx hash, and a checkable transfer. No escrow, no custody, no refund path — `TOKEN.md` §5 says run it invoiced or prepaid first |
| an order book | **not built.** Nothing lists orders or matches them. A provider is reached by URL |
| a provider worth trusting | **not built.** The reference is loopback-only, with no TLS, no auth and no rate limiting. It also learns **when** each buyer transacts, which is the position being sold and belongs in a written policy |
| on-chain verification | **not built.** Settlement here runs on a JSON file, not on Starknet |

## Traps paid for

1. **`JSON.stringify` throws on `BigInt`.** Every felt is hex on the wire, and
   the round trip is tested — build, serialise, parse, settle. A serialiser that
   works in memory and explodes when a buyer saves the order is the failure mode.
2. **A CLI that builds an order differently from the tested code.** The
   construction lives in `src/order.mjs` and the CLI is a printer, because a demo
   that passes while the product leaks is exactly what this split is defending
   against. There is a test asserting the public half carries no salt and no rung.
3. **The `--cell` default.** There isn't one. The cell size is a measurement of a
   specific pool at a specific time, and hardcoding one in the CLI would be the
   hand-copied number this repository exists to catch. `--cell` is required and
   the error message says where to read it.
4. **The window in the order is not the binding one.** It is a courtesy copy for
   the provider. Only the preimage behind `C_w` is binding, which is why a
   settlement that trusts the order's plaintext window is broken — and why the
   provider has to check the proof before it emits rather than at settlement.
5. **Blind cover is not a fallback.** At 45,034 STRK for three bits it is not a
   cheaper option that happens to be weaker; it is a different order of
   magnitude, and the quote says so before anyone commits.
6. **A provider that spreads its decoys wider than the window.** The quote prices
   window-only at a landing rate of `1/ladder`, which assumes every decoy clears
   the block filter by construction. Placing them over a larger span is cheaper,
   easy to do by accident, and delivers a fraction of the bits that were sold
   while charging for all of them. `planDecoys` places every decoy inside the
   window, and the realised rate is **measured against the quoted one** over
   thousands of decoys rather than asserted from the implementation. The mutation
   — spreading them 7× wider — reports `1.89% against a quoted 14.29%`.
7. **A "machine-readable" mode that also prints prose.** `npm run buy --json`
   emits one JSON object and nothing else, because a client that has to strip a
   human report before parsing is a client that will drift from it.
8. **The heading states a count.** "Six ways in" is checked against the number of
   cards by a test, because a section that lists five and says six is a small
   claim that is not true — which in this project is the whole problem.

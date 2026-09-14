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

Six steps in the trade, but **four for the customer**, which is the same list
seen from their side: measure (1), order (2), transact (5), reveal (6). Steps 3
and 4 are the provider's, and the customer's only involvement in them is paying
an invoice. The reveal client is `npm run reveal`, and it will not run before
step 6's window has closed — see below.

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
| `GET /terms` | — | network, ladder, fee per call, margin, address, cap. `feePerCall` is in whole STRK; `margin` is in **base units** per decoy |
| `POST /orders` | `{ order, windowProof }` | `201` with the invoice, or `422` with the reason |
| `POST /orders/:id/payment` | `{ txHash, block }` | the decoy plan, and `emitted` |
| `GET /orders/:id` | — | state, invoice, the plan **once paid**, and the settlement **once revealed** |
| `POST /orders/:id/reveal` | `{ reveal, atBlock, cell, observedDecoys? }` | the settlement, or `400` with the reason and, when the reveal is merely early, `waitBlocks` |

`scripts/serve-provider.mjs` is that service on loopback, and
`scripts/buy.mjs` is the client. What is deliberately missing from it: TLS,
authentication, rate limiting, and a durable order book. Those are not the
interesting part of the protocol, but a public provider needs all four.

The last endpoint is the one that has to refuse. Its decision is not written in
the service: it is `admitReveal` in `src/reveal.mjs`, so the rule the buyer's
client enforces and the rule the provider enforces are the same code rather than
two implementations that agree today. `scripts/serve-provider.mjs` translates
its verdict into a status code and nothing else.

The provider also has to know what block the chain is at, and **where that number
comes from is a trust decision, not a detail.** The provider is the party that
benefits from receiving a reveal early, so a provider that settles on a height
the buyer supplied has made the interested party the only witness. Three
arrangements, and the settlement records which one it used rather than implying a
check it did not perform:

| mode | how | `heightSource` | if it fails |
|---|---|---|---|
| `--at <block>` | pinned by the operator | `pinned` | refused — a typo does not fall through to the buyer's number |
| `--verify` | read from the chain on every reveal | `provider` | **refused**, and it does not fall back |
| neither | the buyer's own assertion | `buyer` | n/a — it is labelled unverified |

The `--verify` row is the one worth reading twice. An operator who asked for a
check and got a formality instead has been told something untrue about their own
settlement — the same class of error as a stale figure, with a worse consequence,
because the thing being handed over is a rung. So a failed read is a refusal.
`--rpc <url>` narrows `--verify` to a single endpoint instead of the network's
public list; `src/blockheight.mjs` holds the list and the read, shared with the
client so the two cannot disagree about which chain they are asking.

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

### When the reveal may be published, which is not "after you pay"

The buyer keeps the reveal, and the reason they keep it is that publishing it
early is worse than publishing it late. The provider was given the window and
never the rung; that split is the only thing standing between the buyer and a
provider that aims its cover at the buyer's own cell — or takes the fee and emits
nothing. So the rule is not a judgement call:

> the reveal is publishable once the chain's height is past the window's last
> block, and not before.

`npm run reveal --order <file>` is the client, and it refuses with the number of
blocks left when it is early. Two details are load-bearing:

**The window's last block is still the window.** A decoy can land in it, so
`windowHasClosed` compares strictly greater than `window.to`. Off by one here is
the difference between protecting the buyer and not, and it has its own test.

**An unknown height is a refusal, not a pass.** If the height cannot be
established the run exits non-zero. The tempting default — `atBlock ?? 0`, or
"probably fine" — turns an unreachable RPC into a rung handed over early, which
is silent and irreversible. `windowHasClosed` returns `null` for this case and
`false` for "not yet", because the two lead to different actions and only one of
them is a wait.

Three outcomes stay distinct, and a single boolean would lose all of them:
**wrong** (the reveal does not open the order — waiting does not help), **early**
(it opens the order but the window is open — waiting helps, and `waitBlocks` says
how long), and **unanswerable** (nobody can say — `waitBlocks` is `null`, not
zero).

Settlement reports two different numbers on purpose:

- **emitted** — every decoy the provider presents. This is the work, and it is
  verifiable from the chain.
- **claimable** — the decoys in the revealed cell that no other order has already
  claimed. This is the value.

They differ whenever the position is window-only, and collapsing them into one
"payout" figure would hide a decision that belongs in a contract, not a library.

What settlement counts is emissions that **landed**, never the plan. A note id
only exists once an emission does, and the emitter is what puts one there, so
today the honest count is zero and the settlement says so in its `emission`
field rather than counting the plan as if the work were done. Counting the plan
would credit the buyer for the provider's intention, which is the most expensive
kind of green.

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
| the reveal gate (early / wrong / unanswerable) | **built and tested** — `src/reveal.mjs` |
| a CLI a buyer can actually run | **built** — `npm run quote` prices, `npm run buy` places, `npm run reveal` closes |
| a provider that reads, prices and plans an order | **built** — `src/provider.mjs`, tested end to end |
| a provider that **broadcasts** the plan | **not built.** This is the emitter, and it needs the local node. The plan is real; the emission is a stand-in |
| a payment rail | **built and tested** — `src/payment.mjs`. Prepaid in STRK, with an amount **unique to the order** so a bare transfer binds to one, four verdicts instead of two, and a first-claim registry so one transfer cannot pay twice. No escrow, no custody, no refund path — `TOKEN.md` §5 says run it invoiced or prepaid first. See below |
| a coordination fee for Ruido | **built; no rate is set.** `src/commission.mjs` computes the second leg, every offer row discloses the fee and checks its rate against the protocol's own, and `reconcile()` keeps four answers apart. What is missing is a rate, an address and a signer — three faces of one gap. See below |
| an order book | **built and tested** — `src/orderbook.mjs`, `npm run serve:book`. It lists **offers, not orders**, and has no window parameter anywhere, so a buyer's cell cannot reach it. **Listing needs a token while browsing stays public**, because a registration is a URL the book will fetch and the row it produces is what a buyer talks to — and it refuses to fetch a loopback, private or link-local address, the cloud metadata service included, even when private addresses are allowed. `npm run verify:book` drives it over HTTP |
| a provider worth trusting | **built and tested** — `src/trust.mjs`. A bearer token on every route that costs money, `/terms` public so a book can list it, a limiter that runs *before* the token check, and a startup refusal to bind a public interface with no token. **The same module closes the book's listing route** and holds the fetch guard above, so the two processes take one set of answers rather than two. `npm run verify:trust` drives it over HTTP. Still no TLS, and it still learns **when** each buyer transacts. The fetch guard reads the URL's own host, so a **name** that resolves to a private address is not caught — `src/trust.mjs` says so where the check lives |
| on-chain verification | **not built.** Settlement here runs on a JSON file, not on Starknet. The *payment* is verified on-chain; the decoys are not |
| a provider's own view of the chain height | **built** — `--verify` reads it from the public endpoints on every reveal, and refuses rather than falling back when the read fails. It does NOT need the emitter's local node; that turned out to be a separate thing |

## Paying: binding a transfer to one order

The hardest small problem in the protocol, and worth stating because the obvious
answer is wrong.

**An ERC-20 transfer carries no memo.** So nothing on the chain says which order a
payment was for. The tempting design is to let the buyer post the transaction
hash and credit the order — and that is not a payment rail, it is a form. The
provider would be recording a number the buyer chose, with no way to tell a real
transfer from a hash of the word "paid".

There are three ways to bind a transfer to an order:

1. **A payment contract.** The buyer calls `pay(orderId)`. Needs a deployed
   contract and a second transaction. Not this.
2. **A per-order address.** The buyer sends to an address derived from the order
   id. Needs a wallet that can derive addresses and a sweep. Not this.
3. **A per-order amount.** The invoice quotes the pool fee **plus a tag** derived
   from the order id. The buyer sends exactly that figure to the provider's own
   address. Needs nothing deployed and no new transaction.

This takes the third, because it is the only one that requires nothing to exist
that does not already.

### The tag is a hash, and its width is a correctness constraint

The tag is `1 + (H("ruido.payment.v1", orderId) mod (10^12 − 1))` base units of
STRK, derived in the same domain-separated scheme as everything else in the
protocol so that "the tag is a hash of the order" is one convention rather than
two.

The width started at 10,000 and **a test found out why that was too narrow**: two
hundred order ids produced 199 distinct tags. That is the birthday bound doing its
arithmetic — at that width the chance of a collision among 200 orders is about
86%, so collisions would be the *normal* case rather than the exception. Every
collision is an honest buyer told their payment "already paid another order". At
10^12 the chance among ten thousand concurrent orders is about 0.005%, and the
width is 10^-6 STRK — economically nothing against a 2 STRK pool fee.

Collisions are still possible in principle, and they still resolve by **refusal**
rather than by miscrediting. The width makes them rare; it does not make them
impossible, and the difference is worth stating.

### Four verdicts, not two

`verifyPayment` answers with `status` ∈ {`paid`, `not-yet`, `wrong`, `unreadable`}
because they lead to four different actions:

| verdict | what it means | what a buyer does |
|---|---|---|
| `paid` | a `Transfer` from the token contract, to this provider, for exactly this amount | proceed |
| `not-yet` | the receipt says `RECEIVED`: in the sequencer, not in a block | wait. **This is the only one that is a wait** |
| `wrong` | reverted / never seen / not this token / not this provider / not this amount / already spent | do not retry. The reason names which of the six |
| `unreadable` | the receipt could not be read from any endpoint | nothing. It is the operator's problem |

`unreadable` is a **refusal**. A provider that credited a payment it could not
read would be turning an outage into free cover, and the buyer would be the one
who found out later.

### One transfer pays one order

A `txHash -> orderId` registry, shared across every order the provider serves.
The tag makes an accidental collision vanishingly unlikely, which means the reuse
this stops is the *deliberate* one: pay once, then present the same hash to a
second order whose amount happens to match. First claim wins.

Held in the provider's memory in the reference implementation. In a market with
more than one provider it belongs somewhere both sides can see, and a provider
being its own judge is the weakest part of the arrangement — the same weakness
`CLAIMED` has, and for the same reason.

### Reading the receipt, and the `u256` trap

OZ's Cairo 1 ERC-20 emits `Transfer` with `value.low, value.high` — **two felts**.
Reading `data[0]` alone silently truncates any amount above 2^128, which is every
amount this protocol deals in. Legacy Cairo 0 tokens emitted a single felt, so
both widths are accepted and the width is what decides. This is the same class of
trap as `Withdrawal.amount` being `data[3]` rather than `data[0]`: a felt read
from the wrong index looks like a number.

The event is also checked to come **from the token contract**. An event with the
right shape emitted by some other contract is not a transfer of this token, and a
provider that matched on shape alone would credit payments it cannot spend.

## The commission: how Ruido would be paid

The mechanism is built and the rate is not set. `src/commission.mjs` computes the
second leg, every offer row carries the disclosure, and `reconcile()` separates
the four answers a forwarding can give. What is missing is a rate
(`COORDINATION_FEE_BPS` is zero), an address (this repository has none), and the
sending itself, which needs a signed transaction and a key.

That split is deliberate rather than unfinished, and it is the same split the
rest of this document makes: the arithmetic is the part that has to be right
before a rate means anything, and a rate published before the arithmetic was
checked would be a promise about a number nobody had computed. The section is
also written down because the answer is not obvious and the obvious answer is
wrong.

### It cannot be a slice of the buyer's payment

The rail moves **one amount to one payee**, and it proves that by matching the
exact figure. Tokens do not split on arrival. So:

- A percentage withheld from what the buyer sends is not expressible. One
  transfer, one destination, whole.
- A contract that splits on receipt needs a deployment — which is precisely what
  the three-ways list above was written to avoid, and it would put a contract back
  between the buyer and the provider.
- The provider collecting everything and owing Ruido a share is not a payment. It
  is a **receivable**, which is a different instrument with a different risk
  whoever holds it.

So the commission is **a second transfer on the same rail**, and the machinery is
already here: `paymentRequest(invoice, { orderId, provider })` takes the payee as
an argument, and `verifyPayment` refuses any transfer not addressed to its own
payee. A second leg is a second instance of the existing rail, not a new
mechanism. The tag comes from the order id, so both legs carry the same tag and
both bind to the same order — while the amounts differ, which is what keeps the
two apart.

### Who sends the second leg

| | the buyer pays both legs | the provider forwards |
|---|---|---|
| transactions the buyer signs | **two** | one |
| what the buyer must know | both addresses, plus the fee schedule | the provider's address |
| Ruido's receipt | direct, at once | a receivable until it is forwarded |
| who can defect | the buyer skips Ruido's leg — and the order completes anyway unless the **provider** checks for it | the provider keeps the fee |
| can Ruido detect the defection? | **no.** It cannot see which orders were placed | **yes.** Every forwarding is a transfer on a public rail |

**The provider forwards, and the last row is why.** A check a provider is
motivated to skip is not an enforcement mechanism: a provider that stopped
verifying the buyer's second leg would make its own orders cheaper and nobody
could tell. A forwarding, by contrast, is a public fact. Ruido can read every
transfer to its own address and compare it against the orders it knows about —
and it knows about them, because step 6 publishes the order id. Non-payment is
then a **publishable finding** rather than an invisible one, and delisting from
the book is the remedy.

That is retroactive, not preventive, and it is the honest limit of the
arrangement. What it buys: the buyer's flow stays **one payee and one
transaction**, which is the product's shape — Ruido does not sit in the buyer's
path. What it costs: the offer row has to **disclose** that its price includes a
coordination fee. A price with an undisclosed cut inside it is a price a buyer
cannot compare against another provider's, and being comparable is what the book
is for.

### What the fee is a fraction of, and its unit

A fraction of the provider's invoice:

```
fee = floor(invoice.amount × coordinationFeeBps / 10_000 / TAG_MOD) × TAG_MOD
```

Written as arithmetic rather than as "5%", because two implementations of "5%"
that round differently disagree about the amount and the buyer is who finds out.
It is floored, so the rounding never charges more than the stated rate, and
quantised to `TAG_MOD` because the second leg needs the same room for its tag
that the first one does.

This is also why the invoice had to move to base units. A 5% cut of a whole-STRK
invoice is not a whole number of STRK, so a commission was **not expressible at
all** while every amount was whole — the same constraint that left a provider's
own margin expressible only as 0%, 50% or 100%.

### The fee: what is built, and what is not

| | |
|---|---|
| the arithmetic | **built.** `commissionFor` in `src/commission.mjs`, floored twice in the same direction so the fee can never exceed the published rate |
| the second leg | **built.** `commissionRequest` returns it, `commissionOwed` reads it off a provider's own terms, and `serve-provider` reports it as **owed** at payment — computed, not sent |
| the reconciliation | **built as a function.** `reconcile()` keeps `forwarded`, `short`, `missing` and `unmatched` apart. Nothing yet feeds it a chain read, so no order has been reconciled |
| the disclosure in the offer row | **built.** Every row carries `coordination`, and the RATE is checked against the protocol's own — a provider cannot declare its own |
| the configuration | **built.** Both processes take the rate from their own flags (`--coordination-bps`, or `RUIDO_COORDINATION_BPS`), and neither reads the other's. A rate with no address is refused before the port opens. `npm run verify:book` drives the real provider with the flag to prove it reaches `/terms` |
| `coordinationFeeBps` | **not set.** The default is zero and nothing sets it, so every row currently discloses "no fee" |
| a receiving address | **not published.** Ruido has no address anywhere in this repository |
| the sending | **not built.** Moving the second leg needs a signed transaction and a key — the same deferral as the emitter |

The last three rows are one gap seen three ways, and it is worth saying what
closes it: a rate, an address, and a signer. Until then the mechanism is a
computation and a disclosure, which is exactly as much as can be checked without
moving money.

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
9. **An idempotency check ordered after the state guard.** Settling moves the
   record to `revealed`, so a guard that only admits `emitted` answers a
   legitimate re-send with `409 the invoice is not paid, so there is nothing to
   settle` — about an invoice that was paid, for an order that is already
   settled. The duplicate check has to come **first**, and there is a test that
   fails if it does not.
10. **A reveal-shaped hole that throws instead of refusing.** `parseReveal` calls
   `BigInt()` on four fields, so a window proof posted to the reveal route raises
   a `TypeError` rather than being turned away — and the window proof is a strict
   subset of the reveal, which makes it the natural mistake to make. A provider
   that one malformed request can knock over is not a provider.
11. **A `--json` mode that leaks the thing the gate protects.** Printing the
   reveal on stdout regardless of the verdict would hand the rung over through
   the very flag someone would reach for in order to script this step. The
   machine path carries the reveal only once the check has passed, so the gate
   holds in both paths rather than only in the one a human reads.

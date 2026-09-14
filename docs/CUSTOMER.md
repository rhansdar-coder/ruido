# How the end customer uses it

Short answer first, because it is the part that is easy to get wrong after
spending a week on nodes and calldata:

**The customer runs none of this.** The node, the prover, the emitter, the pool
viewing key — all of it is the supply side. A customer buying anonymity should
never see Juno. If the customer has to run a node, there is no product; there is a
toolkit with a price list.

---

## What the customer does

Four steps. Only two of them are ours.

### 1. Measure — free, no wallet, no account

They open the meter and ask the only question that matters: *if I move size
through this pool in the window I am about to use, how many other notes could I
be?*

The answer today is bad, and that is the sales argument rather than an
embarrassment: 15.01 bits claimed, **1.76 bits measured** on mainnet. A seller who
publishes the bad number is the only kind worth believing.

Nothing is signed here. The read path is a public RPC with no key.

### 2. Order — commit to a cell, then pay

A **cell** is a window and a denomination. That is what they are buying: not
"cover traffic", but *other origins in the exact cell an adversary will search*.

They commit to the cell **in two halves**, and that split is the whole design.
The provider is given the window — it has to emit inside that window, and cover
that lands after the spend protects nobody — and it is never given the
denomination. So the commitment cannot be a single `H(window, denomination,
nonce)`: opening the window would open the amount with it. It is two
commitments, each domain-separated and salted, plus a derived order id.

The customer's client then sends the provider the public order and the window
proof, and gets back an invoice. `npm run buy` is that client, and
`npm run serve:provider` is a provider to point it at; both are in the
repository and the exchange between them is tested without a chain.

**Paying is the part that had to be designed rather than wired.** An ERC-20
transfer carries no memo, so nothing on the chain says which order a payment was
for — and a provider that credited a transfer on the strength of a transaction
hash the buyer supplied would be accepting a form, not a payment. So the invoice
quotes an amount **unique to the order**: the pool fee plus a tag derived from
the order id. Sending exactly that figure to the provider's address is the whole
of the proof, and the provider reads the receipt and answers with one of four
verdicts rather than two:

| verdict | what it means | what to do |
|---|---|---|
| `paid` | a transfer arrived, to this address, for exactly this amount | proceed |
| `not-yet` | the transaction is in the sequencer and not yet in a block | wait — this is the **only** one worth waiting for |
| `wrong` | reverted, never seen, not this provider, not this amount, or already spent | do not retry; the reason says which |
| `unreadable` | the chain could not be read, so nobody can say | the operator's problem. It is a refusal, never a hopeful credit |

One transfer pays one order. A first-claim registry holds every hash that has
already settled something, because the tag makes an accidental collision
vanishingly unlikely but makes a *deliberate* reuse — pay once, then present the
same hash to a second order — trivial to attempt.

What the provider learns is **when** the customer transacts. That is the position
being sold, it is why window-only is cheaper than aimed, and it is the central
privacy cost of buying cover at all — worth writing down wherever a provider's
policy lives.

### 3. Transact — their own wallet, untouched

**This is the step that must stay theirs.** The customer moves their own funds
through the pool with their own wallet and their own RPC, exactly as they do
today. Ruido does not route it, does not see it, and never holds a key that could.

The cover is *other* notes, emitted by providers, landing in the same cell. The
customer's note is not modified or wrapped. From outside, it looks like what it
now is: one candidate among several.

### 4. Reveal — after the window, and not one block before

Once the window closes, the commitment opens. `npm run reveal` is that client: it
reads the order file that `npm run buy --out` wrote, checks both commitments
locally, resolves the chain height, and refuses until the window is behind them.

The refusal is the point, and it is worth being precise about why. The provider
was given the window and never the rung, and that split is the only reason it
cannot aim cover at the customer's cell. A reveal published while the window is
still open hands over the rung **before the provider emits** — at which point the
provider can aim straight at the cell, or simply keep the fee and emit nothing.
So the rule is a comparison against the chain's height, not the customer's
judgement, and it lives in `src/reveal.mjs` rather than in the CLI, so that a
script cannot be the only thing standing between a buyer and that mistake.

It also **fails closed**. If the current block cannot be established, the run
exits non-zero rather than assuming the window has passed. "Nobody can tell" and
"not yet" are different answers and only one of them is a wait; the tempting
default of treating an unknown height as fine turns a missing RPC into a rung
handed over early, silently and irreversibly.

Then settlement runs: it checks that each decoy the provider presents actually
landed in the revealed cell, and that it was not already claimed by another
buyer. First claim wins. Without this step the customer would be buying a
promise; with it, they are buying something anyone can check.

What settlement counts is emissions that **landed**, never the plan. A note id
only exists once an emission does, and the emitter is what puts one there — so
today the count is zero, and the settlement says so out loud instead of counting
the plan as if the work were done. That is the honest reading of a settled order
in the current build: **settled, and nothing delivered yet**, with the shortfall
printed as a number rather than rounded away.

---

## What the customer never does

| | |
|---|---|
| run a node or a prover | that is the operator's problem, and the reason the market exists |
| hand over a key | the only key in the flow is the provider's, and it never leaves the provider's host |
| route their transaction through Ruido | the customer's own wallet does that, unchanged |
| hold RDO to be served | RDO is not issued. It would be a fee discount, not a ticket and not a stake |
| trust a number they cannot recompute | every figure is reproducible from public RPC |

---

## The design decision, now priced

There was a contradiction between the mechanism in [`TOKEN.md`](TOKEN.md) §3 and
the economics in §4. §3 said:

> Buyer commits to `H(window, denomination, nonce)` and publishes the hash. **The
> provider learns nothing about where to aim.**

If the provider learns nothing about where to aim, they must emit **blindly**, and
blind emission is uniform cover — priced at **~1,700× worse per bit** than aimed
cover. The two sentences cannot both be true. It is resolved, and the resolution
is that **the provider aims, but not on both axes.**

### Why not on both axes

Cover has to land *before* the spend. A provider who does not know the window
cannot deliver anything in time, so **the timing is given away by construction** —
it is a precondition of the service, not a secret the buyer can keep. That leaves
exactly one axis a buyer can withhold: *how much*.

So the choice is not a 2×2. It is a line with three points:

| | provider learns | decoys per cell note | relative cost per bit | the catch |
|---|---|---|---|---|
| **aimed** | window **and** denomination | **1 in 1** | **1×** — 3.3 STRK for the first bit | the provider knows exactly when you move |
| **window-only** | the window only | **1 in 7** | **7×** for the same anonymity, 3.5× at the same budget | six decoys in seven land on a rung nobody cares about |
| **blind** | nothing | **1 in 1,709** | **~1,700×** | nobody can afford it, so nobody buys |

Note the missing fourth corner. *Amount-only* would be the natural counterpart,
and it is not a position anyone can occupy: a provider who knows the amount but
not the window has no way to deliver the cover in time. There are three
positions, not four, and the reason is mechanical rather than commercial.

### What window-only actually costs

The number that was missing, and there are two of them because there are two
questions.

**For the same anonymity — what a buyer asks — withholding the denomination costs
exactly the ladder width: 7× on a 7-rung ladder.** Hiding which rung is yours
means emitting all of them, so three bits takes 14 decoys aimed and 95
window-only. That is exact rather than measured, and it is the number an order
form has to quote.

**At the same budget it reads 3.5× at ten decoys, falling to 1.5× at five
hundred** — from `npm run measure`, averaged over the same hundred notes, because
a single note's cell is one draw and the draw an earlier version used made cover
look 40% dearer than it is. That fall is not window-only getting good: at 500
decoys both strategies are buying saturated bits, at 191 STRK/bit against 125, and
the ratio converges because the cell is full.

Both are true. Conflating them is how "300×" once got published here.

### The consequence for the mechanism

A single commitment `H(window, denomination, nonce)` **cannot express
window-only**, because opening the window opens the denomination with it. Selling
the middle position needs a **split commitment**: a window commitment opened to
the provider at order time, a denomination commitment opened only at reveal, and a
binding that stops either being swapped for the other. That is a design change,
not a parameter, and it is the next thing to specify.

### And the price is a curve, not a number

| decoys | cell | gained | STRK/bit |
|---|---|---|---|
| 1 | 2.93 | +0.602 | **3.3** |
| 10 | 11.93 | +2.628 | 7.6 |
| 50 | 51.93 | +4.750 | 21.1 |

Bits grow logarithmically while cost grows linearly, so the marginal bit gets
dearer. There is no volume discount on anonymity. A quoted STRK/bit without an
order size is not a price — which changes what the order form has to ask for: not
"how much cover do you want" but "how many bits, and what will you pay for the
last one".

---

## What has to exist for the journey to work

| piece | state |
|---|---|
| the meter | **live** |
| the measurement behind it | **live** |
| the aimed/window-only/blind decision | **priced** — exactly the ladder width for the same anonymity |
| the split commitment | **live** — `src/commitment.mjs`, spec in [`ORDER.md`](ORDER.md) |
| the quote (bits → decoys → STRK) | **live** — `src/quote.mjs`, `npm run quote` |
| the order format and its wire round trip | **live** — `src/order.mjs` |
| the window proof a provider is given | **live** — the half that lets it emit in time without learning the rung |
| settlement and the double-sell guard | **live** — `src/settlement.mjs` |
| the reveal gate (early / wrong / unanswerable) | **live** — `src/reveal.mjs`. Refuses while the window is open, fails closed on an unknown height |
| a provider that reads, prices and plans an order | **live** — `src/provider.mjs`, `npm run serve:provider` |
| a client that connects and buys | **live** — `npm run buy`. The whole trade is tested with no chain |
| a client that closes the order | **live** — `npm run reveal`, the fourth step. Also tested with no chain |
| the emitter | **not built** — see [`RUNBOOK-emitter.md`](RUNBOOK-emitter.md) |
| a provider that **broadcasts** what it planned | **not built.** The plan is real; the emission is a stand-in for the emitter |
| a payment rail | **live** — `src/payment.mjs`. Prepaid in STRK, and the invoice quotes an amount **unique to the order** so that a bare transfer can be bound to one. The provider reads the receipt and answers in four verdicts, not two. No escrow, no custody, no refunds — `TOKEN.md` §5 says run it invoiced or prepaid first |
| an order book | **live** — `src/orderbook.mjs`, `npm run serve:book`. It lists **offers**, not orders: there is no window parameter anywhere in its API, so a buyer's cell cannot reach it. Ranking is by what you pay for your size *and* your placement |
| a provider worth trusting | **live** — `src/trust.mjs`. A bearer token for everything that costs money, `/terms` public so a book can list it, a limiter that runs **before** the token check, and a bind guard that refuses to listen on a public interface without a token. It still learns **when** each buyer transacts |
| on-chain settlement | **not built.** Settlement runs on a JSON file, not on Starknet |
| a provider's own view of the chain height | **live** — `--verify` reads it from the chain on every reveal, and **refuses** the settlement rather than falling back to the buyer's number when the read fails. It does not need the emitter's node; that was a separate thing |

Nineteen rows, fifteen live, one priced, three not built — and every live one was
built without a node, a chain, or a key. That is the point: **the customer's side
of Ruido is finished and untested against reality at the same time**, because
what was missing was never code.

The gap is now the emitter, and only the emitter. It is the *supply*, and
everything above it has been built: a way to pay that clears, a book that lists
supply without listing demand, and a provider that can be put on a host without
being drained. What is left of the market is the one thing that needs the node —
**an emission that is real** — plus the honest note that a provider still learns
when its buyer transacts, which is the position being sold and belongs in any
provider's written policy.

## What this changes about the order of work

The roadmap has been working supply-first, which was right while the question was
"can this be done at all". The question has changed. Nothing above the emitter —
order, payment, settlement, the counterparty — depends on the node, on Sepolia,
or on the calldata work that is already finished. It has all now been built and
tested against the measurement that already exists, with no host and no STRK.

If the goal is a customer, the next thing to build is not the emitter. It is
everything that makes a provider worth paying: an emission that is real, a
payment that clears, and a reason to believe the plan was followed.

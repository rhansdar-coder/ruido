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

What the provider learns is **when** the customer transacts. That is the
position being sold, it is why window-only is cheaper than aimed, and it is the
central privacy cost of buying cover at all — worth writing down wherever a
provider's policy lives.

### 3. Transact — their own wallet, untouched

**This is the step that must stay theirs.** The customer moves their own funds
through the pool with their own wallet and their own RPC, exactly as they do
today. Ruido does not route it, does not see it, and never holds a key that could.

The cover is *other* notes, emitted by providers, landing in the same cell. The
customer's note is not modified or wrapped. From outside, it looks like what it
now is: one candidate among several.

### 4. Reveal — after the window, publish the preimage

Once the window closes, the commitment opens. Settlement then checks that each
decoy the provider claims actually landed in the revealed cell, and that the
commitment was not already claimed by another buyer. First claim wins. Then the
provider is paid.

Without this step the buyer would be buying a promise. With it, they are buying
something anyone can check.

---

## What the customer never does

| | |
|---|---|
| run a node or a prover | that is the operator's problem, and the reason the market exists |
| hand over a key | the only key in the flow is the provider's, and it never leaves the provider's host |
| route their transaction through Ruido | the customer's own wallet does that, unchanged |
| hold RDO to be served | RDO is a fee discount. It is not a ticket and not a stake |
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
| a provider that reads, prices and plans an order | **live** — `src/provider.mjs`, `npm run serve:provider` |
| a client that connects and buys | **live** — `npm run buy`. The whole trade is tested with no chain |
| the emitter | **not built** — see [`RUNBOOK-emitter.md`](RUNBOOK-emitter.md) |
| a provider that **broadcasts** what it planned | **not built.** The plan is real; the emission is a stand-in for the emitter |
| a payment rail | **not built.** An invoice, a tx hash, and a transfer someone checks. No escrow, no custody, no refunds — `TOKEN.md` §5 says run it invoiced or prepaid first |
| an order book | **not built.** Nothing lists orders or matches them; a provider is reached by URL |
| a provider worth trusting | **not built.** Loopback, no TLS, no auth, no rate limiting — and it learns **when** each buyer transacts |
| on-chain settlement | **not built.** Settlement runs on a JSON file, not on Starknet |

Sixteen rows, ten of them live, and every live one was built without a node, a
chain, or a key. That is the point: **the customer's side of Ruido is finished
and untested against reality at the same time**, because what was missing was
never code.

The gap is still not the emitter — the emitter is the *supply*. The gap is
everything that turns a supply into a market: a provider that **broadcasts** what
it planned, a way to pay that anyone would accept, and a book that lists orders.
The provider's logic is now written and tested; what is left of it is the
emission, which is the emitter's job, and the trust story, which is a policy
rather than a library.

## What this changes about the order of work

The roadmap has been working supply-first, which was right while the question was
"can this be done at all". The question has changed. Nothing above the emitter —
order, payment, settlement, the counterparty — depends on the node, on Sepolia,
or on the calldata work that is already finished. It has all now been built and
tested against the measurement that already exists, with no host and no STRK.

If the goal is a customer, the next thing to build is not the emitter. It is
everything that makes a provider worth paying: an emission that is real, a
payment that clears, and a reason to believe the plan was followed.

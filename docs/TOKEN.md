# Token design

Not legal advice. Read the last section before you sell anything.

---

## 1. Where I'm useful and where I'm not

I'll help design token **mechanics** for a product that works: how rewards are
earned, how a buyer pays, how the thing resists gaming.

I won't help design a token whose main function is to be bought by people hoping
the price goes up. That's not prudence, it's arithmetic: the mechanism below
only works if there are real buyers paying for real cover, and a sale-first
launch proves the opposite to everyone watching.

There's also a practical point. You've spent this whole session auditing
projects to see whether they're real or a *cascarón*. The single fastest way to
get classified as one is to sell a token before the thing works.

## 2. The mechanism

A two-sided market. Nothing else survives contact with the numbers in the README.

**Buyer.** Wants anonymity in a specific place: a future block window and a
denomination. Pays RUIDO. Receives decoy actions inside that cell.

**Provider.** Runs a funded Starknet account and an emitter. Submits real
`apply_actions` transactions that create notes in the buyer's cell. Earns RUIDO.

**Why this needs a token at all**, rather than a Stripe page: providers are
anonymous, cross-border, and need to be paid per verified action without anyone
holding their funds. That is a real use for a bearer instrument.

## 3. Verification, which is the hard part

A provider must not be able to claim credit for work they didn't do, or sell the
same decoy twice.

**Decoys are self-verifying.** Cover traffic is not a claim, it is a set of real
on-chain `apply_actions` calls. Each one costs a real pool fee — 2 STRK on
Sepolia, 6 on mainnet. You cannot fabricate a decoy without paying for it, so
**the fee is the sybil resistance.** No stake is required to make lying about
cover expensive, which is unusual and worth keeping.

**Double-selling is the remaining problem**, and it is solved with a commitment
scheme:

1. Buyer commits to the cell **in two halves** and publishes both hashes. A single
   `H(window, denomination, nonce)` does not work — see below.
2. Provider emits decoys and records the resulting note commitments.
3. After the window closes the buyer reveals both preimages.
4. Settlement checks each claimed decoy lands in the revealed cell **and** that
   its commitment has not been claimed by another buyer. First claim wins.

Step 4 is what stops one batch of decoys being sold ten times, and it is the part
an implementation gets wrong if it is rushed. The reason is that **windows overlap
constantly** — the buyer's window is a handful of blocks around a block the
adversary already knows — so a decoy in one buyer's cell is usually in another's
too. It is now implemented, with the guard under test, in `src/settlement.mjs`; the
full protocol is in [`ORDER.md`](ORDER.md).

**Resolved: the provider is told the window, and the commitment has to say so.**
An earlier draft of this section said "the provider learns nothing about where to
aim" as if that were a feature. It is a contradiction: blind emission *is*
uniform cover, which the model prices at **~1,700× worse per bit** than aimed
cover, because only **1 decoy in 1,709** lands in the cell the adversary actually
looks in. Either the provider aims, or the price in §4 is wrong. It aims.

But not on both axes. Cover has to land *before* the spend, so the timing is
given away by construction — a provider who does not know the window cannot
deliver anything in time. The denomination is therefore the only thing a buyer
can withhold, and `npm run quote` now prices that too: **for the same anonymity it
costs exactly the ladder width**, 7× on a 7-rung ladder, because hiding which rung
is yours means emitting all of them. At the same budget it reads 3.5× at ten
decoys. All three positions, with the numbers, are in
[`CUSTOMER.md`](CUSTOMER.md).

That has a consequence for the commitment scheme above. A single commitment
`H(window, denomination, nonce)` **cannot express the middle position**, because
opening the window opens the denomination with it. Selling window-only needs a
**split commitment** — a window commitment opened to the provider at order time,
a denomination commitment opened only at reveal, and a binding that stops either
being swapped for the other. That is a design change, not a parameter.

## 4. Rewards

- **Per verified decoy**, paid after the window closes and the buyer reveals.
  No reveal, no settlement — which is why buyers are required to reveal, with a
  small bond forfeited if they don't.
- **Provider stake**, slashed for provable misbehaviour: reusing commitments
  across buyers, or failing to emit after accepting an order.
- **No emissions for holding.** Rewards track verified work. A token that pays
  you for owning it is the thing regulators look at first and the thing that
  makes the whole project read as a *cascarón*.

Pricing sanity check, from the measurement. The price per bit is a curve, not a
number: against a pool whose average note sits in a cell of 1.93 candidates,
aimed cover runs from **3.3 STRK for the first bit** (1 decoy, +0.60 bits) to
7.6 STRK/bit at ten decoys and 21 at fifty. It rises monotonically, because bits
grow logarithmically while cost grows linearly — there is no volume discount on
anonymity. Provider margin has to fit inside that, and the tight part is the
small orders, not the large ones. A figure quoted here without an order size is
not a price.

## 5. Sequencing

1. Ship the measurement against **real** STRK20 traffic (roadmap item 1).
   Without it every price here is a model, and a token priced on a model is a
   promise you can't keep.
2. Ship the on-chain emitter on Sepolia.
3. Run the market with **no token** — invoiced, or prepaid in STRK. If nobody
   buys cover at cost, a token will not create demand.
4. Only then introduce RUIDO, to solve the specific problem in §2: paying
   anonymous providers per verified action.

If step 3 shows no demand, the honest move is to stop, not to launch.

## 6. The sale question

You asked about *venta o recompensa*. They are not the same risk.

**Rewards** for provable work (§4) are the more defensible structure. Think
bandwidth marketplaces and mixnet node rewards — there's precedent, and the
token has a consumptive use.

**A public sale** is where this gets legally expensive. In the US the Howey test
asks whether buyers put in money expecting profit from the efforts of others; a
team raising funds to build the thing you'd buy the token to use answers yes on
all counts. MiCA in the EU has its own regime. This varies by jurisdiction and
by facts, and it's a question for a securities lawyer in wherever you actually
sell, not for me.

What I'll say without qualification: the order matters. **Product, then usage,
then token.** Every project that inverted that order is on the list of things
you've been auditing this week.

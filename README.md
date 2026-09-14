# Ruido

**Private by measurement, not by claim.**

Zero dependencies. Every number below is reproducible: the model from a seed, the
measurement from a public RPC endpoint with no API key.

---

## The result

We indexed every event both deployed STRK20 pools have ever emitted and measured
the anonymity set that survives an adversary holding nothing but public data.

| | Sepolia | Mainnet |
|---|---|---|
| events indexed | 21,062 | 125,751 |
| notes created | 8,322 | 32,920 |
| claimed bits | 13.02 | 15.01 |
| **measured bits (distinct origins, ±10 blocks)** | **0.15** | **1.76** |
| notes alone in their window | 93.4% | 42.5% |

**We predicted mainnet would read worse than testnet. It reads better — 11×
better — because mainnet is 4.6× denser (5.77 notes per thousand blocks against
1.25), not quieter.** Testnet is a different regime, not a smaller mainnet. The
prediction is struck through in the methodology rather than quietly deleted.

Neither number is a passing grade. Mainnet narrows 32,920 notes to 3.4
candidates against an adversary who only knows roughly when the note was made.

"Origins" matter more than notes here. The Sepolia pool contains a single
transaction that minted 295 notes in one block. Counting notes, that is 295
anonymous people; counting origins, it is one suspect. Every table below carries
both and they are never blended.

This is not a defect in the pool's cryptography. STRK20 hides *what* a note is
worth and *who* spends it. It does not hide *when* the note was created, because
creation is an on-chain event. At these densities, "when" is very nearly a
unique identifier.

Full writeup: [`docs/FINDING-strk20-sepolia.md`](docs/FINDING-strk20-sepolia.md).

## The result, pointed elsewhere

A meter that only ever points at the thing its author likes is not a meter. So
we pointed it at three chains that are not STRK20 — **Robinhood Chain**
(Arbitrum Orbit, 4663), **Base** (OP Stack, 8453) and **Ethereum** (1) — none of
which has a shielding primitive.

| at the same ±17 s window | STRK20 mainnet | Robinhood Chain | Base | Ethereum |
|---|---|---|---|---|
| block time | 1.702 s | 0.102 s | 2.000 s | 12.056 s |
| window, in blocks | ±10 | ±167 | ±9 | ±1 |
| candidate set | 3.25 origins | **2,304 senders** | **1,356 senders** | **688 senders** |
| effective anonymity | 1.758 bits | **0 bits** | **0 bits** | **0 bits** |
| alone in their window | 42.5% | **0.0%** | **0.0%** | **0.0%** |
| what a candidate is | an unlinkable note | an address | an address | an address |

**709× the candidates, and less privacy.** Both statements are true at once
because the candidate set is not an anonymity set: on STRK20 the parties are
unlinkable notes, and here they are persistent addresses. The reuse figures
collapse it further — on Robinhood Chain **2% of addresses (731 of 37,335) move
half the traffic** in the window.

The windows are in **seconds** for a reason. Starknet makes a block every 1.702 s
and Robinhood Chain every 0.102 s, so a shared "±10 blocks" column would compare
17 seconds against 1. On Ethereum the same correction runs the other way: ±17 s
is **±1 block**, which is why the ±1 s and ±10 s rows are identical there. That
correction is in the methodology page and enforced by `src/evm.mjs`.

### The detector fired, and then it didn't

Looking for a shielded pool on a chain that has none sounds like a test with one
possible answer, so we made it falsifiable: a mixer concentrates transfers into
a handful of fixed denominations reused many times, leaving a **small value
space** relative to its transfer count. Ordinary traffic does the opposite.

It took three corrections, each one caused by running it:

1. **Whole-chain was the wrong granularity.** On Ethereum it reported "no pool"
   while Tornado Cash was deployed there. The cause was dilution: one contract's
   behaviour is invisible against 340,000 value transfers in a 10-hour window.
   A mixer is a contract, not a chain.
2. **The value shape over-reports.** Per contract it fired on 11 contracts on
   Robinhood Chain. Every one was a fixed-amount payment pattern — a sale at a
   fixed price, a batch payer, one bot repeating an amount.
3. **A fee collector wears the same shape.** One candidate survived both fixes:
   120 deposits of exactly 0.0005 ETH from 72 addresses. Its withdrawals settled
   it — 7 of 10 went to the same address in irregular lumps of 0.77 to 18.6 ETH.
   A pool returns the denominations it took; this swept a balance to a treasury.

So a detection now requires four things: the value shape, **more than one
depositor**, **value flowing both ways**, and a **pool-shaped outflow**. The
last three are requirements a pool cannot fail rather than tuned thresholds —
which is why the outcome is reportable instead of adjustable.

Result: **0 viable pool candidates on all three chains**, with every shape match
listed and the reason it was rejected. The gap between the two counts is the
finding. Full writeups:
[`docs/FINDING-robinhood-chain.md`](docs/FINDING-robinhood-chain.md) and
[`docs/FINDING-multichain.md`](docs/FINDING-multichain.md).

### And a control that failed to be one

Ethereum was registered as the **positive control** for the detector, because
Tornado Cash is deployed there and every other chain can only ever make the
detector answer "no". Then it was measured: in the observed window the 0.1 ETH
pool received **one** transfer and the TORN token thirteen. Tornado Cash is
deployed and effectively dormant, so a recent window cannot exercise the
detector at all. The proof that it can fire is a unit test with a mixer-shaped
fixture — not this chain. A live control would need an archive node and a
2022-era window.

Adding a chain is a data change, not a code change — see `src/chains.mjs`.
Optimism and Arbitrum One are registered too, and a test asserts the indexer
contains no hardcoded addresses or chain IDs.

## The gap this closes

Every project building on STRK20 — Erebus included — publishes a nominal
anonymity set ("your note hides among all notes in the pool") and nobody
publishes the **effective** one.

The distinction is everything. Nominal is how many notes exist. Effective is how
many are left after an adversary applies the data they actually hold: timing,
funding origin, denomination, and counterparty knowledge.

Erebus's own threat model says it plainly:

> The **effective** set is smaller than the nominal one […] STRK20 shipped June
> 2026, so the nominal set is small to begin with. **Neither project currently
> measures its effective set.**

Ruido measures it. And then sells you more of it, at a published price per bit.

## How this is sold

Two things are on offer, and only one of them is the product.

**The measurement is free and stays free.** It is the proof, and a proof you
have to buy is not a proof. Anyone can rerun it from public RPC and get these
same tables. That is why the unflattering number — 1.76 bits measured against
15.01 claimed — is on the front page instead of in a footnote. A seller who
publishes the bad number is the only kind of seller worth believing.

**Cover traffic is the product, priced per bit.** Not per transaction, not per
month: per bit of effective anonymity bought, in a named window and
denomination. The price is a curve rather than a number, because the first bit is
the cheapest — the set is being multiplied from a small base, and a later bit
needs the same multiplication applied to a number that is already large. Against
a pool whose average note sits in a cell of 1.93 candidates, the curve runs from
**3.3 STRK for the first bit** (1 decoy, +0.60 bits) to 7.6 STRK/bit at ten
decoys and 21 at fifty. Blind cover, spending the same money, buys about
**1/1,700th** as much, because six of every seven decoys land on a rung the
adversary does not care about. Withholding the denomination — telling the
provider when you move but not how much — costs **exactly the ladder width for
the same anonymity**, seven times on a seven-rung ladder, because hiding which
rung is yours means emitting all of them. That single table is the product
decision.

**The fee is the sybil resistance.** A decoy is a real `apply_actions` call
costing 2 STRK on Sepolia and 6 on mainnet, so nobody can claim credit for cover
they did not pay for. No stake is required to make lying expensive, which is
unusual and worth keeping.

**Order: product, then usage, then token.** Run the market with no token first —
invoiced, or prepaid in STRK. If nobody buys cover at cost, a token will not
create demand. RDO is designed to solve exactly one problem, paying anonymous
cross-border providers per verified action, and it carries no revenue claim and
no emissions for holding. **It is not deployed, not minted and not for sale.** The full design, including the commitment scheme that
stops one batch of decoys being sold twice, is in
[`docs/TOKEN.md`](docs/TOKEN.md).

## What it does today

| | |
|---|---|
| `npm run corpus` | Index every event the Sepolia pool has emitted → `data/corpus.json` |
| `npm run corpus:mainnet` | Same, against mainnet → `data/corpus-mainnet.json` |
| `npm run measure:corpus` | Measure the real Sepolia pool → `data/measurement.json` |
| `npm run measure:mainnet` | Measure mainnet → `data/measurement-mainnet.json` |
| `npm run rh:index` | Index a 24,000-block window of Robinhood Chain → `data/corpus-robinhood.json` |
| `npm run rh:measure` | Measure that window → `data/measurement-robinhood.json` |
| `npm run base:index` | Index a 3,000-block window of Base → `data/corpus-base.json` |
| `npm run base:measure` | Measure that window → `data/measurement-base.json` |
| `npm run eth:index` | Index a 3,000-block window of Ethereum → `data/corpus-ethereum.json` |
| `npm run eth:measure` | Measure that window → `data/measurement-ethereum.json` |
| `npm run blocktimes` | Measure both chains' block times — the unit every window is stated in |
| `npm run verify:decode` | Check the event decoder against the live chain: 0 unresolved selectors, 0 felt-count mismatches |
| `npm run verify:actions` | Decode real `apply_actions` calldata, resolving the class per block; requires exact consumption |
| `npm run recon:emitter` | Read the deployed pool interface and unwrap one real transaction |
| `npm run verify:compile` | Verify the action-order rules and reproduce `ClientAction` → `ServerAction` against the deployed pool, using a throwaway identity |
| `npm run verify:encode` | Round-trip the calldata **encoder** against real transactions — decode, re-encode, require the felts back identical. `--from <block>` aims it at the live class |
| `npm run check:screening` | Cross-tabulate what the contract *can* screen (deposit / invoke / neither) against what the calldata carried, per class. `--from <block>` targets the live class |
| `npm run check:invokes` | Read every invoke target out of the corpus and each one's `get_open_note_screening_policy` live, so the invoke case is answered from data rather than from a node |
| `npm run check:abi` | Prove the calldata decoder handles every type the deployed ABI mentions |
| `npm run dump:screening` | Dump the `screening` field of a given block's `apply_actions` felt by felt |
| `npm run check:packed` | The negative finding: `EncNoteCreated.packed_value` does not carry the amount |
| `npm run verify:journey` | **The four steps over real HTTP.** Spawns the reference provider, drives `buy` and `reveal` against it as child processes, and checks the refusals on both sides. Needs no chain. This is the seam `npm test` cannot reach: the unit tests call `admitReveal` and never open a socket |
| `npm run measure` | M1, M3, effective set under six models, cover placement, landing rate, order size, cost per bit (synthetic, seeded) |
| `npm run quote` | **The customer's entry point.** Turn "N bits of anonymity" into an order and a reveal, offline. `--cell` is required and points at the measured cell |
| `npm run serve:provider` | A reference provider: `GET /terms` and `GET /health` are public, `POST /orders`, `POST /orders/:id/payment`, `GET /orders/:id` and `POST /orders/:id/reveal` need a token when one is set. Where it gets the block height is a trust decision: `--at <block>` pins one by hand, `--verify` reads the chain on every reveal (`--rpc <url>` narrows it to one endpoint), and with neither it settles on the buyer's number and labels the settlement as unverified. `--verify` that fails **refuses** the settlement rather than falling back. `--token <secret>` closes the money routes; binding to anything but loopback **without** one is refused at startup. `--payment-rpc <url>` reads receipts somewhere other than the height |
| `npm run serve:book` | The order book: `GET /offers?network=&bits=&mode=&cell=` ranks providers for a size, `POST /offers { endpoint }` lists one. It lists **offers, not orders** — the registration is an endpoint and the book fetches the provider's own `/terms`, so it cannot advertise a price the provider would not honour, and there is no window parameter anywhere for a buyer's cell to arrive in |
| `npm run verify:book` | **The book over real HTTP**, with a real provider in it. Checks that a row matches the provider's own terms, that a provider publishing a secret loses its listing, and that a buyer can find a provider without publishing a cell. Needs no chain |
| `npm run verify:trust` | **The provider's door.** That an exposed provider with no token refuses to *start*, that `/terms` and `/health` stay open while everything else answers 401, that the limiter runs before the token check, and that `X-Forwarded-For` cannot buy a fresh bucket |
| `npm run buy` | **Connect and acquire.** Ask a provider for its terms, price the order against its ladder, send the order and the window half, and keep the reveal. `--provider <url> --cell <n> --bits <n> --from <block> --denomination <rung> --out <file>` writes the order and the reveal to a file, which is what step four reads |
| `npm run reveal` | **Step four: publish the reveal.** Refuses while the window is still open, fails closed if the block height cannot be established, and settles against the provider once it can. `--order <file> [--provider <url>] [--at <block>]` |
| `npm run site` | Assemble `_site/` — the exact artifact Pages publishes — and verify nothing is missing |
| `npm run site:check` | Verify the artifact manifest without writing anything |
| `npm run web` | Dashboard at http://127.0.0.1:8080 |
| `npm test` | 445 tests: adversary classifier, keccak vectors, large-input regressions, event decoding, denomination join, calldata decoding (Span, Option, tuples, u256, exact consumption), calldata encoding (round-trip, the ambiguous `Option<Option<T>>`, short-form refusals), cover placement ordering and price curve, the split commitment, quoting, settlement and the double-sell guard, the provider's accept/refuse rules and decoy plan (including a margin charged per decoy, and the margin quantisation that keeps room for the payment tag), the whole trade end to end with no chain, the reveal gate (early / wrong / unanswerable heights, where the height came from, and the four-step journey), the chain-height reader (rotation, the three ways a public endpoint lies, and never defaulting to zero), the payment rail (the per-order tag and its collision bound, `u256` transfer decoding at both widths, the four verdicts, and the first-claim registry), the coordination fee (both legs carrying the same tag with different amounts, the fee floored so it can never exceed the published rate, the refusal to ask for a leg that rounds to nothing, the rate validated in one place for the arithmetic, the row and the book's own startup alike, and the four reconciliation answers — a dropped tag kept apart from a kept fee), the order book (the projection that keeps a buyer's cell out, every forbidden field refused by name and at any depth, the version refusal that keeps a `margin` from being read at the wrong unit, the fee disclosure whose rate the protocol sets rather than the provider, ranking by size *and* mode, and the book's price agreeing with the provider's invoice), provider and book trust (every loopback spelling, the bind guard that refuses an exposed process with no token, a constant-time token compare, a bounded limiter that grants nothing on a backwards clock, the book's listing route closed while browsing stays open, and the fetch guard that refuses a loopback, private or link-local endpoint — the cloud metadata service included, even when private addresses are allowed), artifact manifest, the crop guard (every loopback spelling accepted, a published origin refused, and an unparseable base refused too, so a screenshot run cannot end by photographing a 404 page), DOM contract, EVM measurement |
| `npm run shots` | Render the platform to `shots/` using the installed Chrome. `--only <name>` re-shoots one section |
| `src/chains.mjs` | The chain registry. Adding a chain is a data change, not a code change |
| `src/keccak.mjs` | starknet_keccak, hand-rolled and tested, because Node has no keccak256 |
| `src/collect.mjs` | Stack-safe helpers, because `push(...arr)` dies on real corpora |
| `src/starknet-events.mjs` | ABI-driven event decoder: felt widths, struct tables, selector collisions |
| `src/denomination.mjs` | The two-route amount join and the denomination models |
| `src/actions.mjs` | ABI-driven call-calldata decoder: Span, Option, enums, the v3 execute envelope |
| `src/evm.mjs` | EVM measurement logic: seconds↔blocks, reuse, concentration, the shielded-pool detector |
| `src/salt.mjs` | Wire-accurate salt construction + the real fifth-salt attack |
| `src/anonymity.mjs` | Effective set under `naive`, `timing`, `amount`, `timing+amount`, `linkage`, `all` |
| `src/cover.mjs` | Cadence, fixed denominations, cost model |
| `src/metrics.mjs` | M1 and M3, defined the way the Erebus threat model defines them |
| `src/commitment.mjs` | The **split commitment**: a window half the provider is given, a denomination half it never sees, and domain separation between them |
| `src/quote.mjs` | The inverse of the model: bits → decoys → STRK, per placement position |
| `src/order.mjs` | Building an order and its reveal, and the wire format they travel in. The **window proof** is its own function, so "send the provider what it needs" cannot become "send the provider the reveal" |
| `src/settlement.mjs` | Counting decoys in the revealed cell, and refusing to pay for one twice |
| `src/reveal.mjs` | **When the reveal may be published.** Wrong, early, and unanswerable are three different answers, and an unknown block height fails closed rather than passing. Also the provider's half of the same check, so both sides run one implementation |
| `src/blockheight.mjs` | The chain's height and the public endpoints it can be read from — one list in one place, because the same six URLs were previously copied into three scripts. Returns a number or `undefined`, never a throw and never a default, since `0` reads as both "genesis" and "the window closed long ago" |
| `src/provider.mjs` | The counterparty: terms, accept/refuse, invoice, payment, and the decoy plan — every decoy inside the window, because the quote's landing rate assumes it |

## Real pool measurement

Whole pool, mean over 400 real notes, load generation included:

| model | candidates | median | bits | alone |
|---|---|---|---|---|
| nominal | 8,323 | | 13.023 | |
| timing ±1 | 64.93 | 2 | 6.021 | 0.297 |
| timing ±10 | 65.05 | 2 | 6.023 | 0.282 |
| origins ±1 | 1.02 | 1 | 0.029 | 0.983 |
| origins ±10 | 1.11 | 1 | 0.151 | 0.92 |
| origins ±100 | 3.00 | 2 | 1.587 | 0.268 |
| same transaction | 64.91 | 2 | 6.020 | 0.307 |

Human-scale only (transactions minting ≤ 6 notes, which excludes the load
generators):

| model | candidates | median | bits | alone |
|---|---|---|---|---|
| notes ±10 | 1.91 | 2 | 0.932 | 0.414 |
| origins ±10 | 1.11 | 1 | 0.150 | 0.934 |
| origins ±100 | 2.95 | 2 | 1.562 | 0.330 |

Denomination, over the 2,857 of 8,323 notes whose amount is publicly derivable
(34.3% — the rest are change notes, and their amounts are left unknown):

| model | candidates | median | bits | alone |
|---|---|---|---|---|
| amount | 69.22 | 50 | 6.113 | 0.158 |
| timing+amount ±1 | **1.27** | 1 | **0.345** | 0.895 |
| timing+amount ±10 | 1.31 | 1 | 0.395 | 0.870 |
| timing+amount ±100 | 1.73 | 1 | 0.793 | 0.660 |

The `timing` rows and the `origins` rows differ by a factor of sixty, and the
gap is entirely bot traffic. That gap is why both columns exist. The
`timing+amount` row is the sharpest axis measured: knowing the amount takes a
±1-block observation from 65 candidates to 1.27, and 89.5% of amount-visible
notes have no other note of their denomination in that window at all.

### Mainnet

Whole pool, mean over 400 real notes, blocks 8,978,970 → 14,735,845:

| model | candidates | median | bits | alone |
|---|---|---|---|---|
| nominal | 32,924 | | 15.007 | |
| timing ±1 | 5.46 | 2 | 2.450 | 0.465 |
| timing ±10 | 7.83 | 3 | 2.969 | 0.217 |
| origins ±1 | 1.27 | 1 | 0.350 | 0.780 |
| origins ±10 | 3.25 | 2 | 1.703 | 0.435 |
| origins ±100 | 23.81 | 12 | 4.574 | 0.120 |
| same transaction | 5.15 | 1 | 2.365 | 0.618 |

Denomination, over the 18,215 of 32,924 notes whose amount is publicly derivable
(55.3% — mainnet exposes more than Sepolia does):

| model | candidates | median | bits | alone |
|---|---|---|---|---|
| amount | 72.36 | 19 | 6.177 | 0.268 |
| timing+amount ±1 | **1.15** | 1 | **0.202** | 0.863 |
| timing+amount ±10 | 1.33 | 1 | 0.411 | 0.785 |
| timing+amount ±100 | 3.37 | 1 | 1.751 | 0.570 |

Human-scale only (transactions minting ≤ 6 notes, 369 samples):

| model | candidates | median | bits | alone |
|---|---|---|---|---|
| notes ±10 | 4.07 | 3 | 2.025 | 0.238 |
| origins ±1 | 1.28 | 1 | 0.358 | 0.772 |
| origins ±10 | 3.38 | 2 | 1.758 | 0.425 |
| origins ±100 | 25.03 | 13 | 4.645 | 0.122 |

Mainnet's median cluster size is 1 against Sepolia's 2, and load generation is
7.9% of notes against Sepolia's 30.3%. The testnet is the more artificial
network of the two.

## Dashboard

`npm run web`, then open http://127.0.0.1:8080.

It is two pages, and they are two different jobs.

**`index.html` is the landing.** The argument: the hero states the finding, the
protocol section says how it is produced, the comparison says what is missing
elsewhere, the other-chains section points the same meter at chains with no
shielded pool, and the access section is the index of entry points.

**`app.html` is the instrument.** The meter, the cover simulator and the RDO
calculator — the three things you drive rather than read. It was a panel on the
landing until it became clear that a control panel above the argument asks a
visitor to operate something before they know what it is for.

Both pages load the same `app.js`, which imports the same `src/` modules the CLI
does. There is deliberately no second implementation of the maths in the UI — a
dashboard that recomputes the numbers its own way is a dashboard that will
eventually disagree with the paper. There is one stylesheet for both
(`assets/site.css`), because two copies of 350 lines drift on the first style
change.

The landing carries **two readings from two different files**: the hero states
STRK20 mainnet, and the other-chains section states whichever chain is selected
there. They cannot share a painter or a selector — one selector cannot hold two
selections, and the finding's measurement has no `claimedBits` to print, so the
hero would have read "none" for bits claimed while sitting above a page about
STRK20.

Move the sliders and the thing worth noticing is how little the pool size
matters. Take a 2,000-note pool to 20,000 and the `naive` number goes up by
3.3 bits; the `all` number barely moves, because an adversary who knows your
timing window and your denomination is not searching the whole pool.

Both pages deploy to GitHub Pages on every push to `main`, so the public URL and
your local copy can never drift apart.

## The synthetic model

Seed 20260911, 2,000-note pool, ±10-block timing window, 7 denominations,
Sepolia fee of 2 STRK per action. This is the *cover pricing* model — the real
pool above is what motivates it.

**M1 — can an observer pick our traffic out of the pool?**

| | balanced accuracy |
|---|---|
| legacy wire-v2 shape | **1.0000** (perfectly separable) |
| Ruido (randomised envelope) | **0.5000** (guessing) |

**Anonymity set, by adversary model**

| model | candidates | bits |
|---|---|---|
| naive | 2000 | 10.97 |
| amount | 288 | 8.17 |
| timing | 9.3 | 3.22 |
| timing + amount | 2.2 | 1.12 |
| **all** | **1.9** | **0.95** |

A 2,000-note pool gives you **under one bit** against an adversary who knows
both when you transacted and how much. That is the number worth publishing.

**Placement is the whole game**

STRK per bit, adversary model `all`, measured on the same 100 notes throughout.
The three columns are the three positions a provider can be in: **aimed** knows
the window and the denomination, **window-only** knows when you move but not how
much, and **blind** knows neither and emits continuously.

| decoys | blind | window-only | aimed |
|---|---|---|---|
| 10 | 5,358 | 26.6 | **7.6** |
| 50 | 4,899 | 45.2 | **21.1** |
| 250 | 4,594 | 116.8 | **71.1** |

Window-only is the position a provider can actually be held to, because cover has
to land before the spend: the timing is given away by construction, and the
denomination is the only thing a buyer can withhold.

The table above compares at the same **budget**, which is one question. The other
— and the one a buyer actually asks — is the same **anonymity**. There, the cost
of withholding the denomination is **exactly the ladder width**, 7× on a 7-rung
ladder, because hiding which rung is yours means emitting all of them: three bits
takes 14 decoys aimed and 95 window-only. At the same budget it reads 3.5× at ten
decoys, falling to 1.5× at five hundred — and that fall is not window-only
improving. At 500 decoys both strategies are buying saturated bits, at 191 and
125 STRK/bit.

Read the blind column as an order of magnitude, not a price: at ten decoys its
gain is under 0.005 bits, below what 100 notes can resolve, so the ~5,400
STRK/bit there is a noisy echo of the exact factor below — 1,709 × aimed cover's
*cheapest* bit (3.3), which is 5,640. Blind cover never gets far enough from its
base to saturate, so it stays at the base price. Here is the quantity underneath
all three, measured on a sample large enough to be exact:

| strategy | decoys | on cell | rate | decoys per cell note |
|---|---|---|---|---|
| blind | 200,000 | 117 | 0.00059 | **1 in 1,709** |
| window-only | 200,000 | 28,594 | 0.14297 | **1 in 7** |
| aimed | 200,000 | 200,000 | 1.00000 | **1 in 1** |

Blind cover is the same product at **1/1,700th the yield**: six decoys in seven
land on a rung the adversary does not care about, and of the seventh, only 1 in
238 lands in the window. That is the whole argument for aiming it, and it is why
Ruido sells aimed cover rather than generic noise.

**The cheapest bit is the first one**

| decoys | cell | gained | STRK/bit |
|---|---|---|---|
| 1 | 2.93 | +0.602 | **3.3** |
| 5 | 6.93 | +1.844 | 5.4 |
| 10 | 11.93 | +2.628 | 7.6 |
| 50 | 51.93 | +4.750 | 21.1 |

Aimed cover against a pool whose average note sits in a cell of 1.93 candidates.
The price rises monotonically, because bits grow logarithmically while cost grows
linearly — there is no volume discount on anonymity. So a quoted STRK/bit is an
operating point, not a price, and quoting one without the order size is a
mistake. Both tables come out of `npm run measure`, and both are re-runnable.

## What Ruido is not

- **Not a privacy guarantee.** It buys bits of anonymity at a published price.
  It cannot fix a leak at the protocol layer: if the pool writes both
  counterparty addresses in the clear at channel open, no amount of cover
  traffic hides the relationship.
- **Not a mixer, and not custody.** Decoys carry no plaintext and no key
  material. Nothing in Ruido ever holds a user's pool key.
- **Not a privacy guarantee.** It buys bits of anonymity at a published price.
- **Not a fix for the prover.** If your prover and write RPC see your pool key,
  cover traffic is theatre. Self-host first, or use OHTTP.
- **Not a complete adversary.** The measurement models an attacker with public
  RPC data only. No mempool, no IP addresses, no exchange records, no amounts.
  Every figure is an upper bound on privacy.
- **Not a census of either chain.** The STRK20 measurements cover every event
  the pool has ever emitted. The Robinhood Chain measurement is a **sampled
  window** of 24,000 contiguous blocks out of 60.7M, because the public RPC
  sustains roughly 20 blocks/s and the full chain is about 144 days of scanning.
  The window, its coverage, and any missing blocks are printed with the result.

## Roadmap

1. ~~**Real corpus.**~~ Done for both networks — see
   [`docs/FINDING-strk20-sepolia.md`](docs/FINDING-strk20-sepolia.md).
2. ~~**Mainnet corpus.**~~ Done. It falsified our prediction, which is the most
   useful thing it could have done.
3. ~~**Point the meter at a chain with no shielded pool.**~~ Done for three
   chains — see [`docs/FINDING-robinhood-chain.md`](docs/FINDING-robinhood-chain.md)
   and [`docs/FINDING-multichain.md`](docs/FINDING-multichain.md). The result is
   0 bits everywhere, and the useful part is that the candidate set is *large*.
4. ~~**Denomination axis.**~~ Done, and it was the sharpest axis measured. The
   indexer now decodes `amount` and `token` out of the event payloads. It covers
   the 34.3% of Sepolia notes whose amount is publicly derivable and 55.3% on
   mainnet; the rest are change notes with no public amount, and they are left
   unknown rather than estimated. Knowing the amount takes a ±1-block
   observation from 64.93 candidates to 1.27. Getting there required fixing a
   join bug that had been silently *inflating* coverage by 508 notes — see
   [`docs/FINDING-strk20-sepolia.md`](docs/FINDING-strk20-sepolia.md).
5. **On-chain decoy emitter.** Started, and both blockers are now named — see
   [`docs/FINDING-emitter-interface.md`](docs/FINDING-emitter-interface.md).
   The `apply_actions` calldata is decoded and verified against real transactions
   *and* against live contract state.
   - `user_private_key` is resolved: it is the pool's **viewing** key, not the
     account key. Still a secret, so the emitter **requires a local node** —
     calling `compile_actions` over a public RPC is a key-disclosure tool.
   - Screening is enforced where the contract says so, and the contract says so
     narrowly: a set needs an attestation only if it carries a deposit
     (`TransferFrom`) or an invoke that returns deposits to open notes under a
     non-`Exempt` target. The attestation cannot be minted by us, so the
     **funding leg** needs StarkWare's hosted prover — an external dependency of
     the product.
   - **The internal path does not need the screener.** Measured on the live class
     `0x6d163f2b`: all **44** deposit sets carry an attestation, and all **15**
     sets with neither a deposit nor an invoke carry `None` — none carry one. So
     an emitter that spends a note and reshapes it into decoys plus change can be
     built and exercised end to end today.
   - **The invoke case is closed, and it never needed a node either.** Screening
     on an invoke is narrower than "the set contains an invoke":
     `_apply_invoke_and_deposits` writes a subject only when the call *returns
     deposits to open notes* **and** the target's policy is not `Exempt`. Since
     `get_open_note_screening_policy` is a pool view, the policy is readable
     *before* invoking. Measured over 120 sampled transactions: `Exempt` targets
     carried **0 `Some` / 3 `None`** and `Required` targets **12 `Some` /
     9 `None`** — necessary but not sufficient, exactly as the contract
     describes. `npm run check:invokes` reproduces the table.
   - **`ClientAction` → `ServerAction` is reproduced.** `npm run verify:compile`
     provokes the pool's own ordering rules on the live contract and compiles a
     real action set, decoding the result with this repository's decoder. It needs
     no local node: every call uses a throwaway identity that controls nothing, so
     the viewing key that goes to the RPC is worthless by construction.
   - **The calldata encoder now exists, and it is the decoder's inverse.**
     `npm run verify:encode` round-trips real transactions: decode one,
     re-encode it, require the felts to come back identical. **83 transactions
     spanning all seven implementations, exact**, 29 of them on the live class.
     It is written against the decoder rather than against the Cairo spec, on
     purpose — the decoder is the half that has been held against the chain, so
     an encoder that round-trips through it inherits that validation, while an
     encoder written from a reading of the spec inherits nothing. This is the
     piece the emitter needed to exist at all: the repository could read
     `apply_actions` calldata and could not write it.
   - The enum index and the phase number are **different tables** —
     `CreateEncNote` is variant 3 but phase 5. The verification pins both.
   - Getting that number right required fixing three decoder bugs that had
     inverted an earlier conclusion — see the finding. The headline lesson is
     that the exact-consumption check, not the decoded value, is what caught it.
6. **Provider network + rewards.** See [`docs/TOKEN.md`](docs/TOKEN.md).
7. **The customer path — built end to end, and it never needed the node.** Order,
   payment and settlement all sit *above* the emitter: none of them depends on
   Sepolia, on the calldata work, or on a host. Both sides are written and tested —
   `src/commitment.mjs`, `src/quote.mjs`, `src/order.mjs`, `src/settlement.mjs` for
   the buyer, `src/provider.mjs` for the counterparty, and `npm run buy` against
   `npm run serve:provider` for the exchange itself, with
   [`docs/ORDER.md`](docs/ORDER.md) as the spec. It was blocked by one decision, now
   resolved: the provider is told the window, because cover has to land before the
   spend, and the denomination is the only axis a buyer can withhold — at exactly
   the ladder width for the same anonymity. The whole trade closes offline:
   `tests/provider.test.mjs` commits, accepts, invoices, pays, plans, settles and
   claims without touching a chain.

   What used to be missing here was plumbing, and three of the four pieces now
   exist. **Paying** is real: `src/payment.mjs` binds a bare STRK transfer to one
   order with a per-order tag, reads the receipt, and answers in four verdicts
   instead of two — with `unreadable` a refusal rather than a hopeful credit.
   **Listing** is real: `src/orderbook.mjs` publishes standing *offers* and has no
   window parameter anywhere, so a buyer's cell cannot reach it; it reads each
   provider's own terms rather than accepting a composed row, and refuses by name
   any offer carrying a field that describes one buyer. **Being safe to expose** is
   real: `src/trust.mjs` closes every route that costs money behind a bearer token,
   limits requests *before* it checks the token, and refuses at startup to listen
   on a public interface without one. What is still missing is the emitter — and
   that is the one piece that genuinely needs the local node.

   Two limits are worth stating rather than discovering. The reference provider
   still has no TLS and no durable order book, so the token travels in clear unless
   something terminates TLS in front of it. And it learns **when** its buyer
   transacts, which is the position being sold and belongs in any provider's
   written policy.

## Related findings

- [`docs/ORDER.md`](docs/ORDER.md) — **the protocol a buyer and a provider have to
  agree on.** The split commitment and why one commitment cannot express the
  middle position, the window proof a provider is given and the denomination half
  it must not be, the wire format, the quote, and the first-claim rule that stops
  one batch of decoys being sold to every buyer who asks. It runs offline:
  `npm run quote` prices an order, `npm run serve:provider` and `npm run buy`
  execute one.
- [`docs/CUSTOMER.md`](docs/CUSTOMER.md) — **how the end customer uses it.** They
  run none of this: no node, no prover, no key. The customer measures, commits to a
  cell, transacts with their own wallet, and reveals. It also prices the three
  positions a provider can be in — aimed, window-only and blind — and finds that
  the single commitment in `TOKEN.md` §3 cannot express the middle one.
- [`docs/RUNBOOK-emitter.md`](docs/RUNBOOK-emitter.md) — **what it takes to close
  the last gap.** The blocker is circular: to spend a note you need a note, and
  getting one is the only leg that may need a third party. The resolution is a
  dedicated decoy account, and the runbook is the ordered steps plus what gets
  built once the node is up.
- [`docs/CONNECT.md`](docs/CONNECT.md) — **how the operator connects to the
  chain** — not how a customer connects to a provider, which is `ORDER.md`. The
  write path is one host: emitter, Juno and the prover on loopback. The pool
  viewing key travels *in the calldata* to the preflight RPC and *in plaintext* to
  the prover, which is why a public endpoint is read-only and why the hosted
  prover cannot be used for an emission.
- [`docs/FINDING-strk20-sepolia.md`](docs/FINDING-strk20-sepolia.md) — the real
  pool measurement, plus the discovery that a single-ABI index silently drops
  pre-upgrade events. The pool has run **seven** implementations; event-key
  evidence found three, and resolving the class hash at every corpus
  transaction's own block found the other four.
- [`docs/FINDING-robinhood-chain.md`](docs/FINDING-robinhood-chain.md) — the
  same meter pointed at a chain that has no shielded pool and claims none.
- [`docs/FINDING-multichain.md`](docs/FINDING-multichain.md) — the same meter on
  Base and Ethereum, and the three times the shielded-pool detector was wrong
  before it was right. Includes a control that turned out not to be one.
- [`docs/FINDING-m1-stale.md`](docs/FINDING-m1-stale.md) — the upstream
  measurement script's documented M1 baseline no longer matches what their own
  code reports.

# Finding: a chain with no shielded pool reads 0 bits — and a *larger* candidate set than the pool does

> **The number inverts.** At the same wall-clock window (±17 s), STRK20 mainnet
> puts a transaction among **3.25** candidates and Robinhood Chain puts it among
> **2,304**. Robinhood Chain has 709× the candidates and strictly less privacy,
> because its candidates are not candidates. They are identified parties.
>
> On STRK20, 42.5% of notes are alone in their window. On Robinhood Chain,
> **0.0%** are — nobody is ever alone — and it is still the transparent one.
> A candidate count only becomes an anonymity set when the parties inside it are
> indistinguishable from each other. That is the whole finding.

Measured 2026-09-11 against a sampled window of Robinhood Chain (Chain ID 4663).
Reproduce with:

```
npm run blocktimes   # the unit every window is stated in
npm run rh:index     # index a window -> data/corpus-robinhood.json
npm run rh:measure   # measure it    -> data/measurement-robinhood.json
```

## Why this chain

Robinhood Chain is an Arbitrum Orbit L2 launched 1 July 2026, marketed to
28 million retail clients for 24/7 tokenized equities. It is permissionless, so
anyone can deploy to it, and it has no shielding primitive. Its own ecosystem
page lists **TRM Labs** under "Compliance & Risk Management" and never mentions
privacy. Nothing about it is hidden, and it claims nothing.

That makes it a useful target for a different reason than the STRK20 pool was.
STRK20 was worth measuring because its nominal/effective gap was unmeasured.
Robinhood Chain is worth measuring because it tests whether our method is a
method or a habit. On a chain with no note set, the nominal/effective
distinction has nothing obvious to bite on. If the meter can only produce a
number where a pool exists, it is a tool for flattering pools.

## What was measured

Blocks 60,659,125 → 60,683,124 — **24,000 contiguous blocks**, 40.8 minutes of
chain time, **377,416 transactions**, 0 blocks missing.

The adversary sees **only public block data from a public RPC**: block numbers,
timestamps, sender and recipient addresses, and values. No mempool, no IP
addresses, no KYC records. A real adversary — and the operator of this chain
specifically — has all of those.

## The number

| | STRK20 mainnet | Robinhood Chain |
|---|---|---|
| block time | 1.702 s | 0.102 s |
| window in blocks | ±10 | ±167 |
| **same window in seconds** | **±17 s** | **±17 s** |
| candidate set | 3.25 origins | 2,304.4 senders |
| bits | 1.758 | **0** |
| fraction alone | 42.5% | 0.0% |
| what a candidate is | an unlinkable note | an address, in the clear |

The two chains differ in block time by **16.7×**. A table that put "±10 blocks"
in both columns would have compared 17 seconds against 1, and reported a
difference that is an artefact of block cadence rather than of privacy. Every
window in this report is stated in seconds, and `npm run blocktimes` measures
the conversion from the chains instead of assuming it.

## Full timing table

Mean over 250 sampled real transactions:

| window | candidates | median | bits | alone |
|---|---|---|---|---|
| ±1 s | 333.5 | 328 | 8.382 | 0.0% |
| ±10 s | 1,567.2 | 1,590.5 | 10.614 | 0.0% |
| **±17 s** (matches STRK20) | **2,304.4** | **2,327.5** | **11.170** | **0.0%** |
| ±60 s | 5,488.5 | 5,501 | 12.422 | 0.0% |
| ±300 s | 15,069.6 | 15,485.5 | 13.879 | 0.0% |
| ±600 s | 22,189.1 | 23,714 | 14.438 | 0.0% |

11.17 bits at ±17 s is a large number and it is reported as measured. It is not
privacy, and the reason is structural rather than statistical:

1. **The sender of every transaction is public.** The adversary reads the answer
   instead of guessing it. The candidate set for "who sent this" is 1, by
   construction.
2. **Addresses persist.** One link deanonymises the entire history of an
   address. The reuse figures below quantify how often that matters.
3. **ERC-4337 carries 0.45% of transactions.** Account abstraction is advertised
   by the chain; measured, it is 1,710 of 377,416 transactions. With no paymaster
   in the path for 99.55% of activity, there is no separating layer between the
   identity and the transaction.
4. **A single operator sequences the chain first-come, first-served.** It sees
   arrival order and, for accounts it serves, the identity behind them. This is
   not observable from public data, which is why it is excluded from every number
   above — and why every number above is an upper bound.

## Address reuse is where the set collapses

| | |
|---|---|
| distinct senders | 37,335 |
| transactions per sender | 10.109 |
| senders used exactly once | 13,028 (34.9%) |
| **senders accounting for 50% of all activity** | **731 (2.0%)** |

**Two percent of the addresses move half the traffic.** A second transaction from
an address is not a new suspect; it is a confirmation of a link the adversary
already held. So the honest reading of "2,304 candidates in a ±17 s window" is
that most of those 2,304 are the same few hundred parties appearing again, each
of them persistently identifiable across the entire window and beyond it.

## Destination traffic is concentrated too

| | |
|---|---|
| distinct targets | 11,510 |
| top 1 contract's share | 9.5% |
| top 10 contracts' share | 39.0% |
| top 100 contracts' share | 76.2% |
| contracts needed for 80% of traffic | 140 |

"What is this address doing" is largely answered by which contract it calls, and
140 contracts answer it for 80% of the traffic.

## The shielded-pool test, and why it is behavioural

Contract names were **not** resolved against an explorer. An explorer is a third
party with its own incentives, and its label is not evidence. So the test is the
shape of the value distribution, because a mixer cannot hide it: fixed
denominations, reused hundreds of times, leave a small value space relative to
the number of transfers. Ordinary traffic does the opposite.

### Whole-chain, which cannot fire here

| | observed | a mixer would read |
|---|---|---|
| value transfers | 79,586 | many |
| distinct values | 35,263 | a handful |
| values appearing once | 33,590 (95.3%) | a minority |
| top 5 share of transfers | 16.0% | > 60% |
| value space ratio | 0.4431 | < 0.1 |
| **signature present** | **false** | true |

This table is kept because it is what the first version of the test published,
and because it shows why the test had to change: **on a busy chain it can never
fire.** One contract's behaviour is invisible against 79,586 value transfers.

### Per contract, which is the test that counts

A mixer is a contract, not a chain. The same test applied to each contract that
received at least 50 value transfers:

| | observed |
|---|---|
| contracts with value transfers | 6,280 |
| contracts scanned (≥ 50 transfers) | 111 |
| value shape matched | 11 |
| **viable pool candidates** | **0** |

All eleven failed a condition a pool cannot fail, and none is hidden — the
measurement JSON lists each one with its reason. The distribution is the finding:

| reason | contracts |
|---|---|
| one depositor — an anonymity set of 1 by construction | 4 |
| no outflow — value only ever goes in | 6 |
| outflow not pool-shaped — takes a fixed denomination, pays out irregular amounts | 1 |

The single closest case is worth stating in full, because it is why the last
condition exists. `0xda5494742e05ca4c1271df6fd515f89635c702fe` took 120 deposits
of exactly 0.0005 ETH from **72 distinct addresses** and made 10 withdrawals — 7
of them to the same address, in irregular lumps of 0.77 to 18.62 ETH. That is a
fee accumulator sweeping to its treasury. **A pool returns the denominations it
took.**

A detection therefore requires four things, of which the last three are
requirements rather than thresholds: the value shape, more than one depositor,
value flowing both ways, and a pool-shaped outflow. The thresholds are in
`src/evm.mjs`, and the detector is tested against every shape it has to separate
— including synthetic cases that prove it *can* fire and that prove each
condition *rejects*, because a detector that always answers "no pool" manufactures
confidence rather than removing it.

The full account of how this test was wrong three times before it was right is in
[`FINDING-multichain.md`](FINDING-multichain.md).

## Two exclusions, stated rather than applied quietly

**`0x…a4b05` was removed from the identity counts.** It is written exactly once
per block: Arbitrum's L1-block-number pseudo-address. Left in, it is the single
most active "account" on the chain — a phantom power user with 100% block
participation. 24,168 such transactions were excluded and the count is published
alongside the result. The exclusion list is explicit in `src/chains.mjs`, and the
indexer separately **reports** any address whose transaction count equals the
block count, so a missed entry shows up as a warning instead of silently
inflating the numbers.

**This is a sample, not a census.** The public RPC sustains roughly 20 blocks/s
with batching. The chain is 60.7M blocks — about 144 days of sequential
scanning. This window covers 0.04% of the chain. It is contiguous, it has no
holes, and its coverage is printed with every figure. A sample that presents
itself as a census is worse than no sample.

## What we did not measure

- **The operator's view.** The sequencer sees arrival order and, for the
  accounts it serves, the identity behind them. Not measurable from public data,
  and it makes every number here an upper bound.
- **Off-chain clustering.** The chain's own ecosystem page lists TRM Labs under
  compliance. Whatever that clustering achieves is invisible from here.
- **Any shielded pool.** None was observed in this window. If one exists
  elsewhere on the chain it is a separate population and this measurement does
  not describe it.
- **Contract identity.** No explorer labels were used. The concentration figures
  are real; the names behind the addresses are not asserted.

## What would falsify this

- Finding a transaction on this chain whose sender is not present in the public
  block data. That falsifies the 0-bit result directly.
- Showing that a large timing candidate set on a chain with persistent,
  cleartext addresses *does* provide anonymity. That is the claim this rests on.
- Showing that the ±17 s window is unjustified — that a real adversary cannot
  narrow to a range that tight. The 0.0% "alone" figure is the case to argue
  with: at ±1 second, 333 distinct senders are active around a typical
  transaction.
- A window in which 4337 paymaster traffic carries a meaningful share of
  transactions, which would put a separating layer between identity and
  transaction.

## A note on the docs

The official Robinhood Chain documentation lists **Chain ID 4663 for both
mainnet and testnet**. The testnet reports `0x0b626` = **46630**. The registry in
`src/chains.mjs` carries what the chain says, not what the docs say, and a test
asserts it. This is a small thing and it is the reason the registry exists: a
measurement that trusts a document over the chain it is measuring has already
stopped being a measurement.

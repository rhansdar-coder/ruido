# The same meter on three more chains

*Measured 11–12 September 2026 from public RPC only. Every figure is reproducible
with the commands in this document.*

> **The result in one line:** at the same ±17-second window, Robinhood Chain
> offers 2,304 candidate senders, Base 1,356, and Ethereum 688 — against STRK20
> mainnet's 3.25 candidate notes. All three offer **0 bits** of effective
> anonymity, against STRK20's 1.758. **709× the candidates, less privacy.**
>
> And the detector that was supposed to find a shielded pool on a transparent
> chain was wrong three times before it was right.

---

## Why these three chains

STRK20 is a shielded pool, so it is the wrong control for a detector whose job is
to find shielded pools on chains that do not have them. Robinhood Chain, Base and
Ethereum are transparent by design: every sender is written into the transaction.
They are what almost every chain is.

They also differ from each other in the one way that matters most for a
block-window measurement: **block time**.

| chain | Chain ID | stack | block time | window indexed | wall-clock |
|---|---|---|---|---|---|
| Robinhood Chain | 4663 | Arbitrum Orbit | 0.102 s | 24,000 blocks | 40.8 min |
| Base | 8453 | OP Stack | 2.000 s | 3,000 blocks | 100.0 min |
| Ethereum | 1 | Ethereum L1 | 12.056 s | 3,000 blocks | 602.6 min |

Three windows of similar *size* that cover 40 minutes, 100 minutes and 10 hours.
A table that put them side by side under a "±10 blocks" heading would be
comparing 1 second against 120.

---

## The number, at the shared window

±17 s is the exact wall-clock equivalent of the ±10-block window already
published for STRK20 (10 × 1.702 s). Same formula, same window, four chains:

| at ±17 s | STRK20 mainnet | Robinhood Chain | Base | Ethereum |
|---|---|---|---|---|
| block time | 1.702 s | 0.102 s | 2.000 s | 12.056 s |
| window in blocks | ±10 | ±167 | ±9 | **±1** |
| candidate set | 3.25 origins | 2,304.4 senders | 1,356 senders | 687.9 senders |
| median candidates | — | 2,327.5 | — | 653.5 |
| nominal bits | 1.758 | 11.170 | 10.405 | 9.426 |
| alone in their window | 42.5% | 0.0% | 0.0% | 0.0% |
| effective bits | **1.758** | **0** | **0** | **0** |
| what a candidate is | an unlinkable note | an address | an address | an address |

### Ethereum is where the unit correction runs backwards

On Ethereum, ±17 s is **±1 block**. That is why the ±1 s and ±10 s rows in its
timing table are *identical* — 292.9 candidates, 8.194 bits, both:

```
  ±1 s        292.9        266.5    8.194    0.0%
  ±10 s       292.9        266.5    8.194    0.0%
  ±17 s *     687.9        653.5    9.426    0.0%
```

Ten seconds is less than one Ethereum block, so widening the window from ±1 s to
±10 s widens it by nothing at all. A block-denominated comparison across these
four chains would have hidden that entirely.

### The candidate set is not an anonymity set

On STRK20, 3.25 candidate notes is 1.758 bits *of privacy*, because the notes are
unlinkable and the adversary must guess. On the other three, 2,304 addresses is 0
bits, because the adversary does not guess — they read the sender field.

**A number only becomes privacy when the parties inside it are indistinguishable
from each other.** This is the whole thesis of the project, and pointing the
meter at three ordinary chains is what makes it visible as a table rather than as
an argument.

### Address reuse collapses it further

| | Robinhood Chain | Base | Ethereum |
|---|---|---|---|
| distinct senders | 37,335 | 37,886 | 250,246 |
| transactions per sender | 10.109 | 14.418 | 3.241 |
| used exactly once | 34.9% | 51.9% | 71.0% |
| senders for 50% of traffic | **731 (2.0%)** | **289 (0.8%)** | **5,083 (2.0%)** |
| distinct targets | 11,510 | 15,597 | 148,105 |
| top 10 contracts' share | 39.0% | 28.7% | 33.0% |
| contracts for 80% of traffic | 140 | 103 | 11,722 |

On all three, **under 2% of senders move half the traffic**, and a hundred-odd
contracts carry 80% of it. An address that appears fourteen times is not fourteen
independent observations of a person; it is one person observed fourteen times.

---

## The detector, and the three times it was wrong

A test that only ever answers "no" is not a test. So the shielded-pool detector
was designed to be falsifiable: a Tornado-style pool concentrates transfers into
a handful of fixed denominations reused many times, which leaves a **small value
space** relative to its transfer count. Ordinary traffic is long-tailed with a
large value space. Thresholds are stated in the code and can be argued with:
`top5Share > 0.6` **and** `valueSpaceRatio < 0.1`.

It was then run, and each run broke it.

### Correction 1 — whole-chain was the wrong granularity

Run chain-wide on Ethereum, it answered **no shielded pool**, on a chain where
Tornado Cash is deployed. The cause was dilution, and it is arithmetic: a 10-hour
Ethereum window carries 339,950 value transfers, and a working mixer with a
hundred deposits is 0.03% of that. A chain-wide distribution can never be
concentrated enough to fire.

The honest reading is not "Tornado Cash is gone". It is **the test was asking the
wrong question. A mixer is a contract, not a chain.** So the test was rewritten
per contract: for each target receiving at least 50 value transfers, does *that
contract's* own value distribution look like a mixer?

### Correction 2 — the value shape over-reports

Per contract on Robinhood Chain, it fired on **11 contracts**. Investigating them
showed what they were: fixed-amount payment patterns.

| contract | transfers | value ratio | depositors | out | what it actually is |
|---|---|---|---|---|---|
| `0x225cc3ce…e4a0` | 530 | 0.0019 | 8 | 0 | 10 wei dust, 8 bots |
| `0xca75df55…0721` | 256 | 0.0039 | 160 | 0 | fixed-amount intake |
| `0xca0e42c1…fd84` | 159 | 0.0189 | 36 | 0 | fixed-amount intake |
| `0x5c811d91…c301` | 114 | 0.0088 | 75 | 0 | fixed-amount intake |
| `0x3c51e1c0…1d56` | 105 | 0.0190 | **1** | 0 | one bot, one amount |
| `0x02f36939…09fb` | 94 | 0.0106 | **1** | 0 | one bot, one amount |
| `0x8f6f0cb3…eac3` | 85 | 0.0118 | **1** | 0 | one bot, one amount |
| `0x6e8395d3…2b45` | 71 | 0.0423 | **1** | 0 | one bot, one amount |
| `0x7ed598bc…ec7e` | 57 | 0.0175 | 53 | 0 | fixed-amount intake |
| `0xb3c3f1cd…1570` | 57 | 0.0175 | 16 | 0 | fixed-amount intake |

A sale at a fixed price, a batch payer, a single bot repeating an amount — all of
them produce the same deposit shape as a mixer deposit pool. **The shape alone
cannot tell them apart.** So two conditions were added, and neither is a tuned
threshold:

- **More than one depositor.** A pool's anonymity set *is* its set of depositors.
  A contract with one depositor offers an anonymity set of one, whatever its
  value shape looks like.
- **Value flowing both ways.** A pool takes deposits and lets them out. Value
  that only ever goes in is a vault, a fee collector or a sale.

### Correction 3 — a fee collector wears the same shape

One candidate survived both. `0xda5494742e05ca4c1271df6fd515f89635c702fe`:
120 transfers, value ratio 0.0083, **72 distinct depositors**, 10 outflows. It
passed every condition so far.

Its withdrawals settled it:

- 7 of the 10 went to the **same address**, `0x0bd7d308…ad73`
- in **irregular lumps**: 11.47, 2.70, 0.77, 4.94, 15.56, 1.29, 18.62 ETH
- against a deposit denomination of **0.0005 ETH** — 3,000× to 37,000× larger
- the other 3 went to fresh addresses at exactly 1.5 ETH each

**A pool returns the denominations it took.** This contract takes a fixed
micro-fee and sweeps the accumulated balance to a treasury. Calling it a shielded
pool would have published a fabricated finding, which is the one thing this
project exists not to do.

So a third condition: **the outflow has to be pool-shaped too.** The same test,
applied to the outgoing side. A real Tornado-style pool passes it — deposits of
0.1/1/10/100 ETH, withdrawals of 0.1/1/10/100 ETH, a tiny outflow value space.

**A detection now requires four things**, of which the last three are
requirements a pool cannot fail:

1. the value shape — few fixed denominations, reused many times
2. more than one depositor
3. value flows both in and out
4. the outflow is pool-shaped too — it returns what it took

### The result

| | Robinhood Chain | Base | Ethereum |
|---|---|---|---|
| contracts with value transfers | 6,280 | 7,346 | 130,684 |
| contracts scanned (≥ 50 transfers) | 111 | 45 | 313 |
| value shape matched | 11 | 9 | 15 |
| **viable pool candidates** | **0** | **0** | **0** |

Nothing is hidden: every contract the shape test fired on is listed in the
measurement JSON with the reason it was rejected. **The gap between the two
counts is the finding.**

Base's nine are all either one-depositor contracts or contracts with no outflow.
Ethereum's fifteen likewise, with the busiest — `0x316fb96c…241b`, 960 transfers
from 925 depositors and 911 outflows — rejected because its outflow carries 322
distinct amounts. That is a high-volume many-party contract, not a pool.

---

## A control that failed to be one

Ethereum was registered in `src/chains.mjs` as the **positive control** for the
detector, because Tornado Cash is deployed there and every other registered chain
can only ever make the detector answer "no".

Then it was measured, and the control does not work:

| Tornado Cash contract | transfers in the window |
|---|---|
| 0.1 ETH pool `0x12d66f87…b8fc` | **1** |
| TORN token `0x77777fed…116c` | 13 |
| 1 ETH pool `0x47ce0c6e…2936` | 0 — not in the window at all |
| 10 ETH pool `0x910cbd52…9dbF` | 0 |
| 100 ETH pool `0xa160cdab…f291` | 0 |
| Router `0xd90e2f92…0EA3` | 0 |

Tornado Cash is deployed and **effectively dormant** — sanctioned and
deprecated. A recent window cannot exercise the detector at all, so the `false`
it returned on Ethereum proves nothing in either direction.

**The proof that the detector can fire is a unit test with a mixer-shaped
fixture**, not this chain. A live control would need an archive node and a
2022-era window. That is recorded in the registry entry, next to the chain it
concerns, so the claim cannot drift away from its correction.

One address did appear that is worth naming: `0xd90e2f925da726b50c4ed8d0fb90ad053324f31b`
shares a **29-character hex prefix** with the Tornado Cash router and is not it.
It was rejected as a pool candidate for having no outflow.

---

## ERC-4337, measured rather than assumed

Account abstraction is advertised heavily. Measured:

| | Robinhood Chain | Base | Ethereum |
|---|---|---|---|
| EntryPoint transactions | 1,710 | 22,602 | 8,944 |
| share of all transactions | **0.45%** | **4.14%** | **1.10%** |
| EntryPoint v0.7 | 1,497 | 14,572 | 7,166 |
| EntryPoint v0.6 | 213 | 8,030 | 1,778 |

Base uses it **nine times** as heavily as Robinhood Chain. On Robinhood Chain,
99.55% of transactions have no paymaster in the path, so the fee payer is the
user and there is no separating layer between the identity and the transaction.
That is a clause in the identifiability list, and it is falsifiable: *a window in
which EntryPoint traffic carries a meaningful share of transactions.*

Base is approaching that threshold. Robinhood Chain is not near it.

---

## Two exclusions, and one that was deliberately not made

**Excluded, by explicit list.** Robinhood Chain: 24,168 transactions to
`0x…a4b05`, the Arbitrum L1-block-number pseudo-address, written exactly once per
block. Base: 3,001 transactions to `0xdeaddead…0001`, the OP Stack L1 attributes
depositor, exactly one per block. Ethereum: none. Leaving these in would make
them the most active "accounts" on their chains.

**Reported, never auto-excluded.** Both indexers flag any address whose
transaction count approaches the block count, and publish the list. On Base that
list has 23 entries at 0.92 to 4.00 transactions per block; on Ethereum, 10
entries at 0.91 to 3.34. Every one is a **high-frequency bot**, not
infrastructure — a bot that trades every block looks identical to a system
address under a count-based heuristic.

This is why the heuristic reports instead of excluding. A rule that silently
dropped anything transacting once per block would have deleted 23 real
participants from Base's counts and quietly flattered every number built on them.

**Not a census of any chain.** Each window is contiguous but sampled:

| | blocks indexed | blocks on chain | coverage |
|---|---|---|---|
| Robinhood Chain | 24,000 | 60,683,124 | 0.0396% |
| Base | 3,000 | 51,193,541 | 0.0059% |
| Ethereum | 3,000 | 25,957,881 | 0.0116% |

---

## What would falsify this

- **A window in which a contract passes all four conditions.** That would be a
  candidate, and it would need its own measurement — the 0-bit figure covers the
  transparent population only.
- **A Tornado-style pool found on any of these chains**, which is what the
  detector exists to look for and did not find.
- **EntryPoint traffic becoming a meaningful share of Robinhood Chain
  transactions**, which would break the "the fee payer is the user" clause.
- **A sender absent from the public block data** on any of the three chains.
- **The whole-chain test firing on a busy chain**, which the dilution argument
  says is impossible.
- **A pool that pays out net of a variable fee** would have a many-valued outflow
  and be rejected by condition 4. That is a real limitation of the current
  thresholds, not a defence of them: they are calibrated on fixed-denomination
  designs, and a variable-fee design would be missed.

---

## Reproduce it

```
npm run blocktimes     # the unit every window is stated in, measured live
npm run rh:index       # 24,000 blocks of Robinhood Chain   (~21 min)
npm run rh:measure
npm run base:index     # 3,000 blocks of Base               (~6 min)
npm run base:measure
npm run eth:index      # 3,000 blocks of Ethereum           (~6 min)
npm run eth:measure
```

Two operational notes, both learned the hard way.

**Windows are in seconds because block times differ by 118×.** From 0.102 s on
Robinhood Chain to 12.056 s on Ethereum.

**The indexer holds its window in memory, and Base is dense.** The first attempt
at a 12,000-block Base window died with a V8 heap-limit dump after 6,125 blocks,
on a machine with 1.3 GB free. Base used roughly 0.33 MB per block. The indexer
now prints free RAM and an estimated requirement before it starts, and warns
instead of crashing. Base's window is 3,000 blocks for that reason, which is a
measured constraint rather than a preference.

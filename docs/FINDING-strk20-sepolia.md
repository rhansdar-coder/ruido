# Finding: the STRK20 pool offers 1.8 bits on mainnet and 0.15 on Sepolia

> **Our prediction was wrong, and the mainnet measurement is what caught it.**
> The methodology said mainnet "should read worse, not better" because a quieter
> pool has fewer notes to hide among. It reads **better** — 1.76 bits against
> Sepolia's 0.15. Mainnet is not quieter; it is 4.6× denser. Testnet is a
> different regime, not a smaller version of mainnet. The original prediction is
> left in the methodology page rather than quietly edited out, because the
> falsification is the useful part. See [Mainnet](#mainnet-where-we-were-wrong).

Measured 2026-09-11 against every event the deployed pool has ever emitted.
Reproduce with:

```
npm run corpus          # index the pool -> data/corpus.json
npm run measure:corpus  # measure it    -> data/measurement.json
```

## What was measured

The STRK20 privacy pool at
`0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91` on Starknet
Sepolia. 21,065 events across blocks 8,271,125 → 14,920,547, of which 8,323 are
note creations. The index is complete: it ran until the RPC stopped returning a
continuation token.

The adversary in this measurement sees **only public data from a public RPC**:
block numbers, transaction hashes, and the amounts the pool's own events
publish. No mempool, no IP addresses, no exchange records. A real adversary has
all of those.

## The number

| | set size | bits |
|---|---|---|
| Claimed (notes in pool) | 8,323 | 13.02 |
| Measured (origins, ±10 blocks) | 1.11 | **0.15** |

93.4% of notes have no other origin inside a ±10-block window. At ±1 block the
figure is 1.02 origins and 98.3% alone.

"Origins" means distinct funding transactions, not notes. The distinction
matters: one load-generating transaction on this pool minted 295 notes in a
single block. Counting notes, a bot is 295 anonymous people. Counting origins,
it is one. Every figure below reports both, and they are never mixed.

## Full table

Whole pool, mean over 400 real notes, bot traffic included:

| model | candidates | median | bits | alone |
|---|---|---|---|---|
| nominal | 8,323 | | 13.023 | |
| timing ±1 | 64.93 | 2 | 6.021 | 0.297 |
| timing ±10 | 65.05 | 2 | 6.023 | 0.282 |
| timing ±100 | 130.5 | 5 | 7.028 | 0.092 |
| timing ±1000 | 310.78 | 18 | 8.28 | 0.02 |
| origins ±1 | 1.02 | 1 | 0.029 | 0.983 |
| origins ±10 | 1.11 | 1 | 0.151 | 0.92 |
| origins ±100 | 3.00 | 2 | 1.587 | 0.268 |
| origins ±1000 | 10.67 | 9.5 | 3.415 | 0.04 |
| same transaction | 64.91 | 2 | 6.02 | 0.307 |

Human-scale only — transactions minting at most 6 notes, which excludes the load
generators:

| model | candidates | median | bits | alone |
|---|---|---|---|---|
| notes ±1 | 1.79 | 2 | 0.844 | 0.436 |
| origins ±1 | 1.03 | 1 | 0.042 | 0.974 |
| notes ±10 | 1.91 | 2 | 0.932 | 0.414 |
| origins ±10 | 1.11 | 1 | 0.15 | 0.934 |
| notes ±100 | 4.77 | 3 | 2.253 | 0.136 |
| origins ±100 | 2.95 | 2 | 1.562 | 0.33 |
| notes ±1000 | 15.64 | 10 | 3.968 | 0.029 |
| origins ±1000 | 10.55 | 7 | 3.4 | 0.059 |

## The denomination axis

Amounts were absent from the first version of this measurement, because the
indexer threw them away at the RPC boundary. They are now decoded out of the
event payloads, and this is the sharpest axis measured so far.

**It does not cover the whole pool, and that is the first thing to say.** Two
routes expose an amount, and both are public:

| route | what it uses | notes |
|---|---|---|
| explicit | an open note publishes `note_id`, and `OpenNoteDeposited` publishes the same `note_id` with an amount | 730 |
| transaction | the note's transaction carries exactly one distinct `Deposit` | 2,127 |
| unknown | a change note minted by spending an existing note has no deposit in its transaction | 5,466 |

So **34.3%** of the 8,323 notes have a publicly derivable amount. The rest do
not, and are left unknown rather than estimated. Where the axis applies, it
describes those notes and not the pool.

One candidate was checked and rejected. `EncNoteCreated` carries a `packed_value`
felt, and if the amount were in it the axis would cover 100% of notes rather than
34%. It is not: its magnitude sits 55 orders of magnitude above the amounts it
would have to encode, which makes it a commitment rather than a plaintext
amount. See `scripts/check-packed-value.mjs`.

| model | candidates | median | bits | alone |
|---|---|---|---|---|
| amount | 69.22 | 50 | 6.113 | 0.158 |
| timing+amount ±1 | **1.27** | 1 | **0.345** | 0.895 |
| timing+amount ±10 | 1.31 | 1 | 0.395 | 0.87 |
| timing+amount ±100 | 1.73 | 1 | 0.793 | 0.66 |
| timing+amount ±1000 | 3.17 | 2 | 1.667 | 0.438 |

The comparison that matters is against the timing axis on its own:

| | candidates | bits |
|---|---|---|
| timing ±1 | 64.93 | 6.021 |
| timing+amount ±1 | **1.27** | **0.345** |

Knowing the amount takes a ±1-block observation from 65 candidates to 1.27, and
89.5% of amount-visible notes have no other note of their denomination inside
that window at all. The pool hides *what* a note is worth from other users. It
cannot hide it from the ledger, because the deposit that funded the note is a
public event.

The amounts themselves explain why. They are round, and a round denomination is
a small bucket:

| amount | notes | token |
|---|---|---|
| 10 ETH | 188 | `0x4718f5a0…` |
| 1 ETH | 181 | `0x4718f5a0…` |
| 0.001 ETH | 148 | `0x4718f5a0…` |
| 4 ETH | 105 | `0x4718f5a0…` |
| 100 ETH | 100 | `0x4718f5a0…` |
| 5 ETH | 83 | `0x4718f5a0…` |
| 2 ETH | 58 | `0x4718f5a0…` |

523 distinct `(token, amount)` pairs across 2,857 notes, but the mass sits on a
handful of human denominations. One further detail: a `+1 wei` variant of the
same amount forms a *separate* bucket — `0.001 ETH` and
`0.001000000000000001 ETH` are different denominations as far as this model is
concerned. The pool's own fee marker splits one bucket into two, which makes both
of them smaller.

### A join that was wrong, and how

The first version of this axis had a bug worth recording, because nothing about
the numbers it produced looked wrong. It treated every money-in event as
evidence about every note in its transaction, so an open-note deposit was
broadcast onto the encrypted notes sharing that batch.

On this pool that is **470 transactions**, and it gave **508 notes an amount they
should not have**. It inflated coverage from 34.3% to 40.4%, and a wrong amount
is not an error message — it is a smaller anonymity set, which is
indistinguishable from a better finding.

The fix is that only `Deposit` is evidence about an encrypted note; open-note
amounts are matched to their own note by `note_id` and never broadcast to their
neighbours. `tests/denomination.test.mjs` fails if the two are merged again, and
that was checked by re-introducing the bug rather than assumed.

## Reading it

The pool is not broken. It does what it says: it hides *what* a note is worth
and *who* spends it. It does not hide *when* it was created, because the
creation is an on-chain event and the block number is public.

At 1.25 notes per thousand blocks, "when" is nearly a unique identifier. Knowing
the funding transaction to within ten blocks is enough to narrow the field to
one origin for 93.4% of notes. Everything the pool hides is then hidden inside
a set of size one.

This is the nominal-vs-effective gap, measured instead of asserted. Erebus and
Stellar Private Payments both state the distinction in their threat models;
neither publishes the second number. That is the gap Ruido exists to close.

## Mainnet: where we were wrong

Measured the same way, against the mainnet pool
`0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a`:
125,772 events, 32,924 note creations, blocks 8,978,970 → 14,735,845.

| | Sepolia | Mainnet |
|---|---|---|
| events indexed | 21,065 | 125,772 |
| notes created | 8,323 | 32,924 |
| origin clusters | 4,313 | 25,138 |
| notes per 1,000 blocks | 1.253 | **5.773** |
| median cluster size | 2 | 1 |
| claimed bits | 13.02 | 15.01 |
| **measured bits (origins ±10)** | **0.15** | **1.76** |
| fraction alone | 93.4% | 42.5% |

Mainnet is **11× more private than testnet**, and the whole difference is
density. A note hides among the notes created near it; mainnet creates 4.6×
more of them per block, so the candidate set is 3× larger even though the pool
itself is only 4× bigger.

Two secondary differences worth noting:

- **Median cluster size is 1 on mainnet against 2 on Sepolia.** Mainnet traffic
  is mostly single-note transactions. Sepolia's median of 2 is an artefact of
  the five-note wire shape and the load generators.
- **Load generation is proportionally smaller.** 2,605 of 32,924 mainnet notes
  (7.9%) sit in transactions minting more than six notes; on Sepolia it is 2,521
  of 8,323 (30.3%). Testnet is *more* artificial than mainnet, which is the
  opposite of the usual assumption.

### What we got wrong, precisely

We assumed mainnet would be quieter than testnet. It is the other way round:
mainnet carries real usage, testnet carries a handful of integrations and a
load generator. Any argument of the form "testnet is a conservative proxy for
mainnet" is wrong for this property, and we made exactly that argument.

The prediction is left standing in the methodology page, with this section as
its refutation. A measurement shop that edits its predictions after the fact is
not measuring.

## What this does not say

- **The Sepolia numbers are Sepolia.** Roughly a third of its notes are load
  generation. Mainnet has now been measured separately and reads better — see
  above. Do not carry the 0.15 figure over to mainnet.
- **The denomination axis is partial.** It covers the 34.3% of Sepolia notes
  whose amount is publicly derivable, and 55.3% on mainnet (18,215 of 32,924).
  On both networks the remaining notes are change notes whose amount no public
  event exposes. The axis is reported over the subset it can see, never
  extrapolated to the pool.
- **Upper bound.** A real adversary knows more than block numbers. Every figure
  here is the most privacy a note has, not the least.

## Incidental finding: the pool has been upgraded twice

Event keys resolved against the current class ABI left five events unexplained.
Fetching the class hash at those blocks found three distinct implementations
over the pool's lifetime:

| class | live at block |
|---|---|
| `0x715b22abfb60815623f4127ba64bd2f93613d8a5c1e519841eaab444659d2af` | 8,271,125 |
| `0x30b8c540cf04d8ef0f4db2a9098d9cc0e35e83af1cb3325f5a4f40144b4b30b` | 11,111,909 |
| `0x6d163f2b27df0f53c5b0d019366261ba8034af1bef949dee920a60fe58bcf83` | current |

The indexer now discovers class versions lazily from unexplained keys rather
than assuming the ABI at `latest` explains the whole history. Any tool that
reads this pool's history from a single ABI is silently dropping events.

**That lazy discovery under-reports, and the corpus shows it.** The current
Sepolia index lists two classes, not three, because this run produced no
unexplained key — so nothing triggered a probe of the middle implementation. The
three rows above were confirmed by asking the RPC for the class hash directly at
each block:

```
sepolia  block  8,271,125 -> 0x715b22abfb60815623f4127ba64bd2f93613d8a5c1e519841eaab444659d2af
sepolia  block 11,111,909 -> 0x30b8c540cf04d8ef0f4db2a9098d9cc0e35e83af1cb3325f5a4f40144b4b30b
sepolia  block 14,920,547 -> 0x6d163f2b27df0f53c5b0d019366261ba8034af1bef949dee920a60fe58bcf83
mainnet  block  8,978,970 -> 0x30b8c540cf04d8ef0f4db2a9098d9cc0e35e83af1cb3325f5a4f40144b4b30b
mainnet  block 14,735,845 -> 0x67dddd89d80fedadc06b6f160798f94800a4a70164e5a24301cd0d6076b554d
```

Two things follow. The same implementation (`0x30b8c540…`) was live on both
networks, so a class hash is not a network identifier. And `classHistory` in the
corpus is a *lower bound* on the number of implementations, not a count — it
records only the versions whose event layouts differ enough to leave a key
unexplained. A history that needs to be exact has to be probed block by block,
which is what the commands above do.

**That lower bound is now concrete: the pool has run seven implementations, not
three.** The emitter reconnaissance had to resolve the class hash at each corpus
transaction's own block, and doing so across the whole corpus found four more —
`0x1a78d2da…` (blocks 11,133,748–11,433,152), `0x67dddd89…`
(11,767,419–12,905,217), `0x56ab118a…` (12,964,568–14,330,611), `0x7e2bbd7c…`
(14,376,243–14,713,594) — plus the live `0x6d163f2b…` from block 14,865,231. The
two classes listed here are the ones whose *event layout* differed enough to
leave a key unexplained; the pool was upgraded more often than that. See
[`FINDING-emitter-interface.md`](FINDING-emitter-interface.md) §4.

## Distribution of notes per transaction

Bimodal, and the two modes are not the same kind of actor:

```
   1 note  -> 3,258 txs      5 notes ->   45 txs   (Erebus wire v3)
   2 notes ->   668 txs     11 notes ->    4 txs
   3 notes ->    58 txs     21-51   ->    4 txs
   4 notes ->     9 txs    101-295  ->   11 txs   (load generation)
```

The 45 transactions that minted exactly five notes are the wire v3 signature
from the Erebus protocol. They are the real users in this corpus, and they are
outnumbered eighty to one by single-note transactions.

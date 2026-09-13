# Finding: the documented M1 baseline no longer matches the code

Found 2026-09-11 while building Ruido. Reported because the project documents
its measurements honestly everywhere else, so this reads as drift rather than
spin — and because it changes the justification for planned work.

## What the threat model says

`docs/threat-model.md`, metric M1:

| # | Question | Baseline now | Target |
|---|---|---|---|
| M1 | Can an observer tell an Erebus transaction from other pool traffic? | **1.0000, measured 2026-08-21** (`scripts/linkage.py`, 2 fixtures against 10,000 synthetic negatives, zero false positives) | 0.5 |

And in §5, scoping Phase 8:

> **M1 and M2 are what the Phase 8 wire work is for.**

## What the code says today

```
$ python3 scripts/linkage.py --json
{
  "m1_traffic_classification": {
    "precision": 0.0,
    "recall": 0.0,
    "true_negative_rate": 1.0,
    "balanced_accuracy": 0.5,
    "true_positive": 0,
    "false_positive": 0,
    "true_negative": 10000,
    "false_negative": 4,
    "target": 0.5
  },
  ...
}
```

**0.5, not 1.0000.** The classifier fires on zero of the four positives.
M1 is already at its target.

## Why they differ

The fixture set changed. `linkage.py` now runs:

```python
DEFAULT_FIXTURES = (
    "observer-wire-v3.json",                 # codec-derived
    "observer-wire-v3-live-190c6b.json",     # live Sepolia settlement
    "observer-wire-v3-live-6bb25a.json",     # live Sepolia settlement
    "observer-wire-v3-live-60eace.json",     # live Sepolia settlement
)
```

The 2026-08-21 baseline was measured against two wire-v2-era fixtures. Three of
the four current positives are live wire-v3 settlements, and wire v3 does not
exhibit the v2 fingerprint: v2 zero-filled 59 bits in the envelope, while v3
uses that space for a deal-id header and masks what remains.

So the leak was real, and wire v3 removed it. The threat model was never updated.

## Why it matters

Phase 8's stated purpose is M1 and M2. If M1 already sits at 0.5 for v3 writes,
the M1 half of that scope may be work already done. Worth re-running
`linkage.py` against whatever fixture set Phase 8 would target before spending
the phase on it.

## The fair caveat

Two reasons not to read this as "the problem is gone":

1. **n = 4.** Recall resolution is 1/4. A single fixture flipping changes the
   number by 0.125. The script says this itself: *"Four positives is a small
   sample."*
2. **Historical records are still on chain.** `docs/friction.md` notes that
   historical wire-v2 records retain the fifth-salt shape. Those transactions
   are permanently fingerprintable. Nothing about v3 retroactively hides them.

So: new writes look clean, old writes do not, and the doc's number describes the
old ones while its Phase 8 scope reads as if it describes the new ones.

## Reproducing

```bash
cd Erebus-main
python3 scripts/linkage.py --json
```

Ruido reproduces both directions from scratch in `tests/ruido.test.mjs`:
legacy-shaped salts score 1.0, randomised ones score 0.5, against the same
predicate ported line-for-line from `scripts/observer.py:223`.

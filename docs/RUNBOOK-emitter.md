# Runbook: from a verified interface to an observed expansion

Everything the emitter needs is verified except one thing: the expansion of
`UseNote` and `CreateEncNote`. Those two have only ever been *read from the
source*, because provoking them needs real subchannel and note state, and a
throwaway identity has none.

This is what it takes to close that, and what to build once it is closed.

---

## The blocker, stated plainly

**To spend a note you must have a note. To get a note you deposit. A deposit
acquires a screening subject.**

That is the whole problem, and it is circular in an unpleasant way. From
`privacy.cairo`, `_apply_actions` writes a screening subject for a `TransferFrom`
— the depositor. If that depositor's policy is `Required`, the attestation can
only be signed by the key in `get_screener_public_key`, whose setter is
`only_security_governor()`. Self-hosting the prover gives you ZK proofs and
**not** that signature.

So the one leg that needs an external party is the one that happens *first*. Every
emission after it is local.

## The resolution: a dedicated decoy account

The tension only exists if the account you deposit from is an account you care
about. So do not use one.

**A decoy account holds nothing but decoys.** Its pool viewing key is the only
key you would ever hand to a hosted prover, and that key controls notes whose
entire content is cover traffic the market is about to publish anyway. Handing it
over once costs nothing worth protecting.

This is an architecture requirement, not a workaround: **the emitter's account
must be separate from any client's account, permanently.** An emitter that shares
an account with a customer's real positions reintroduces the exposure on every
deposit, and no amount of care at the emission step undoes it.

If the account comes back `Exempt`, the external party disappears entirely and the
whole loop is local from the first block.

---

## What you need

| # | | why |
|---|---|---|
| 1 | **A Linux x86_64 host** with Docker Compose v2 and **~80 GiB free** | the stack is digest-pinned for `linux/amd64` and enforces the disk floor. On Windows that means a VPS or WSL2 + Docker Desktop; a VPS is the honest choice, because the node has to stay up and synced. |
| 2 | **An Ethereum Sepolia WebSocket endpoint** | mandatory, and the single easiest way to break everything: point it at mainnet and the node starts, syncs, answers `starknet_chainId` correctly, then fails L1 verification forever with no diagnostic. |
| 3 | **A dedicated Starknet Sepolia account** | see above. Fund it with nothing but decoy money. |
| 4 | **STRK on that account** | the pool fee is 2 STRK per `apply_actions` **call**. The Starknet Foundation runs a faucet at `faucet.starknet.io`; a minimal cycle is a handful of STRK plus gas. |
| 5 | **One deposit into the pool** from that account | the only step that may need a third party. |
| 6 | **Its pool viewing key**, on that host only | it travels in the calldata to the preflight RPC and in plaintext to the prover — both local. |

---

## The steps

**Step 0 — probe before spending anything.** This decides whether you need an
external party at all, and it costs nothing.

```bash
node erebus-ops-sepolia/scripts/probe-pool.mjs --depositor 0xYOUR_DECOY_ACCOUNT
```

- `get_screener_public_key == 0` → screening is not configured. Fully local.
- policy `Exempt (1)` → you shield without an attestation. Fully local.
- policy `Delegated (2)` → your screening provider decides. Local only if it says so.
- policy `Required (0)` → the hosted prover, once, for the deposit.

**Step 1 — bring the node up.**

```bash
cd erebus-ops-sepolia
cp sepolia.env.example sepolia.env
$EDITOR sepolia.env            # ETHEREUM_WS_URL — Sepolia, not mainnet
./bootstrap.sh                 # flag preflight, disk check, snapshot, start
```

**Step 2 — assert the chain before trusting anything else.**

```bash
./verify.sh                    # must report 0x534e5f5345504f4c4941
```

Spec version, sync status and block height all look healthy on the wrong network.
The chain id is the only check that means anything.

**Step 3 — wait for sync.** Hours, not minutes. `docker compose --env-file
sepolia.env logs -f juno`.

**Step 4 — start the prover.** `docker compose --env-file sepolia.env --profile
prover up -d`. If you are remote, tunnel both ports:
`ssh -L 6060:127.0.0.1:6060 -L 3000:127.0.0.1:3000 user@host`.

**Step 5 — fund the decoy account**, then re-run Step 0 against it.

**Step 6 — deposit.** This is the screening gate. It is also the last time an
external party is involved.

**Step 7 — the observation.** Submit the smallest possible set and dump what the
contract expands it into:

```
[UseNote, CreateEncNote]   →   compile_actions   →   ServerAction[]
```

That output is the missing piece. Once it is captured, the emitter's action
assembler stops being written from a reading of the source.

---

## What we build once the node is up

1. **`src/emitter.mjs`** — assemble the `ActionSet` (`UseNote` phase 4, then
   `CreateEncNote` × (N+1) phase 5), encode it with the encoder this repository
   already has, and walk the seven-step pipeline: compile → same-block preflight
   → signed proof invocation → `starknet_proveTransaction` → compare the proved
   server actions against the preflight → signed `apply_actions` → receipt.
2. **The observation script** — submit the minimal set above and dump the
   expansion. This is the deliverable that closes the finding.
3. **The event read-back** — after a submission, read `EmitEncNoteCreated` and
   `EmitNoteUsed` to record the decoys' note commitments. Settlement checks those
   later, so nothing emitted without them counts.

## What it costs

| | |
|---|---|
| pool fee | **2 STRK per call.** One call per decoy, deliberately — batching is cheaper and puts every decoy in one origin, which is the one thing the measurement says destroys the value. See `costEstimate` in `src/cover.mjs`. |
| a minimal cycle | deposit + one spend = **2 calls ≈ 4 STRK** plus L1/L2 gas |
| host | a VPS with 80 GiB. This is the real cost, and it is recurring. |

## One detail that will bite at step 7

`apply_actions` ends with:

```cairo
if let Some(screening_subject) = self._apply_actions(:actions) {
    self._verify_screening(screening.expect(errors::SCREENING_REQUIRED), :screening_subject);
} else {
    assert(screening.is_none(), errors::UNEXPECTED_SCREENING);
}
```

The `else` branch is the one to notice. A decoy set acquires no subject, so it
must pass `screening: None` — **passing an attestation "just in case" reverts with
`UNEXPECTED_SCREENING`.** The encoder already encodes `None` as the single felt
`0x1`, and the decoder already reads it back the same way, so this is a
one-line detail rather than a trap. It is written down because it is the kind of
thing that reads as a rejection of your whole transaction.

## What we do not need

- **The Rust SDK.** It is the reference for the pipeline, and the calldata work
  is already done here in JavaScript — the encoder round-trips against 83 real
  transactions. Reading the SDK is how the pipeline was confirmed; compiling it is
  not required.
- **A hosted prover, for the emitting leg.** That is the point of the decoy set.
- **Mainnet.** Sepolia is not just cheaper here, it is *newer*: the Sepolia class
  has `get_open_note_screening_policy`, which the mainnet class does not.

## Assumed, and worth checking before planning around it

- That a public Sepolia snapshot still exists at the default URL. `bootstrap.sh`
  falls back to a genesis sync rather than failing, so this costs time and not
  correctness.
- That the pinned Juno image still accepts `--network`. The preflight asserts it,
  so a change surfaces immediately rather than after a six-hour sync.
- That StarkWare's hosted Sepolia prover is still up. The upstream note is dated
  2026-07-31. Re-run Step 0 before planning around it.
- That the faucet is still funded. It was reachable on 2026-09-12.

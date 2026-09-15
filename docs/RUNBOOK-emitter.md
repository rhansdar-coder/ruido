# Runbook: from a verified interface to an observed expansion

**Updated 2026-09-14.** The blocker is now narrower than this file originally
stated, and the narrowing came from a probe rather than from reading.

`npm run check:decoy` builds the decoy set with the real deployed ABI and asks
the live pool to compile it. The pool answers **`SUBCHANNEL_NOT_FOUND`** — it
read the whole set and went looking for state. A set with a short payload answers
`Failed to deserialize param #3` instead, so the two are distinguishable and the
first one means the **wire format is correct**.

The same probe found the limit of that result: `[CreateEncNote, UseNote]` is out
of order and the pool answers `SUBCHANNEL_NOT_FOUND` too, not
`ACTIONS_OUT_OF_ORDER`. **The subchannel lookup runs before the order check**, so
a decoy set without a subchannel never reaches it. That splits what remains into
two, and they are the same dependency:

| still unobserved | why |
|---|---|
| the **expansion** of `UseNote` and `CreateEncNote` | needs a real subchannel and a real note |
| the **order rules for this set** | the subchannel lookup runs first, so the check is never reached |

What IS verified for this set: the encoding, the field order, the variant index,
and the parameter names of `compile_actions`. `src/emitter.mjs` implements the
order rules from the source and says so in its header rather than implying the
contract confirmed them.

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
| 1 | **A Linux host — x86_64 or arm64** — with Docker Compose v2 and **~80 GiB free** | both pinned images are multi-arch, so the architecture is not the constraint here; see "What it costs". The disk floor is enforced. On Windows that means a VPS or WSL2 + Docker Desktop; a VPS is the honest choice, because the node has to stay up and synced. |
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

**Half of item 1 is already built, and it is the half that does not need the
node.** `src/emitter.mjs` assembles the `ActionSet` (`UseNote` phase 4, then
`CreateEncNote` × (N+1) phase 5), checks the three rules, and encodes it with the
encoder this repository already has. `npm run emit` prints the whole thing as a
dry run, and `npm run check:decoy` holds the encoding against the deployed pool.
What is left of item 1 is the network half, which is exactly the part that needs
the host.

1. **The seven-step pipeline** — compile → same-block preflight → signed proof
   invocation → `starknet_proveTransaction` → compare the proved server actions
   against the preflight → signed `apply_actions` → receipt. `scripts/emit.mjs`
   refuses `--submit` today and names the two loopback endpoints it would need,
   because steps 2 and 4 carry the pool viewing key and must not leave the
   operator's trust boundary.
2. **The observation script** — submit the minimal set above and dump the
   expansion. This is the deliverable that closes the finding.
3. **The event read-back** — after a submission, read `EmitEncNoteCreated` and
   `EmitNoteUsed` to record the decoys' note commitments. Settlement checks those
   later, so nothing emitted without them counts.
4. **The order-rule confirmation** — once a subchannel exists, re-run
   `npm run check:decoy` with an out-of-order set and watch for
   `ACTIONS_OUT_OF_ORDER` instead of `SUBCHANNEL_NOT_FOUND`. That single flipped
   answer is what moves the order rules from "read from the source" to "measured",
   and the script already runs the case.

## What it costs

Nothing here is metered per request. Two things are worth separating: what the
node needs, and how long you need it to exist.

| | |
|---|---|
| pool fee | **2 STRK per call.** One call per decoy, deliberately — batching is cheaper and puts every decoy in one origin, which is the one thing the measurement says destroys the value. See `costEstimate` in `src/cover.mjs`. |
| a minimal cycle | deposit + one spend = **2 calls ≈ 4 STRK** plus L1/L2 gas |

### Free

| | |
|---|---|
| the software | Juno and the transaction prover are open source and digest-pinned. No licence and no account. |
| the snapshot | the default URL is public and needs no key. **25,750,390,385 bytes (24.0 GiB)**, last written 2026-09-12, read 2026-09-13. A 404 costs hours of genesis sync, not correctness. |
| the L1 endpoint | an Ethereum Sepolia WebSocket. The node only reads L1, so a provider's free tier is the size of this problem. |
| the STRK | `faucet.starknet.io`. |
| the prover, for emitting | not needed — that is the point of the decoy set. The local prover profile is for the deposit leg only. |

### The host, which is the only real cost

| option | | |
|---|---|---|
| the machine you already have | **$0.** Item 1 above allows WSL2 + Docker Desktop. Cheapest correct answer, weakest one: the node has to stay up and synced, and a machine that sleeps loses that. |
| Oracle Cloud Always Free | **$0** — 2 OCPU / 12 GB Arm and 200 GB of block storage, for the life of the account. Two caveats. Oracle may reclaim an instance whose CPU, network **and** memory all stay under 20% across seven days; whether a synced node's memory footprint clears that bar is untested. And Arm capacity in the free tier is a lottery. A node that vanishes without saying so is the failure this project cannot have. |
| a VPS | **≈$6.40–6.60/month** for 4 vCPU / 8 GB / 100 GB SSD (Contabo Cloud VPS 4; third-party indexes read 2026-09-13, cheaper on a long term). The honest answer, because it is the only option where the node is still there next month. |

Hetzner is no longer the cheap answer. Both 2026 adjustments (April 1 and June 15)
followed a DRAM and NAND shortage, and every shared-vCPU plan — the whole CX and
CAX lines — is currently listed as unavailable. The cheapest plan that can
actually be ordered is €11.99/month for 1 vCPU and 2 GB, against Contabo's
4 vCPU / 8 GB / 100 GB at roughly half that.

### Which architectures are actually possible

Both pinned images are OCI indexes, not single manifests. Read from the
registries on 2026-09-13:

```
nethermind/juno@sha256:64bf3017…                      linux/amd64, linux/arm64
starknet-privacy/transaction-prover@sha256:a2f71d71…  linux/amd64, linux/arm64
```

So `platform: linux/amd64` in `compose.yaml`, and the `--platform linux/amd64` in
`bootstrap.sh`'s flag preflight, are restrictions this stack imposes on itself
rather than ones the images require. Removing them is what would make the Arm
free tier a native option instead of an emulated one. Whether it then runs is
untested, and the flag preflight is the first thing that would say.

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

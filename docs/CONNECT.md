# How Ruido connects

Everything in this repository that reads a chain works from a public RPC with no
key. Everything that *writes* to a pool has to happen on one machine, and this
document says why, what talks to what, and what that machine needs.

**This is the operator's connection to the chain, not the customer's connection
to a provider.** The two are easy to confuse by name and have nothing in common:
this one needs a node, a prover and a funded key; the customer's needs none of
those and is specified in [`ORDER.md`](ORDER.md), with `npm run buy` as its
client. If you arrived here looking for "how does a customer buy cover", you
want that document instead.

It is short on purpose. The wiring is small; the reason for it is the part worth
reading.

---

## The short version

**One machine is the trust boundary.** Three processes run on it, all bound to
loopback. One outbound connection leaves it, and that connection carries no key
material.

```
                    ┌──────────── one host ────────────┐
                    │                                  │
   reads ──────────►│  public RPC        (no key)      │
                    │                                  │
                    │  ┌──────────┐                    │
   writes ─────────►│  │ emitter  │  account key       │
                    │  │          │  pool viewing key  │
                    │  └────┬─────┘                    │
                    │       │                          │
                    │       ├──► juno    127.0.0.1:6060│──► Ethereum Sepolia WS
                    │       │    (preflight + submit)  │    (L1 verification, no key)
                    │       │                          │
                    │       └──► prover  127.0.0.1:3000│
                    │            (sees the pool key)   │
                    └──────────────────────────────────┘
```

The pool viewing key exists in exactly two places: the emitter, and the local
prover. Both are on that host.

---

## Why a public RPC cannot be used for the write path

This is not a preference, and it is not a hardening measure. The key is *in the
calldata*.

From the upstream SDK, `sdk/rs/src/prover.rs`:

> The invocation handed to `starknet_proveTransaction` carries the pool private
> key in plaintext at `calldata[5]`. A prover operator can decrypt everything
> protected by that key. […] The `compile_actions` preflight exposes the same key
> to its Starknet RPC endpoint, so **both endpoints must be inside the operator
> trust boundary.**

And `sdk/rs/src/execution.rs`:

> `compile_actions` calldata exposes the same key to the preflight RPC. Both the
> prover and this RPC must be operator-controlled. **Public RPC endpoints are only
> suitable for reads.**

So the rule falls out of the wire format rather than out of caution:

| endpoint | receives the pool viewing key? | can be public? |
|---|---|---|
| Starknet RPC used for reads | no | **yes** |
| Starknet RPC used for `compile_actions` | **yes, in calldata** | no |
| Proving service | **yes, in plaintext at `calldata[5]`** | no |

A third-party RPC operator who sees that calldata can decrypt every note that key
protects. That is the whole of the privacy claim, handed over.

**Which is why the throwaway-key trick in `npm run verify:compile` is safe and a
real key is not.** A generated scalar that is never funded and never registered
controls nothing, so disclosing it discloses nothing. The verification scripts use
one on purpose. The emitter cannot: its key is the one that owns the notes.

---

## The write pipeline

Seven steps, taken from the SDK's own `execution.rs` header and reproduced here
because they are the contract the emitter has to satisfy:

```
ActionSet
  -> compile_actions calldata
  -> same-block view preflight
  -> signed pool __execute__ proof invocation
  -> starknet_proveTransaction
  -> compare proved server actions with the preflight
  -> signed account call to apply_actions
  -> receipt
```

Step by step, with what each one needs:

1. **`ActionSet`** — the `ClientAction` list. For a decoy emission: `UseNote`
   (phase 4) then `CreateEncNote` × (N+1) (phase 5). Built by the emitter.
2. **`compile_actions` calldata** — this is where the encoder this repository now
   has gets used. **Exposes the pool key → local RPC.**
3. **Same-block view preflight** — the compile is a simulation that applies the
   `WriteOnce` writes, so it must run against the state the set will actually be
   applied to, at the same block.
4. **Signed pool `__execute__` proof invocation** — a *virtual* execution inside
   the prover. Its signature is what `assert_valid_signature` checks
   (`privacy.cairo:207`). **Carries the pool key in plaintext → local prover.**
5. **`starknet_proveTransaction`** — the prover returns `proof_facts` plus a
   signature.
6. **Compare proved server actions with the preflight.** The executor does not
   trust the prover to choose the state transition: it compares the proof's L2→L1
   payload byte-for-byte against the independent `compile_actions` result before
   submitting. This is the step that makes a malicious prover useless rather than
   merely unlikely.
7. **Signed account call to `apply_actions`** — a v3 invoke carrying
   `proof_facts`. **This is a privacy-specific extension to the v3 hash preimage**:
   a non-empty `proof_facts` adds one `poseidon_hash_many` term, and a generic v3
   hash omits it and produces an invalid signature for a proof-carrying
   transaction.

Then the emitter reads its own events back — `EmitEncNoteCreated`, `EmitNoteUsed`
— to record the decoys' note commitments. Those commitments are what settlement
checks later.

---

## Screening does not change the write path, and that is the whole point

`erebus-ops-sepolia/README.md` recommends StarkWare's hosted prover for a
depositor whose policy is `Required`, because the attestation can only be signed
by the key in `get_screener_public_key` and self-hosting does not mint one. That
recommendation is **correct for the funding leg and wrong for the emitting leg**,
for a reason the two documents only make visible when read together:

**The hosted prover is a prover. It receives the pool viewing key in plaintext at
`calldata[5]`.** Using it for an emission hands a third party the key to every
note it protects.

The way out is the measurement in
[`FINDING-emitter-interface.md`](FINDING-emitter-interface.md) §2b: screening only
applies where the contract says so, and the contract says so narrowly. A set that
carries **no deposit and no invoke** acquires no screening subject at all —
`_verify_screening` is never reached — so it needs no attestation, and therefore
no hosted prover.

| leg | action set | screening subject? | attestation? | can be fully local? |
|---|---|---|---|---|
| **funding** | `TransferFrom` (a deposit) | yes | **yes, if the depositor is `Required`** | no |
| **emitting** | `UseNote` + `CreateEncNote` × (N+1) | **no** | **no** | **yes** |

Measured, not inferred: on the live class `0x6d163f2b`, all **44** deposit sets
carried an attestation and all **15** sets with neither a deposit nor an invoke
carried `None`.

So the emitter runs entirely inside the trust boundary, and the one leg that needs
an external party is the one that happens once, before the product does anything.

---

## What it takes to run it

| | |
|---|---|
| host | Linux, x86_64, Docker Compose v2 |
| disk | ~80 GiB free (`JUNO_MIN_FREE_GIB` overrides) |
| outbound | **an Ethereum Sepolia WebSocket.** Not mainnet. Pointing this at mainnet does not error — the node starts, syncs, answers `starknet_chainId` correctly, and then quietly fails L1 verification forever. |
| account | a funded Starknet Sepolia account. Pool fee is **2 STRK** per action. |
| secret | the pool viewing key, on that host only |

```bash
# in erebus-ops-sepolia/
cp sepolia.env.example sepolia.env
$EDITOR sepolia.env              # ETHEREUM_WS_URL is mandatory
./bootstrap.sh                   # flag preflight, disk check, snapshot, start
./verify.sh                      # asserts chain id 0x534e5f5345504f4c4941
docker compose --env-file sepolia.env --profile prover up -d
ssh -L 6060:127.0.0.1:6060 -L 3000:127.0.0.1:3000 user@host   # if remote
```

Both ports bind to `127.0.0.1` only. There is no LAN or public exposure in
`compose.yaml`; a remote host is reached through the tunnel.

---

## What is built and what is not

| piece | state |
|---|---|
| read path (index, measure, meter) | **live**, public RPC, no key |
| calldata decoder | **live**, exact consumption against real transactions |
| calldata encoder | **live**, round-trip identical over 83 real transactions across all seven implementations |
| action-set order rules | **live**, provoked on the deployed contract |
| screening scope (which sets need an attestation) | **measured** on the live class |
| node + prover stack | **written**, `erebus-ops-sepolia/`, needs the host above |
| emitter: assembling `UseNote` + `CreateEncNote` | **built and verified.** `src/emitter.mjs` assembles, checks and encodes the set, `npm run emit` prints it, and `npm run check:decoy` confirms the deployed pool reads the wire format |
| emitter: the seven-step pipeline (steps 3-7) | **not built.** Needs the node, the prover and a funded account — i.e. the host below |
| settlement | **specified**, not built — see [`TOKEN.md`](TOKEN.md) |

The gap has narrowed to two things, and they are the same dependency.

**The wire format is verified, and that is new.** `[UseNote, CreateEncNote]` is
accepted by the deployed `compile_actions` and reaches the contract's body, where
it reverts with `SUBCHANNEL_NOT_FOUND` — the contract read the whole set and went
looking for state. A set with a short payload answers `Failed to deserialize
param #3` instead, and that difference is what makes the first result mean
something rather than being the response to everything. `npm run check:decoy`
runs both and asserts they stay distinct.

**What is still not observed, and now precisely which part.** Two things, and the
probe above is what separates them:

- **The expansion of `UseNote` and `CreateEncNote`.** Needs a real subchannel and
  a real note. Unchanged.
- **The order rules as applied to this set.** `[CreateEncNote, UseNote]` is out of
  order — phase 5 then 4 — and the contract answers `SUBCHANNEL_NOT_FOUND`, not
  `ACTIONS_OUT_OF_ORDER`. So the subchannel lookup runs BEFORE the order check,
  and a decoy set without a subchannel never reaches it. The rules ARE verified
  for `[Deposit]` and `[Deposit, SetViewingKey]`, which need no subchannel — and
  that contrast is asserted by the same script, so it stays a measurement rather
  than a memory. `checkSet` in `src/emitter.mjs` implements the rules from the
  source for this set in the meantime, and says so in its own header.

The ordered steps to close both, and what gets built once the node is up, are in
[`RUNBOOK-emitter.md`](RUNBOOK-emitter.md). The short version of the blocker is
still circular and still worth stating: **to spend a note you need a note, and
getting one is the only leg that may need a third party.**

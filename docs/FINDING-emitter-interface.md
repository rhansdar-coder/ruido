# Finding: the interface the emitter has to speak

Reconnaissance for roadmap item 5, the on-chain decoy emitter. Nothing here
sends a transaction and nothing here touches a key. The point is to read the
deployed interface before writing anything that acts on it.

Produced by `npm run recon:emitter`, `npm run verify:actions`,
`npm run verify:compile`, `npm run check:screening` and `npm run check:abi`.

---

## 1. `apply_actions` is the entrypoint, and the client does not hand-encode it

The pool's ABI exposes **interfaces**, not top-level functions. Scanning the ABI
for `type === "function"` finds **zero** entrypoints, which reads as "the pool has
no callable functions". The real ones live in `items` of
`privacy::interface::IClient`, `IServer`, `IViews`, `IAdmin` and the StarkWare
utility interfaces. Flattened, the pool has **45** reachable functions.

The one that matters:

```
apply_actions(
  actions:   core::array::Span::<privacy::actions::ServerAction>,
  screening: core::option::Option::<privacy::snip12::ScreeningAttestation>,
)   [external]
```

And next to it, the piece that decides the whole design:

```
compile_actions(
  user_addr:        ContractAddress,
  user_private_key: felt252,
  client_actions:   Span<ClientAction>,
) -> Span<ServerAction>   [view]
```

So the split is: the client builds **`ClientAction`s** — the intent, e.g. "create
five encrypted notes" — and the pool compiles them into **`ServerAction`s**, the
literal event-emitting steps. The 12 `ServerAction` variants are
`WriteOnce`, `Append`, `TransferFrom`, `TransferTo`, `EmitViewingKeySet`,
`EmitWithdrawal`, `EmitDeposit`, `EmitOpenNoteCreated`, `EmitEncNoteCreated`,
`EmitNoteUsed`, `Invoke`, `InvokeWithComputation`. Ten `ClientAction` variants sit
on the other side.

**This is good news for the emitter and it changes what "writing the emitter"
means.** A decoy does not need the pool's encryption scheme reimplemented. It
needs a well-formed `ClientAction` list and a way to get it compiled.

## 2. `user_private_key` is the pool's viewing key, not the account key

**Resolved.** This was the question that gated the whole emitter, so it was read
out of the SDK rather than inferred from the signature. The answer is in
`erebus-harness/src/crypto/channel-secret.ts`, which documents the pool's own
key convention:

> `deriveViewingPublicKey(privateKey)` — the x-coordinate of `privateKey · G`.
> This is the value the pool stores in `public_key[user_addr]`.
> Matches the pool's `derive_public_key`.

and, on the canonicality rule:

> The pool requires non-zero and *canonical* — strictly below half the group
> order (`is_canonical_key`, utils.cairo).

So `user_private_key: felt252` is the **viewing private key of the pool
identity** — one Stark scalar, distinct from the Starknet account key that signs
transactions. The same module states the boundary it lives under:

> SDK BOUNDARY. Private keys enter here and never leave (CLAUDE.md constraint 6).

**Verified against the live contract, not just read.** A transaction from block
8,276,431 carries an `EmitViewingKeySet` action. The values this repository's
decoder extracts from it match today's contract state:

| value | source | result |
|---|---|---|
| `public_key` | decoded from the transaction | `0x7913e4db…6a82d` |
| `get_public_key(user_addr)` | live `starknet_call` | `0x7913e4db…6a82d` |
| `enc_private_key.auditor_public_key` | decoded from the transaction | `0x1d17f98b…dfbb2` |
| `get_auditor_public_key()` | live `starknet_call` | `0x1d17f98b…dfbb2` |

Two independent agreements, across a class upgrade, from a decoder written today.
That is the strongest evidence in this document that the layout is right.

### It is still a secret, and it still should not go to an RPC

Being the viewing key rather than the account key changes the blast radius; it
does not make the exposure acceptable. The same module notes that the pool's
`channel_key` is "a hash of the sender's *private* key", and the viewing key is
what decrypts notes addressed to you. Handing it to a public RPC provider hands
them your viewing capability.

**The exposure is avoidable, and the answer is already in this workspace.**
`compile_actions` is a view, so it does not need a third party — it needs *a*
node. `erebus-ops-sepolia/` runs a Juno node bound to `127.0.0.1` for exactly
this class of reason. Calling the view against your own node means the key goes
from your process to your process.

**Design consequence: the emitter requires a local node.** Not as a nicety — as
a hard requirement of not leaking the viewing key. An emitter that calls
`compile_actions` over a public endpoint is a key-disclosure tool.

**The upstream SDK states the same rule from its own side, and names the second
endpoint.** `sdk/rs/src/prover.rs`:

> The invocation handed to `starknet_proveTransaction` carries the pool private
> key in plaintext at `calldata[5]`. A prover operator can decrypt everything
> protected by that key. […] The `compile_actions` preflight exposes the same key
> to its Starknet RPC endpoint, so **both endpoints must be inside the operator
> trust boundary.**

So it is not one endpoint that has to be local, it is two: the preflight RPC *and*
the prover. [`CONNECT.md`](CONNECT.md) is the operational side of that — what runs
on the host, in what order, and what each leg of the emitter actually needs.

## 2b. Screening is enforced, and it is the harder blocker

Read live off the deployed pool (`erebus-ops-sepolia/scripts/probe-pool.mjs`):

```
get_version                  0x322e31  (v2.1)
get_fee_amount               2 STRK
get_proof_validity_blocks    450
is_paused                    false
get_screener_public_key      0x62f1e7ca…1b552   (non-zero)
get_open_note_screening_policy(fresh depositor)  0  (Required)
```

From `privacy.cairo`, quoted in `erebus-ops-sepolia/README.md`:

```cairo
if let Some(screening_subject) = self._apply_actions(:actions) {
    self._verify_screening(screening.expect(errors::SCREENING_REQUIRED), :screening_subject);
}
```

`SCREENING_REQUIRED` is a **revert**. The attestation must be signed by the key
in `get_screener_public_key`, and that setter is gated by
`only_security_governor()`.

The part that matters most, and the reason "just self-host the prover" does not
work:

> Self-hosting `transaction-prover` gives you ZK proofs. It does **not** give you
> that signature. Anyone who tells you otherwise has not read the contract.

So a decoy set that includes a deposit cannot be submitted by us, on Sepolia,
today, without an attestation we cannot mint. The workable path documented in
that README is StarkWare's hosted prover, which runs a `proof-interceptor` with
`SCREENING_URL` configured and mints and relays the attestation — no approval
needed. That is an **external dependency on someone else's service**, and it is
a dependency of the product, not of the tooling.

### Where screening actually applies — measured, not read

The question that decides how much of the emitter is reachable: does the
*internal* path — spending an existing note and reshaping it into decoys plus
change, with no deposit in the action set — trigger screening at all?

**The contract's answer is in `_apply_actions`, and it is narrow.** The screening
subject is written in exactly two places:

```cairo
ServerAction::TransferFrom(input) => {
    unify_address(ref screening_subject, reference: input.from_addr);
    self._apply_transfer_from(:input);
},
ServerAction::Invoke(input)              => self._apply_invoke_and_deposits(... :screening_subject),
ServerAction::InvokeWithComputation(inp) => self._apply_invoke_and_deposits(... :screening_subject),
```

so a set requires an attestation only if it contains a `TransferFrom` (a deposit),
or an `Invoke`/`InvokeWithComputation` that returns deposits to open notes under a
target whose `open_note_depositor_screening_policies` is not `Exempt`. **A set
with neither cannot be screened at all** — `_verify_screening` is not reached when
`_apply_actions` returns `None`.

That makes a prediction we can hold real transactions against, and
`scripts/check-screening-scope.mjs` does exactly that: it decodes real
`apply_actions` calls and cross-tabulates what the contract *can* require against
what the calldata actually carried.

**The live implementation, measured.** Class `0x6d163f2b` — the one deployed
right now — blocks 14,865,231–14,920,547, 59 decoded transactions:

```
  clase 0x6d163f2b27df0f53c5b0d019366261ba8034af1bef949dee920a60fe58bcf83
    bloques 14865231-14920547   (59 muestras)
                          screening None   screening Some
    con deposito           0               44
    con invoke             0                0
    ninguno               15                0
```

**All 44 deposit sets carry an attestation. All 15 sets with neither a deposit nor
an invoke carry `None` — not one carries an attestation.**

```
14865231  0x6d163f2b… ninguno  screening=None  WriteOnce,WriteOnce,EmitViewingKeySet
14866863  0x6d163f2b… ninguno  screening=None  WriteOnce,WriteOnce,EmitViewingKeySet
14870253  0x6d163f2b… ninguno  screening=None  WriteOnce,WriteOnce,EmitViewingKeySet
```

**The internal path does not need the screener.** An emitter that spends an
existing note and reshapes it into decoys plus change — no deposit, no invoke —
can be built and exercised end to end today. Only the funding leg needs an
attestation, and only invokes remain a further question.

**Across the class history the same split holds, with one exception.** The
stratified 200-sample, grouped by class:

```
  clase                                    bloques              deposito   invoke   ninguno
                                                               N  /  S   N / S    N  /  S
  0x715b22ab  8,363,022-10,795,698    0/34    0/5    0/13   <- the exception
  0x30b8c540  10,889,964              0/ 1    0/0    0/ 0
  0x1a78d2da  11,133,748-11,433,152   0/ 1    5/0    1/ 0
  0x67dddd89  11,767,419-12,905,217   0/ 7   10/0    2/ 0
  0x56ab118a  12,964,568-14,330,611   0/ 7   10/0    8/ 0
  0x7e2bbd7c  14,376,243-14,713,594   0/ 5    1/1    3/ 0
  0x6d163f2b  14,865,231-live         0/44    0/0   15/ 0
```

The deposit row is `Some` in **every** class — 55 of 55 in the stratified sample
and 44 of 44 in the live-class window, with no exceptions. The `ninguno` row is
`None` everywhere except the oldest class, where 13 of 13 carry an attestation.
Either that implementation screened everything, or its client attached one
unconditionally. Both are plausible and distinguishing them needs that class's
source, which we do not have. It does not bind us — it is not the deployed code —
so it is recorded and left open rather than guessed at.

### The first conclusion was the exact opposite, and a decoder bug caused it

An earlier version of this document concluded *"the emitter cannot avoid the
screener"*, from a run reporting 18 deposit-free sets all carrying `Some`.
**That was wrong**, and wrong in the worst available way: the number came from
reading Cairo's `Option` backwards.

Cairo declares `enum Option<T> { Some: T, None }`, so `Some` owns **variant 0** and
carries the payload; `None` is variant 1. `src/actions.mjs` had it inverted, and
the failure was asymmetric, which is what made it invisible:

- a real `Some` read as `None` still returned a value — it consumed one felt and
  left the attestation's three felts unread;
- a real `None` read as `Some` tried to decode a payload that was not there.

`decodeCall`'s exact-consumption assertion caught the shape of it — `consumed 100
of 101` on a real transaction — and that is the only reason it was found.

Two more bugs fell out of the same hole, both found the same way:

- **The tuple branch was dead.** `splitGeneric` returns the whole string as `head`
  when there is no `<`, so `head === "("` was false for
  `(core::felt252, core::felt252)` — which is exactly
  `ScreeningAttestation.signature`. The tuple fell through to the decoder's
  one-felt fallback and left a felt unread.
- **`u256` decoded as one felt.** It sat in `PRIMITIVES`, which is tested before
  `WIDE`, so the two-felt branch was unreachable.

The fallback that made all three silent — *unknown type, return one felt* — is now
a throw, and `scripts/check-abi-types.mjs` walks every type the deployed ABI
mentions, recursively, and proves the throw cannot fire on it. The three bugs are
pinned by tests in `tests/actions.test.mjs`, including the inverted `Option`
assertion that had been **holding the bug in place**: the test asserted `["0x0"]`
was `None`, so it agreed with the decoder and passed.

**The limits of the measurement, stated rather than implied:**

- **Not the whole corpus.** 114 of 200 sampled transactions decoded in the
  stratified run, and 59 of 67 in the live-class window. The rest did not call the
  pool directly through an envelope this decoder knows (section 5), so they are
  not evidence about screening either way.
- **Invokes are unresolved.** 26 of 32 invoke-bearing sets carried `None` and 6
  carried `Some`. Whether an invoke is screened depends on the target's
  `open_note_depositor_screening_policies` and on whether it actually returns
  deposits — neither is visible in the ABI. An emitter that invokes an external
  contract is inside this unknown; one that does not, is not.
- **The oldest class disagrees**, and is unexplained, as above.

## 3. A v3 INVOKE carries the account's envelope, not the pool's arguments

`tx.calldata` on a v3 invoke is the account's call array:

```
[calls_len, (to, selector, calldata_len, ...calldata)*]
```

Reading it as if it were the pool's arguments decodes felts that look plausible
and mean nothing. The decoder unwraps this first. Verified on a real
transaction: 59 felts in, 59 consumed.

## 4. The layout is per-class, and one ABI silently mis-decodes the rest

This is the finding that cost the most and is the most reusable.

The first version of the verifier read the **current** class's ABI and decoded
every transaction in the corpus against it. Sepolia has run **seven** pool
implementations, not one:

| class | observed at blocks |
|---|---|
| `0x715b22ab…d2af` | 8,276,431 – 10,795,698 |
| `0x30b8c540…b30b` | 10,889,964 (also live on mainnet) |
| `0x1a78d2da…3d18` | 11,133,748 – 11,433,152 |
| `0x67dddd89…554d` | 11,767,419 – 12,905,217 |
| `0x56ab118a…23b2` | 12,964,568 – 14,330,611 |
| `0x7e2bbd7c…33f` | 14,376,243 – 14,713,594 |
| `0x6d163f2b…cf83` | 14,865,231 – live |

The first three were known when this section was written; the rest came out of
measuring the screening scope across the whole corpus (section 2b), which is the
argument for sampling by class rather than by position.

A transaction from block 8,276,431 was therefore being decoded with a later
class's layout. **It did not throw.** It returned `consumed 4 of 55` — a wrong
answer wearing the clothes of a right one, which is the exact failure mode the
denomination join was already caught doing once.

The fix is to resolve `starknet_getClassHashAt` **at the transaction's own block**
and cache the ABI per class hash. With that, the sample decodes cleanly:

```
class 0x715b22ab…  blocks 8,276,431-8,336,305   8 exact, 0 short, 0 long
```

**8 of 8 exact.** The layout is understood for that class. This is the same
lesson the event index already learned — a class hash does not identify a
network, and now also: *one ABI does not describe one contract's history.*

## 5. What the verification does and does not cover

The check is exact consumption: decode a real transaction's arguments and require
the decoder to consume **every** felt. A layout off by one still produces
plausible values and leaves a felt unread, so `consumed === length` is the only
assertion carrying weight. It is pinned by
`tests/actions.test.mjs`, including a non-vacuous case with one trailing felt.

On top of that, the decoded values are checked against **live contract state** —
`get_public_key` and `get_auditor_public_key`, both agreeing with what the decoder
pulled out of a transaction from an older class (section 2). Consumption proves
the *shape*; the live calls prove the *values*.

What it does **not** cover, stated rather than implied:

- **One class only.** 8 transactions against `0x715b22ab`. The two later classes
  are not exercised by this sample, because the corpus's transactions predate
  them. Their layouts are unread.
- **Only 8 of 20 sampled transactions call the pool directly.** Of the rest, 11
  call a different contract (`0x75a180e1…`) with two selectors the pool ABI does
  not contain, and 1 calls another (`0x2ceed65a…`). Either the pool is reached
  indirectly, or those accounts use an `__execute__` envelope this decoder does
  not know. Both are unresolved.
- **`ClientAction` → `ServerAction` is now reproduced** (section 6), and it did
  not need a local node after all — a throwaway identity is enough to call the
  view, because the key it discloses is worthless by construction.
- **Screening reachability.** Resolved, and it is better news than an earlier
  draft of this document claimed. A set with no deposit and no invoke cannot be
  screened: all 15 such sets in the live class carry `None` (section 2b). The
  internal path — spend a note, reshape into decoys plus change — does **not**
  need the screener. A deposit does, and invokes are the remaining unknown.

## 6. `ClientAction` → `ServerAction` is reproduced, and it did not need a node

Section 2 concluded the emitter would need a local node, because `compile_actions`
takes the pool's viewing key and handing that to a public RPC hands over the
ability to decrypt your notes. **That conclusion was right about the danger and
too strong about the fix.** The key only has to be *worth* protecting. A
throwaway scalar — generated in the script, never funded, never registered,
controlling nothing — discloses nothing when it goes to an RPC. So the
compilation can be exercised against the deployed pool today, with no node.

`scripts/verify-compile.mjs` does that, as `starknet_call` views: no transaction,
no fee, no state. Eleven checks, all passing.

### The enum order and the phase order are different tables

This is the trap that would have cost the most, and it is the reason the variant
order was read out of the deployed ABI instead of inferred:

```
enum index (ABI)   0 SetViewingKey  1 OpenChannel  2 OpenSubchannel
                   3 CreateEncNote  4 CreateOpenNote  5 Deposit
                   6 UseNote  7 Withdraw  8 InvokeExternal  9 ComputeAndInvoke

phase (contract)   0 SetViewingKey  1 OpenChannel  2 OpenSubchannel
                   3 Deposit  4 UseNote  5 CreateEncNote/CreateOpenNote
                   6 Withdraw  7 InvokeExternal/ComputeAndInvoke
```

`CreateEncNote` is **variant 3 but phase 5**. `Deposit` is **variant 5 but phase
3**. Assuming the two tables agree would produce a set that is out of order in a
way that looks ordered. The script pins both tables and asserts they disagree.

### The three ordering rules, held against the deployed pool

From `privacy.cairo:251-310`, mirrored by the SDK's `ActionSetBuilder`:

1. **Phase cannot decrease.** `assert_and_advance_phase` returns
   `ACTIONS_OUT_OF_ORDER`.
2. **At most one invoke-phase action.**
3. **At least one action must compile to a `WriteOnce`**, or the pool returns
   `NO_REPLAY_PROTECTION`. `Deposit`, `Withdraw`, `InvokeExternal` and
   `ComputeAndInvoke` do **not** produce one; `SetViewingKey`, `OpenChannel`,
   `OpenSubchannel`, `UseNote`, `CreateEncNote` and `CreateOpenNote` do.

Each rule was provoked on the live contract and the contract's own error name
came back:

```
[Deposit]                     -> NO_REPLAY_PROTECTION
[]                            -> NO_REPLAY_PROTECTION
[Deposit, SetViewingKey]      -> ACTIONS_OUT_OF_ORDER     (phase 3 then 0)
```

### A real compile, decoded by our own decoder

`[SetViewingKey { random }]` against a virgin address returns 17 felts, and our
decoder consumes exactly 17 of 17 and reads:

```
WriteOnce        { storage_address: <public_key slot>, value: [public_key] }
WriteOnce        { storage_address: <enc_private_key slot>,
                   value: [auditor_public_key, ephemeral_pubkey, enc_private_key] }
EmitViewingKeySet{ user_addr, public_key, enc_private_key }
```

which is `set_viewing_key` in the source, line for line. The `public_key` and the
three `enc_private_key` felts are identical between the `WriteOnce` and the event,
because the handler computes them once — an internal consistency check the script
asserts.

### `compile_actions` is a simulation, not a pure function

The same call against an **already registered** address reverts with
`NON_ZERO_VALUE` — the "this slot is already written" assertion inside
`_apply_write_once`. So the compile path reaches the write-once slots. That is
consistent with the source's own comment on `set_viewing_key`:

> The key is immutable once set; re-registration reverts via WriteOnce enforcement.

**Operationally this matters for the emitter:** the set has to be compiled
against the state it will actually be applied to. A decoy set writes fresh
nullifiers and fresh note ids, so it compiles; a `SetViewingKey` for an identity
that already has one cannot, by design. Calling the same view twice returns the
same 17 felts, confirming the view rolls back and nothing persists.

### The emitter's own set is phase-legal

The internal decoy set is `UseNote` (phase 4) followed by `CreateEncNote` × (N+1)
(phase 5) — decoys plus change. Non-decreasing, one replay-protecting action,
no deposit, no invoke. It satisfies all three rules and, per section 2b, needs no
screening attestation. That is the whole emitter, and it is reachable today.

**What this section does not cover:** only `SetViewingKey` was compiled
end-to-end. `UseNote` and `CreateEncNote` require real subchannel and note state,
so they cannot be provoked with a throwaway identity — their expansion is read
from the source, not observed. Closing that gap is what the local node is
actually for.

## 7. The encoder exists, and it is the decoder's inverse

Sections 1–6 establish that the pool's call can be *read*. The emitter has to
*write* one, and until now this repository could not: `src/actions.mjs` was a
decoder with no counterpart, and its own header said so.

`encodeValue` / `encodeCall` are now the exact inverse, branch for branch. The
order they were written in is the point. The decoder came first and was held
against real transactions with `consumed === length` as the assertion, so it is a
validated oracle. The encoder was then written to round-trip **through it**,
rather than from the Cairo spec — because an encoder that round-trips through a
validated decoder inherits that validation, while an encoder written from a
reading of the spec inherits nothing. A wrong encoder does not merely revert: it
produces calldata that does something valid and unintended.

### The check is a round-trip over real transactions

`npm run verify:encode` samples transactions from the corpus, resolves the class
at each one's **own block**, fetches the transaction, unwraps the account
envelope, decodes the `apply_actions` call, re-encodes it, and requires the felts
to be identical.

This is stronger than a fixture suite, because the fixtures would be written by
the same hand that wrote the encoder — and a test that agrees with the code
proves nothing when both are wrong. That failure has already happened once in
this project: the `Option` test asserted the inverted order and held the bug in
place rather than catching it.

Result, over two passes:

| pass | sample | classes | decoded exactly | round-trip identical |
|---|---|---|---|---|
| whole range | 110 stratified | 6 | 54 | **54** |
| live class | `--from 14,865,231` | `0x6d163f2b` | 29 | **29** |

83 transactions across all seven implementations, no mismatch. The per-class
table is printed, so a class the sample missed is visible rather than implied.

Sampling is stratified by block, and `--from` exists for the same reason it does
in `check:screening`: a whole-range sample reaches the live class about once,
because that class owns well under 1% of the block range.

### What the round-trip does not prove

That the ABI's variant **names** match the chain's. Both directions read the same
table, so a permuted table would still round-trip cleanly. Exact consumption is
what covers that, and it is covered separately by `verify:actions` — a permuted
variant order moves the felt widths, and that check goes red.

### Two places the encoder refuses to guess

Both are cases where a decoded value cannot be re-encoded unambiguously, and both
throw instead of picking:

- **`Option<Option<T>>`.** `Some(None)` and `None` both decode to `null`, so a
  null cannot be re-encoded. Guessing would silently turn one into the other. The
  deployed ABI has no nested `Option`; this guard exists so that adding one is an
  error rather than a quiet bug.
- **A payload-carrying variant named without its payload.** Writing only the
  variant felt would shift every following field by one — calldata that decodes
  into plausible values and means something else. The same guard runs the other
  way: a payload handed to a variant that takes none is refused.

Both are pinned by tests, because "it throws" is a property that is easy to
delete by accident and impossible to notice once gone.

// The decoy set the emitter submits, and the three rules it has to satisfy.
//
// ## What this module does, and what it refuses to do
//
// It **assembles** a `ClientAction` set and **checks** it. It does not talk to a
// chain, hold a key, or decide how much cover to buy — the plan is
// `src/cover.mjs`, the placement is `planDecoys` in `src/provider.mjs`, and the
// price is `src/quote.mjs`. Keeping the assembly pure is what makes it testable,
// and a set is small enough to read: four actions, not four thousand.
//
// The network half of the emitter — `compile_actions`, the prover, the signed
// `apply_actions` — is deliberately NOT here. Those steps carry the pool viewing
// key in calldata, so they can only run inside the operator's trust boundary,
// and code that cannot be exercised should not pretend to be a library. See
// `docs/CONNECT.md` for the seven steps and what each one needs.
//
// ## The two tables that are not the same table
//
// `ClientAction` has an **ABI variant index** and a **contract phase**, and they
// disagree. `CreateEncNote` is variant 3 and phase 5; `Deposit` is variant 5 and
// phase 3. The ABI index is what goes on the wire; the phase is what
// `privacy.cairo` compares to decide `ACTIONS_OUT_OF_ORDER`. Assuming they match
// produces a set that is out of order in a way that is not obvious.
//
// `CLIENT_ACTION_ORDER` is pinned from the deployed ABI rather than derived, and
// `scripts/check-decoy-set.mjs` re-reads the deployed ABI and fails if it moved.
// A silent reorder would build sets with the wrong variant index, which is the
// same class of failure as decoding with the wrong class's ABI.
//
// ## What is verified here, and what is only read
//
// This distinction is the whole point of the module, so it is stated in full:
//
// **Verified against the deployed pool** (`npm run check:decoy-set`): the
// *encoding* of this set. `[UseNote, CreateEncNote]` is accepted by
// `compile_actions` and reaches the body of the contract, where it reverts with
// `SUBCHANNEL_NOT_FOUND`. That is not a deserialization error — the contract
// parsed the whole set and went looking for state. The same probe with the
// payloads left short returns `Failed to deserialize param #3`, which is what
// distinguishes the two, and it is why the check is worth having.
//
// **NOT verified, and read from the source**: the **order rules as applied to
// this set**. `[CreateEncNote, UseNote]` is out of order (phase 5 then 4) and the
// contract answers `SUBCHANNEL_NOT_FOUND`, not `ACTIONS_OUT_OF_ORDER` — so the
// subchannel lookup runs BEFORE the order check, and a set without a subchannel
// never reaches it. The rules ARE verified for `[Deposit]` and
// `[Deposit, SetViewingKey]`, which need no subchannel. `checkSet` below
// therefore implements the rules as `privacy.cairo:251-310` states them, and
// they become observable for this set only once a subchannel exists — which is
// the same dependency as the expansion of the two actions.
//
// **NOT verified either**: what the contract *expands* these two actions into.
// That needs real subchannel and note state. `docs/RUNBOOK-emitter.md` records
// the ordered steps to close it.

import { encodeCall, encodeValue, typeRegistry } from "./actions.mjs";

/** The `ClientAction` variants, in the order the deployed ABI declares them. */
export const CLIENT_ACTION_ORDER = [
  "SetViewingKey", "OpenChannel", "OpenSubchannel", "CreateEncNote", "CreateOpenNote",
  "Deposit", "UseNote", "Withdraw", "InvokeExternal", "ComputeAndInvoke",
];

/**
 * The contract's phase per action, from `sdk/rs/src/actions.rs` → `pub mod phase`.
 *
 * A different table from the ABI order on purpose. `privacy.cairo` compares
 * phases, not variant indices, so this is the one the ordering rule uses.
 */
export const PHASE = {
  SetViewingKey: 0,
  OpenChannel: 1,
  OpenSubchannel: 2,
  Deposit: 3,
  UseNote: 4,
  CreateEncNote: 5,
  CreateOpenNote: 5,
  Withdraw: 6,
  InvokeExternal: 7,
  ComputeAndInvoke: 7,
};

/** The phase value that means "this action invokes something". */
export const INVOKE_PHASE = 7;

/**
 * Which actions compile to a `WriteOnce`, which is the set's replay protection.
 *
 * Taken from the source and confirmed by the contract's own behaviour: an empty
 * set and a `[Deposit]`-only set both revert with `NO_REPLAY_PROTECTION` on the
 * deployed pool, and `[SetViewingKey]` compiles to `WriteOnce, WriteOnce,
 * EmitViewingKeySet`. `Deposit`, `Withdraw`, `InvokeExternal` and
 * `ComputeAndInvoke` are absent because they produce none — a set made only of
 * those is not replay-protected and the contract says so.
 */
export const WRITE_ONCE_PRODUCERS = new Set([
  "SetViewingKey", "OpenChannel", "OpenSubchannel", "UseNote",
  "CreateEncNote", "CreateOpenNote",
]);

/** The variant name of an action, accepting either the encoder's shape or a bare name. */
export function actionName(action) {
  return typeof action === "string" ? action : action?.variant;
}

/** The phase of each action, in order. */
export function phasesOf(actions) {
  return actions.map((a) => {
    const name = actionName(a);
    const phase = PHASE[name];
    if (phase === undefined) throw new Error(`no phase for action ${name}`);
    return phase;
  });
}

/**
 * The three rules from `privacy.cairo:251-310`, as a check.
 *
 * Returns every violation rather than throwing on the first, because a set is
 * assembled once and a caller fixing one rule at a time is a caller who ships
 * the other two.
 */
export function checkSet(actions) {
  const violations = [];
  if (!Array.isArray(actions) || actions.length === 0) {
    return { ok: false, violations: ["an empty set has no replay protection"] };
  }

  const phases = phasesOf(actions);
  for (let i = 1; i < phases.length; i += 1) {
    if (phases[i] < phases[i - 1]) {
      violations.push(
        `phase drops from ${phases[i - 1]} to ${phases[i]} at position ${i} (ACTIONS_OUT_OF_ORDER)`,
      );
    }
  }

  const invokes = phases.filter((p) => p === INVOKE_PHASE).length;
  if (invokes > 1) {
    violations.push(`${invokes} invoke actions, and the contract allows at most one`);
  }

  const writes = actions.filter((a) => WRITE_ONCE_PRODUCERS.has(actionName(a))).length;
  if (writes === 0) {
    violations.push(
      "no action compiles to a WriteOnce, so the set has no replay protection (NO_REPLAY_PROTECTION)",
    );
  }

  return { ok: violations.length === 0, violations };
}

/**
 * One emission: spend one note, then create the notes that replace it.
 *
 * The shape is `UseNote` (phase 4) followed by `CreateEncNote` × (N+1) (phase
 * 5) — the N decoys and the change. It does not decrease, it carries replay
 * protection, and it has neither a deposit nor an invoke, which by
 * `docs/FINDING-emitter-interface.md` §2b means it acquires **no screening
 * subject** and needs no attestation. That is what makes the emitting leg
 * fully local while the funding leg may not be.
 *
 * `notes` is explicit — a list of `{ index, amount }` — rather than derived from
 * a decoy count, because the amounts are the plan's business and this function
 * should not be able to get them wrong. `emissionNotes` below builds the common
 * case.
 *
 * `salts` is one per created note. It is a parameter rather than drawn here for
 * the same reason `src/provider.mjs` takes `next`: the set has to be
 * reproducible from a seed for a dispute to be re-run rather than argued.
 *
 * The returned actions are in the shape `encodeValue` accepts, so they can go
 * straight into `encodeSet`.
 */
export function assembleDecoySet({
  channelKey,
  token,
  spendIndex,
  notes,
  recipient,
  recipientKey,
  salts,
}) {
  if (!Array.isArray(notes) || notes.length === 0) {
    throw new Error("an emission creates at least one note — the decoys and the change");
  }
  if (!Array.isArray(salts) || salts.length !== notes.length) {
    throw new Error(`need one salt per created note: ${notes?.length} notes, ${salts?.length} salts`);
  }

  const actions = [
    {
      variant: "UseNote",
      value: { channel_key: channelKey, token, index: spendIndex },
    },
    ...notes.map((note, i) => ({
      variant: "CreateEncNote",
      value: {
        recipient_addr: recipient,
        recipient_public_key: recipientKey,
        token,
        amount: note.amount,
        index: note.index,
        salt: salts[i],
      },
    })),
  ];

  const check = checkSet(actions);
  if (!check.ok) throw new Error(`the set this assembles is not submittable: ${check.violations.join("; ")}`);
  return actions;
}

/**
 * The notes one emission creates: `decoys` at `denomination`, then the change.
 *
 * ## The unit, which is the one thing here that can go wrong quietly
 *
 * `denomination` and `changeAmount` are in the token's **base units** — the unit
 * `CreateEncNote.amount` is a `u128` in — and NOT in whole STRK. The ladder in
 * `src/cover.mjs` is whole STRK, so a caller holding a rung converts it, and
 * `scripts/emit.mjs` is the one place that does.
 *
 * The distinction is worth a paragraph because the wrong one is not an error the
 * chain reports: a rung passed straight through mints a note worth 10 wei, which
 * is a perfectly valid note that nobody else is holding. That is a smaller
 * anonymity set wearing the shape of a correct one, which is this repository's
 * whole subject.
 *
 * A change of zero creates no change note. That is not a special case bolted on
 * — a zero-amount note is a note whose amount is publicly known to be nothing,
 * so it is worse than absent.
 */
export function emissionNotes({ firstIndex, decoys, denomination, changeAmount }) {
  if (!Number.isInteger(decoys) || decoys < 1) {
    throw new Error(`an emission needs at least one decoy, got ${decoys}`);
  }
  if (!Number.isInteger(firstIndex) || firstIndex < 0) {
    throw new Error(`firstIndex must be a non-negative integer, got ${firstIndex}`);
  }
  const notes = [];
  for (let i = 0; i < decoys; i += 1) {
    notes.push({ index: firstIndex + i, amount: denomination });
  }
  const change = BigInt(changeAmount ?? 0n);
  if (change < 0n) throw new Error(`a change cannot be negative, got ${change}`);
  if (change > 0n) notes.push({ index: firstIndex + decoys, amount: change });
  return notes;
}

/**
 * Encode the set as the `Span<ClientAction>` a pool entrypoint takes.
 *
 * Returns the **whole span encoding, length prefix included** — a `Span` is
 * `[length, ...elements]`, and that is what `compile_actions` and
 * `apply_actions` take. The prefix is not decoration: dropping it shifts every
 * following felt by one, which is the same class of mistake as reading
 * `Withdrawal.amount` at `data[0]`. The selector is NOT included, which is the
 * convention `unwrapExecute` uses.
 *
 * The ABI is a parameter because this module stays pure. `encodeValue` is the
 * inverse of a decoder that has been held against real transactions with exact
 * consumption as the assertion, so an encoder that goes through it inherits that
 * validation — see `src/actions.mjs`.
 */
export function encodeSet(abi, actions) {
  const reg = typeRegistry(abi);
  return encodeValue("core::array::Span::<privacy::actions::ClientAction>", actions, reg);
}

/**
 * The `compile_actions` calldata for a set, in the argument order the ABI gives.
 *
 * Exposed separately from `encodeSet` because this is the calldata that carries
 * the pool viewing key, and it should be hard to build one without noticing.
 * `scripts/check-decoy-set.mjs` uses it with a throwaway scalar; the emitter uses
 * it only against a loopback RPC.
 *
 * **The third parameter is `client_actions`, not `actions`.** `encodeCall`
 * matches on name, so a plausible name is a hard failure — which is the good
 * outcome, and it is how this was found: an offline fixture that said `actions`
 * passed its own test and the deployed contract refused the calldata. The name
 * is asserted against the live ABI by `scripts/check-decoy-set.mjs`, so a
 * redeployment that renames it fails there rather than at submit time.
 */
export function compileCalldata(abi, { userAddr, viewingKey, actions }) {
  return encodeCall(abi, "compile_actions", {
    user_addr: userAddr,
    user_private_key: viewingKey,
    client_actions: actions,
  });
}

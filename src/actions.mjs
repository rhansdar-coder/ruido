// ABI-driven codec for the pool's call calldata: `decodeValue`/`decodeCall` read
// it, `encodeValue`/`encodeCall` write it.
//
// The emitter needs to build an `apply_actions` call, so the encoder had to
// exist. It is written as the *inverse of the decoder* rather than from the
// Cairo spec, and that order matters: the decoder has been held against real
// transactions and required to consume them exactly, so it is a validated
// oracle, and an encoder that round-trips through it inherits that validation.
// An encoder written from a reading of the spec inherits nothing, and a wrong
// one produces calldata that either reverts or — far worse — does something
// valid and unintended.
//
// `scripts/verify-encode.mjs` is the check: it decodes real `apply_actions`
// transactions, re-encodes them, and requires the felts to come back identical.
//
// The check is the same one the event decoder uses: decode a real transaction's
// arguments and require that the decoder consumes **exactly** the calldata, not
// less. A layout that is off by one felt usually still decodes into plausible
// values; it just leaves a felt unread. So `consumed === length` is the assertion
// that carries the weight.
//
// Nothing here touches a key or a network. It is a pure function over felts.
//
// Two shapes the pool's ABI actually uses, and which a naive decoder gets wrong:
//
//   - `core::array::Span::<T>` and `core::array::Array::<T>` both encode as
//     [length, ...elements]. A Span is not a pointer on the wire.
//   - `core::option::Option::<T>` encodes as [variant, ...payload] where variant
//     is 0 for Some (payload follows) or 1 for None (nothing follows). Cairo
//     declares `Some` first, so it owns variant 0.
//
// Verified by `scripts/verify-actions.mjs` against real mainnet and Sepolia
// transactions.

/** Split `core::array::Span::<X>` into its head and inner type, balanced. */
export function splitGeneric(type) {
  const open = type.indexOf("<");
  // No generic: the whole string is the head.
  if (open === -1) return { head: type.trim(), inner: null };
  // Strip the `::` that separates the head from its `<`. Leaving it attached
  // makes `head === "core::array::Span"` false, which silently skips the Span
  // branch and falls through to "one felt" — a wrong answer, not an error.
  const head = type.slice(0, open).replace(/::\s*$/, "").trim();
  // Walk to the matching close so `Span::<Span::<felt252>>` does not truncate.
  let depth = 0;
  for (let i = open; i < type.length; i += 1) {
    if (type[i] === "<") depth += 1;
    else if (type[i] === ">") {
      depth -= 1;
      if (depth === 0) return { head, inner: type.slice(open + 1, i).trim() };
    }
  }
  return { head, inner: type.slice(open + 1, -1).trim() };
}

const PRIMITIVES = new Set([
  "core::felt252",
  "core::integer::u8",
  "core::integer::u16",
  "core::integer::u32",
  "core::integer::u64",
  "core::integer::u128",
  "core::integer::usize",
  "core::bool",
  "core::starknet::contract_address::ContractAddress",
  "core::starknet::class_hash::ClassHash",
  "core::starknet::eth_address::EthAddress",
  "core::starknet::storage_access::StorageAddress",
  "core::bytes_31::bytes31",
]);

/**
 * u256 is two felts (low, high) everywhere it appears in this ABI, so it is
 * checked **before** `PRIMITIVES`. It used to sit in `PRIMITIVES`, which is
 * tested first — so `u256` decoded as one felt and this set was dead code.
 */
const WIDE = new Set(["core::integer::u256"]);

export function typeRegistry(abi) {
  const structs = new Map();
  const enums = new Map();
  for (const item of abi) {
    if (item.type === "struct") structs.set(item.name, item.members ?? []);
    if (item.type === "enum") enums.set(item.name, item.variants ?? []);
  }
  return { structs, enums };
}

const short = (type) => String(type).split("::").pop();

/**
 * Decode one value of `type` starting at `at`.
 * Returns { value, consumed }. Throws when the felts run out, because a
 * truncated decode is a wrong answer, not a partial one.
 */
export function decodeValue(type, felts, at, reg, depth = 0) {
  if (depth > 32) throw new Error(`type nesting too deep at ${type}`);
  const { head, inner } = splitGeneric(type);

  // `WIDE` first: a type that is both wide and primitive (u256) must take the
  // wide branch, and `PRIMITIVES` would otherwise claim it as one felt.
  if (WIDE.has(type)) {
    if (at + 1 >= felts.length) throw new Error(`out of felts decoding u256 at ${at}`);
    return { value: { low: felts[at], high: felts[at + 1] }, consumed: 2 };
  }
  if (PRIMITIVES.has(type)) {
    if (at >= felts.length) throw new Error(`out of felts decoding ${type} at ${at}`);
    return { value: felts[at], consumed: 1 };
  }

  // [length, ...elements]
  if (head === "core::array::Span" || head === "core::array::Array") {
    const len = Number(BigInt(felts[at]));
    let cursor = at + 1;
    const items = [];
    for (let i = 0; i < len; i += 1) {
      const out = decodeValue(inner, felts, cursor, reg, depth + 1);
      items.push(out.value);
      cursor += out.consumed;
    }
    return { value: items, consumed: cursor - at };
  }

  // [variant, ...payload]. Cairo declares `Option` as `enum Option<T> { Some: T,
  // None }`, so **variant 0 is `Some`** and carries the payload, and variant 1 is
  // `None` and carries nothing. The SDK agrees from the other side:
  // `screening_suffix(None) == vec![Felt::ONE]` (sdk/rs/src/calldata.rs) and the
  // TS test calls the trailing `0x1` "Serde for Option::None".
  //
  // This was backwards here, and the direction it failed in is the dangerous one:
  // a real `Some` read as `None` still returns a value, it just leaves the
  // attestation's felts unread. Only `consumed === length` catches it.
  if (head === "core::option::Option") {
    const variant = Number(BigInt(felts[at]));
    if (variant === 1) return { value: null, consumed: 1 };
    if (variant !== 0) throw new Error(`${short(type)}: bad Option variant ${variant}`);
    const out = decodeValue(inner, felts, at + 1, reg, depth + 1);
    return { value: out.value, consumed: 1 + out.consumed };
  }

  // A tuple is just its members in order. The test is on the raw `type`, not on
  // `head`: `splitGeneric` returns the whole string as `head` when there is no
  // `<` in it, so `head === "("` is false for `(core::felt252, core::felt252)`
  // and this branch was dead for every tuple without a generic inside — which is
  // exactly the shape of `ScreeningAttestation.signature`. Those tuples fell
  // through to the one-felt fallback and left a felt unread.
  if (type.startsWith("(") && type.endsWith(")")) {
    const parts = splitTopLevel(type.slice(1, -1));
    let cursor = at;
    const items = [];
    for (const part of parts) {
      const out = decodeValue(part.trim(), felts, cursor, reg, depth + 1);
      items.push(out.value);
      cursor += out.consumed;
    }
    return { value: items, consumed: cursor - at };
  }

  if (reg.enums.has(type)) {
    const variant = Number(BigInt(felts[at]));
    const variants = reg.enums.get(type);
    const chosen = variants[variant];
    if (!chosen) throw new Error(`${short(type)}: no variant ${variant}`);
    if (!chosen.type) return { value: { variant: chosen.name }, consumed: 1 };
    const out = decodeValue(chosen.type, felts, at + 1, reg, depth + 1);
    return { value: { variant: chosen.name, value: out.value }, consumed: 1 + out.consumed };
  }

  if (reg.structs.has(type)) {
    const members = reg.structs.get(type);
    let cursor = at;
    const value = {};
    for (const m of members) {
      const out = decodeValue(m.type, felts, cursor, reg, depth + 1);
      value[m.name] = out.value;
      cursor += out.consumed;
    }
    return { value, consumed: cursor - at };
  }

  // No fallback on purpose. This used to return one felt for any unrecognised
  // type, which is how the dead tuple branch above turned a 3-felt
  // `ScreeningAttestation` into 2 felts and left a felt unread — a wrong answer
  // with no error. An unknown type is a decoder gap; say so.
  // `scripts/check-abi-types.mjs` keeps this from ever firing on the real ABI.
  throw new Error(`cannot decode type ${type} at ${at}`);
}

/**
 * Encode one value of `type`. The exact inverse of `decodeValue`, branch for
 * branch, on purpose: the two are only trustworthy together.
 *
 * Why the inverse is written against the decoder rather than against the Cairo
 * spec: the decoder has been held against real transactions and required to
 * consume them **exactly**, so it is a validated oracle. An encoder that
 * round-trips through it inherits that validation. An encoder written from a
 * reading of the spec inherits nothing, and a wrong one produces calldata that
 * either reverts or — the bad case — does something valid and unintended.
 *
 * Returns an array of BigInt.
 */
export function encodeValue(type, value, reg, depth = 0) {
  if (depth > 32) throw new Error(`type nesting too deep at ${type}`);
  const { head, inner } = splitGeneric(type);

  // `WIDE` before `PRIMITIVES`, mirroring the decoder. If these two ever
  // disagree about which branch a type takes, the round-trip fails loudly.
  if (WIDE.has(type)) {
    if (value === null || typeof value !== "object") {
      throw new Error(`u256 needs {low, high}, got ${value === null ? "null" : typeof value}`);
    }
    if (value.low === undefined || value.high === undefined) {
      throw new Error("u256 needs both low and high");
    }
    return [BigInt(value.low), BigInt(value.high)];
  }
  if (PRIMITIVES.has(type)) {
    // `bool` is the one primitive whose JS value is not already a number-like.
    if (type === "core::bool") return [value ? 1n : 0n];
    return [BigInt(value)];
  }

  // [length, ...elements]
  if (head === "core::array::Span" || head === "core::array::Array") {
    if (!Array.isArray(value)) {
      throw new Error(`${short(type)} needs an array, got ${value === null ? "null" : typeof value}`);
    }
    const out = [BigInt(value.length)];
    for (const item of value) out.push(...encodeValue(inner, item, reg, depth + 1));
    return out;
  }

  // [variant, ...payload], with `Some` = 0 and `None` = 1 — the same order the
  // decoder reads and the same order the SDK writes.
  //
  // `null` means `None`. That is unambiguous EXCEPT when the payload type is
  // itself an `Option`: `Some(None)` and `None` both decode to `null`, so the
  // decoded value cannot be re-encoded and a guess here would silently turn one
  // into the other. Refuse instead. (The deployed ABI has no nested Option; the
  // guard is here so that adding one is an error rather than a quiet bug.)
  if (head === "core::option::Option") {
    if (value === null || value === undefined) {
      if (splitGeneric(inner).head === "core::option::Option") {
        throw new Error(
          `cannot encode ${short(type)}: Some(None) and None are indistinguishable from a null`,
        );
      }
      return [1n];
    }
    return [0n, ...encodeValue(inner, value, reg, depth + 1)];
  }

  if (type.startsWith("(") && type.endsWith(")")) {
    const parts = splitTopLevel(type.slice(1, -1)).map((p) => p.trim());
    if (!Array.isArray(value)) throw new Error(`${type} needs a tuple array`);
    if (value.length !== parts.length) {
      throw new Error(`${type} has ${parts.length} members, got ${value.length}`);
    }
    const out = [];
    parts.forEach((part, i) => out.push(...encodeValue(part, value[i], reg, depth + 1)));
    return out;
  }

  if (reg.enums.has(type)) {
    const variants = reg.enums.get(type);
    // Accept either the decoder's own shape (`{ variant, value }`) or a bare
    // variant name, because hand-written action sets name the variant and
    // decoded ones carry the object.
    const name = typeof value === "string" ? value : value?.variant;
    const payload = typeof value === "string" ? undefined : value?.value;
    const index = variants.findIndex((v) => v.name === name);
    if (index < 0) throw new Error(`${short(type)}: no variant ${name}`);
    const chosen = variants[index];
    if (!chosen.type) {
      // A variant with no payload carries nothing. Writing a felt here would
      // shift every following field by one.
      if (payload !== undefined && payload !== null) {
        throw new Error(`${short(type)}::${name} carries no payload`);
      }
      return [BigInt(index)];
    }
    if (payload === undefined) throw new Error(`${short(type)}::${name} needs a payload`);
    return [BigInt(index), ...encodeValue(chosen.type, payload, reg, depth + 1)];
  }

  if (reg.structs.has(type)) {
    const members = reg.structs.get(type);
    if (value === null || typeof value !== "object") {
      throw new Error(`${short(type)} needs an object`);
    }
    const out = [];
    for (const m of members) {
      if (!(m.name in value)) throw new Error(`${short(type)}: missing member ${m.name}`);
      out.push(...encodeValue(m.type, value[m.name], reg, depth + 1));
    }
    return out;
  }

  // Same doctrine as the decoder: no fallback. An unknown type on this side
  // would write a felt that means nothing, and the contract would either revert
  // or accept it as something else.
  throw new Error(`cannot encode type ${type}`);
}

/** Split a comma-separated list at depth 0, respecting nested generics. */
export function splitTopLevel(source) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (c === "<" || c === "(") depth += 1;
    else if (c === ">" || c === ")") depth -= 1;
    else if (c === "," && depth === 0) {
      parts.push(source.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

/**
 * Decode a call's arguments for `fnName` out of an ABI.
 * Returns { args, consumed, length, ok } where `ok` means the decoder consumed
 * the calldata exactly.
 */
export function decodeCall(abi, fnName, calldata) {
  const fn = findFunction(abi, fnName);
  if (!fn) throw new Error(`no function ${fnName} in ABI`);
  const reg = typeRegistry(abi);
  let cursor = 0;
  const args = {};
  for (const input of fn.inputs ?? []) {
    const out = decodeValue(input.type, calldata, cursor, reg);
    args[input.name] = out.value;
    cursor += out.consumed;
  }
  return { fn, args, consumed: cursor, length: calldata.length, ok: cursor === calldata.length };
}

/**
 * Encode a call's arguments for `fnName`. Returns an array of BigInt, WITHOUT
 * the selector — the selector is what the caller puts in front, and the same
 * convention `unwrapExecute` hands back.
 */
export function encodeCall(abi, fnName, args) {
  const fn = findFunction(abi, fnName);
  if (!fn) throw new Error(`no function ${fnName} in ABI`);
  const reg = typeRegistry(abi);
  const out = [];
  for (const input of fn.inputs ?? []) {
    if (!(input.name in args)) throw new Error(`${fnName}: missing argument ${input.name}`);
    out.push(...encodeValue(input.type, args[input.name], reg));
  }
  return out;
}

/** Interfaces hide their entrypoints in `items`; look there too. */
export function findFunction(abi, fnName) {
  for (const item of abi) {
    if (item.type === "function" && item.name === fnName) return item;
    if (item.type === "interface") {
      for (const sub of item.items ?? []) {
        if (sub.type === "function" && sub.name === fnName) return sub;
      }
    }
  }
  return null;
}

/**
 * Pull the pool calls out of an account's `__execute__` envelope.
 *
 * A v3 INVOKE's `calldata` is the account's call array, not the pool's
 * arguments:
 *
 *     [calls_len, (to, selector, calldata_len, ...calldata)*]
 *
 * Reading it as pool arguments decodes nonsense that still looks like felts.
 */
export function unwrapExecute(calldata) {
  const calls = [];
  if (calldata.length === 0) return calls;
  const count = Number(BigInt(calldata[0]));
  let cursor = 1;
  for (let i = 0; i < count; i += 1) {
    const to = calldata[cursor];
    const selector = calldata[cursor + 1];
    const len = Number(BigInt(calldata[cursor + 2]));
    const args = calldata.slice(cursor + 3, cursor + 3 + len);
    calls.push({ to, selector, args });
    cursor += 3 + len;
  }
  return calls;
}

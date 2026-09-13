// Turn a deployed Starknet class ABI into a decoder for its event payloads.
//
// Why this exists
// ---------------
// The first version of the indexer kept only { block, tx, key, name }. The
// amounts were dropped at the RPC boundary, so the denomination axis — the one
// axis that can only ever shrink a candidate set — could not be measured at all.
// Every anonymity number in the README was therefore a slight over-estimate in a
// way the project could not see.
//
// Getting the amounts back is not a matter of reading data[0]. The position of a
// member depends on how many felts the members before it occupy:
//
//   Deposit          user_addr(key) token(key) amount(data)              -> data[0]
//   OpenNoteDeposited depositor(key) token(key) note_id(key) amount(data) -> data[0]
//   Withdrawal       enc_user_addr(data, 3 felts) to_addr(key) token(key) amount(data)
//                                                                        -> data[3]
//
// `enc_user_addr` is a three-felt struct. Reading data[0] on a Withdrawal
// returns a fragment of the recipient's encrypted address, and at a glance it
// looks exactly like an amount. That is the failure this module is built to make
// impossible: a wrong member is not a crash, it is a plausible number.
//
// Two things this module refuses to do
// ------------------------------------
//   1. Guess. A member whose width cannot be derived (an array, an unknown type)
//      marks the whole event undecodable. It is reported, not approximated.
//   2. Stay quiet. decodeEvent() returns the felt count it consumed next to the
//      felt count the event actually carried. When those disagree the ABI and
//      the chain have diverged, and the caller is expected to fail loudly rather
//      than keep the number.

import { selectorHex } from "./keccak.mjs";

/** Last path segment: "privacy::events::Deposit" -> "Deposit". */
export const shortName = (name) => String(name).split("::").pop();

// Widths of the leaf types a pool event can carry, in felts. u256 is two felts
// because Starknet serialises it as (low, high). Anything absent from this table
// is treated as underivable rather than assumed to be one felt.
export const PRIMITIVE_WIDTHS = new Map([
  ["core::felt252", 1],
  ["core::bool", 1],
  ["core::starknet::contract_address::ContractAddress", 1],
  ["core::starknet::class_hash::ClassHash", 1],
  ["core::starknet::eth_address::EthAddress", 1],
  ["core::bytes_31::bytes31", 1],
  ["core::integer::u8", 1],
  ["core::integer::u16", 1],
  ["core::integer::u32", 1],
  ["core::integer::u64", 1],
  ["core::integer::u128", 1],
  ["core::integer::u256", 2],
]);

/** name -> members, for every struct in the ABI. */
export function structTable(abi) {
  const table = new Map();
  for (const item of abi) {
    if (item.type === "struct" && item.name) table.set(item.name, item.members ?? []);
  }
  return table;
}

/**
 * Felts occupied by one value of `typeName`.
 *
 * Returns null when the width cannot be derived — an array, a tuple, a type the
 * ABI never defines. null propagates up and disqualifies the event, which is the
 * point: an underivable width is a missing measurement, not a zero.
 */
export function feltWidth(typeName, structs, seen = new Set()) {
  if (typeof typeName !== "string") return null;
  if (PRIMITIVE_WIDTHS.has(typeName)) return PRIMITIVE_WIDTHS.get(typeName);
  if (seen.has(typeName)) return null; // recursive type: give up, do not loop
  const members = structs.get(typeName);
  if (!members) return null;
  seen.add(typeName);
  let total = 0;
  for (const member of members) {
    const w = feltWidth(member.type, structs, seen);
    if (w === null) return null;
    total += w;
  }
  return total;
}

/**
 * selector -> event definition, derived from the event structs the ABI declares.
 *
 * The selector is keccak of the SHORT name, which is verified against live
 * events rather than assumed. Two conventions were in play in the codebase and
 * only one of them is real:
 *
 *   selectorHex("privacy::events::Deposit") = 0x1a0499985073c081…   never observed
 *   selectorHex("Deposit")                  = 0x9149d2123147c5f4…   matches
 *
 * All eight selectors observed on chain resolved with the short form and none
 * with the full form, so the full form is dead weight in the lookup map. It is
 * also why the previous name resolution appeared to work: it was pulling the
 * bare name "Deposit" out of privacy::actions::ClientAction, an enum of
 * *actions*, which happens to share a name with the event. Correct by
 * coincidence, and one rename away from labelling every event wrong.
 */
export function eventDefinitions(abi) {
  const structs = structTable(abi);
  const defs = new Map();
  const collisions = [];
  const undecodable = [];

  for (const item of abi) {
    if (item.type !== "event" || item.kind !== "struct" || !item.name) continue;
    const name = shortName(item.name);
    const selector = selectorHex(name);
    const members = [];
    let decodable = true;
    let reason = null;

    for (const member of item.members ?? []) {
      const width = feltWidth(member.type, structs);
      if (width === null) {
        decodable = false;
        reason = `member ${member.name} has type ${typeof member.type === "string" ? member.type : JSON.stringify(member.type)}, whose width is not derivable`;
        break;
      }
      members.push({
        name: member.name,
        kind: member.kind === "key" ? "key" : "data",
        type: member.type,
        width,
      });
    }

    const def = { name, fullName: item.name, selector, members, decodable, reason };

    if (defs.has(selector)) {
      // Two structs sharing a short name would silently overwrite one another,
      // and the survivor would be arbitrary. Report instead.
      collisions.push({ selector, names: [defs.get(selector).fullName, item.name] });
      continue;
    }
    defs.set(selector, def);
    if (!decodable) undecodable.push({ name, reason });
  }

  return { defs, collisions, undecodable };
}

/**
 * Decode one raw RPC event against its definition.
 *
 * `keys[0]` is the event selector, so key indices start at 1 while data indices
 * start at 0. Members are walked in declaration order, each advancing its own
 * index by its own width.
 *
 * Returns `consumed` and `dataLength` separately on purpose. When they disagree,
 * the caller has a decision to make — the ABI no longer describes the chain —
 * and that decision should be visible in the output rather than absorbed here.
 */
export function decodeEvent(def, raw) {
  const keys = raw.keys ?? [];
  const data = raw.data ?? [];
  const values = {};
  let keyIndex = 1;
  let dataIndex = 0;

  for (const member of def.members) {
    if (member.kind === "key") {
      const value = keys[keyIndex];
      values[member.name] = member.width === 1 ? (value ?? null) : keys.slice(keyIndex, keyIndex + member.width);
      keyIndex += member.width;
    } else {
      values[member.name] = member.width === 1
        ? (data[dataIndex] ?? null)
        : data.slice(dataIndex, dataIndex + member.width);
      dataIndex += member.width;
    }
  }

  return {
    values,
    consumed: dataIndex,
    dataLength: data.length,
    // consumed === dataLength is the check that the width model is still right.
    ok: dataIndex === data.length,
  };
}

/** A felt as a decimal string, so big amounts survive JSON without precision loss. */
export function feltToDecimal(value) {
  if (value === null || value === undefined) return null;
  try {
    return BigInt(value).toString(10);
  } catch {
    return null;
  }
}

/**
 * Decimal string -> canonical hex, so the same amount written two ways compares
 * equal. "0x0de0b6b3a7640000" and "1000000000000000000" are the same deposit.
 */
export function decimalToHex(value) {
  if (value === null || value === undefined) return null;
  try {
    return `0x${BigInt(value).toString(16)}`;
  } catch {
    return null;
  }
}

/**
 * A multi-felt amount as one decimal string.
 *
 * Starknet serialises u256 as (low, high), each limb 128 bits, so the value is
 * low + high * 2^128. Today the pool's amounts are u128 and this is never
 * reached — which is exactly why it is written down: if a future ABI widens the
 * amount, the alternative is that `values.amount` silently becomes a two-element
 * array and every comparison against it quietly returns false, turning the
 * denomination axis off without saying so.
 */
export function limbsToDecimal(limbs) {
  if (!Array.isArray(limbs) || limbs.length === 0) return null;
  try {
    let value = 0n;
    for (let i = limbs.length - 1; i >= 0; i -= 1) {
      value = value * (1n << 128n) + BigInt(limbs[i] ?? 0);
    }
    return value.toString(10);
  } catch {
    return null;
  }
}

/** An amount that may be one felt or several, as a decimal string. */
export function amountToDecimal(value) {
  if (Array.isArray(value)) return limbsToDecimal(value);
  return feltToDecimal(value);
}

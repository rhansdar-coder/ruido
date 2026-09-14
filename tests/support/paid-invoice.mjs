// A verified payment, for tests that need a paid invoice without a chain.
//
// It goes through the real `verifyPayment` rather than fabricating the shape it
// returns. That matters: a helper that hand-built `{ ok: true, payment: {…} }`
// would keep passing after the verifier started refusing the very thing the test
// asserts, and the test would be certifying a rail that no longer exists.
//
// So the fixture builds a receipt, hands it to the verifier, and throws if the
// verifier says no. When `verifyPayment` changes its mind about something, every
// test that marks an invoice paid fails — which is the point.

import {
  STRK_TOKEN,
  TRANSFER_SELECTOR,
  paymentRequest,
  verifyPayment,
} from "../../src/payment.mjs";

const hex = (value) => `0x${BigInt(value).toString(16)}`;

/** A provider address that is only ever used in tests. */
export const TEST_PROVIDER = "0x0119f9a1e4e3f0f0c2a1b8d7e6f5a4b3c2d1e0f1a2b3c4d5e6f708192a3b4c5d";
export const TEST_BUYER = "0x0277aa11bb22cc33dd44ee55ff6600112233445566778899aabbccddeeff0011";

/**
 * The verdict from paying `invoice` correctly.
 *
 * `value` overrides the amount, which is how the tests that must be REFUSED are
 * built — an amount one base unit short, or one without the tag in it.
 */
export function verifiedPayment(
  invoice,
  { orderId, txHash = "0xpaid", block = 1, from = TEST_BUYER, provider = TEST_PROVIDER, value = null } = {},
) {
  const request = { ...paymentRequest(invoice, { orderId, provider }), txHash };
  const amount = value ?? request.amountDue;
  const receipt = {
    finality: "ACCEPTED_ON_L2",
    execution: "SUCCEEDED",
    block,
    events: [
      {
        from_address: STRK_TOKEN,
        keys: [TRANSFER_SELECTOR, from, provider],
        data: [hex(amount & ((1n << 128n) - 1n)), hex(amount >> 128n)],
      },
    ],
    revertReason: null,
  };

  const verdict = verifyPayment({ invoice, request, receipt });
  if (!verdict.ok) {
    throw new Error(`the payment fixture did not verify: ${verdict.status} — ${verdict.reason}`);
  }
  return verdict;
}

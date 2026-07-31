// Proof that the person holding this session also holds a given browser wallet.
//
// Needed because autopay_grants.debtor_address decides whose off-chain rules
// (the score floor, the verified-hash check, the model review) apply to a
// wallet, and whose decision log shows its payments. A merely CLAIMED address
// would let anyone attach their own rules to someone else's wallet and read
// their log — so the address has to be signed for.
//
// Pure and clock-free: `nowMs` is an argument, never Date.now(), so the staleness
// rule is testable.
import { verifyMessage } from "viem";

// Long enough to read a wallet prompt, short enough that a leaked signature is
// not a standing credential.
export const LINK_MAX_AGE_MS = 5 * 60 * 1000;

// The exact bytes the wallet signs. The address and handle are both inside the
// message, so a signature captured for one account cannot be replayed to link
// the same wallet to another.
export function buildLinkMessage(address: string, handle: string, isoTimestamp: string): string {
  return `Splitsy: link ${address.toLowerCase()} to @${handle} for autopay\n${isoTimestamp}`;
}

export async function verifyLinkSignature(input: {
  address: string;
  handle: string;
  message: string;
  signature: string;
  nowMs: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  // Re-derive the message from what the SESSION says rather than trusting the
  // body's copy. Otherwise a valid signature over some other text would pass.
  const lines = input.message.split("\n");
  const isoTimestamp = lines[1] ?? "";
  const expected = buildLinkMessage(input.address, input.handle, isoTimestamp);
  if (expected !== input.message) {
    return { ok: false, error: "That signature was not for this account and wallet." };
  }

  const signedAt = Date.parse(isoTimestamp);
  if (!Number.isFinite(signedAt)) {
    return { ok: false, error: "That link request has no readable timestamp." };
  }
  // Both directions: a future timestamp is as suspect as a stale one.
  if (Math.abs(input.nowMs - signedAt) > LINK_MAX_AGE_MS) {
    return { ok: false, error: "That link request expired. Try again." };
  }

  const valid = await verifyMessage({
    address: input.address as `0x${string}`,
    message: input.message,
    signature: input.signature as `0x${string}`,
  }).catch(() => false);
  if (!valid) {
    return { ok: false, error: "That signature does not come from this wallet." };
  }

  return { ok: true };
}

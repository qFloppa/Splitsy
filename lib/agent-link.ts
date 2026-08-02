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

// The exact bytes the wallet signs. The address AND the full account identity are
// inside the message, so a signature captured for one account cannot be replayed
// to link the same wallet to another.
//
// The provider is in here because a handle alone does not identify an account:
// uniqueness in `users` is (provider, provider_user_id) — see
// schema-generic-identity.sql — while handle carries only a NON-unique
// provider-scoped index. So @ada on x and @ada on discord are different people,
// and without the provider a victim could be phished into signing a message
// naming their own handle and their own address, which the holder of the same
// handle in another namespace could then replay to link the victim's wallet to
// THEIR account.
//
// Both are lowercased: every handle lookup in this schema is case-insensitive by
// construction (lower(handle), lower(debtor_handle)), so `users.handle` may still
// carry a provider's display casing. Signing the raw casing would make the link
// fail for anyone whose client did not reproduce it exactly.
export function buildLinkMessage(
  address: string,
  handle: string,
  provider: string,
  isoTimestamp: string,
): string {
  return `Splitsy: link ${address.toLowerCase()} to @${handle.toLowerCase()} on ${provider.toLowerCase()} for autopay\n${isoTimestamp}`;
}

export async function verifyLinkSignature(input: {
  address: string;
  handle: string;
  provider: string;
  message: string;
  signature: string;
  nowMs: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  return verifyFreshSignature({
    address: input.address,
    message: input.message,
    signature: input.signature,
    nowMs: input.nowMs,
    // Re-derive the message from what the SESSION says rather than trusting the
    // body's copy. Otherwise a valid signature over some other text would pass.
    rebuild: (iso) => buildLinkMessage(input.address, input.handle, input.provider, iso),
    mismatch: "That signature was not for this account and wallet.",
    noun: "link request",
  });
}

// The bytes a wallet signs to sign IN, as opposed to linking. Deliberately a
// different sentence: the two are read by different routes with different
// consequences — one widens an existing account's reach, the other mints an
// account and a session — so a signature captured for either must be inert at
// the other. Rebuilt server-side from the address in the body, so the only thing
// the client controls is the timestamp.
export function buildSigninMessage(address: string, isoTimestamp: string): string {
  return `Splitsy: sign in as ${address.toLowerCase()}\n${isoTimestamp}`;
}

export async function verifySigninSignature(input: {
  address: string;
  message: string;
  signature: string;
  nowMs: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  return verifyFreshSignature({
    address: input.address,
    message: input.message,
    signature: input.signature,
    nowMs: input.nowMs,
    rebuild: (iso) => buildSigninMessage(input.address, iso),
    mismatch: "That signature was not a Splitsy sign-in for this wallet.",
    noun: "sign-in request",
  });
}

// Fired on `window` once a wallet session has been dropped and the server has
// confirmed the cookie is gone. Panels that read the session when they mount —
// the Agents tab holds the account's caps, decision log and agent balance —
// listen for it and re-read, which is what a page reload used to do. A reload
// also threw away which tab the user was on, so this is both cheaper and less
// destructive. Shared from here so the two sides cannot drift on the string.
export const SESSION_ENDED_EVENT = "splitsy:session-ended";

// Does this session still describe the wallet the browser is holding?
//
// A wallet session's handle IS the address that signed for it, so it outlives
// its own truth in two ways: the user picks a different account in Rabby (the
// session now names someone else — a different users row, a different agent, a
// different balance), or disconnects entirely (there is no longer a key backing
// the identity, and disconnecting is the only sign-out a wallet account has,
// since it deliberately owns no chip in the header). Both drop the session in
// app/SignInMenu.tsx.
//
// `connected` is passed rather than inferred from a missing address because the
// two are NOT the same: wagmi's store initialises to disconnected with no
// address and only flips to 'reconnecting' once reconnect() runs from a mount
// effect, so "no address" during that window means "not known yet", not "signed
// out". Callers pass connected: false only for wagmi's real connected →
// disconnected transition.
//
// A session from any other provider is never stale here — a social account's
// browser wallet is a linked wallet, not its identity. Casing never matters:
// wagmi hands out checksummed addresses, the DB stores lowercase.
export function isStaleWalletSession(
  session: { provider?: string | null; handle: string } | null | undefined,
  wallet: { connected: boolean; address?: string | null },
): boolean {
  if (session?.provider !== "wallet") return false;
  if (!wallet.connected) return true;
  if (!wallet.address) return false;
  return wallet.address.toLowerCase() !== session.handle.toLowerCase();
}

// The shared tail of both checks: the message must be EXACTLY what we rebuild,
// recent in both directions, and signed by the address it names.
//
// ponytail: the timestamp window is the whole replay defence — there is no
// server-issued nonce, so a signature captured in flight is reusable until it
// ages out. Bounded at 5 minutes and the transport is TLS. Add a nonce table if
// sign-in ever leaves the browser->server hop.
async function verifyFreshSignature(input: {
  address: string;
  message: string;
  signature: string;
  nowMs: number;
  rebuild: (isoTimestamp: string) => string;
  mismatch: string;
  noun: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const lines = input.message.split("\n");
  const isoTimestamp = lines[1] ?? "";
  if (input.rebuild(isoTimestamp) !== input.message) {
    return { ok: false, error: input.mismatch };
  }

  const signedAt = Date.parse(isoTimestamp);
  if (!Number.isFinite(signedAt)) {
    return { ok: false, error: `That ${input.noun} has no readable timestamp.` };
  }
  // Both directions: a future timestamp is as suspect as a stale one.
  if (Math.abs(input.nowMs - signedAt) > LINK_MAX_AGE_MS) {
    return { ok: false, error: `That ${input.noun} expired. Try again.` };
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

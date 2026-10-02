// "Which handles may this login collect money under?" — one answer, used by the
// login tail and by every slot lookup.
//
// THE ANSWER IS NOT "their current handle", and that is the whole point. A rename
// leaves money filed under the old string: escrow deposits under
// keccak256("x:alice") (lib/handle-escrow.ts) and, worse, a slot address that is
// that hash truncated and is named by a bill on chain, permanently
// (lib/handle-slot.ts). So the list is every handle this account has ever claimed.
//
// AND IT IS NOT "every handle they can log in with" either. X and Discord free an
// abandoned handle for re-registration, so "I can authenticate as @alice today"
// does not mean "the @alice money was meant for me". The claim table
// (schema-handle-claims.sql) is what separates the two: first login under a
// handle owns it for good, so the new holder of a recycled handle gets an account
// and an empty list. That matters most on the slot path, where
// {BillSplitRegistry.bind} is write-once and a wrong binding is unfixable by
// anyone, including the real owner.
//
// Pure and framework-free (no "use client", no next/*, no @/ aliases) so it stays
// importable by `node --test` — the repo call is reached lazily through the deps
// object below. Same rule and same reason as lib/escrow-release.ts.
import { normalizeHandle } from "./iou.ts";

// Injection seam, same pattern as ReleaseDeps in lib/escrow-release.ts: the two
// database calls are stubbed so the decision — whose handle is whose — can be
// tested with no Supabase.
export type ClaimDeps = {
  claim: (provider: string, handle: string, userId: string) => Promise<void>;
  listForUser: (userId: string) => Promise<string[]>;
};

const realDeps: ClaimDeps = {
  // Lazy import: handle-claims-repo.ts reaches for the Supabase client, and this
  // module has to load under `node --test` without one.
  claim: async (provider, handle, userId) => {
    const { claimHandle } = await import("./handle-claims-repo.ts");
    return claimHandle(provider, handle, userId);
  },
  listForUser: async (userId) => {
    const { handlesForUser } = await import("./handle-claims-repo.ts");
    return handlesForUser(userId);
  },
};

/**
 * Stake this login's claim to its current handle, then answer every handle this
 * account owns — current one first.
 *
 * Called at login, which is the only moment the handle is proven: an OAuth round
 * trip or a verified Privy token has just said this person controls it. The claim
 * write is therefore the strongest statement we will ever be able to make about
 * this handle, and it is made once.
 *
 * THE CURRENT HANDLE IS NOT APPENDED WHEN IT IS MISSING FROM THE LIST, and that
 * omission is the guard rather than an oversight. Missing means another account
 * claimed it first — a handle that was renamed away from and re-registered by
 * somebody else — so this login collects nothing under it. Nothing is taken from
 * them either: they keep the account, and the escrow they cannot see goes back to
 * its sender when the sweep runs.
 *
 * THROWS. The caller is a login and treats a failure as "release nothing this
 * pass", which is the safe direction: the money stays where it is and the next
 * sign-in retries. An empty list returned on error would look exactly like a
 * squatter being correctly refused, so the two must not be the same value.
 */
export async function claimAndListHandles(
  userId: string,
  provider: string,
  handle: string,
  deps: ClaimDeps = realDeps,
): Promise<string[]> {
  await deps.claim(provider, handle, userId);

  const owned = await deps.listForUser(userId);
  const current = normalizeHandle(handle);

  // Current first, which for everyone who never renamed is the only entry. The
  // order only decides which chain read happens first, but on a login that is
  // one round trip per handle and the common case should pay for one.
  return owned.includes(current) ? [current, ...owned.filter((h) => h !== current)] : owned;
}

import type { IdentityProvider } from "./types";
import { getPendingWallet, normalizePendingHandle } from "./pending-wallets-repo.ts";
import { slotForHandle } from "./handle-slot.ts";

export type ResolvedParticipant = { provider: IdentityProvider; handle: string; address: string };

// Injection seam so unit tests can stub the side-effecting dependencies.
export type ResolveDeps = {
  getUserByProviderHandle: (p: IdentityProvider, h: string) => Promise<{ wallet_address: string | null } | null>;
  getPendingWallet: (p: IdentityProvider, h: string) => Promise<{ wallet_address: string } | null>;
};

const realDeps: ResolveDeps = {
  // Lazy import: users-repo.ts uses "@/lib/..." aliases internally, which only
  // resolve under Next's bundler — not under node --test. Deferring the import
  // to call time lets tests load this module with injected deps.
  getUserByProviderHandle: async (p, h) => {
    const { getUserByProviderHandle } = await import("./users-repo.ts");
    return getUserByProviderHandle(p, h);
  },
  getPendingWallet,
};

// user wallet → pending wallet → a slot derived from the handle. Idempotent per
// handle: two tags of the same @alice on two bills resolve to the same address.
//
// THE LAST STEP USED TO MINT A WALLET. It called getOrCreateWallet("prem", …),
// which pre-minted a custodial address under Splitsy's key quorum and filed the
// debt there. That was the compromise this design removes: the tagged person was
// told they owed money at an address Splitsy held the key to and they did not,
// and unwinding a failed bill out of it took three transactions and leaked gas.
//
// A derived slot is a pure function of the handle — no key exists anywhere, so
// there is nothing to hold. The one operation that genuinely needed a key
// (refunding a failed bill) is now an attester-signed relay in the registry
// itself: {BillSplitRegistry.refundSlot}. See lib/handle-slot.ts for why the
// derivation must match the contract's.
export async function resolveParticipantAddress(
  provider: IdentityProvider,
  handle: string,
  deps: ResolveDeps = realDeps,
): Promise<string> {
  const user = await deps.getUserByProviderHandle(provider, handle);
  if (user?.wallet_address) return user.wallet_address;

  const pending = await deps.getPendingWallet(provider, handle);
  if (pending?.wallet_address) return pending.wallet_address;

  return slotForHandle(provider, handle);
}

/**
 * The same walk as {@link resolveParticipantAddress}, stopping at "there is
 * nobody here" instead of minting.
 *
 * ADDITIVE ON PURPOSE. resolveParticipants is shared by the bill and recurring
 * routes, which need an address for every participant at createBill time; changing
 * its answer would break them. The settle rail is the one that MOVES money, so it
 * asks this instead and escrows when the answer is null.
 *
 * WHY A SLOT IS NOT AN ANSWER HERE.
 *
 * A slot is DERIVED from a handle, so nobody holds a key to it and nobody ever
 * will — USDC sent there is money nobody can move, stuck for good. HandleEscrow
 * holds the same money with no such trust, releases it on the attester's signature
 * at login, and lets the SENDER take it back with {reclaim} if the recipient never
 * turns up. Strictly better on every axis, and already deployed — so the rail that
 * moves money uses it.
 *
 * This was already the answer for a different reason (pre-minted slots were
 * custodial, so the recipient was trusting Splitsy to forward); the derivation
 * makes the same refusal for a stronger one.
 *
 * A BILL IS DIFFERENT, which is why resolveParticipantAddress still answers with a
 * slot. Creating a bill sends nothing anywhere: it records who owes what, and the
 * slot is the name that debt is filed under until its owner signs in. Nobody is
 * trusting Splitsy with a balance, because there is no balance.
 *
 * Gated on the STACK because on Circle a pending wallet is not merely signable, it
 * is adopted: finishProviderLogin makes it the user's own wallet at login
 * (lib/oauth-callback.ts), so it really is their address and escrowing to a handle
 * they can already be paid at would be the wrong answer there.
 */
export async function lookupParticipantAddress(
  provider: IdentityProvider,
  handle: string,
  deps: ResolveDeps = realDeps,
): Promise<string | null> {
  const user = await deps.getUserByProviderHandle(provider, handle);
  if (user?.wallet_address) return user.wallet_address;

  // Lazy import for the same reason realDeps' is: keeps the wallet backend's SDK
  // out of this module's load-time graph so node --test can import it.
  const { walletUiName } = await import("./wallet-provider.ts");
  if (walletUiName() === "privy") return null;

  const pending = await deps.getPendingWallet(provider, handle);
  return pending?.wallet_address ?? null;
}

export async function resolveParticipants(
  rows: { provider: IdentityProvider; handle: string }[],
  deps: ResolveDeps = realDeps,
): Promise<ResolvedParticipant[]> {
  const out: ResolvedParticipant[] = [];
  for (const row of rows) {
    // Sequential, not Promise.all: two rows tagging the same handle must not race
    // to mint two wallets. Bills have few participants, so this is cheap.
    const address = await resolveParticipantAddress(row.provider, row.handle, deps);
    out.push({ provider: row.provider, handle: normalizePendingHandle(row.handle), address });
  }
  return out;
}

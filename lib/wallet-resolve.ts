import type { IdentityProvider } from "./types";
import {
  getPendingWallet,
  insertPendingWallet,
  normalizePendingHandle,
} from "./pending-wallets-repo.ts";

export type ResolvedParticipant = { provider: IdentityProvider; handle: string; address: string };

// Injection seam so unit tests can stub the three side-effecting dependencies.
export type ResolveDeps = {
  getUserByProviderHandle: (p: IdentityProvider, h: string) => Promise<{ wallet_address: string | null } | null>;
  getPendingWallet: (p: IdentityProvider, h: string) => Promise<{ wallet_address: string } | null>;
  // Pre-mint a DCW for this handle, persist it to pending_wallets, return its address.
  mintPending: (p: IdentityProvider, h: string) => Promise<string>;
};

async function defaultMintPending(provider: IdentityProvider, handle: string): Promise<string> {
  // Lazy import: keeps the wallet backend's SDK out of this module's load-time
  // graph so unit tests (node --test) can import wallet-resolve.ts with stub deps.
  const { getOrCreateWallet, walletProviderLabel } = await import("./wallet-provider.ts");
  const norm = normalizePendingHandle(handle);

  // ONE PATH FOR BOTH STACKS, and the Privy branch that used to be here is why.
  //
  // It called pregenerateWallet, which minted the slot as a `custom_auth` Privy
  // user with NO OWNER QUORUM AND NO ADDITIONAL SIGNER. That made the address
  // unreachable by everyone at once: the tagged person never gets it (a later
  // login is a different Privy user and the SDK has no link method) and the server
  // gets 401 on every signing path. A bill against it recorded a debt its debtor
  // could not see and nobody could unwind — measured on bill 64, 2026-09-15.
  //
  // getOrCreateWallet mints under Splitsy's key quorum (see walletSpec in
  // lib/privy-wallet.ts), so the server CAN sign for a slot. That is what lets
  // app/api/onchain-bills/[billId]/refund relay a failed escrow back to the
  // person's real wallet, which is the one thing a slot address genuinely has to
  // be able to do.
  //
  // WHAT THAT CONCEDES, SAID PLAINLY: a slot is a wallet Splitsy holds a key to,
  // which the rest of this stack deliberately avoids. It is a bookkeeping address
  // and not a user's wallet — bills send nothing to it, payments go to the
  // registry via payDebtFor, and the person spends from their own wallet. The only
  // money that ever rests here is a refund from a failed all-or-nothing bill,
  // in transit, which the server forwards. The settle rail does NOT come here for
  // exactly this reason: money it sends is trustless in HandleEscrow instead.
  //
  // Namespaced refId so a slot can never collide with a real signin wallet
  // ("<provider>:<providerUserId>"). Keyed by handle, not user id.
  const wallet = await getOrCreateWallet("prem", `${provider}:${norm}`);
  if (!wallet) throw new Error(`${walletProviderLabel()} is not configured — cannot pre-mint a wallet`);
  await insertPendingWallet({
    provider,
    handle: norm,
    wallet_address: wallet.address,
    // The column name is legacy from the Circle era; on the Privy stack it holds
    // the Privy wallet id, exactly as users.circle_wallet_id does. It is what the
    // refund relay signs with.
    circle_wallet_id: wallet.walletId,
  });
  return wallet.address;
}

const realDeps: ResolveDeps = {
  // Lazy import: users-repo.ts uses "@/lib/..." aliases internally, which only
  // resolve under Next's bundler — not under node --test. Deferring the import
  // to call time lets tests load this module with injected deps.
  getUserByProviderHandle: async (p, h) => {
    const { getUserByProviderHandle } = await import("./users-repo.ts");
    return getUserByProviderHandle(p, h);
  },
  getPendingWallet,
  mintPending: defaultMintPending,
};

// user wallet → pending wallet → freshly minted DCW. Idempotent per handle:
// two tags of the same @alice on two bills resolve to the same address.
export async function resolveParticipantAddress(
  provider: IdentityProvider,
  handle: string,
  deps: ResolveDeps = realDeps,
): Promise<string> {
  const user = await deps.getUserByProviderHandle(provider, handle);
  if (user?.wallet_address) return user.wallet_address;

  const pending = await deps.getPendingWallet(provider, handle);
  if (pending?.wallet_address) return pending.wallet_address;

  return deps.mintPending(provider, handle);
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
 * WHY A SLOT IS NOT AN ANSWER HERE, even though the server can now sign for one.
 *
 * It is not that the address is unreachable — that was true of the old
 * `custom_auth` pre-mints and is no longer true of anything this mints. It is that
 * a slot is CUSTODIAL: Splitsy holds its key, so USDC sent there is money the
 * recipient is trusting us to forward. HandleEscrow holds the same money with no
 * such trust, releases it on the attester's signature at login, and lets the SENDER
 * take it back with {reclaim} if the recipient never turns up. Strictly better on
 * every axis, and already deployed — so the rail that moves money uses it.
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

  // Lazy import for the same reason defaultMintPending's is: keeps the wallet
  // backend's SDK out of this module's load-time graph so node --test can import it.
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

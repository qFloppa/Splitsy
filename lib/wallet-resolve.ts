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
  // Lazy import: keeps the Circle SDK out of this module's load-time graph so
  // unit tests (node --test) can import wallet-resolve.ts with stub deps.
  const { getOrCreateArcWallet } = await import("./circle-dcw.ts");
  const norm = normalizePendingHandle(handle);
  // Namespaced refId so a pre-mint can never collide with a real signin wallet
  // ("<provider>:<providerUserId>"). Keyed by handle, not user id.
  const wallet = await getOrCreateArcWallet("prem", `${provider}:${norm}`);
  if (!wallet) throw new Error("Circle is not configured — cannot pre-mint a wallet");
  await insertPendingWallet({
    provider,
    handle: norm,
    wallet_address: wallet.address,
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

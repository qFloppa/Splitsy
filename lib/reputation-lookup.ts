import type { IdentityProvider } from "./types.ts";
import { getUserByProviderHandle } from "./users-repo.ts";
import { getPendingWallet } from "./pending-wallets-repo.ts";
import { getReputationSummary } from "./reputation-repo.ts";

const isProvider = (v: string | null): v is IdentityProvider =>
  v === "x" || v === "discord" || v === "email";
const looksLikeAddress = (v: string) => /^0x[a-fA-F0-9]{40}$/.test(v);

// Aggregate ERC-8004 payment reputation for a wallet or a tagged handle, from
// `?address=` or `?provider=&handle=`.
//
// Resolving a handle here must never mint a wallet (that only happens when a
// bill is actually created), so this walks users → pending_wallets and stops.
// Returns only the aggregate — not the wallet address — so it isn't a
// handle→address oracle.
//
// status "none" covers both "person unknown" and "wallet known, no payments":
// under the consent policy those are deliberately the same neutral answer.
//
// Lives here rather than in the route because it is served twice: sold to agents
// at /api/reputation, and read straight by the bill composer's badge at
// /api/reputation/lookup. One function, so the price is the only difference.
export async function reputationResponse(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const address = url.searchParams.get("address");
  const provider = url.searchParams.get("provider");
  const handle = url.searchParams.get("handle");

  let wallet: string | null = null;
  if (address) {
    if (!looksLikeAddress(address)) return Response.json({ error: "bad address" }, { status: 400 });
    wallet = address;
  } else if (handle && isProvider(provider)) {
    const user = await getUserByProviderHandle(provider, handle);
    wallet = user?.wallet_address ?? (await getPendingWallet(provider, handle))?.wallet_address ?? null;
  } else {
    return Response.json({ error: "pass ?address= or ?provider=&handle=" }, { status: 400 });
  }

  if (!wallet) return Response.json({ status: "none" });

  const summary = await getReputationSummary(wallet);
  if (summary.count === 0) return Response.json({ status: "none" });
  return Response.json({
    status: "scored",
    count: summary.count,
    avgScore: summary.avgScore,
    lateCount: summary.lateCount,
    lastPaidAt: summary.lastPaidAt,
  });
}

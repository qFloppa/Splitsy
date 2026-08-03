// Links a browser wallet (EOA) to this account for autopay, and unlinks it.
//
// Why this exists: app/api/agents/autopay/route.ts resolves a bill participant
// to a Splitsy account so it can load that person's off-chain rules and write
// their decision log. That lookup matches on users.wallet_address, which only
// Circle DCW provisioning populates — so a browser wallet was never seen at all,
// not even skipped with a reason. This is the missing edge.
//
// The signature is mandatory: the link decides whose rules bind a wallet and who
// can read its decision log, so a claimed address would be a way to attach your
// own score floor to someone else's money and watch what it does.
//
// Deliberately NOT behind the wallet-unlock cookie, for the same reason the
// settings panel isn't: UNLINKING must never be harder than linking.
import { getSessionUser } from "@/lib/session";
import { setGrantDebtorAddress } from "@/lib/agents-repo";
import { verifyLinkSignature } from "@/lib/agent-link";
import { getUsdcBalanceOnchain } from "@/lib/arc-read";
import { agentToAdopt } from "@/lib/user-agent";
import { getUserByProviderHandle, setUserAgentWallet } from "@/lib/users-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });

  const body = (await request.json().catch(() => null)) as {
    address?: unknown;
    message?: unknown;
    signature?: unknown;
  } | null;
  if (!body) return Response.json({ error: "Expected a JSON body." }, { status: 400 });

  const address = String(body.address ?? "").toLowerCase();
  const message = String(body.message ?? "");
  const signature = String(body.signature ?? "");
  if (!/^0x[a-f0-9]{40}$/.test(address)) {
    return Response.json({ error: "Expected a 0x wallet address." }, { status: 400 });
  }

  // handle AND provider both come from the session, never the body: a handle is
  // only unique within its provider namespace, so the pair is the account.
  const verdict = await verifyLinkSignature({
    address,
    handle: user.handle,
    provider: user.provider,
    message,
    signature,
    nowMs: Date.now(),
  });
  if (!verdict.ok) return Response.json({ error: verdict.error }, { status: 400 });

  // This wallet may already be an ACCOUNT of its own — /api/auth/wallet mints
  // one from a signature — in which case the two accounts here are one person's
  // two login slots, not rivals, and the unique index below would 409 them out of
  // linking their own wallet. Fold that account in rather than refusing it: the
  // signature just verified is the same credential the account itself is built
  // on, so whoever can link is exactly whoever could sign into it.
  const own = await getUserByProviderHandle("wallet", address).catch(() => null);
  const merging = own && own.id !== user.id ? own : null;
  // Free the index BEFORE claiming the address, and only in that order: the two
  // writes are not atomic, and a failure between them must leave the wallet
  // linked to NEITHER account rather than to the wrong one. Nothing is lost by
  // that — the next sign-in with this wallet re-links it, since no one holds it.
  if (merging) await setGrantDebtorAddress(merging.id, null);

  try {
    await setGrantDebtorAddress(user.id, address);
  } catch (err) {
    // The partial unique index on debtor_address is what produces this, and it
    // is worth its own sentence: two accounts claiming one wallet would make the
    // debtor -> user lookup ambiguous, so the second one is refused.
    const errText = err instanceof Error ? err.message : "";
    if (errText.includes("autopay_grants_debtor_idx") || errText.includes("23505")) {
      return Response.json(
        { error: "That wallet is already linked to another Splitsy account." },
        { status: 409 },
      );
    }
    throw err;
  }

  // One account now, so one agent. The merged-in account's agent wins where it
  // can (see agentToAdopt) — it is the one that has been funded — and the loser
  // is simply forgotten: its balance is the reason this is not unconditional.
  //
  // Adopted AFTER the link write, so a failed link cannot leave two accounts
  // pointing at one agent wallet.
  let adoptedAgent: string | null = null;
  if (merging) {
    const keep = agentToAdopt(
      {
        address: user.agent_wallet_address,
        balance: user.agent_wallet_address
          ? // 1n on failure: an unreadable balance must not read as empty, or an
            // RPC blip is enough to strand whatever this agent holds.
            await getUsdcBalanceOnchain(user.agent_wallet_address as `0x${string}`).catch(() => 1n)
          : 0n,
      },
      { address: merging.agent_wallet_address, walletId: merging.agent_wallet_id },
    );
    if (keep) {
      // Never fail the link over the adoption: the link is the permission the
      // user asked for, and an un-adopted agent is still visible and fundable.
      // ponytail: the donor row keeps pointing at the same agent wallet, so an
      // unlink later leaves both accounts on it — clear it here if that bites.
      try {
        await setUserAgentWallet(user.id, keep.address, keep.walletId);
        adoptedAgent = keep.address;
      } catch (err) {
        console.error("agents/link: could not adopt the merged agent:", err);
      }
    }
  }

  return Response.json({ ok: true, address, adoptedAgent });
}

export async function DELETE() {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });

  await setGrantDebtorAddress(user.id, null);
  return Response.json({ ok: true });
}

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
import { getAutopayGrant, setGrantDebtorAddress } from "@/lib/agents-repo";
import { verifyLinkSignature } from "@/lib/agent-link";
import { agentToAdopt, wasAgentAdoptedFrom } from "@/lib/user-agent";
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

  // One account now, so one agent, and it is the LINKED WALLET's (see
  // agentToAdopt) — that is the wallet the user just named. The loser is simply
  // forgotten until an unlink hands it back.
  //
  // Adopted AFTER the link write, so a failed link cannot leave two accounts
  // pointing at one agent wallet.
  let adoptedAgent: string | null = null;
  if (merging) {
    const keep = agentToAdopt(user.agent_wallet_address, {
      address: merging.agent_wallet_address,
      walletId: merging.agent_wallet_id,
    });
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

  // Read the link BEFORE dropping it: giving the agent back needs to know which
  // wallet is being unlinked, and nothing else records it.
  const grant = await getAutopayGrant(user.id).catch(() => null);
  const linked = grant?.debtorAddress ?? null;
  await setGrantDebtorAddress(user.id, null);

  // Hand the agent BACK when this account only has it because the link merged two
  // accounts. Unlinking must be the exact inverse of linking or it is not an
  // unlink: the wallet's own account would stay signed out of the agent it
  // funded, while this one kept spending it.
  //
  // Detected rather than recorded, because no column had to be added: the donor
  // row still names the agent it donated, so an address match IS the adoption.
  // Clearing our two columns is the whole handover — getOrCreateUserAgent
  // re-derives this account's own agent from its unchanged refId on the next
  // read, which is the agent it had before the merge, balance and all.
  let returnedAgent: string | null = null;
  if (linked && user.agent_wallet_address) {
    const donor = await getUserByProviderHandle("wallet", linked).catch(() => null);
    const adopted = wasAgentAdoptedFrom(
      { id: user.id, agentAddress: user.agent_wallet_address },
      donor && { id: donor.id, agentAddress: donor.agent_wallet_address },
    );
    if (adopted) {
      // Never fail the unlink over this: the permission is already withdrawn,
      // which is the part the user asked for and the part that matters.
      try {
        await setUserAgentWallet(user.id, null, null);
        returnedAgent = user.agent_wallet_address;
      } catch (err) {
        console.error("agents/link: could not hand the merged agent back:", err);
      }
    }
  }

  return Response.json({ ok: true, returnedAgent });
}

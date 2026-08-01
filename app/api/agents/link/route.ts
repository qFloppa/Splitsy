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

  return Response.json({ ok: true, address });
}

export async function DELETE() {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });

  await setGrantDebtorAddress(user.id, null);
  return Response.json({ ok: true });
}

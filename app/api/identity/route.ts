import { getSessionUser } from "@/lib/session";
import { getUsersByWallets } from "@/lib/users-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

// GET /api/identity?addresses=0x…,0x… — wallet addresses → the social identity
// that owns each, for display surfaces that read the chain directly (the settle
// deck's registry debts know only addresses, so its "collected by" row was hex
// even when the collector had signed in).
//
// SESSION-GATED, like /api/bills: a signed-out wallet-only user keeps seeing
// addresses — which is what they see today, so no regression — rather than this
// becoming a public address→handle directory. The same mapping already reaches
// the public pay page, but only for the participants of a bill whose share token
// you hold; this endpoint answers for arbitrary addresses, so it needs the gate.
//
// WHAT IT RETURNS is display-only: handle, provider, avatar. No provider ids, no
// wallet the user hasn't already been given by other routes — getUsersByWallets
// selects exactly those three columns.
export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return Response.json({ error: "Not signed in" }, { status: 401 });
  }

  const url = new URL(request.url);
  const addresses = (url.searchParams.get("addresses") ?? "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter((a) => ADDR_RE.test(a));

  const people: Record<string, { handle: string; provider: string; avatarUrl: string | null }> = {};
  for (const [addr, person] of await getUsersByWallets(addresses)) {
    people[addr] = { handle: person.handle, provider: person.provider, avatarUrl: person.avatarUrl };
  }
  return Response.json({ people });
}

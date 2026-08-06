import { resolveParticipants } from "@/lib/wallet-resolve";
// Per-provider handle validity, shared with the /owe composer so the client that
// submits and the route that accepts can't drift. Still mirrored inline in
// HomeClient's HandleField.
import { validHandle } from "@/lib/iou";
import type { IdentityProvider } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVIDERS: IdentityProvider[] = ["x", "discord", "email"];
const MAX_PARTICIPANTS = 20;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    participants?: { provider?: unknown; handle?: unknown }[];
  } | null;
  const rows = body?.participants;
  if (!Array.isArray(rows) || rows.length === 0) {
    return Response.json({ error: "participants required" }, { status: 400 });
  }
  if (rows.length > MAX_PARTICIPANTS) {
    return Response.json({ error: "too many participants" }, { status: 400 });
  }
  const clean: { provider: IdentityProvider; handle: string }[] = [];
  for (const r of rows) {
    if (typeof r?.provider !== "string" || !PROVIDERS.includes(r.provider as IdentityProvider)) {
      return Response.json({ error: "invalid provider" }, { status: 400 });
    }
    if (typeof r?.handle !== "string" || !validHandle(r.provider as IdentityProvider, r.handle)) {
      return Response.json({ error: `invalid handle for ${r.provider}` }, { status: 400 });
    }
    clean.push({ provider: r.provider as IdentityProvider, handle: r.handle });
  }

  try {
    const resolved = await resolveParticipants(clean);
    return Response.json({ resolved });
  } catch (err) {
    const message = err instanceof Error ? err.message : "resolve failed";
    const status = /not configured/i.test(message) ? 503 : 500;
    return Response.json({ error: message }, { status });
  }
}

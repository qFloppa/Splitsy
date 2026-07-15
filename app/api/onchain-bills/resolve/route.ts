import { resolveParticipants } from "@/lib/wallet-resolve";
import type { IdentityProvider } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVIDERS: IdentityProvider[] = ["x", "discord", "email"];
const MAX_PARTICIPANTS = 20;

// Per-provider handle validity — same rules as HomeClient's HandleField.
function validHandle(provider: IdentityProvider, handle: string): boolean {
  const h = handle.replace(/^@/, "").trim();
  if (provider === "x") return /^[a-zA-Z0-9_]{1,15}$/.test(h);
  if (provider === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(h);
  if (provider === "discord") return /^[a-z0-9._]{2,32}$/.test(h.toLowerCase());
  return false;
}

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

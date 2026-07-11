import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return Response.json({ user: null });
  }
  return Response.json({
    user: {
      id: user.id,
      provider: user.provider,
      handle: user.handle,
      name: user.name,
      avatarUrl: user.avatar_url,
      walletAddress: user.wallet_address,
    },
  });
}

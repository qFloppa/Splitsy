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
      handle: user.x_handle,
      name: user.x_name,
      avatarUrl: user.x_avatar_url,
      walletAddress: user.wallet_address,
    },
  });
}

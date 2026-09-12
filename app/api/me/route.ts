import { getSessionUser } from "@/lib/session";
import { walletProviderLabel, walletUiName } from "@/lib/wallet-provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  // OUTSIDE `user`, because the sign-in menu needs it while signed OUT: it decides
  // whether the header opens Privy's modal or the four OAuth links. One server
  // value read by every panel, rather than a NEXT_PUBLIC copy that can disagree
  // with the one the routes enforce.
  const walletUi = walletUiName();
  if (!user) {
    return Response.json({ user: null, walletUi });
  }
  return Response.json({
    walletUi,
    user: {
      id: user.id,
      provider: user.provider,
      // NOT decoration and not a secret: it is the user's own public id at their
      // provider. The wallet setup ceremony salts the keys that will OWN the wallet
      // with (provider, providerUserId) — it cannot use the address, which does not
      // exist until those keys do — so the browser needs both halves before it
      // makes a key. See lib/export-crypto.ts:accountSalt.
      providerUserId: user.provider_user_id,
      handle: user.handle,
      name: user.name,
      avatarUrl: user.avatar_url,
      walletAddress: user.wallet_address,
      // Which custodian actually holds this wallet's keys. The panel says so out
      // loud (spec §5) and the two stacks have different answers, so it cannot be
      // a hard-coded string in the component.
      custodian: walletProviderLabel(),
    },
  });
}

import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser, SESSION_COOKIE_NAME, WALLET_PROOF_COOKIE } from "@/lib/session";
import { WALLET_UNLOCK_COOKIE } from "@/lib/session-core";
import { revokeUserSessions } from "@/lib/users-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  // Read BEFORE the cookies are cleared, because revoking needs to know whose
  // sessions to retire. Best-effort: a sign-out must still clear this browser
  // even when the database cannot be reached, so a failure here logs and
  // continues rather than leaving the user apparently signed in.
  const user = await getSessionUser().catch(() => null);

  const response = NextResponse.redirect(new URL("/app", request.nextUrl.origin), 303);
  response.cookies.set(SESSION_COOKIE_NAME, "", { path: "/", maxAge: 0 });
  // The second identity goes with the first. It is tied to a WALLET rather than
  // to the session that was holding it, so leaving it behind would hand the next
  // person to sign in on this browser the previous one's agent, balance and
  // decision log — for as long as that wallet stayed connected.
  response.cookies.set(WALLET_PROOF_COOKIE, "", { path: "/", maxAge: 0 });
  // AND THE ONE THAT SPENDS. This was the cookie left behind: the unlock is what
  // authorizes /api/wallet/send, the bill claim and refund legs and the key
  // export, and it outlived the sign-out by up to five minutes. It is bound to a
  // user id, so it was never usable by whoever signed in next — but someone
  // returning to an abandoned browser could re-establish that same session and
  // find the wallet still unlocked, which is exactly what the PIN exists to stop.
  response.cookies.set(WALLET_UNLOCK_COOKIE, "", { path: "/", maxAge: 0 });

  // CLEARING THE COOKIE IS NOT REVOCATION. The token is signed and stateless, so
  // a copy taken before this request — a browser backup, a shared machine, a
  // proxy log — still verifies. Bumping sessions_valid_from is what actually ends
  // it, and it ends every one of this account's sessions rather than only the
  // browser that asked.
  //
  // SIGNING OUT IS THEREFORE GLOBAL HERE, deliberately: on a wallet the remedy a
  // user wants from "log out" is the strong one, and the cost is being signed out
  // on a second device. It is also the operator's kill switch for a leaked cookie
  // — see the column comment in schema-session-revocation.sql.
  if (user) {
    await revokeUserSessions(user.id).catch((err) => {
      console.error(`logout: could not revoke sessions for ${user.id} (cookies cleared anyway):`, err);
    });
  }

  return response;
}

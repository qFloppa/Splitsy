import { NextResponse, type NextRequest } from "next/server";
import {
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  getRedirectUri,
  DISCORD_OAUTH_COOKIE_MAX_AGE,
  DISCORD_OAUTH_STATE_COOKIE,
  DISCORD_OAUTH_VERIFIER_COOKIE,
} from "@/lib/discord-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/auth/discord — start the Sign in with Discord flow. Generates a PKCE
// pair and CSRF state, stashes them in short-lived httpOnly cookies, then
// redirects to Discord's authorization screen. Mirrors /api/auth/twitter.
export async function GET(request: NextRequest) {
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "Missing DISCORD_CLIENT_ID on the server. Add it to .env.local." },
      { status: 500 },
    );
  }

  const { verifier, challenge } = createPkcePair();
  const state = createState();
  const redirectUri = getRedirectUri(request.nextUrl.origin);
  const authorizeUrl = buildAuthorizeUrl({ clientId, redirectUri, state, challenge });

  const response = NextResponse.redirect(authorizeUrl);

  // `secure` must be off on http://localhost or the browser drops the cookie.
  // sameSite:"lax" still rides Discord's top-level redirect back to our callback.
  const secure = request.nextUrl.protocol === "https:";
  const cookieOptions = {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: DISCORD_OAUTH_COOKIE_MAX_AGE,
  };

  response.cookies.set(DISCORD_OAUTH_STATE_COOKIE, state, cookieOptions);
  response.cookies.set(DISCORD_OAUTH_VERIFIER_COOKIE, verifier, cookieOptions);

  return response;
}

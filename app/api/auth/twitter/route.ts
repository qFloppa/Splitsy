import { NextResponse, type NextRequest } from "next/server";
import {
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  getRedirectUri,
  OAUTH_COOKIE_MAX_AGE,
  OAUTH_STATE_COOKIE,
  OAUTH_VERIFIER_COOKIE,
} from "@/lib/twitter-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/auth/twitter — start the Sign in with X flow. Generates a PKCE pair
// and CSRF state, stashes them in short-lived httpOnly cookies, then redirects
// the browser to X's authorization screen.
export async function GET(request: NextRequest) {
  const clientId = process.env.X_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "Missing X_CLIENT_ID on the server. Add it to .env.local." },
      { status: 500 },
    );
  }

  const { verifier, challenge } = createPkcePair();
  const state = createState();
  const redirectUri = getRedirectUri(request.nextUrl.origin);
  const authorizeUrl = buildAuthorizeUrl({ clientId, redirectUri, state, challenge });

  const response = NextResponse.redirect(authorizeUrl);

  // `secure` must be off on http://localhost or the browser drops the cookie.
  // sameSite:"lax" still rides X's top-level redirect back to our callback.
  const secure = request.nextUrl.protocol === "https:";
  const cookieOptions = {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: OAUTH_COOKIE_MAX_AGE,
  };

  response.cookies.set(OAUTH_STATE_COOKIE, state, cookieOptions);
  response.cookies.set(OAUTH_VERIFIER_COOKIE, verifier, cookieOptions);

  return response;
}

import { NextResponse, type NextRequest } from "next/server";
import {
  exchangeCodeForToken,
  fetchGoogleUser,
  isEmailVerified,
  getRedirectUri,
  GOOGLE_OAUTH_STATE_COOKIE,
  GOOGLE_OAUTH_VERIFIER_COOKIE,
  GoogleApiError,
  GoogleTokenError,
  type GoogleUser,
} from "@/lib/google-oauth";
import { finishProviderLogin, clearOauthCookies, resultPage } from "@/lib/oauth-callback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/auth/google/callback — Google redirects here with ?code&state (or an
// error). Validate state, exchange the code, read the profile, require a
// verified email, then hand off to the shared finishProviderLogin under the
// merged "email" provider (keyed by the email address, not Google's sub).
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const clear = (res: NextResponse) =>
    clearOauthCookies(res, GOOGLE_OAUTH_STATE_COOKIE, GOOGLE_OAUTH_VERIFIER_COOKIE);

  const oauthError = params.get("error");
  if (oauthError) {
    return resultPage({
      ok: false,
      status: 400,
      title: "Google denied the authorization request",
      lines: [`error: ${oauthError}`, `description: ${params.get("error_description") ?? "(none)"}`],
    });
  }

  const code = params.get("code");
  const state = params.get("state");
  const storedState = request.cookies.get(GOOGLE_OAUTH_STATE_COOKIE)?.value;
  const verifier = request.cookies.get(GOOGLE_OAUTH_VERIFIER_COOKIE)?.value;

  if (!code || !state) {
    return resultPage({
      ok: false,
      status: 400,
      title: "Missing code or state",
      lines: ["The callback was reached without the expected ?code and ?state parameters."],
    });
  }

  if (!storedState || state !== storedState) {
    return resultPage({
      ok: false,
      status: 400,
      title: "State mismatch",
      lines: [
        "The state parameter did not match the stored value.",
        "This usually means the sign-in cookie expired or a different browser/tab was used.",
      ],
    });
  }

  if (!verifier) {
    return resultPage({
      ok: false,
      status: 400,
      title: "Missing PKCE verifier",
      lines: ["The sign-in cookie was not found. Start again from the sign-in button."],
    });
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return resultPage({
      ok: false,
      status: 500,
      title: "Server not configured",
      lines: ["Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET. Add both to .env.local."],
    });
  }

  const redirectUri = getRedirectUri(request.nextUrl.origin);

  try {
    const token = await exchangeCodeForToken({ code, redirectUri, verifier, clientId, clientSecret });

    const sessionSecret = process.env.SESSION_SECRET;
    if (!sessionSecret || sessionSecret.length < 32) {
      return clear(
        resultPage({
          ok: false,
          status: 500,
          title: "Server not configured",
          lines: ["SESSION_SECRET is missing or shorter than 32 chars. Add it to .env.local."],
        }),
      );
    }

    let user: GoogleUser;
    try {
      user = await fetchGoogleUser(token.access_token);
    } catch (profileCaught) {
      const detail =
        profileCaught instanceof GoogleApiError
          ? [`HTTP ${profileCaught.status}`, profileCaught.body.slice(0, 800)]
          : [profileCaught instanceof Error ? profileCaught.message : "Unexpected error during profile lookup."];
      return clear(
        resultPage({
          ok: false,
          status: 200,
          title: "Login worked — but the profile read failed",
          lines: ["GET /userinfo failed:", ...detail],
        }),
      );
    }

    // Only a verified email is a safe identity key — otherwise anyone could
    // claim someone else's address (and their debts + wallet).
    if (!user.email || !isEmailVerified(user)) {
      return clear(
        resultPage({
          ok: false,
          status: 400,
          title: "Email not verified",
          lines: ["Your Google account's email isn't verified, so we can't sign you in with it."],
        }),
      );
    }

    const email = user.email.trim().toLowerCase();
    const response = await finishProviderLogin({
      provider: "email",
      profile: {
        providerUserId: email, // key on the email, not Google's sub — merges with OTP
        handle: email,
        name: user.name ?? null,
        avatarUrl: user.picture ?? null,
      },
      request,
      sessionSecret,
    });
    return clear(response);
  } catch (caught) {
    const detail =
      caught instanceof GoogleTokenError
        ? [`HTTP ${caught.status}`, caught.body.slice(0, 600)]
        : [caught instanceof Error ? caught.message : "Unexpected error during token exchange."];
    return clear(
      resultPage({
        ok: false,
        status: 502,
        title: "Token exchange failed",
        lines: detail,
      }),
    );
  }
}

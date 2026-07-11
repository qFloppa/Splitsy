import { NextResponse, type NextRequest } from "next/server";
import {
  exchangeCodeForToken,
  fetchDiscordUser,
  discordAvatarUrl,
  getRedirectUri,
  DISCORD_OAUTH_STATE_COOKIE,
  DISCORD_OAUTH_VERIFIER_COOKIE,
  DiscordApiError,
  DiscordTokenError,
  type DiscordUser,
} from "@/lib/discord-oauth";
import { finishProviderLogin, clearOauthCookies, resultPage } from "@/lib/oauth-callback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/auth/discord/callback — Discord redirects here with ?code&state (or
// an error). Validate state, exchange the code, read the profile, then hand off
// to the shared finishProviderLogin (upsert + debts + wallet + session).
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const clear = (res: NextResponse) =>
    clearOauthCookies(res, DISCORD_OAUTH_STATE_COOKIE, DISCORD_OAUTH_VERIFIER_COOKIE);

  const oauthError = params.get("error");
  if (oauthError) {
    return resultPage({
      ok: false,
      status: 400,
      title: "Discord denied the authorization request",
      lines: [`error: ${oauthError}`, `description: ${params.get("error_description") ?? "(none)"}`],
    });
  }

  const code = params.get("code");
  const state = params.get("state");
  const storedState = request.cookies.get(DISCORD_OAUTH_STATE_COOKIE)?.value;
  const verifier = request.cookies.get(DISCORD_OAUTH_VERIFIER_COOKIE)?.value;

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

  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return resultPage({
      ok: false,
      status: 500,
      title: "Server not configured",
      lines: ["Missing DISCORD_CLIENT_ID or DISCORD_CLIENT_SECRET. Add both to .env.local."],
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

    let user: DiscordUser;
    try {
      user = await fetchDiscordUser(token.access_token);
    } catch (profileCaught) {
      const detail =
        profileCaught instanceof DiscordApiError
          ? [`HTTP ${profileCaught.status}`, profileCaught.body.slice(0, 800)]
          : [profileCaught instanceof Error ? profileCaught.message : "Unexpected error during profile lookup."];
      return clear(
        resultPage({
          ok: false,
          status: 200,
          title: "Login worked — but the profile read failed",
          lines: ["GET /users/@me failed:", ...detail],
        }),
      );
    }

    const response = await finishProviderLogin({
      provider: "discord",
      profile: {
        providerUserId: user.id,
        handle: user.username,
        name: user.global_name ?? null,
        avatarUrl: discordAvatarUrl(user),
      },
      request,
      sessionSecret,
    });
    return clear(response);
  } catch (caught) {
    const detail =
      caught instanceof DiscordTokenError
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

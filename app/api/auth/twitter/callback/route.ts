import { NextResponse, type NextRequest } from "next/server";
import {
  exchangeCodeForToken,
  fetchTwitterUser,
  getRedirectUri,
  OAUTH_STATE_COOKIE,
  OAUTH_VERIFIER_COOKIE,
  TwitterApiError,
  TwitterTokenError,
  type TwitterUser,
} from "@/lib/twitter-oauth";
import { upsertUserFromX } from "@/lib/users-repo";
import { signSession, SESSION_COOKIE_NAME, SESSION_MAX_AGE } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/auth/twitter/callback — X redirects here with ?code&state (or an
// error). We validate state, exchange the code for a token, read the profile,
// upsert the user into Supabase, and set a signed session cookie before
// redirecting into the app. Errors render a plain HTML result page.
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  const oauthError = params.get("error");
  if (oauthError) {
    return resultPage({
      ok: false,
      status: 400,
      title: "X denied the authorization request",
      lines: [`error: ${oauthError}`, `description: ${params.get("error_description") ?? "(none)"}`],
    });
  }

  const code = params.get("code");
  const state = params.get("state");
  const storedState = request.cookies.get(OAUTH_STATE_COOKIE)?.value;
  const verifier = request.cookies.get(OAUTH_VERIFIER_COOKIE)?.value;

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
      lines: ["The sign-in cookie was not found. Start again from /auth-test."],
    });
  }

  const clientId = process.env.X_CLIENT_ID;
  const clientSecret = process.env.X_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return resultPage({
      ok: false,
      status: 500,
      title: "Server not configured",
      lines: ["Missing X_CLIENT_ID or X_CLIENT_SECRET. Add both to .env.local."],
    });
  }

  const redirectUri = getRedirectUri(request.nextUrl.origin);

  try {
    const token = await exchangeCodeForToken({ code, redirectUri, verifier, clientId, clientSecret });

    const sessionSecret = process.env.SESSION_SECRET;
    if (!sessionSecret || sessionSecret.length < 32) {
      return clearOauthCookies(
        resultPage({
          ok: false,
          status: 500,
          title: "Server not configured",
          lines: ["SESSION_SECRET is missing or shorter than 32 chars. Add it to .env.local."],
        }),
      );
    }

    let user: TwitterUser;
    try {
      user = await fetchTwitterUser(token.access_token);
    } catch (profileCaught) {
      const detail =
        profileCaught instanceof TwitterApiError
          ? [`HTTP ${profileCaught.status}`, profileCaught.body.slice(0, 800)]
          : [profileCaught instanceof Error ? profileCaught.message : "Unexpected error during profile lookup."];
      return clearOauthCookies(
        resultPage({
          ok: false,
          status: 200,
          title: "Login worked — but the profile read was blocked",
          lines: ["GET /2/users/me failed:", ...detail],
        }),
      );
    }

    let appUserId: string;
    try {
      const appUser = await upsertUserFromX({
        xUserId: user.id,
        handle: user.username,
        name: user.name ?? null,
        avatarUrl: user.profile_image_url ?? null,
        email: user.confirmed_email ?? null,
      });
      appUserId = appUser.id;
    } catch (dbCaught) {
      return clearOauthCookies(
        resultPage({
          ok: false,
          status: 500,
          title: "Could not save your account",
          lines: [dbCaught instanceof Error ? dbCaught.message : "Unexpected database error."],
        }),
      );
    }

    const response = NextResponse.redirect(new URL("/", request.nextUrl.origin));
    response.cookies.set(SESSION_COOKIE_NAME, signSession(appUserId, sessionSecret), {
      httpOnly: true,
      secure: request.nextUrl.protocol === "https:",
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE,
    });
    return clearOauthCookies(response);
  } catch (caught) {
    const detail =
      caught instanceof TwitterTokenError
        ? [`HTTP ${caught.status}`, caught.body.slice(0, 600)]
        : [caught instanceof Error ? caught.message : "Unexpected error during token exchange."];
    return clearOauthCookies(
      resultPage({
        ok: false,
        status: 502,
        title: "Token exchange failed",
        lines: detail,
      }),
    );
  }
}

function clearOauthCookies(response: NextResponse) {
  response.cookies.set(OAUTH_STATE_COOKIE, "", { path: "/", maxAge: 0 });
  response.cookies.set(OAUTH_VERIFIER_COOKIE, "", { path: "/", maxAge: 0 });
  return response;
}

// Minimal self-contained HTML so the result is readable in the browser without
// pulling in the app shell. No inline scripts, so the CSP is unaffected.
function resultPage({
  ok,
  status,
  title,
  lines,
}: {
  ok: boolean;
  status: number;
  title: string;
  lines: string[];
}) {
  const accent = ok ? "#16a34a" : "#dc2626";
  const body = lines.map((line) => escapeHtml(line)).join("\n");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
    font-family: ui-sans-serif, system-ui, sans-serif; background:#0d1b2a; color:#e6edf3; padding:2rem; }
  main { width:min(640px,100%); background:#0f2438; border:1px solid #1e3a52;
    border-radius:16px; padding:2rem; box-shadow:0 10px 40px rgba(0,0,0,.35); }
  h1 { margin:0 0 1rem; font-size:1.35rem; border-left:4px solid ${accent}; padding-left:.75rem; }
  pre { margin:0 0 1.5rem; padding:1rem; background:#0a1826; border-radius:10px;
    white-space:pre-wrap; word-break:break-word; font-size:.9rem; line-height:1.5; }
  a { color:#5aa9ff; text-decoration:none; font-weight:600; }
  a:hover { text-decoration:underline; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(title)}</h1>
  <pre>${body}</pre>
  <a href="/auth-test">← Back to the X login test</a>
</main>
</body>
</html>`;

  return new NextResponse(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

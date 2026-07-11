import { createHash, randomBytes } from "crypto";

// Discord OAuth 2.0 with PKCE — sign-in only. Mirrors lib/twitter-oauth.ts so
// both providers share the same handshake shape. Splitsy is a confidential
// client (has a client secret) and requests only the `identify` scope: enough
// for the user's id, username, display name and avatar — no email, matching the
// X integration's minimal-consent decision.

export const DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
export const DISCORD_TOKEN_URL = "https://discord.com/api/oauth2/token";
export const DISCORD_USERS_ME_URL = "https://discord.com/api/users/@me";

// `identify` returns the user object (id, username, global_name, avatar). No
// `email` — Splitsy keys wallets to the Discord user id, not an email.
export const DISCORD_SCOPES = ["identify"];

// Separate from the X cookie names so both flows can be in flight at once.
export const DISCORD_OAUTH_STATE_COOKIE = "discord_oauth_state";
export const DISCORD_OAUTH_VERIFIER_COOKIE = "discord_oauth_verifier";

// Short-lived cookies that only need to survive the round-trip to Discord.
export const DISCORD_OAUTH_COOKIE_MAX_AGE = 600; // seconds

function base64url(input: Buffer) {
  return input.toString("base64url");
}

export function createPkcePair() {
  const verifier = base64url(randomBytes(32)); // 43-char high-entropy string
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function createState() {
  return base64url(randomBytes(16));
}

// The authorize request and the token exchange must use an identical
// redirect_uri, matching a Redirect registered on the Discord application. We
// derive it from the request origin so localhost and production both work, with
// an optional override for proxied deployments.
export function getRedirectUri(origin: string) {
  const base = process.env.DISCORD_OAUTH_REDIRECT_ORIGIN ?? origin;
  return `${base}/api/auth/discord/callback`;
}

export function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}) {
  const url = new URL(DISCORD_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", DISCORD_SCOPES.join(" "));
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export type DiscordTokenResponse = {
  token_type: string;
  expires_in: number;
  access_token: string;
  scope: string;
  refresh_token?: string;
};

export class DiscordTokenError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "DiscordTokenError";
  }
}

// Exchange the authorization code for tokens. Discord's token endpoint takes the
// client credentials as form fields (not HTTP Basic).
export async function exchangeCodeForToken(params: {
  code: string;
  redirectUri: string;
  verifier: string;
  clientId: string;
  clientSecret: string;
}): Promise<DiscordTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.verifier,
    client_id: params.clientId,
    client_secret: params.clientSecret,
  });

  const response = await fetch(DISCORD_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });

  const text = await response.text();
  if (!response.ok) {
    throw new DiscordTokenError(`Token exchange failed (${response.status}).`, response.status, text);
  }

  return JSON.parse(text) as DiscordTokenResponse;
}

// Raw Discord user object (subset we use). `username` is the unique handle;
// `global_name` is the display name; `avatar` is a hash (or null for the default
// avatar). https://discord.com/developers/docs/resources/user
export type DiscordUser = {
  id: string;
  username: string;
  global_name?: string | null;
  avatar: string | null;
};

export class DiscordApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "DiscordApiError";
  }
}

// Build the CDN URL for a user's avatar, or null when they use a default one
// (Discord's default avatars need no auth but aren't per-user meaningful, so we
// treat "no custom avatar" as null and let the UI fall back). Animated avatars
// have hashes prefixed with "a_" and are served as .gif.
export function discordAvatarUrl(user: DiscordUser): string | null {
  if (!user.avatar) return null;
  const ext = user.avatar.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=128`;
}

// Read the authenticating user's own profile.
export async function fetchDiscordUser(accessToken: string): Promise<DiscordUser> {
  const response = await fetch(DISCORD_USERS_ME_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });

  const text = await response.text();
  if (!response.ok) {
    throw new DiscordApiError(`Profile lookup failed (${response.status}).`, response.status, text);
  }

  return JSON.parse(text) as DiscordUser;
}

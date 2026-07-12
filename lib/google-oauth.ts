import { createHash, randomBytes } from "crypto";

// Google OAuth 2.0 with PKCE — sign-in only. Mirrors lib/twitter-oauth.ts and
// lib/discord-oauth.ts so all providers share the same handshake shape. Splitsy
// is a confidential client (has a client secret). Google is a *login method*
// that feeds the merged "email" identity: we key the account/wallet to the
// verified email, NOT to Google's `sub`, so a person who later signs in with
// Email-OTP using the same address lands on the same account + wallet.

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

// `openid email profile` returns the userinfo (sub, email, email_verified,
// name, picture). We only persist email/name/picture.
export const GOOGLE_SCOPES = ["openid", "email", "profile"];

// Separate from the X/Discord cookie names so all flows can be in flight at once.
export const GOOGLE_OAUTH_STATE_COOKIE = "google_oauth_state";
export const GOOGLE_OAUTH_VERIFIER_COOKIE = "google_oauth_verifier";

// Short-lived cookies that only need to survive the round-trip to Google.
export const GOOGLE_OAUTH_COOKIE_MAX_AGE = 600; // seconds

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
// redirect_uri, matching a redirect registered on the Google OAuth client. We
// derive it from the request origin so localhost and production both work, with
// an optional override for proxied deployments.
export function getRedirectUri(origin: string) {
  const base = process.env.GOOGLE_OAUTH_REDIRECT_ORIGIN ?? origin;
  return `${base}/api/auth/google/callback`;
}

export function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}) {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export type GoogleTokenResponse = {
  token_type: string;
  expires_in: number;
  access_token: string;
  scope: string;
  id_token: string;
  refresh_token?: string;
};

export class GoogleTokenError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "GoogleTokenError";
  }
}

// Exchange the authorization code for tokens. Google's token endpoint takes the
// client credentials as form fields (not HTTP Basic).
export async function exchangeCodeForToken(params: {
  code: string;
  redirectUri: string;
  verifier: string;
  clientId: string;
  clientSecret: string;
}): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.verifier,
    client_id: params.clientId,
    client_secret: params.clientSecret,
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });

  const text = await response.text();
  if (!response.ok) {
    throw new GoogleTokenError(`Token exchange failed (${response.status}).`, response.status, text);
  }

  return JSON.parse(text) as GoogleTokenResponse;
}

// Subset of Google's userinfo we use. `email_verified` may arrive as a boolean
// or the string "true" depending on endpoint — normalize at the call site.
export type GoogleUser = {
  sub: string;
  email: string;
  email_verified?: boolean | string;
  name?: string | null;
  picture?: string | null;
};

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

// Read the authenticating user's profile from the OIDC userinfo endpoint.
export async function fetchGoogleUser(accessToken: string): Promise<GoogleUser> {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });

  const text = await response.text();
  if (!response.ok) {
    throw new GoogleApiError(`Profile lookup failed (${response.status}).`, response.status, text);
  }

  return JSON.parse(text) as GoogleUser;
}

export function isEmailVerified(user: GoogleUser): boolean {
  return user.email_verified === true || user.email_verified === "true";
}

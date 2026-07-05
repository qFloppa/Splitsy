import { createHash, randomBytes } from "crypto";

// X (Twitter) OAuth 2.0 with PKCE — sign-in only.
//
// Stage 1 of the Splitsy X-identity integration proves the login handshake
// works end-to-end (authorize → consent → token exchange) without calling any
// billed data endpoint. The token exchange itself is part of X's auth system
// and is not a metered "read", so this flow can be tested for free. Reading the
// user's profile via GET /2/users/me (handle + email) is a separate, billed
// step added later.

// x.com also serves these; the twitter.com hosts remain valid and are the
// historically documented endpoints.
export const TWITTER_AUTHORIZE_URL = "https://twitter.com/i/oauth2/authorize";
export const TWITTER_TOKEN_URL = "https://api.twitter.com/2/oauth2/token";
export const TWITTER_USERS_ME_URL = "https://api.twitter.com/2/users/me";

// Read-only scopes. `users.email` additionally requires the "Request email from
// users" permission to be enabled in the X app settings, otherwise authorize
// returns an error.
export const TWITTER_SCOPES = ["tweet.read", "users.read", "users.email", "offline.access"];

export const OAUTH_STATE_COOKIE = "x_oauth_state";
export const OAUTH_VERIFIER_COOKIE = "x_oauth_verifier";

// Short-lived cookies that only need to survive the round-trip to X and back.
export const OAUTH_COOKIE_MAX_AGE = 600; // seconds

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

// Both the authorize request and the token exchange must use an identical
// redirect_uri, and it must exactly match a Callback URI registered on the X
// app. We derive it from the incoming request origin so localhost and
// production both work, with an optional override for proxied deployments.
export function getRedirectUri(origin: string) {
  const base = process.env.X_OAUTH_REDIRECT_ORIGIN ?? origin;
  return `${base}/api/auth/twitter/callback`;
}

export function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}) {
  const url = new URL(TWITTER_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", TWITTER_SCOPES.join(" "));
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export type TwitterTokenResponse = {
  token_type: string;
  expires_in: number;
  access_token: string;
  scope: string;
  refresh_token?: string;
};

export class TwitterTokenError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "TwitterTokenError";
  }
}

// Exchange the authorization code for tokens. Splitsy is a confidential client,
// so we authenticate to the token endpoint with HTTP Basic (client_id:secret).
export async function exchangeCodeForToken(params: {
  code: string;
  redirectUri: string;
  verifier: string;
  clientId: string;
  clientSecret: string;
}): Promise<TwitterTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.verifier,
    client_id: params.clientId,
  });

  const basic = Buffer.from(`${params.clientId}:${params.clientSecret}`).toString("base64");

  const response = await fetch(TWITTER_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body,
    cache: "no-store",
  });

  const text = await response.text();
  if (!response.ok) {
    throw new TwitterTokenError(
      `Token exchange failed (${response.status}).`,
      response.status,
      text,
    );
  }

  return JSON.parse(text) as TwitterTokenResponse;
}

export type TwitterUser = {
  id: string;
  name: string;
  username: string; // the @handle, without the leading @
  confirmed_email?: string;
  profile_image_url?: string;
};

export class TwitterApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "TwitterApiError";
  }
}

// Read the authenticating user's own profile. Under 2026 pay-per-use this is a
// "user read" and may require account credit; attempting it is free (a blocked
// call returns an error rather than a charge), which lets us probe whether it
// works without a top-up. `confirmed_email` requires the `users.email` scope
// AND the field to be explicitly requested.
export async function fetchTwitterUser(accessToken: string): Promise<TwitterUser> {
  const url = new URL(TWITTER_USERS_ME_URL);
  url.searchParams.set("user.fields", "confirmed_email,profile_image_url");

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });

  const text = await response.text();
  if (!response.ok) {
    throw new TwitterApiError(`Profile lookup failed (${response.status}).`, response.status, text);
  }

  const parsed = JSON.parse(text) as { data: TwitterUser };
  return parsed.data;
}

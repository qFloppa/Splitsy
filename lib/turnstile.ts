// Cloudflare Turnstile server-side verification. Returns true if the token is valid.
//
// FAILS CLOSED WHEN UNCONFIGURED, and that direction is the whole point. This
// used to return `true` on a missing TURNSTILE_SECRET_KEY, so forgetting one
// environment variable silently removed the only bot gate in front of email
// sign-in and the public receipt scan — with nothing in the response to say so.
// A deployment that has not been given the key now cannot pass the challenge,
// which is loud and cheap to fix; the inverse was quiet and expensive.
//
// Local development is the one case that wants the old behaviour, so it is opted
// into explicitly rather than inferred from a missing value: set
// TURNSTILE_DISABLED=true and NODE_ENV must not be production.
export async function verifyTurnstile(token: string, ip?: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    if (process.env.TURNSTILE_DISABLED === "true" && process.env.NODE_ENV !== "production") {
      console.warn("TURNSTILE_DISABLED=true — skipping verification (non-production only)");
      return true;
    }
    console.error("TURNSTILE_SECRET_KEY is not set — refusing the request");
    return false;
  }

  if (!token) return false;

  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, response: token, remoteip: ip }),
    });
    const data = (await res.json()) as { success?: boolean };
    // `=== true` rather than truthiness: a malformed or error-shaped response
    // must not read as a pass.
    return data.success === true;
  } catch {
    return false;
  }
}

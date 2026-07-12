import { NextResponse, type NextRequest } from "next/server";
import { verifyPin } from "@/lib/pin";
import { normalizeEmail, isValidEmail, decideOtp } from "@/lib/email-otp";
import { readOtp, bumpOtpAttempts, deleteOtp } from "@/lib/otp-repo";
import { finishProviderLogin } from "@/lib/oauth-callback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/auth/email/verify — finish Email-OTP sign-in. Body: { email, code }.
// Checks the code against the stored hash (with expiry + attempt limits), then
// hands off to the shared finishProviderLogin under the merged "email" provider
// (keyed by the email — same account/wallet as Google sign-in with that email).
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { email?: unknown; code?: unknown } | null;
  const email = normalizeEmail(String(body?.email ?? ""));
  const code = String(body?.code ?? "").trim();

  if (!isValidEmail(email) || !/^\d{6}$/.test(code)) {
    return Response.json({ error: "Enter the 6-digit code we emailed you." }, { status: 400 });
  }

  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < 32) {
    return Response.json({ error: "Server not configured (SESSION_SECRET)." }, { status: 500 });
  }

  const record = await readOtp(email);
  const matches = record ? verifyPin(code, record.code_hash) : false;
  const decision = decideOtp(
    record ? { expiresAt: Date.parse(record.expires_at), attempts: record.attempts } : null,
    matches,
    Date.now(),
  );

  if (decision === "expired") {
    await deleteOtp(email);
    return Response.json({ error: "That code has expired — request a new one." }, { status: 400 });
  }
  if (decision === "locked") {
    await deleteOtp(email);
    return Response.json({ error: "Too many attempts — request a new code." }, { status: 429 });
  }
  if (decision === "reject") {
    if (record) await bumpOtpAttempts(email, record.attempts + 1);
    return Response.json({ error: "Incorrect code." }, { status: 400 });
  }

  // accept — burn the single-use code, then create the account + session.
  await deleteOtp(email);

  const response = (await finishProviderLogin({
    provider: "email",
    profile: { providerUserId: email, handle: email, name: null, avatarUrl: null },
    request,
    sessionSecret,
    mode: "json",
  })) as NextResponse;
  return response;
}

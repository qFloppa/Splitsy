import { hashPin } from "@/lib/pin";
import {
  generateOtpCode,
  normalizeEmail,
  isValidEmail,
  sendOtpEmail,
  OtpSendError,
  OTP_TTL_MS,
} from "@/lib/email-otp";
import { upsertOtp } from "@/lib/otp-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/auth/email/start — begin Email-OTP sign-in. Body: { email }.
// Generates a 6-digit code, stores its hash, and emails the plaintext. Always
// returns 200 for a well-formed email (don't leak whether an address exists);
// only misconfiguration/validation errors surface.
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { email?: unknown } | null;
  const email = normalizeEmail(String(body?.email ?? ""));

  if (!isValidEmail(email)) {
    return Response.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  const code = generateOtpCode();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  try {
    await upsertOtp(email, hashPin(code), expiresAt);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Could not start sign-in." },
      { status: 500 },
    );
  }

  try {
    const sent = await sendOtpEmail(email, code);
    if (!sent) {
      return Response.json(
        { error: "Email sending is not configured (missing RESEND_API_KEY or EMAIL_FROM)." },
        { status: 500 },
      );
    }
  } catch (e) {
    const detail = e instanceof OtpSendError ? `${e.message} ${e.body.slice(0, 300)}` : "Could not send the code.";
    return Response.json({ error: detail }, { status: 502 });
  }

  return Response.json({ ok: true });
}

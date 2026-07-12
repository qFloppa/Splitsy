import { randomInt } from "crypto";

// Email-OTP sign-in helpers. A 6-digit code is generated, its hash stored (see
// lib/otp-repo.ts), and the plaintext emailed via Resend's REST API (no SDK
// dependency — a single fetch). Verifying the code resolves the person to the
// merged "email" identity, same as Google sign-in.

export const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const OTP_MAX_ATTEMPTS = 5; // wrong guesses before the code is burned
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Cryptographically-uniform 6-digit code (000000–999999), zero-padded.
export function generateOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

// Pure verify decision, split out so it's unit-testable without a DB. Returns
// what the caller should do: accept, reject (bad code, attempts left), expired,
// or locked (too many attempts).
export type OtpRecord = { expiresAt: number; attempts: number };
export type OtpDecision = "accept" | "reject" | "expired" | "locked";

export function decideOtp(record: OtpRecord | null, codeMatches: boolean, now: number): OtpDecision {
  if (!record) return "reject";
  if (now >= record.expiresAt) return "expired";
  if (record.attempts >= OTP_MAX_ATTEMPTS) return "locked";
  return codeMatches ? "accept" : "reject";
}

export class OtpSendError extends Error {
  // Plain fields (not constructor parameter properties) so this module loads
  // under `node --test --experimental-strip-types`, which the OTP unit test uses.
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "OtpSendError";
    this.status = status;
    this.body = body;
  }
}

// Send the code via Resend. Returns false (not throwing) when Resend isn't
// configured, so callers can decide whether to hard-fail. `EMAIL_FROM` must be a
// verified sender on the Resend account (e.g. "Splitsy <auth@yourdomain>").
export async function sendOtpEmail(email: string, code: string): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) return false;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
    body: JSON.stringify({
      from,
      to: [email],
      subject: `${code} is your Splitsy sign-in code`,
      text: `Your Splitsy sign-in code is ${code}. It expires in 10 minutes. If you didn't request this, you can ignore this email.`,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new OtpSendError(`Resend send failed (${res.status}).`, res.status, body);
  }
  return true;
}

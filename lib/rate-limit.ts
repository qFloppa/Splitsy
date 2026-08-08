// In-memory rate limiter for email OTP requests. Tracks attempts per email and per IP.
// Stores { count, resetAt } per key. Resets window after the TTL expires.

type RateLimitEntry = { count: number; resetAt: number };
const store = new Map<string, RateLimitEntry>();

const EMAIL_WINDOW_MS = 60_000; // 1 minute
const EMAIL_MAX_ATTEMPTS = 3;
const IP_WINDOW_MS = 60_000;
const IP_MAX_ATTEMPTS = 10;

function checkLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || now > entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (entry.count >= max) return false;

  entry.count++;
  return true;
}

export function checkEmailRateLimit(email: string): boolean {
  return checkLimit(`email:${email}`, EMAIL_MAX_ATTEMPTS, EMAIL_WINDOW_MS);
}

export function checkIpRateLimit(ip: string): boolean {
  return checkLimit(`ip:${ip}`, IP_MAX_ATTEMPTS, IP_WINDOW_MS);
}

// Optional: cleanup expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (now > entry.resetAt) store.delete(key);
  }
}, 300_000);

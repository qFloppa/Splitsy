// The gates that have to hold across requests: the wallet PIN, the public
// receipt scan, and the email-OTP send.
//
// WHAT THIS REPLACED, AND WHY IT HAD TO. This module used to keep a `Map` in
// module scope. On Vercel that is per lambda instance: N concurrent instances
// enforced N × the limit, and a cold start reset every counter to zero. It also
// read-then-wrote, so simply sending the attempts at once got them all past the
// check — each one read the same pre-increment count. Neither is a limiter.
//
// The counters now live in Postgres (schema-rate-limits.sql) and each attempt is
// counted by a single `insert … on conflict do update … returning`, which takes a
// row lock. Concurrent attempts are therefore counted, not raced.
//
// EVERY GATE FAILS CLOSED. A limiter that opens when its store is unreachable is
// a limiter an attacker can remove by making it unreachable. For the PIN this
// costs nothing: getSessionUser() reads the same database, so a caller who could
// not be rate-limited could not have been identified either.
//
// The pure decision functions are exported and take `now`, so the escalation
// schedule is unit-testable with no database (lib/rate-limit.test.ts).
import { createSupabaseServerClient } from "./supabase.ts";

// --- PIN escalation ---------------------------------------------------------

// Four wrong guesses cost nothing: a person mistyping their own PIN must not be
// punished for it. The fifth starts the clock.
export const PIN_FREE_ATTEMPTS = 4;
export const PIN_BASE_DELAY_MS = 15 * 60_000; // 15 minutes
export const PIN_MAX_DELAY_MS = 24 * 3_600_000; // one day
// Failures are forgotten after a day of not trying, so the escalation cannot
// ratchet a real user into a permanent lockout. There is NO PIN reset flow
// (app/api/wallet/pin/route.ts), which is exactly why this has to self-clear: a
// hard lock would brick the wallet with no way back.
export const PIN_WINDOW_SECONDS = 24 * 3600;

/**
 * How long the gate stays shut after `failures` consecutive wrong PINs.
 *
 * Doubling from 15 minutes, capped at a day. The point is not to make guessing
 * impossible — it is to make it slow enough to be worthless: a 4-digit PIN is
 * 10,000 candidates, and past the free attempts each one costs at least a
 * quarter of an hour. Ten thousand of those is over a century.
 */
export function pinLockMs(failures: number): number {
  if (failures <= PIN_FREE_ATTEMPTS) return 0;
  // 2 ** n goes to Infinity long before it overflows, and Math.min then picks
  // the cap — so a large count needs no special case.
  return Math.min(PIN_BASE_DELAY_MS * 2 ** (failures - PIN_FREE_ATTEMPTS - 1), PIN_MAX_DELAY_MS);
}

/**
 * Milliseconds the caller must wait, given the recorded state and the clock.
 *
 * Measured from the LAST attempt, not the first: a delay that ran from the start
 * of the window would get cheaper the longer someone kept guessing.
 */
export function pinRetryAfterMs(state: LimitState | null, now: number): number {
  if (!state) return 0;
  return Math.max(0, state.lastAtMs + pinLockMs(state.count) - now);
}

// --- fixed-window caps ------------------------------------------------------

const EMAIL_WINDOW_SECONDS = 60;
const EMAIL_MAX_ATTEMPTS = 3;
const IP_WINDOW_SECONDS = 60;
const IP_MAX_ATTEMPTS = 10;

// The public receipt scan. Each one can reach a paid model, so the cap is a
// spend ceiling per address rather than an abuse heuristic — see
// app/api/scout/scan/route.ts for why the endpoint cannot simply require a
// session.
export const SCAN_WINDOW_SECONDS = 24 * 3600;
export const SCAN_MAX_PER_IP = Number(process.env.SCAN_MAX_PER_IP ?? "20");

// --- storage ----------------------------------------------------------------

export type LimitState = { count: number; windowStartMs: number; lastAtMs: number };

type Row = { count: number; window_start: string; last_at: string };

const toState = (row: Row): LimitState => ({
  count: row.count,
  windowStartMs: Date.parse(row.window_start),
  lastAtMs: Date.parse(row.last_at),
});

// Count one attempt. `null` means the store could not be reached, and every
// caller reads that as "deny" — see the header.
async function bump(key: string, windowSeconds: number): Promise<LimitState | null> {
  const client = createSupabaseServerClient();
  if (!client) return null;
  const { data, error } = await client.rpc("bump_rate_limit", {
    p_key: key,
    p_window_seconds: windowSeconds,
  });
  if (error || !data?.[0]) {
    console.error(`[rate-limit] bump ${key} failed, denying:`, error?.message);
    return null;
  }
  return toState(data[0] as Row);
}

// Read without counting. Distinguishes three answers, and the third is the
// reason this is not folded into `bump`:
//   a state  — this key has been seen
//   null     — it has not
//   "error"  — we cannot tell, so the caller must deny
async function peek(key: string): Promise<LimitState | null | "error"> {
  const client = createSupabaseServerClient();
  if (!client) return "error";
  const { data, error } = await client.rpc("peek_rate_limit", { p_key: key });
  if (error) {
    console.error(`[rate-limit] peek ${key} failed, denying:`, error.message);
    return "error";
  }
  return data?.[0] ? toState(data[0] as Row) : null;
}

async function clear(key: string): Promise<void> {
  const client = createSupabaseServerClient();
  if (!client) return;
  const { error } = await client.rpc("clear_rate_limit", { p_key: key });
  if (error) console.error(`[rate-limit] clear ${key} failed:`, error.message);
}

// --- gates ------------------------------------------------------------------

const allowed = (state: LimitState | null, max: number) => state !== null && state.count <= max;

export async function checkEmailRateLimit(email: string): Promise<boolean> {
  return allowed(await bump(`otp-email:${email}`, EMAIL_WINDOW_SECONDS), EMAIL_MAX_ATTEMPTS);
}

export async function checkIpRateLimit(ip: string): Promise<boolean> {
  return allowed(await bump(`otp-ip:${ip}`, IP_WINDOW_SECONDS), IP_MAX_ATTEMPTS);
}

export async function checkScanIpLimit(ip: string): Promise<boolean> {
  return allowed(await bump(`scan-ip:${ip}`, SCAN_WINDOW_SECONDS), SCAN_MAX_PER_IP);
}

/**
 * Milliseconds before this user may try their PIN again; 0 means now.
 *
 * Called BEFORE the PIN is verified, and deliberately does not count an attempt
 * — otherwise a locked-out caller polling this would extend their own lock
 * forever and no one could ever wait it out.
 */
export async function pinRetryAfter(userId: string): Promise<number> {
  const state = await peek(`pin:${userId}`);
  if (state === "error") return PIN_BASE_DELAY_MS;
  return pinRetryAfterMs(state, Date.now());
}

/** Count a wrong PIN and report how long the gate is now shut for. */
export async function recordPinFailure(userId: string): Promise<number> {
  const state = await bump(`pin:${userId}`, PIN_WINDOW_SECONDS);
  // An unreachable store must not become a free guess: without a recorded
  // failure the next attempt would face no delay at all.
  if (!state) return PIN_BASE_DELAY_MS;
  return pinRetryAfterMs(state, Date.now());
}

/** A correct PIN forgets the failures before it. */
export async function clearPinFailures(userId: string): Promise<void> {
  await clear(`pin:${userId}`);
}

/**
 * The caller's address, for the gates keyed on one.
 *
 * `cf-connecting-ip` first because Cloudflare sets it and a client cannot; the
 * LEFTMOST `x-forwarded-for` entry is the client's own claim, which is why this
 * is a rate-limit key and never an authorization input. An empty result is
 * counted under its own key rather than skipped — a request with no discernible
 * address still gets a share, not a bypass.
 */
export function callerIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

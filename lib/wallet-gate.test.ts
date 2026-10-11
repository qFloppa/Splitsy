// THE GUARD ON THE GUARD: no route may sign from a user's custodial wallet
// without first checking that the wallet is unlocked.
//
// This is a test about the SHAPE of the codebase rather than about a function,
// and it exists because the check it looks for is four lines long and lives in
// thirteen route files. That is how two of them came to be written without it:
// /api/onchain-bills/create and /api/recurring/create both signed a transaction
// from the signed-in user's wallet on nothing but a session cookie, so a tab
// left open — or a stolen session — could write bills and deploy tabs in
// someone's name without ever being asked for their PIN. Every other spending
// route refused with 403 locked.
//
// A unit test cannot catch that: each route was individually correct about what
// it meant to do. What was missing was anything that noticed a route had joined
// the set and not taken the check with it. So the rule is enforced over the
// FILES: find every route that can make the server sign, and require the gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const API_DIR = join(import.meta.dirname, "..", "app", "api");

// Calling either of these is what "the server signs from the user's wallet"
// means in this codebase — lib/wallet-provider.ts's two exits to the custodian.
const SIGNS_FOR_USER = /executeContract|transferUsdc\(/;

// The check itself, in either of its two forms: the inline cookie comparison the
// older routes carry, or the shared helper in lib/wallet-gate.ts. Both are the
// same test against the same cookie; new routes should take the helper, which is
// why it is one line.
const GATED = /WALLET_UNLOCK_COOKIE|requireWalletUnlocked/;

// Routes that sign WITHOUT a user present, each for a stated reason. A PIN
// cannot be asked for when nobody is at the keyboard, so these are authorised by
// something else — and gating them would break the thing they exist to do.
const NO_USER_PRESENT: Record<string, string> = {
  "agents/autopay/route.ts": "an agent pays on a mandate the user already granted; no session at all",
  "agents/dunning/route.ts": "same — runs from a webhook, not a click",
  "agents/grants/route.ts": "arming moves no money and is unreachable on this stack (see the file)",
  "agents/mandate/route.ts": "granting moves no money, and withdrawing must never be harder than granting",
  "escrow/reclaim-stale/route.ts": "a cron sweep, authorised by ESCROW_SWEEP_SECRET",
};

function routeFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...routeFiles(join(dir, entry.name), rel));
    else if (entry.name === "route.ts") out.push(rel);
  }
  return out;
}

test("every route that signs from a user's wallet checks the unlock first", () => {
  const unguarded: string[] = [];

  for (const rel of routeFiles(API_DIR)) {
    const source = readFileSync(join(API_DIR, rel), "utf8");
    if (!SIGNS_FOR_USER.test(source)) continue;
    if (rel in NO_USER_PRESENT) continue;
    if (!GATED.test(source)) unguarded.push(rel);
  }

  assert.deepEqual(
    unguarded,
    [],
    `These routes can make the server sign from a user's wallet with no unlock check. Add requireWalletUnlocked (lib/wallet-gate.ts), or — if nobody is at the keyboard when they run — list them in NO_USER_PRESENT with the reason:\n  ${unguarded.join("\n  ")}`,
  );
});

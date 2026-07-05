# X Identity Spine (P1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the verified Sign-in-with-X handshake into a real logged-in session: persist the user in Supabase, issue a signed session cookie, expose the current user via `/api/me`, add logout, and show login state in the app header.

**Architecture:** The OAuth callback (already built) gains a persistence + session step. A pure `lib/session.ts` HMAC-signs a cookie value carrying only the Supabase `users.id`. A `lib/users-repo.ts` module hides Supabase behind an `upsertUserFromX` / `getUserById` interface. New route handlers (`/api/me`, `/api/auth/logout`) and a small client component (`XAuthControl`) surface identity in the existing header. No wallet, no bills yet — those are P2/P3/P4.

**Tech Stack:** Next.js 16 (App Router, route handlers), React 19, `@supabase/supabase-js` (already a dep), Node `crypto` (HMAC), `node:test` + `node:assert/strict` for unit tests.

## Global Constraints

- This is NOT the Next.js you know — read `node_modules/next/dist/docs/` before writing framework code; heed deprecation notices. (from AGENTS.md)
- Route handlers set `export const runtime = "nodejs"` and `export const dynamic = "force-dynamic"` (existing convention; `crypto` + cookies require Node runtime).
- `cookies()` from `next/headers` is **async** in Next 16 — always `await` it.
- Supabase is reached **server-side only** via `createSupabaseServerClient()` (service-role key); the browser never holds it. The helper returns `null` when env is unconfigured — callers must handle null.
- Session cookie name: `splitsy_session`. It stores ONLY the Supabase `users.id`, HMAC-signed. `HttpOnly`, `SameSite=Lax`, `Secure` only when the request is HTTPS (so localhost http works), `Path=/`, `maxAge` 2592000 (30 days).
- New server secret env var: `SESSION_SECRET` (min 32 chars). Add to `.env.example`.
- Unit tests are pure-logic only, run with `node --test --experimental-strip-types <file>`; import sibling modules with explicit `.ts` extensions (matches `lib/netting.test.ts`).
- Add `offline.access` to the OAuth scopes so the access token can later be refreshed (access token TTL is 2h).
- Reference spec: `docs/superpowers/specs/2026-07-04-twitter-identity-design.md` (phase P1).

---

### Task 1: Session token module (`lib/session.ts`)

Pure, dependency-free HMAC sign/verify for the session cookie value. No Next.js imports so it is unit-testable with `node:test`.

**Files:**
- Create: `lib/session.ts`
- Test: `lib/session.test.ts`

**Interfaces:**
- Consumes: `SESSION_SECRET` env (read by callers, passed in — the module takes the secret as an argument so it stays pure and testable).
- Produces:
  - `signSession(userId: string, secret: string): string` — returns `"<userId>.<base64url-hmac>"`.
  - `verifySession(token: string, secret: string): string | null` — returns the `userId` if the HMAC matches (constant-time compare), else `null`.
  - `SESSION_COOKIE_NAME = "splitsy_session"` constant.
  - `SESSION_MAX_AGE = 2592000` constant (seconds, 30 days).

- [ ] **Step 1: Write the failing test**

```ts
// lib/session.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { signSession, verifySession, SESSION_COOKIE_NAME } from "./session.ts";

const SECRET = "test-secret-that-is-at-least-32-chars-long!!";

test("verifySession returns the userId for a token it signed", () => {
  const token = signSession("user-123", SECRET);
  assert.equal(verifySession(token, SECRET), "user-123");
});

test("verifySession rejects a tampered payload", () => {
  const token = signSession("user-123", SECRET);
  const tampered = token.replace("user-123", "user-999");
  assert.equal(verifySession(tampered, SECRET), null);
});

test("verifySession rejects a token signed with a different secret", () => {
  const token = signSession("user-123", SECRET);
  assert.equal(verifySession(token, "a-completely-different-secret-value-32x"), null);
});

test("verifySession rejects malformed tokens", () => {
  assert.equal(verifySession("garbage", SECRET), null);
  assert.equal(verifySession("", SECRET), null);
  assert.equal(verifySession("a.b.c", SECRET), null);
});

test("cookie name constant is stable", () => {
  assert.equal(SESSION_COOKIE_NAME, "splitsy_session");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --experimental-strip-types lib/session.test.ts`
Expected: FAIL — cannot find module `./session.ts` (or export undefined).

- [ ] **Step 3: Write the minimal implementation**

```ts
// lib/session.ts
import { createHmac, timingSafeEqual } from "crypto";

export const SESSION_COOKIE_NAME = "splitsy_session";
export const SESSION_MAX_AGE = 2592000; // 30 days in seconds

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

// Token format: "<userId>.<base64url-hmac-of-userId>". The userId is opaque
// (a Supabase uuid) and contains no ".", so we split on the last ".".
export function signSession(userId: string, secret: string): string {
  return `${userId}.${sign(userId, secret)}`;
}

export function verifySession(token: string, secret: string): string | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const userId = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  const expectedSig = sign(userId, secret);

  const provided = Buffer.from(providedSig);
  const expected = Buffer.from(expectedSig);
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  return userId;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --experimental-strip-types lib/session.test.ts`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/session.ts lib/session.test.ts
git commit -m "feat: add HMAC-signed session token module"
```

---

### Task 2: Users repository (`lib/users-repo.ts`)

Server-side Supabase access for the `users` table, behind a narrow interface. Also ships the SQL migration for the `users` table.

**Files:**
- Create: `lib/users-repo.ts`
- Create: `schema-users.sql` (migration to run in Supabase; sibling to existing `schema.sql`)
- Modify: `lib/types.ts` (append `AppUser` type)

**Interfaces:**
- Consumes: `createSupabaseServerClient()` from `lib/supabase.ts` (returns a client or `null`).
- Produces:
  - `type AppUser = { id: string; x_user_id: string; x_handle: string; x_name: string | null; x_avatar_url: string | null; email: string | null; wallet_address: string | null; circle_wallet_id: string | null; created_at: string }` (in `lib/types.ts`).
  - `upsertUserFromX(profile: { xUserId: string; handle: string; name: string | null; avatarUrl: string | null; email: string | null }): Promise<AppUser>` — inserts or updates by `x_user_id`, returns the row. Throws `Error("Supabase is not configured")` if the client is null.
  - `getUserById(id: string): Promise<AppUser | null>` — returns the row or null.

- [ ] **Step 1: Write the SQL migration**

```sql
-- schema-users.sql — run in the Supabase SQL editor (additive; does not touch
-- the existing tabs/members/charges/settlements tables).
create table if not exists users (
  id               uuid primary key default gen_random_uuid(),
  x_user_id        text unique not null,
  x_handle         text not null,
  x_name           text,
  x_avatar_url     text,
  email            text,
  wallet_address   text,
  circle_wallet_id text,
  created_at       timestamptz not null default now()
);
create index if not exists idx_users_x_handle on users (lower(x_handle));
```

- [ ] **Step 2: Add the `AppUser` type**

Append to `lib/types.ts`:

```ts
export type AppUser = {
  id: string;
  x_user_id: string;
  x_handle: string;
  x_name: string | null;
  x_avatar_url: string | null;
  email: string | null;
  wallet_address: string | null;
  circle_wallet_id: string | null;
  created_at: string;
};
```

- [ ] **Step 3: Write the repository**

```ts
// lib/users-repo.ts
import { createSupabaseServerClient } from "@/lib/supabase";
import type { AppUser } from "@/lib/types";

export type XProfileInput = {
  xUserId: string;
  handle: string;
  name: string | null;
  avatarUrl: string | null;
  email: string | null;
};

function requireClient() {
  const client = createSupabaseServerClient();
  if (!client) {
    throw new Error("Supabase is not configured");
  }
  return client;
}

export async function upsertUserFromX(profile: XProfileInput): Promise<AppUser> {
  const client = requireClient();
  const { data, error } = await client
    .from("users")
    .upsert(
      {
        x_user_id: profile.xUserId,
        x_handle: profile.handle,
        x_name: profile.name,
        x_avatar_url: profile.avatarUrl,
        email: profile.email,
      },
      { onConflict: "x_user_id" },
    )
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to upsert user: ${error.message}`);
  }
  return data as AppUser;
}

export async function getUserById(id: string): Promise<AppUser | null> {
  const client = requireClient();
  const { data, error } = await client.from("users").select().eq("id", id).maybeSingle();
  if (error) {
    throw new Error(`Failed to read user: ${error.message}`);
  }
  return (data as AppUser) ?? null;
}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -vE "netting.test.ts" | grep -E "users-repo|types.ts" || echo "no new type errors"`
Expected: `no new type errors` (the pre-existing `netting.test.ts` import error is filtered out).

- [ ] **Step 5: Commit**

```bash
git add lib/users-repo.ts lib/types.ts schema-users.sql
git commit -m "feat: add users repository and users table migration"
```

---

### Task 3: Wire persistence + session into the OAuth callback

Replace the callback's debug success page with the real flow: fetch profile → upsert user → set signed session cookie → redirect into the app. Also add `offline.access` to the scopes.

**Files:**
- Modify: `lib/twitter-oauth.ts` (add `offline.access` to `TWITTER_SCOPES`)
- Modify: `app/api/auth/twitter/callback/route.ts` (replace success path)

**Interfaces:**
- Consumes: `exchangeCodeForToken`, `fetchTwitterUser`, `TwitterUser` (from `lib/twitter-oauth.ts`); `upsertUserFromX` (Task 2); `signSession`, `SESSION_COOKIE_NAME`, `SESSION_MAX_AGE` (Task 1); `process.env.SESSION_SECRET`.
- Produces: on success, a redirect to `/` with the `splitsy_session` cookie set. Errors still render the existing `resultPage(...)` HTML.

- [ ] **Step 1: Add `offline.access` to scopes**

In `lib/twitter-oauth.ts`, change the `TWITTER_SCOPES` constant:

```ts
export const TWITTER_SCOPES = ["tweet.read", "users.read", "users.email", "offline.access"];
```

- [ ] **Step 2: Replace the success path in the callback**

In `app/api/auth/twitter/callback/route.ts`, update the imports to add the new deps:

```ts
import { NextResponse, type NextRequest } from "next/server";
import {
  exchangeCodeForToken,
  fetchTwitterUser,
  getRedirectUri,
  OAUTH_STATE_COOKIE,
  OAUTH_VERIFIER_COOKIE,
  TwitterApiError,
  TwitterTokenError,
  type TwitterTokenResponse,
  type TwitterUser,
} from "@/lib/twitter-oauth";
import { upsertUserFromX } from "@/lib/users-repo";
import { signSession, SESSION_COOKIE_NAME, SESSION_MAX_AGE } from "@/lib/session";
```

Replace the inner `try` block that currently calls `fetchTwitterUser` + `profileSuccessPage` with this version, which upserts the user and sets the session cookie on a redirect to `/`:

```ts
  try {
    const token = await exchangeCodeForToken({ code, redirectUri, verifier, clientId, clientSecret });

    const sessionSecret = process.env.SESSION_SECRET;
    if (!sessionSecret || sessionSecret.length < 32) {
      return clearOauthCookies(
        resultPage({
          ok: false,
          status: 500,
          title: "Server not configured",
          lines: ["SESSION_SECRET is missing or shorter than 32 chars. Add it to .env.local."],
        }),
      );
    }

    let user: TwitterUser;
    try {
      user = await fetchTwitterUser(token.access_token);
    } catch (profileCaught) {
      const detail =
        profileCaught instanceof TwitterApiError
          ? [`HTTP ${profileCaught.status}`, profileCaught.body.slice(0, 800)]
          : [profileCaught instanceof Error ? profileCaught.message : "Unexpected error during profile lookup."];
      return clearOauthCookies(
        resultPage({
          ok: false,
          status: 200,
          title: "Login worked — but the profile read was blocked",
          lines: ["GET /2/users/me failed:", ...detail],
        }),
      );
    }

    let appUserId: string;
    try {
      const appUser = await upsertUserFromX({
        xUserId: user.id,
        handle: user.username,
        name: user.name ?? null,
        avatarUrl: user.profile_image_url ?? null,
        email: user.confirmed_email ?? null,
      });
      appUserId = appUser.id;
    } catch (dbCaught) {
      return clearOauthCookies(
        resultPage({
          ok: false,
          status: 500,
          title: "Could not save your account",
          lines: [dbCaught instanceof Error ? dbCaught.message : "Unexpected database error."],
        }),
      );
    }

    const response = NextResponse.redirect(new URL("/", request.nextUrl.origin));
    response.cookies.set(SESSION_COOKIE_NAME, signSession(appUserId, sessionSecret), {
      httpOnly: true,
      secure: request.nextUrl.protocol === "https:",
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE,
    });
    return clearOauthCookies(response);
  } catch (caught) {
```

Then **delete** the now-unused `profileSuccessPage` function and the `TwitterTokenResponse` / `TwitterUser` imports if they become unused. Keep `resultPage`, `clearOauthCookies`, `escapeHtml`, and the outer `catch` (token-exchange failure) exactly as they are.

- [ ] **Step 3: Verify it typechecks**

Run: `npx tsc --noEmit 2>&1 | grep -vE "netting.test.ts" | grep -E "callback/route|twitter-oauth" || echo "no new type errors"`
Expected: `no new type errors`.

- [ ] **Step 4: Lint**

Run: `npx eslint app/api/auth/twitter/callback/route.ts lib/twitter-oauth.ts`
Expected: no output (clean). If it flags an unused import (`TwitterTokenResponse`/`TwitterUser`), remove that import and re-run until clean.

- [ ] **Step 5: Commit**

```bash
git add app/api/auth/twitter/callback/route.ts lib/twitter-oauth.ts
git commit -m "feat: persist X user and set session cookie on login"
```

---

### Task 4: Current-user endpoint (`/api/me`) and session reader

A route that reads the session cookie, verifies it, loads the user, and returns a safe JSON shape. Adds a small `getSessionUser()` helper other routes will reuse.

**Files:**
- Modify: `lib/session.ts` (add `getSessionUser` server helper)
- Create: `app/api/me/route.ts`

**Interfaces:**
- Consumes: `cookies()` from `next/headers`; `verifySession`, `SESSION_COOKIE_NAME` (Task 1); `getUserById` (Task 2); `process.env.SESSION_SECRET`.
- Produces:
  - `getSessionUser(): Promise<AppUser | null>` (added to `lib/session.ts`) — reads+verifies the cookie and loads the user; returns null if no/invalid session or unconfigured secret.
  - `GET /api/me` → `200 { user: { id, handle, name, avatarUrl, walletAddress } | null }`. Never returns the email or raw x_user_id to the client.

- [ ] **Step 1: Add `getSessionUser` to `lib/session.ts`**

Append to `lib/session.ts` (the crypto helpers above stay pure; this async helper is the server-side bridge):

```ts
import { cookies } from "next/headers";
import { getUserById } from "@/lib/users-repo";
import type { AppUser } from "@/lib/types";

export async function getSessionUser(): Promise<AppUser | null> {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) return null;

  const store = await cookies();
  const raw = store.get(SESSION_COOKIE_NAME)?.value;
  if (!raw) return null;

  const userId = verifySession(raw, secret);
  if (!userId) return null;

  return getUserById(userId);
}
```

- [ ] **Step 2: Re-run the Task 1 unit tests to confirm the pure functions still pass**

Run: `node --test --experimental-strip-types lib/session.test.ts`
Expected: PASS — the added `getSessionUser` import (`next/headers`) is not exercised by these tests, which only import `signSession`/`verifySession`/`SESSION_COOKIE_NAME`. If the strip-types loader errors on the `next/headers` import, split the pure functions into `lib/session-core.ts` and re-import; otherwise leave as-is.

> Note: if Step 2 shows a loader error from the `next/headers` import, do this refactor: move `sign`, `signSession`, `verifySession`, `SESSION_COOKIE_NAME`, `SESSION_MAX_AGE` into `lib/session-core.ts`; have `lib/session.ts` re-export them and add `getSessionUser`; point `lib/session.test.ts` at `./session-core.ts`. Re-run the test — Expected: PASS.

- [ ] **Step 3: Write the `/api/me` route**

```ts
// app/api/me/route.ts
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return Response.json({ user: null });
  }
  return Response.json({
    user: {
      id: user.id,
      handle: user.x_handle,
      name: user.x_name,
      avatarUrl: user.x_avatar_url,
      walletAddress: user.wallet_address,
    },
  });
}
```

- [ ] **Step 4: Typecheck + lint**

Run: `npx tsc --noEmit 2>&1 | grep -vE "netting.test.ts" | grep -E "api/me|session" || echo "no new type errors"`
Then: `npx eslint app/api/me/route.ts lib/session.ts`
Expected: `no new type errors` and clean lint.

- [ ] **Step 5: Commit**

```bash
git add lib/session.ts app/api/me/route.ts
git commit -m "feat: add getSessionUser helper and /api/me endpoint"
```

---

### Task 5: Logout endpoint (`/api/auth/logout`)

Clears the session cookie and redirects home.

**Files:**
- Create: `app/api/auth/logout/route.ts`

**Interfaces:**
- Consumes: `SESSION_COOKIE_NAME` (Task 1).
- Produces: `POST /api/auth/logout` → redirect to `/` with the session cookie expired.

- [ ] **Step 1: Write the route**

```ts
// app/api/auth/logout/route.ts
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const response = NextResponse.redirect(new URL("/", request.nextUrl.origin));
  response.cookies.set(SESSION_COOKIE_NAME, "", { path: "/", maxAge: 0 });
  return response;
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `npx tsc --noEmit 2>&1 | grep -vE "netting.test.ts" | grep -E "logout" || echo "no new type errors"`
Then: `npx eslint app/api/auth/logout/route.ts`
Expected: `no new type errors` and clean lint.

- [ ] **Step 3: Commit**

```bash
git add app/api/auth/logout/route.ts
git commit -m "feat: add logout endpoint"
```

---

### Task 6: Header auth control (`XAuthControl`) + env docs

A small client component that fetches `/api/me` and renders either a "Sign in with X" link or the user's handle + avatar with a logout button. Mounted in the existing header next to `<ConnectButton>`. Also documents `SESSION_SECRET`.

**Files:**
- Create: `app/XAuthControl.tsx`
- Modify: `app/HomeClient.tsx` (import + mount, next to `<ConnectButton>` at ~line 1389)
- Modify: `.env.example` (add `SESSION_SECRET`)

**Interfaces:**
- Consumes: `GET /api/me` (Task 4); `POST /api/auth/logout` (Task 5); `GET /api/auth/twitter` (existing login start).
- Produces: `<XAuthControl />` default export (a client component).

- [ ] **Step 1: Write the component**

```tsx
// app/XAuthControl.tsx
"use client";

import { useEffect, useState } from "react";

type Me = { id: string; handle: string; name: string | null; avatarUrl: string | null; walletAddress: string | null };

export default function XAuthControl() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    fetch("/api/me")
      .then((r) => r.json())
      .then((data: { user: Me | null }) => {
        if (active) setMe(data.user);
      })
      .catch(() => {
        if (active) setMe(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  if (loading) {
    return <span className="text-sm text-[var(--text-muted)]">…</span>;
  }

  if (!me) {
    return (
      <a
        href="/api/auth/twitter"
        className="inline-flex items-center gap-2 rounded-full bg-[#1d9bf0] px-3 py-1.5 text-sm font-semibold text-white"
      >
        Sign in with X
      </a>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {me.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={me.avatarUrl} alt="" width={24} height={24} className="rounded-full" />
      ) : null}
      <span className="text-sm font-semibold">@{me.handle}</span>
      <form action="/api/auth/logout" method="post">
        <button type="submit" className="text-sm text-[var(--text-muted)] underline">
          Log out
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Mount it in the header**

In `app/HomeClient.tsx`, add the import near the other `app/`-local imports at the top of the file:

```tsx
import XAuthControl from "./XAuthControl";
```

Then, at the header controls (immediately before the existing `<ConnectButton ... />` line, ~1389), insert:

```tsx
              <XAuthControl />
```

so the two controls sit side by side inside the existing `<div className="flex flex-wrap items-center gap-2">`.

- [ ] **Step 3: Document the env var**

In `.env.example`, under the X OAuth block added earlier, append:

```ini
# Session signing secret for the Splitsy login cookie (min 32 chars).
SESSION_SECRET=replace_with_a_long_random_secret_at_least_32_chars
```

- [ ] **Step 4: Typecheck + lint + build**

Run: `npx tsc --noEmit 2>&1 | grep -vE "netting.test.ts" | grep -E "XAuthControl|HomeClient" || echo "no new type errors"`
Then: `npx eslint app/XAuthControl.tsx app/HomeClient.tsx`
Then: `npm run build`
Expected: `no new type errors`, clean lint, and a successful build.

- [ ] **Step 5: Commit**

```bash
git add app/XAuthControl.tsx app/HomeClient.tsx .env.example
git commit -m "feat: show X login state in the app header"
```

---

### Task 7: End-to-end manual verification

No new files — drive the real flow to confirm the spine works. Requires `.env.local` to have `X_CLIENT_ID`, `X_CLIENT_SECRET`, `SESSION_SECRET` (≥32 chars), and Supabase env configured, and the `users` table created (Task 2 migration run in Supabase).

- [ ] **Step 1: Ensure the `users` table exists**

Run the contents of `schema-users.sql` in the Supabase SQL editor (once). Confirm the `users` table appears in the Table editor.

- [ ] **Step 2: Start a single dev server on port 3000**

Run: `npm run dev`
Expected: `Local: http://localhost:3000`. (If port 3000 is taken, stop the other server first — the X callback is registered for `:3000`.)

- [ ] **Step 3: Log in**

In a browser, open `http://localhost:3000/auth-test` → click **Sign in with X** → approve.
Expected: you are redirected to `http://localhost:3000/` (the app), not to a debug page.

- [ ] **Step 4: Confirm the session works**

Open `http://localhost:3000/api/me` in the same browser.
Expected JSON: `{"user":{"id":"…","handle":"<your handle>","name":…,"avatarUrl":…,"walletAddress":null}}`.
Also confirm the header now shows `@<your handle>` with a "Log out" button.

- [ ] **Step 5: Confirm the row persisted**

In the Supabase Table editor, open `users`.
Expected: one row with your `x_user_id`, `x_handle`, and `wallet_address = null`.

- [ ] **Step 6: Confirm logout**

Click **Log out** in the header (or `curl -i -X POST http://localhost:3000/api/auth/logout`).
Expected: redirected to `/`; header shows **Sign in with X** again; `GET /api/me` now returns `{"user":null}`.

- [ ] **Step 7: Commit a short verification note (optional)**

If anything needed adjustment during verification, commit those fixes with a descriptive message. Otherwise, no commit — this task is a gate, not a code change.

---

## Self-Review

**Spec coverage (P1 scope):**
- `lib/session.ts` → Task 1 ✔ (HMAC-signed cookie storing only `users.id`, per §10).
- `lib/users-repo.ts` + `users` table → Task 2 ✔ (matches §7 schema; `bills`/`bill_debts` are P2/P3, correctly out of scope).
- Extend callback to upsert + session → Task 3 ✔ (§9 step 1, minus wallet creation which is P2).
- `offline.access` scope → Task 3 ✔ (§11.4).
- `/api/me` → Task 4 ✔ (§8).
- `/api/auth/logout` → Task 5 ✔ (§8).
- Header login UI → Task 6 ✔ (§8, §13 P1).
- DCW wallet creation is **intentionally deferred to P2** — Task 3 leaves `wallet_address` null; `/api/me` returns it as null. Not a gap.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every command has expected output.

**Type consistency:** `AppUser` (Task 2) is consumed by `getUserById`/`getSessionUser` (Tasks 2/4) and shaped into the `/api/me` response (Task 4) and the `Me` type (Task 6) — fields align (`x_handle`→`handle`, `x_avatar_url`→`avatarUrl`, `wallet_address`→`walletAddress`). `signSession`/`verifySession`/`SESSION_COOKIE_NAME`/`SESSION_MAX_AGE` names are consistent across Tasks 1, 3, 4, 5. `upsertUserFromX` input shape matches the callback's call site in Task 3.

**Known follow-up flagged for execution:** Task 4 Step 2 contains a contingency (split into `session-core.ts`) in case the `--experimental-strip-types` test loader chokes on the `next/headers` import — an explicit, resolved instruction, not a placeholder.

import { cookies } from "next/headers";
import { getUserById } from "@/lib/users-repo";
import type { AppUser } from "@/lib/types";
import {
  SESSION_COOKIE_NAME,
  verifySession,
  verifyWalletProof,
  WALLET_PROOF_COOKIE,
} from "@/lib/session-core";

// Re-export the pure session primitives so server code has a single import
// surface. They live in session-core.ts (no next/headers import) so they stay
// unit-testable under `node --test`.
export {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE,
  signSession,
  verifySession,
  signWalletProof,
  WALLET_PROOF_COOKIE,
  WALLET_PROOF_TTL,
} from "@/lib/session-core";

export async function getSessionUser(): Promise<AppUser | null> {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) return null;

  const store = await cookies();
  const raw = store.get(SESSION_COOKIE_NAME)?.value;
  if (!raw) return null;

  const session = verifySession(raw, secret, Date.now());
  if (!session) return null;

  const user = await getUserById(session.userId);
  if (!user) return null;

  // REVOCATION, and the only kind a stateless session can have: a token is dead
  // if it was minted before the moment this account last invalidated its
  // sessions. Signing out bumps that column (app/api/auth/logout), and so can an
  // operator with one UPDATE — which is what makes a leaked cookie something that
  // can be dealt with rather than waited out for thirty days.
  //
  // A NULL column means "never revoked" and must not read as "revoked at the
  // epoch" or the reverse; the comparison is skipped entirely in that case, which
  // is every account that has never signed out.
  if (user.sessions_valid_from) {
    const validFrom = Date.parse(user.sessions_valid_from);
    // An unparseable value is treated as no revocation rather than as a total
    // lockout: the failure mode of the other direction is every user of this
    // deployment signed out at once, for a bad string in one column.
    if (Number.isFinite(validFrom) && session.issuedAtMs < validFrom) return null;
  }

  return user;
}

// This browser's OTHER account — the one a browser wallet signed into while the
// session above stayed put — but only while the extension is still on that very
// wallet.
//
// Two conditions, and each rules out a different mistake. The COOKIE is the
// authority: it was issued against a verified signature, so nothing here trusts
// an address the caller merely names. The `connected` address only NARROWS, which
// is why passing the wrong one can hide this account but never reveal another: the
// card follows the extension, and rows from an agent that is not on screen would
// be unattributable.
export async function getProvenWalletAccount(
  sessionUserId: string,
  connected: string,
): Promise<AppUser | null> {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) return null;

  const address = connected.toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(address)) return null;

  const raw = (await cookies()).get(WALLET_PROOF_COOKIE)?.value;
  if (!raw) return null;
  const userId = verifyWalletProof(raw, secret, Date.now());
  if (!userId || userId === sessionUserId) return null;

  const proven = await getUserById(userId).catch(() => null);
  // provider_user_id IS the address for a wallet account, and the provider check
  // keeps a stale cookie from ever naming a social one.
  if (!proven || proven.provider !== "wallet" || proven.provider_user_id.toLowerCase() !== address) {
    return null;
  }
  return proven;
}

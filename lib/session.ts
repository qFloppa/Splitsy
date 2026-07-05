import { cookies } from "next/headers";
import { getUserById } from "@/lib/users-repo";
import type { AppUser } from "@/lib/types";
import { SESSION_COOKIE_NAME, verifySession } from "@/lib/session-core";

// Re-export the pure session primitives so server code has a single import
// surface. They live in session-core.ts (no next/headers import) so they stay
// unit-testable under `node --test`.
export {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE,
  signSession,
  verifySession,
} from "@/lib/session-core";

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

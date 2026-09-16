// A Privy user → the Splitsy `users` row that person already has.
//
// THIS IS THE FILE THAT CAN SILENTLY FORK AN ACCOUNT. Splitsy keys a user on
// (provider, provider_user_id). If a Privy login lands on the wrong key nothing
// errors — a SECOND row is created, holding none of that person's debts, bills or
// reputation, and the only visible symptom is a balance of zero on an account that
// looks right. So the mapping is per provider, not one rule, and it is written to
// be correct whether or not Privy's ids turn out to match the ones the OAuth
// callbacks stored. See the table below.
//
// The mapping itself is PURE and has its own unit test (privy-identity.test.ts).
// Everything that touches the network is behind a lazy import or an injected dep,
// so that test runs under `node --test` with no SDK and no database.
import type { AccountProvider, AppUser } from "./types.ts";

// The parts of Privy's server-side `User.linked_accounts` this reads. Declared
// structurally rather than imported from @privy-io/node so the pure half of this
// module stays loadable without the SDK — the field names are copied verbatim
// from resources/users/users.d.ts and must not drift from it.
//
// ONE FLAT SHAPE WITH OPTIONAL FIELDS, not a discriminated union. `type` is an
// open string in the SDK (there are twenty-odd account kinds and Privy adds
// more), so a union would need a `{type: string}` member, which swallows every
// other member and defeats the narrowing it was written for. Flat reads the same
// at every call site and cannot silently stop narrowing.
export type PrivyLinkedAccount = {
  type: string;
  // twitter_oauth / discord_oauth / google_oauth
  subject?: string;
  username?: string | null;
  name?: string | null;
  profile_picture_url?: string | null;
  // google_oauth
  email?: string | null;
  // email
  address?: string;
  // wallet
  connector_type?: string;
  chain_type?: string;
  id?: string | null;
};

export type PrivyProfile = {
  provider: AccountProvider;
  providerUserId: string;
  handle: string;
  name: string | null;
  avatarUrl: string | null;
};

// What each provider stores TODAY, and what Privy hands over:
//
//   X        provider "x",     provider_user_id = X's numeric user id
//            (app/api/auth/twitter/callback/route.ts:123) — Privy's
//            twitter_oauth.subject is expected to be the same number.
//   Discord  provider "discord", provider_user_id = Discord's user id
//            (app/api/auth/discord/callback/route.ts:123) — likewise
//            discord_oauth.subject.
//   Google   provider "email", provider_user_id = THE EMAIL ADDRESS, deliberately
//            "not Google's sub — merges with OTP"
//            (app/api/auth/google/callback/route.ts:138). So google_oauth.subject
//            is the WRONG key here and google_oauth.email is the right one.
//   Email    provider "email", provider_user_id = the address
//            (app/api/auth/email/verify/route.ts:54).
//
// Google and email-OTP therefore collapse onto ONE row keyed on the lowercased
// address. That is what makes "sign in with Google" and "email me a code" the same
// account today, and it has to survive this path.
//
// ORDER IS THE TIE-BREAK, because a Privy user may have several accounts linked
// and Splitsy has room for exactly one identity per row. X and Discord come first
// because a handle is what a bill tags — an email-keyed row cannot be tagged as
// @alice — so the identity that carries a handle wins over the one that does not.
// Deterministic rather than "best", which is what matters: the same Privy user
// must resolve to the same Splitsy row on every login.
export function privyProfile(accounts: readonly PrivyLinkedAccount[]): PrivyProfile | null {
  for (const a of accounts) {
    if (a.type === "twitter_oauth" && a.subject && a.username) {
      return { provider: "x", providerUserId: a.subject, handle: a.username, name: a.name ?? null, avatarUrl: a.profile_picture_url ?? null };
    }
  }
  for (const a of accounts) {
    if (a.type === "discord_oauth" && a.subject && a.username) {
      return { provider: "discord", providerUserId: a.subject, handle: a.username, name: null, avatarUrl: null };
    }
  }
  for (const a of accounts) {
    if (a.type === "google_oauth" && a.email) {
      const email = a.email.trim().toLowerCase();
      return { provider: "email", providerUserId: email, handle: email, name: a.name ?? null, avatarUrl: null };
    }
  }
  for (const a of accounts) {
    if (a.type === "email" && a.address) {
      const email = a.address.trim().toLowerCase();
      return { provider: "email", providerUserId: email, handle: email, name: null, avatarUrl: null };
    }
  }
  return null;
}

// The user's Privy EMBEDDED Ethereum wallet — the one this stack pays from.
//
// `connector_type: "embedded"` is the whole filter. A Privy user may also have
// linked a browser wallet (type "wallet", connector_type "injected"), and paying
// from that is not what this stack does: the embedded wallet is the one Privy
// created and can prompt to sign. NOTE: a pregenerated wallet does NOT reappear
// here on the tagged person's first login — the pre-mint is a separate Privy user
// and nothing links the two (lib/privy-wallet.ts pregenerateWallet). This reads
// the embedded wallet of whichever user it is handed; it is the pre-mint's own
// user at creation, and the real login's user afterwards.
export function privyEmbeddedWallet(
  accounts: readonly PrivyLinkedAccount[],
): { walletId: string; address: string } | null {
  for (const a of accounts) {
    if (a.type === "wallet" && a.connector_type === "embedded" && a.chain_type === "ethereum" && a.id && a.address) {
      return { walletId: a.id, address: a.address };
    }
  }
  return null;
}

// Injection seam, same shape and same reason as lib/wallet-resolve.ts's: the three
// side-effecting calls are stubbed in the unit test so the keying rules can be
// checked without a database.
export type IdentityDeps = {
  byProviderUserId: (provider: AccountProvider, providerUserId: string) => Promise<AppUser | null>;
  byHandle: (provider: AccountProvider, handle: string) => Promise<AppUser | null>;
  upsert: (profile: PrivyProfile) => Promise<AppUser>;
};

// Lazy imports for the same reason wallet-resolve.ts uses them: users-repo.ts
// reaches Supabase at call time, and deferring it lets `node --test` load this
// module with stub deps.
const realDeps: IdentityDeps = {
  byProviderUserId: async (provider, providerUserId) => {
    const { getUserByProviderUserId } = await import("./users-repo.ts");
    return getUserByProviderUserId(provider, providerUserId);
  },
  byHandle: async (provider, handle) => {
    const { getUserByProviderHandle } = await import("./users-repo.ts");
    return getUserByProviderHandle(provider, handle);
  },
  upsert: async (profile) => {
    const { upsertUserFromProvider } = await import("./users-repo.ts");
    return upsertUserFromProvider({
      provider: profile.provider,
      providerUserId: profile.providerUserId,
      handle: profile.handle,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
    });
  },
};

// Land a Privy login on the row this person already has, or make one.
//
// TWO LOOKUPS, NOT ONE, and the second is the whole point. The id lookup is the
// right answer when Privy's subject is the id the OAuth callback stored — which is
// EXPECTED for X and Discord and has never been measured. The handle lookup is the
// answer when it is not. Trying both costs one extra query on a first login and
// removes the failure entirely, which is worth far more than the query: the
// alternative was to measure the ids by hand on Preview and trust the result
// forever, and a wrong answer there is invisible at the moment it happens.
//
// THE FOUND ROW KEEPS ITS OWN KEY. When the handle lookup is what matched, the
// upsert is re-aimed at that row's existing provider_user_id rather than at
// Privy's subject — otherwise the "fix" would insert the duplicate it exists to
// prevent. The row's handle, name and avatar are refreshed either way.
//
// The handle lookup's one soft spot, stated rather than guarded: a username
// released and re-registered by someone else at X or Discord would match the
// original owner's row. Nothing in Privy's response distinguishes that case, it is
// testnet, and the alternative — never matching on handle — is the larger failure.
export async function upsertUserFromPrivy(
  profile: PrivyProfile,
  deps: IdentityDeps = realDeps,
): Promise<AppUser> {
  const existing =
    (await deps.byProviderUserId(profile.provider, profile.providerUserId)) ??
    (await deps.byHandle(profile.provider, profile.handle));

  return deps.upsert(existing ? { ...profile, providerUserId: existing.provider_user_id } : profile);
}

// Everything above this line is pure or injected. Below it is the network.

// Who a Privy access token says the caller is, and what Privy knows about them.
//
// VERIFIED SERVER-SIDE, ALWAYS. Privy's own guidance is that a client holding a
// valid token can reach Privy directly and skip anything the app checks, so a
// browser's claim about who it is is worth nothing here: the token is the only
// input, and it is checked against Privy's signing key before a single field of it
// is believed.
export async function privyUserFromToken(
  accessToken: string,
): Promise<{ privyUserId: string; accounts: PrivyLinkedAccount[] } | null> {
  const appId = process.env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) return null;

  const { PrivyClient } = await import("@privy-io/node");
  const client = new PrivyClient({ appId, appSecret });

  let privyUserId: string;
  try {
    privyUserId = (await client.utils().auth().verifyAccessToken(accessToken)).user_id;
  } catch {
    // An invalid, expired or forged token is one answer — the caller turns it into
    // a 401. Deliberately not told apart from the others: the remedy is the same
    // (log in again) and naming which one tells a prober how close they got.
    return null;
  }

  // _get rather than get: the public users().get() takes an IDENTITY token and
  // parses the user out of it, and the SDK warns that payload "may be incomplete
  // due to the size constraints of the identity token" — a user with several
  // linked accounts could arrive missing the one the mapping needs, which is the
  // silent-fork failure again. The underscore-prefixed reader asks Privy for the
  // whole user, the same escape hatch lib/privy-wallet.ts uses for _rpc.
  const user = await client.users()._get(privyUserId);
  return { privyUserId, accounts: (user.linked_accounts ?? []) as PrivyLinkedAccount[] };
}

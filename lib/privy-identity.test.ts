import assert from "node:assert/strict";
import { test } from "node:test";
import {
  privyEmbeddedWallet,
  privyProfile,
  upsertUserFromPrivy,
  type IdentityDeps,
  type PrivyLinkedAccount,
  type PrivyProfile,
} from "./privy-identity.ts";
import type { AppUser } from "./types.ts";

// Shapes copied from @privy-io/node's resources/users/users.d.ts. Only the fields
// the mapping reads are filled in; the rest are absent on purpose, so a mapping
// that started depending on one would fail here rather than in production.
const twitter = (subject: string, username: string): PrivyLinkedAccount => ({
  type: "twitter_oauth",
  subject,
  username,
  name: "Q Floppa",
  profile_picture_url: "https://pbs.twimg.com/x.jpg",
});
const discord = (subject: string, username: string): PrivyLinkedAccount => ({
  type: "discord_oauth",
  subject,
  username,
});
const google = (email: string): PrivyLinkedAccount => ({
  type: "google_oauth",
  subject: "108461234567890123456",
  email,
  name: "A Person",
});
const emailAccount = (address: string): PrivyLinkedAccount => ({ type: "email", address });

test("X maps to provider 'x' keyed on the twitter subject", () => {
  assert.deepEqual(privyProfile([twitter("21068173", "qFloppa")]), {
    provider: "x",
    providerUserId: "21068173",
    handle: "qFloppa",
    name: "Q Floppa",
    avatarUrl: "https://pbs.twimg.com/x.jpg",
  });
});

test("Discord maps to provider 'discord' keyed on the discord subject", () => {
  assert.deepEqual(privyProfile([discord("4412", "floppa")]), {
    provider: "discord",
    providerUserId: "4412",
    handle: "floppa",
    name: null,
    avatarUrl: null,
  });
});

// Privy hands back `name#discriminator`; Discord's own API and therefore every
// tagged row (bill_debts, escrow_deposits, pending_wallets) hold the bare name.
test("Discord drops Privy's discriminator so the handle matches what bills tag", () => {
  assert.equal(privyProfile([discord("1042943132188286976", "back_room#0")])?.handle, "back_room");
  assert.equal(privyProfile([discord("4412", "floppa#1234")])?.handle, "floppa");
});

// The one the plan calls out by name: google_oauth.subject is a Google `sub`, and
// keying on it would fork every Google user away from the email-keyed row the
// OAuth callback wrote (app/api/auth/google/callback/route.ts:138).
test("Google keys on the EMAIL, never on Google's subject", () => {
  const profile = privyProfile([google("Person@Example.COM")]);
  assert.equal(profile?.provider, "email");
  assert.equal(profile?.providerUserId, "person@example.com");
  assert.equal(profile?.handle, "person@example.com");
});

test("Email-OTP keys on the lowercased address", () => {
  const profile = privyProfile([emailAccount("  Person@Example.com ")]);
  assert.equal(profile?.provider, "email");
  assert.equal(profile?.providerUserId, "person@example.com");
});

// What makes "sign in with Google" and "email me a code" ONE account today.
test("a Google account and an email account at the same address produce the same key", () => {
  const viaGoogle = privyProfile([google("person@example.com")]);
  const viaOtp = privyProfile([emailAccount("person@example.com")]);
  assert.equal(viaGoogle?.provider, viaOtp?.provider);
  assert.equal(viaGoogle?.providerUserId, viaOtp?.providerUserId);
});

test("a handle-bearing identity wins over an email one, and the order is stable", () => {
  const accounts = [emailAccount("person@example.com"), google("person@example.com"), discord("4412", "floppa"), twitter("21068173", "qFloppa")];
  assert.equal(privyProfile(accounts)?.provider, "x");
  assert.equal(privyProfile([...accounts].reverse())?.provider, "x");
  assert.equal(privyProfile([emailAccount("p@e.com"), discord("4412", "floppa")])?.provider, "discord");
  assert.equal(privyProfile([emailAccount("p@e.com"), google("p@e.com")])?.provider, "email");
});

test("an unusable Privy user maps to nothing rather than to a guess", () => {
  assert.equal(privyProfile([]), null);
  assert.equal(privyProfile([{ type: "passkey" }]), null);
  // A linked account with no username is not a handle we can tag.
  assert.equal(privyProfile([{ type: "twitter_oauth", subject: "1", username: null, name: null, profile_picture_url: null }]), null);
});

test("the embedded Ethereum wallet is picked out, and a linked browser wallet is not", () => {
  const injected: PrivyLinkedAccount = {
    type: "wallet",
    connector_type: "injected",
    chain_type: "ethereum",
    address: "0x1111111111111111111111111111111111111111",
    id: "not-ours",
  };
  const embedded: PrivyLinkedAccount = {
    type: "wallet",
    connector_type: "embedded",
    chain_type: "ethereum",
    address: "0x2222222222222222222222222222222222222222",
    id: "wal_abc",
  };
  assert.deepEqual(privyEmbeddedWallet([injected, embedded]), {
    walletId: "wal_abc",
    address: "0x2222222222222222222222222222222222222222",
  });
  assert.equal(privyEmbeddedWallet([injected]), null);
  assert.equal(privyEmbeddedWallet([]), null);
});

// ── Which row a login lands on ────────────────────────────────────────────────

const row = (over: Partial<AppUser>): AppUser =>
  ({
    id: "u1",
    provider: "x",
    provider_user_id: "21068173",
    handle: "qFloppa",
    name: null,
    avatar_url: null,
    wallet_address: null,
    circle_wallet_id: null,
    agent_wallet_address: null,
    agent_wallet_id: null,
    pin_hash: null,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  }) as AppUser;

function deps(found: { byId?: AppUser | null; byHandle?: AppUser | null }) {
  const calls: { upserted: PrivyProfile[]; handleLookups: number } = { upserted: [], handleLookups: 0 };
  const impl: IdentityDeps = {
    byProviderUserId: async () => found.byId ?? null,
    byHandle: async () => {
      calls.handleLookups += 1;
      return found.byHandle ?? null;
    },
    upsert: async (profile) => {
      calls.upserted.push(profile);
      // Faithful to the real upsert: (provider, provider_user_id) is the conflict
      // target, so an upsert aimed at an existing row RETURNS that row.
      const hit = found.byId ?? found.byHandle;
      return row({
        id: hit && hit.provider_user_id === profile.providerUserId ? hit.id : "new",
        provider: profile.provider,
        provider_user_id: profile.providerUserId,
        handle: profile.handle,
      });
    },
  };
  return { impl, calls };
}

test("a matching provider id lands on that row and never asks about the handle", async () => {
  const { impl, calls } = deps({ byId: row({}) });
  await upsertUserFromPrivy(privyProfile([twitter("21068173", "qFloppa")])!, impl);
  assert.equal(calls.handleLookups, 0);
  assert.equal(calls.upserted[0].providerUserId, "21068173");
});

// The failure the whole two-lookup shape exists to prevent: Privy's subject does
// not have to be the id X's own API returned, and if it is not, keying on it
// creates a second @qFloppa with none of their debts.
test("a DIFFERENT Privy subject still lands on the existing row, under that row's own key", async () => {
  const { impl, calls } = deps({ byId: null, byHandle: row({ provider_user_id: "21068173" }) });
  const user = await upsertUserFromPrivy(privyProfile([twitter("privy-subject-not-x-id", "qfloppa")])!, impl);
  assert.equal(calls.upserted.length, 1);
  assert.equal(calls.upserted[0].providerUserId, "21068173", "must reuse the row's key, not Privy's subject");
  assert.equal(calls.upserted[0].handle, "qfloppa", "the handle is still refreshed from Privy");
  assert.equal(user.provider_user_id, "21068173");
});

test("a Google login lands on the existing EMAIL-keyed row rather than making a sub-keyed one", async () => {
  const existing = row({ id: "u9", provider: "email", provider_user_id: "person@example.com", handle: "person@example.com" });
  const { impl, calls } = deps({ byId: existing });
  const user = await upsertUserFromPrivy(privyProfile([google("Person@Example.com")])!, impl);
  assert.equal(user.id, "u9");
  assert.equal(calls.upserted[0].provider, "email");
  assert.equal(calls.upserted[0].providerUserId, "person@example.com");
});

test("nobody matching means a new row under Privy's own key", async () => {
  const { impl, calls } = deps({ byId: null, byHandle: null });
  await upsertUserFromPrivy(privyProfile([discord("4412", "floppa")])!, impl);
  assert.equal(calls.upserted[0].providerUserId, "4412");
  assert.equal(calls.upserted[0].provider, "discord");
});

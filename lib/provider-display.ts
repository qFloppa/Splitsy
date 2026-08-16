import type { AccountProvider } from "@/lib/types";

// How a tagged person renders for each identity provider: the avatar source, a
// link to their public profile (if the provider has one), and how their handle
// reads (X uses a leading "@", Discord doesn't). Centralised so the debt/history
// panels don't each re-implement the X-vs-Discord branching.
export type ProviderPerson = {
  provider?: AccountProvider | null;
  handle?: string | null;
  avatarUrl?: string | null;
};

export type ProviderDisplay = {
  provider: AccountProvider;
  avatarSrc: string | null;
  profileUrl: string | null;
  label: string;
  prefix: string;
};

export function providerDisplay(person: ProviderPerson): ProviderDisplay {
  const provider = person.provider ?? "x";
  const bare = person.handle?.replace(/^@/, "") ?? null;

  // A wallet account's handle IS its address, so it renders as one: shortened,
  // no avatar service to ask, no profile page to link. Without this branch it
  // would fall through to the X default and offer x.com/0xab…12.
  if (provider === "wallet") {
    return {
      provider,
      avatarSrc: person.avatarUrl ?? null,
      profileUrl: null,
      label: bare ? `${bare.slice(0, 6)}…${bare.slice(-4)}` : "?",
      prefix: "",
    };
  }

  if (provider === "discord") {
    return {
      provider,
      // Discord has no public username→avatar CDN (avatars need the user id +
      // hash), so only a stored avatar_url works — otherwise fall back to none.
      avatarSrc: person.avatarUrl ?? null,
      profileUrl: null, // Discord has no public per-username profile page.
      label: bare ?? "?",
      prefix: "", // Discord usernames don't carry a leading "@".
    };
  }

  if (provider === "email") {
    const email = person.handle ?? null;
    return {
      provider,
      // unavatar.io resolves a Gravatar (or provider-specific avatar) from an
      // email, so a tagged email shows a face even before they've signed in.
      // A stored avatar_url (Google picture) takes precedence once we have one.
      avatarSrc: person.avatarUrl || (email ? `https://unavatar.io/${encodeURIComponent(email)}` : null),
      profileUrl: null, // No public profile page for an email identity.
      label: email ?? "?",
      prefix: "",
    };
  }

  // X (default): unavatar.io resolves an avatar from the handle alone, so tagged
  // users show a picture even before they've signed in.
  return {
    provider: "x",
    avatarSrc: person.avatarUrl || (bare ? `https://unavatar.io/x/${bare}` : null),
    profileUrl: bare ? `https://x.com/${bare}` : null,
    label: bare ?? "?",
    prefix: "@",
  };
}

// The same identity as one phrase — "@alice on X" — for prose rather than a tag.
// Written for the wallet-collision refusals, which tell the user to go sign in on
// the account that already holds this wallet: naming the provider alone ("on x")
// left them to guess WHICH account of that provider's, which is the one thing
// they need to act on.
export function describeAccount(person: ProviderPerson): string {
  const d = providerDisplay(person);
  // A wallet account has no platform to be "on" — the address is the whole
  // identity, so it names itself.
  if (d.provider === "wallet") return `the wallet account ${d.label}`;
  const platform = d.provider === "x" ? "X" : d.provider[0].toUpperCase() + d.provider.slice(1);
  return `${d.prefix}${d.label} on ${platform}`;
}

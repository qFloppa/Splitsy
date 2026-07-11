import type { IdentityProvider } from "@/lib/types";

// How a tagged person renders for each identity provider: the avatar source, a
// link to their public profile (if the provider has one), and how their handle
// reads (X uses a leading "@", Discord doesn't). Centralised so the debt/history
// panels don't each re-implement the X-vs-Discord branching.
export type ProviderPerson = {
  provider?: IdentityProvider | null;
  handle?: string | null;
  avatarUrl?: string | null;
};

export type ProviderDisplay = {
  provider: IdentityProvider;
  avatarSrc: string | null;
  profileUrl: string | null;
  label: string;
  prefix: string;
};

export function providerDisplay(person: ProviderPerson): ProviderDisplay {
  const provider = person.provider ?? "x";
  const bare = person.handle?.replace(/^@/, "") ?? null;

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

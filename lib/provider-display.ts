import type { AccountProvider } from "@/lib/types";

// How a tagged person renders for each identity provider: the avatar source, a
// link to their public profile (if the provider has one), and how their handle
// reads (X uses a leading "@", Discord doesn't). Centralised so the debt/history
// panels don't each re-implement the X-vs-Discord branching.
export type ProviderPerson = {
  provider?: AccountProvider | null;
  handle?: string | null;
  avatarUrl?: string | null;
  // The wallet this person pays from, when it is known. Display-only: it is what
  // turns the tag into a link to the chain, and it is absent for a person who has
  // been tagged on a bill but never signed in (no wallet exists for them yet).
  address?: string | null;
};

export type ProviderDisplay = {
  provider: AccountProvider;
  avatarSrc: string | null;
  profileUrl: string | null;
  label: string;
  prefix: string;
  // The letter to draw when there is no avatar to show. Discord and email-OTP
  // accounts store no avatar_url at all, so this is the common case rather than
  // the fallback — an empty avatar slot collapses the row it should align.
  monogram: string | null;
};

// The first character worth drawing as an initial, uppercased.
//
// Punctuation is skipped rather than taken: an X handle may be typed with its
// "@" and Discord names routinely start with underscores, both of which would
// otherwise monogram every such person to the same glyph. Digits count — a
// handle can legitimately start with one, and "9" names its owner better than
// a question mark does.
function monogramOf(bare: string | null): string | null {
  return bare?.match(/[a-z0-9]/i)?.[0].toUpperCase() ?? null;
}

// A handle is UNTRUSTED TEXT on its way into a URL, so it is encoded before it
// gets there. It reaches us from an OAuth provider, from Privy, or from a bill's
// creation-time snapshot label — none of which this app controls — and the two
// URLs below are consumed as an href and as a CSS `url()`. A handle holding a
// quote or a bracket would otherwise terminate the `url()` early and let the
// rest of it be read as declarations.
//
// THE PARENTHESES ARE ESCAPED BY HAND because encodeURIComponent does not touch
// them — they are "unreserved marks" to it. Inside the quoted url("…") the tag
// writes today they are already harmless, the quote being the character that
// could end the string; escaping them anyway is one replace, and it means this
// stays safe if the quoting around it is ever changed.
//
// Nothing changes for a real handle: X allows [A-Za-z0-9_] and Discord's set is
// narrower still, and neither step touches any of those.
const urlSafe = (handle: string) =>
  encodeURIComponent(handle).replace(/\(/g, "%28").replace(/\)/g, "%29");

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
      // An address has no initial worth drawing — every one of them would
      // monogram to "0". ProviderIcon's wallet mark stands in for it.
      monogram: null,
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
      monogram: monogramOf(bare),
    };
  }

  if (provider === "email") {
    const email = person.handle ?? null;
    return {
      provider,
      // unavatar.io resolves a Gravatar (or provider-specific avatar) from an
      // email, so a tagged email shows a face even before they've signed in.
      // A stored avatar_url (Google picture) takes precedence once we have one.
      avatarSrc: person.avatarUrl || (email ? `https://unavatar.io/${urlSafe(email)}` : null),
      profileUrl: null, // No public profile page for an email identity.
      label: email ?? "?",
      prefix: "",
      monogram: monogramOf(email),
    };
  }

  // X (default): unavatar.io resolves an avatar from the handle alone, so tagged
  // users show a picture even before they've signed in.
  return {
    provider: "x",
    avatarSrc: person.avatarUrl || (bare ? `https://unavatar.io/x/${urlSafe(bare)}` : null),
    profileUrl: bare ? `https://x.com/${urlSafe(bare)}` : null,
    label: bare ?? "?",
    prefix: "@",
    monogram: monogramOf(bare),
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

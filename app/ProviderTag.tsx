"use client";

import { Mail, Wallet } from "lucide-react";
import { ARC_EXPLORER } from "@/lib/arc-explorer";
import { providerDisplay, type ProviderPerson } from "@/lib/provider-display";
import type { AccountProvider } from "@/lib/types";

// Exported so a surface that can't use ProviderIcon's pixel `size` can still
// draw the same mark — /owe sets its glyph in `em`, to sit as a letter inside a
// sentence whose type scales with the viewport.
export const DISCORD_PATH =
  "M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0a105.89 105.89 0 0 0-26.25 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.19-16.14c2.64-27.38-4.51-51.11-18.9-72.15ZM42.45 65.69C36.18 65.69 31 60 31 53s5-12.74 11.43-12.74S54 46 53.89 53s-5.05 12.69-11.44 12.69Zm42.24 0C78.41 65.69 73.25 60 73.25 53s5-12.74 11.44-12.74S96.23 46 96.12 53s-5.04 12.69-11.43 12.69Z";

// Small platform badge so a tagged handle reads unambiguously as X / Discord /
// Email / a raw wallet. Shared by the debt + history panels so the mapping lives
// in one place.
export function ProviderIcon({ provider, size = 13 }: { provider: AccountProvider; size?: number }) {
  if (provider === "discord") {
    return (
      <svg width={size} height={size} viewBox="0 0 127.14 96.36" fill="#5865f2" role="img" aria-label="Discord">
        <path d={DISCORD_PATH} />
      </svg>
    );
  }
  if (provider === "email") {
    return <Mail size={size} className="text-[var(--text-muted)]" aria-label="Email" />;
  }
  // An account owned by a browser wallet rather than a social identity — there
  // is no platform logo to show, so the badge says what it is.
  if (provider === "wallet") {
    return <Wallet size={size} className="text-[var(--text-muted)]" aria-label="Wallet" />;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/x.png" alt="X" width={size} height={size} style={{ width: size, height: size }} />;
}

// `size` sets the diameter, in px, for a caller that knows the number. Omit it
// and the surface's stylesheet decides via --ptag-size — which is how a tag sits
// in type that scales with the viewport (the pay roster sets it in `em`, so the
// circle grows with the name beside it instead of pinning to 22px at every width).
function sizeVar(size?: number | string) {
  if (size === undefined) return undefined;
  return { "--ptag-size": typeof size === "number" ? `${size}px` : size } as React.CSSProperties;
}

// The round part of a tag: a face if one loads, the handle's initial if not, and
// the platform mark notched into the corner either way.
//
// THE MONOGRAM IS THE COMMON CASE, NOT THE FALLBACK. We only ever store an
// avatar_url for X and Google sign-ins — Discord and email-OTP accounts have
// none — so a tag that only drew real pictures left most rows with an empty
// slot, and a row with no circle is visibly lighter than the ones beside it.
//
// SO THE FACE IS A BACKGROUND, NOT AN <img>, and that is the whole trick: a
// background-image that fails to load paints NOTHING, uncovering the monogram
// underneath it. The same thing written as an <img> cannot be made reliable —
// `avatarSrc` for an X or email identity is a guess resolved by unavatar.io from
// the handle alone, it answers for people who have never signed in, and when it
// 404s or rate-limits the browser paints its broken-image glyph. An onError
// handler does not save it either: an image that fails BEFORE hydration fires
// its error event into nothing, and the glyph then stays for the life of the
// page. No JavaScript is involved in the version below.
export function ProviderAvatar({ person, size }: { person: ProviderPerson; size?: number | string }) {
  const d = providerDisplay(person);

  return (
    <span className="ptag-avatar" data-provider={d.provider} style={sizeVar(size)}>
      {d.monogram ? (
        <span className="ptag-monogram">{d.monogram}</span>
      ) : (
        // A wallet address has no initial and no face. The mark fills the circle
        // instead of hanging off it — badging a wallet icon with a wallet icon
        // says the same thing twice.
        <span className="ptag-monogram ptag-monogram-glyph">
          <ProviderIcon provider={d.provider} />
        </span>
      )}
      {d.avatarSrc ? (
        // Quoted, and the handle inside it is percent-encoded by providerDisplay:
        // this value is interpolated into CSS, and a handle carrying a quote
        // would otherwise close the url() and have the remainder read as style.
        <span className="ptag-face" style={{ backgroundImage: `url("${d.avatarSrc}")` }} />
      ) : null}
      {d.monogram ? (
        <span className="ptag-badge">
          <ProviderIcon provider={d.provider} />
        </span>
      ) : null}
    </span>
  );
}

// A tagged person: badged avatar + handle, linking to their wallet on Arc.
//
// WHERE IT POINTS, AND WHY THE CHAIN WINS. A payer's question about the person
// who billed them is "who is this and where is my money going", and the address
// answers the second half — so when we know the wallet, the whole tag opens it
// on the explorer. The public profile is the fallback for someone who has been
// tagged on a bill but never signed in: there is no wallet for them yet, and an
// x.com page is better than a dead tag. Discord and email have neither, so those
// render as plain text.
export function ProviderTag({ person, size }: { person: ProviderPerson; size?: number | string }) {
  const d = providerDisplay(person);
  const href = person.address ? `${ARC_EXPLORER}/address/${person.address}` : d.profileUrl;

  const inner = (
    <>
      <ProviderAvatar person={person} size={size} />
      <span className="ptag-handle">
        {d.prefix}
        {d.label}
      </span>
    </>
  );

  if (href) {
    return (
      <a
        className="ptag"
        href={href}
        onClick={(e) => e.stopPropagation()}
        rel="noreferrer"
        target="_blank"
        // The address is what the link opens, so it is also what the tooltip
        // should say — the handle is already on screen.
        title={person.address ?? undefined}
      >
        {inner}
      </a>
    );
  }

  return <span className="ptag">{inner}</span>;
}

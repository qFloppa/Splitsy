"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

// Header "Sign in with X" button — only shows when signed out. Once signed in,
// the floating wallet widget (XAuthControl) takes over, so this renders null.
export default function XSignInButton() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/me")
      .then((r) => r.json())
      .then((d: { user: unknown }) => {
        if (active) setSignedIn(Boolean(d.user));
      })
      .catch(() => {
        if (active) setSignedIn(false);
      });
    return () => {
      active = false;
    };
  }, []);

  if (signedIn !== false) return null;

  return (
    <a
      href="/api/auth/twitter"
      className="inline-flex items-center gap-2 rounded-full bg-black px-3.5 py-2 text-sm font-semibold !text-white no-underline transition hover:opacity-90"
    >
      <Image src="/x.png" alt="" width={15} height={15} className="invert-0" />
      <span className="!text-white">Sign in with X</span>
    </a>
  );
}

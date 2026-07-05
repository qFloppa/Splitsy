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
      <a href="/bills" className="text-sm font-semibold text-[#1d9bf0]">
        Bills
      </a>
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

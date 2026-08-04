"use client";

import { useCallback, useEffect, useState } from "react";
import type { SocialDebt } from "./settle-items.ts";

type Row = {
  id: string;
  amount_usdc: string;
  status: string;
  bill: { merchant: string | null; creator: SocialDebt["creator"] } | null;
};

// Returns null when the list could not be read — signed out (/api/bills answers
// 401, which is ordinary) or the network failed. Null means "leave what you
// have", not "you owe nothing".
async function fetchSocialDebts(): Promise<SocialDebt[] | null> {
  const res = await fetch("/api/bills").catch(() => null);
  if (!res?.ok) return null;
  const data = await res.json().catch(() => ({}));
  const rows = (data.iOwe ?? []) as Row[];
  return rows
    .filter((row) => row.status !== "paid")
    .map((row) => ({
      id: row.id,
      amountUsd: Number(row.amount_usdc) || 0,
      merchant: row.bill?.merchant ?? "Bill",
      creator: row.bill?.creator ?? null,
    }));
}

// Unpaid off-chain debts tagged to the signed-in user's handle.
export function useSocialDebts(): { debts: SocialDebt[]; reload: () => Promise<void> } {
  const [debts, setDebts] = useState<SocialDebt[]>([]);

  const reload = useCallback(async () => {
    const next = await fetchSocialDebts();
    if (next) setDebts(next);
  }, []);

  useEffect(() => {
    let active = true;
    void fetchSocialDebts().then((next) => {
      if (active && next) setDebts(next);
    });
    return () => {
      active = false;
    };
  }, []);

  return { debts, reload };
}

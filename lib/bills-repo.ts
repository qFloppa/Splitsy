import { createSupabaseServerClient } from "@/lib/supabase";
import type { Bill, BillDebt } from "@/lib/types";

function requireClient() {
  const client = createSupabaseServerClient();
  if (!client) {
    throw new Error("Supabase is not configured");
  }
  return client;
}

export type NewDebt = { handle: string; amountUsdc: string };

export async function createBill(input: {
  creatorUserId: string;
  merchant: string | null;
  currency: string;
  totalUsdc: string;
  metadata?: unknown;
  debts: NewDebt[];
}): Promise<Bill> {
  const client = requireClient();

  const { data: bill, error: billError } = await client
    .from("bills")
    .insert({
      creator_user_id: input.creatorUserId,
      merchant: input.merchant,
      currency: input.currency,
      total_usdc: input.totalUsdc,
      metadata: input.metadata ?? {},
    })
    .select()
    .single();
  if (billError) {
    throw new Error(`Failed to create bill: ${billError.message}`);
  }

  const rows = input.debts.map((d) => ({
    bill_id: (bill as Bill).id,
    debtor_handle: d.handle.replace(/^@/, "").toLowerCase(),
    amount_usdc: d.amountUsdc,
  }));
  const { error: debtError } = await client.from("bill_debts").insert(rows);
  if (debtError) {
    throw new Error(`Failed to create debts: ${debtError.message}`);
  }

  return bill as Bill;
}

// Debts this user owes (matched to them by handle at login), with the bill and
// the creator's handle for display.
export async function listDebtsIOwe(userId: string) {
  const client = requireClient();
  const { data, error } = await client
    .from("bill_debts")
    .select("*, bill:bills(*, creator:users!creator_user_id(x_handle))")
    .eq("debtor_user_id", userId)
    .order("created_at", { ascending: false });
  if (error) {
    throw new Error(`Failed to read debts: ${error.message}`);
  }
  return data ?? [];
}

// Bills this user created, each with its debts (owed to me).
export async function listBillsICreated(userId: string) {
  const client = requireClient();
  const { data, error } = await client
    .from("bills")
    .select("*, debts:bill_debts(*)")
    .eq("creator_user_id", userId)
    .order("created_at", { ascending: false });
  if (error) {
    throw new Error(`Failed to read bills: ${error.message}`);
  }
  return data ?? [];
}

// On login, link any pending debts tagged with this handle to the user.
export async function resolveDebtsForHandle(userId: string, handle: string): Promise<void> {
  const client = requireClient();
  const { error } = await client
    .from("bill_debts")
    .update({ debtor_user_id: userId })
    .eq("debtor_handle", handle.replace(/^@/, "").toLowerCase())
    .is("debtor_user_id", null);
  if (error) {
    throw new Error(`Failed to resolve debts: ${error.message}`);
  }
}

export type { Bill, BillDebt };

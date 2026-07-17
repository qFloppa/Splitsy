import { createSupabaseServerClient } from "@/lib/supabase";
import type { Bill, BillDebt, IdentityProvider } from "@/lib/types";

function requireClient() {
  const client = createSupabaseServerClient();
  if (!client) {
    throw new Error("Supabase is not configured");
  }
  return client;
}

export type NewDebt = { provider: IdentityProvider; handle: string; amountUsdc: string };

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
    debtor_provider: d.provider,
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
    .select("*, bill:bills(*, creator:users!creator_user_id(provider, handle, avatar_url))")
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
    .select("*, debts:bill_debts(*, debtor:users!debtor_user_id(provider, handle, avatar_url))")
    .eq("creator_user_id", userId)
    .order("created_at", { ascending: false });
  if (error) {
    throw new Error(`Failed to read bills: ${error.message}`);
  }
  return data ?? [];
}

// On login, link any pending debts tagged with this (provider, handle) to the
// user. Scoped by provider so an X @alice and a Discord "alice" never collide.
export async function resolveDebtsForHandle(
  userId: string,
  provider: IdentityProvider,
  handle: string,
): Promise<void> {
  const client = requireClient();
  const { error } = await client
    .from("bill_debts")
    .update({ debtor_user_id: userId })
    .eq("debtor_provider", provider)
    .eq("debtor_handle", handle.replace(/^@/, "").toLowerCase())
    .is("debtor_user_id", null);
  if (error) {
    throw new Error(`Failed to resolve debts: ${error.message}`);
  }
}

// A debt with the creator's wallet, for settlement.
export async function getDebtForSettlement(id: string) {
  const client = requireClient();
  const { data, error } = await client
    .from("bill_debts")
    .select("*, bill:bills(creator:users!creator_user_id(id, wallet_address))")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to read debt: ${error.message}`);
  }
  return data as
    | (BillDebt & { bill: { creator: { id: string; wallet_address: string | null } | null } | null })
    | null;
}

export async function markDebtPaid(id: string, txRef: string): Promise<void> {
  const client = requireClient();
  const { error } = await client
    .from("bill_debts")
    .update({ status: "paid", paid_tx_hash: txRef, paid_at: new Date().toISOString() })
    .eq("id", id);
  if (error) {
    throw new Error(`Failed to mark debt paid: ${error.message}`);
  }
}

// Transfer accepted by Circle but not yet COMPLETE — the webhook flips it.
// paid_tx_hash holds the Circle transaction id (not the on-chain hash) so the
// webhook can find the debt by the tx id in the notification.
export async function markDebtSettling(id: string, circleTxId: string): Promise<void> {
  const client = requireClient();
  const { error } = await client
    .from("bill_debts")
    .update({ status: "settling", paid_tx_hash: circleTxId, paid_at: null })
    .eq("id", id);
  if (error) {
    throw new Error(`Failed to mark debt settling: ${error.message}`);
  }
}

// Webhook: the transfer reached COMPLETE/CONFIRMED on chain. Keyed by Circle
// tx id; idempotent (a retry re-sets the same terminal state).
export async function confirmDebtPaidByTxId(circleTxId: string): Promise<void> {
  const client = requireClient();
  const { error } = await client
    .from("bill_debts")
    .update({ status: "paid", paid_at: new Date().toISOString() })
    .eq("paid_tx_hash", circleTxId)
    .neq("status", "paid"); // don't touch paid_at on webhook retries
  if (error) {
    throw new Error(`Failed to confirm debt paid: ${error.message}`);
  }
}

// Webhook: the transfer FAILED/DENIED/CANCELLED after we accepted it. Put the
// debt back so the debtor can retry. Clears the tx ref so a stale notification
// for the dead tx can't match again after a successful retry.
export async function revertDebtByTxId(circleTxId: string): Promise<void> {
  const client = requireClient();
  const { error } = await client
    .from("bill_debts")
    .update({ status: "pending", paid_tx_hash: null, paid_at: null })
    .eq("paid_tx_hash", circleTxId)
    .neq("status", "paid"); // COMPLETE and FAILED are exclusive; never un-pay on a stray event
  if (error) {
    throw new Error(`Failed to revert debt: ${error.message}`);
  }
}

// At-least-once delivery guard: true if this notificationId is new, false if
// we've already processed it (Circle retry). Insert-first so two concurrent
// deliveries can't both pass.
export async function recordWebhookEvent(input: {
  notificationId: string;
  notificationType: string;
  txId: string | null;
  txState: string | null;
}): Promise<boolean> {
  const client = requireClient();
  const { data, error } = await client
    .from("circle_webhook_events")
    .upsert(
      {
        notification_id: input.notificationId,
        notification_type: input.notificationType,
        tx_id: input.txId,
        tx_state: input.txState,
      },
      { onConflict: "notification_id", ignoreDuplicates: true },
    )
    .select("notification_id");
  if (error) {
    throw new Error(`Failed to record webhook event: ${error.message}`);
  }
  return (data ?? []).length > 0; // empty result = duplicate was ignored
}

export type { Bill, BillDebt };

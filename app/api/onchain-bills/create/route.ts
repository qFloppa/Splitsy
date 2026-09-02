import { after } from "next/server";
import { getSessionUser } from "@/lib/session";
import { triggerAutopay } from "@/lib/autopay-trigger";
import { resolveParticipants } from "@/lib/wallet-resolve";
import { billMetadataHash } from "@/lib/bill-metadata";
import { encodeCreateBill } from "@/lib/registry-calldata";
import { executeContract, InsufficientFundsError } from "@/lib/wallet-provider";
import { REGISTRY_ADDRESS, getBillOnchain, getBillIdsForSplitterOnchain } from "@/lib/arc-read";
import { publishOnchainBillPreimage } from "@/lib/onchain-bill-preimage-repo";
import { isShareToken } from "@/lib/pay-link";
import { participantProvidersFromSlots } from "./participant-providers";
import type { IdentityProvider } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVIDERS: IdentityProvider[] = ["x", "discord", "email"];
const toUnits = (usd: number) => BigInt(Math.round(usd * 1e6));

type InRow = { provider?: unknown; handle?: unknown; address?: unknown; label?: unknown; amountUsd?: unknown };

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  if (!user.circle_wallet_id || !user.wallet_address) {
    return Response.json({ error: "Your wallet isn't provisioned yet. Log in again." }, { status: 409 });
  }

  const body = (await request.json().catch(() => null)) as {
    merchant?: unknown; currency?: unknown; total?: unknown;
    participants?: InRow[]; receiptHash?: unknown; receiptImageBase64?: unknown; dueDate?: unknown;
    escrowUntilFull?: unknown; shareToken?: unknown;
  } | null;
  if (!body || !Array.isArray(body.participants) || body.participants.length === 0) {
    return Response.json({ error: "participants required" }, { status: 400 });
  }
  const merchant = typeof body.merchant === "string" ? body.merchant : "";
  const currency = typeof body.currency === "string" ? body.currency : "USD";
  const total = typeof body.total === "number" && Number.isFinite(body.total) ? body.total : NaN;
  if (!Number.isFinite(total)) return Response.json({ error: "invalid total" }, { status: 400 });
  const receiptHash = typeof body.receiptHash === "string" ? body.receiptHash : "";
  const receiptImageBase64 = typeof body.receiptImageBase64 === "string" ? body.receiptImageBase64 : undefined;
  // Optional due date (Unix seconds). Anything not a positive integer is treated
  // as "no due date" so a malformed value can't slip into the on-chain hash.
  const dueDate =
    typeof body.dueDate === "number" && Number.isInteger(body.dueDate) && body.dueDate > 0 ? body.dueDate : undefined;
  // Escrow requires a deadline to release it — the registry rejects the pair
  // outright, so refuse it here too rather than sending a call that reverts.
  const escrowUntilFull = body.escrowUntilFull === true && dueDate !== undefined;
  // Same rejection rule as the browser-wallet path: a malformed token means the
  // creator is holding a link that would never resolve.
  const shareToken = body.shareToken;
  if (shareToken !== undefined && !isShareToken(shareToken)) {
    return Response.json({ error: "Invalid share token" }, { status: 400 });
  }
  if (dueDate !== undefined && dueDate <= Math.floor(Date.now() / 1000)) {
    return Response.json({ error: "The due date must be in the future." }, { status: 400 });
  }

  // Split rows into social (need resolving) and raw-address, remembering order.
  const socialRows: { provider: IdentityProvider; handle: string }[] = [];
  const slots: ({ kind: "social"; idx: number; amountUsd: number; label: string } |
                { kind: "address"; address: `0x${string}`; amountUsd: number; label: string })[] = [];
  let payerN = 0;
  for (const r of body.participants) {
    const amountUsd = typeof r.amountUsd === "number" ? r.amountUsd : 0;
    if (amountUsd <= 0) continue;
    payerN += 1;
    if (typeof r.address === "string" && /^0x[a-fA-F0-9]{40}$/.test(r.address)) {
      const label = typeof r.label === "string" && r.label.trim() ? r.label.trim() : `Payer ${payerN}`;
      slots.push({ kind: "address", address: r.address as `0x${string}`, amountUsd, label });
    } else if (typeof r.provider === "string" && PROVIDERS.includes(r.provider as IdentityProvider) && typeof r.handle === "string") {
      const norm = r.handle.replace(/^@/, "").toLowerCase();
      socialRows.push({ provider: r.provider as IdentityProvider, handle: norm });
      slots.push({ kind: "social", idx: socialRows.length - 1, amountUsd, label: `@${norm}` });
    } else {
      return Response.json({ error: "each participant needs an address or provider+handle" }, { status: 400 });
    }
  }
  if (slots.length === 0) return Response.json({ error: "no participants with a positive share" }, { status: 400 });

  let resolvedSocial;
  try {
    resolvedSocial = await resolveParticipants(socialRows);
  } catch (err) {
    const message = err instanceof Error ? err.message : "resolve failed";
    return Response.json({ error: message }, { status: /not configured/i.test(message) ? 503 : 500 });
  }

  const addresses: `0x${string}`[] = [];
  const owed: bigint[] = [];
  const labels: string[] = [];
  for (const s of slots) {
    addresses.push(s.kind === "address" ? s.address : (resolvedSocial[s.idx].address as `0x${string}`));
    owed.push(toUnits(s.amountUsd));
    labels.push(s.label);
  }
  const participantProviders = participantProvidersFromSlots(slots, socialRows);

  const metadataHash = billMetadataHash({ merchant, currency, total, participantLabels: labels, receiptHash, dueDate });

  // Execute createBill from the creator's DCW. The hash is kept so callers can
  // link the creation on the explorer — it is null only if the poll timed out
  // before Circle reported one, which the caller reads as "no link".
  let txHash: string | null = null;
  try {
    ({ txHash } = await executeContract(user.circle_wallet_id, REGISTRY_ADDRESS, encodeCreateBill(metadataHash, addresses, owed, BigInt(dueDate ?? 0), escrowUntilFull)));
  } catch (err) {
    if (err instanceof InsufficientFundsError) return Response.json({ error: "insufficient_funds" }, { status: 402 });
    return Response.json({ error: err instanceof Error ? err.message : "createBill failed" }, { status: 502 });
  }

  // The DCW execution has no return value, so find the new bill: the highest id
  // for this splitter whose committed metadataHash matches what we just sent.
  let billId: bigint | null = null;
  try {
    const ids = await getBillIdsForSplitterOnchain(user.wallet_address as `0x${string}`);
    for (const id of [...ids].sort((a, b) => (a > b ? -1 : 1))) {
      const bill = await getBillOnchain(id);
      if (bill.metadataHash.toLowerCase() === metadataHash.toLowerCase()) { billId = id; break; }
    }
  } catch {
    // fall through — creation succeeded even if we can't pin the id right now
  }
  if (billId === null) {
    return Response.json({ error: "Bill created, but its id could not be confirmed. Refresh to see it.", txHash }, { status: 202 });
  }

  // Publish the preimage (best-effort) so payers can verify. Reuses the server
  // publisher, which re-reads the on-chain hash and hard-gates a mismatch.
  try {
    const receiptBytes = receiptImageBase64 ? new Uint8Array(Buffer.from(receiptImageBase64, "base64")) : null;
    // A receipt image that doesn't hash to the committed receiptHash is rejected
    // inside publishOnchainBillPreimage (hard gate) and swallowed by this catch —
    // text-only publish is impossible once a receiptHash is committed on-chain.
    await publishOnchainBillPreimage(
      { registryAddress: REGISTRY_ADDRESS, billId: billId.toString(), merchant, currency, total, participantLabels: labels, participantProviders, receiptHash, dueDate, shareToken: shareToken as string | undefined },
      metadataHash,
      receiptBytes,
    );
    // Only now can the agent check what it is about to pay for. The BillCreated
    // webhook already woke it a moment ago and it skipped for want of this row;
    // this second wake is the one that can actually verify. Inside the try, so a
    // failed publish leaves that honest `unverifiable` skip standing.
    const origin = new URL(request.url).origin;
    after(() => triggerAutopay(origin, billId.toString()));
  } catch (err) {
    console.error("Preimage publish failed (bill still created):", err);
  }

  return Response.json({ billId: billId.toString(), txHash });
}

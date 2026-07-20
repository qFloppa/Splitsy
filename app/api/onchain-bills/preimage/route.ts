import { createPublicClient, http } from "viem";
import { arcTestnet } from "viem/chains";
import { getOnchainBillPreimage, publishOnchainBillPreimage } from "@/lib/onchain-bill-preimage-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Minimal read-only view of BillSplitRegistry.getBill — just enough to pull the
// committed metadataHash the server validates a submitted preimage against.
const getBillAbi = [
  {
    type: "function",
    name: "getBill",
    stateMutability: "view",
    inputs: [{ name: "billId", type: "uint256" }],
    outputs: [
      { name: "splitter", type: "address" },
      { name: "metadataHash", type: "bytes32" },
      { name: "totalOwed", type: "uint256" },
      { name: "totalPaid", type: "uint256" },
      { name: "claimed", type: "uint256" },
      { name: "participantList", type: "address[]" },
    ],
  },
] as const;

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network"),
});

function isAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isBillId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]+$/.test(value);
}

// GET /api/onchain-bills/preimage?registry=0x..&billId=5 → the published preimage
// (the payer's browser re-hashes it against the chain). 404 when unpublished.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const registry = url.searchParams.get("registry");
  const billId = url.searchParams.get("billId");
  if (!isAddress(registry) || !isBillId(billId)) {
    return Response.json({ error: "registry and billId are required" }, { status: 400 });
  }

  const preimage = await getOnchainBillPreimage(registry, billId);
  if (!preimage) {
    return Response.json({ error: "not_published" }, { status: 404 });
  }
  return Response.json({ preimage });
}

// POST /api/onchain-bills/preimage — the creator publishes a bill's plaintext
// details right after createBill. The server reads the real metadataHash from
// Arc and refuses to store anything that doesn't match, so a stored record is
// always genuine.
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    registryAddress?: unknown;
    billId?: unknown;
    merchant?: unknown;
    currency?: unknown;
    total?: unknown;
    participantLabels?: unknown;
    receiptHash?: unknown;
    receiptImageBase64?: unknown;
    dueDate?: unknown;
  } | null;
  if (!body) {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const {
    registryAddress,
    billId,
    merchant,
    currency,
    total,
    participantLabels,
    receiptHash,
    receiptImageBase64,
    dueDate,
  } = body;
  if (!isAddress(registryAddress) || !isBillId(billId)) {
    return Response.json({ error: "registryAddress and billId are required" }, { status: 400 });
  }
  if (
    typeof merchant !== "string" ||
    typeof currency !== "string" ||
    typeof total !== "number" ||
    !Number.isFinite(total) ||
    !Array.isArray(participantLabels) ||
    !participantLabels.every((label) => typeof label === "string") ||
    typeof receiptHash !== "string" ||
    (receiptImageBase64 !== undefined && typeof receiptImageBase64 !== "string")
  ) {
    return Response.json({ error: "Invalid bill fields" }, { status: 400 });
  }
  // Optional due date: a positive integer Unix timestamp (seconds), or absent/0
  // for "no due date". Reject anything else so a malformed value can't slip into
  // the commitment the payer will re-hash.
  if (
    dueDate !== undefined &&
    (typeof dueDate !== "number" || !Number.isInteger(dueDate) || dueDate < 0)
  ) {
    return Response.json({ error: "Invalid due date" }, { status: 400 });
  }
  const normalizedDueDate = typeof dueDate === "number" && dueDate > 0 ? dueDate : undefined;
  // A committed receiptHash requires the image bytes to store; "" requires none.
  if (Boolean(receiptHash) !== Boolean(receiptImageBase64)) {
    return Response.json({ error: "receiptHash and receiptImageBase64 must be provided together" }, { status: 400 });
  }
  const receiptBytes = receiptImageBase64 ? new Uint8Array(Buffer.from(receiptImageBase64, "base64")) : null;

  // Read the committed hash straight from Arc — never trust a client-sent hash.
  let onchainHash: `0x${string}`;
  try {
    const bill = await publicClient.readContract({
      address: registryAddress as `0x${string}`,
      abi: getBillAbi,
      functionName: "getBill",
      args: [BigInt(billId)],
    });
    onchainHash = bill[1];
  } catch {
    return Response.json({ error: "Could not read the bill from Arc." }, { status: 502 });
  }

  try {
    await publishOnchainBillPreimage(
      { registryAddress, billId, merchant, currency, total, participantLabels, receiptHash, dueDate: normalizedDueDate },
      onchainHash,
      receiptBytes,
    );
  } catch (err) {
    // A mismatch is a client error (wrong details), not a server fault.
    const message = err instanceof Error ? err.message : "Failed to publish";
    const status = message.includes("does not match") ? 409 : 500;
    return Response.json({ error: message }, { status });
  }
  return Response.json({ ok: true });
}

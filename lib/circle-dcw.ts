import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

type Client = ReturnType<typeof initiateDeveloperControlledWalletsClient>;
let cachedClient: Client | null = null;

// Returns the DCW client + wallet set id, or null when Circle isn't configured
// (so login keeps working without wallet provisioning).
function getConfig(): { client: Client; walletSetId: string } | null {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  const walletSetId = process.env.CIRCLE_WALLET_SET_ID;
  if (!apiKey || !entitySecret || !walletSetId || apiKey.includes("your_circle_api_key")) {
    return null;
  }
  cachedClient ??= initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
  return { client: cachedClient, walletSetId };
}

const ARC_USDC_ADDRESS = process.env.ARC_TESTNET_USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000";

export type ArcWallet = { address: string; walletId: string };

// Transfer USDC on Arc Testnet from a DCW to any address. The wallet pays its
// own gas (USDC on Arc) at the MEDIUM fee level.
// ponytail: no Gas Station paymaster — add a policy + sponsor gas if we want
// truly gasless payments; for now the debtor's wallet needs a little USDC for gas.
export async function transferUsdcOnArc(
  fromWalletId: string,
  toAddress: string,
  amountUsdc: string,
): Promise<{ id: string; state: string }> {
  const config = getConfig();
  if (!config) throw new Error("Circle is not configured");

  let res;
  try {
    // ponytail: cast the whole input — SDK 9.2.0's transfer union types lag the API
    // (ARC-TESTNET missing) and mis-discriminate the walletId+tokenAddress branch.
    // Shape verified against Circle's createTransaction docs.
    res = await config.client.createTransaction({
      walletId: fromWalletId,
      blockchain: "ARC-TESTNET",
      tokenAddress: ARC_USDC_ADDRESS,
      amount: [String(amountUsdc)], // Supabase returns numeric as a JS number; Circle wants a string
      destinationAddress: toAddress,
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    } as unknown as Parameters<typeof config.client.createTransaction>[0]);
  } catch (e) {
    // The SDK (axios) hides Circle's real message behind "Request failed with
    // status code 400". Surface the response body so the cause is visible.
    const body = (e as { response?: { data?: unknown } })?.response?.data;
    const raw = body ? JSON.stringify(body) : (e as Error).message;
    // Detect the common "not enough USDC (for the amount or for gas)" case so
    // callers can show a friendly funding prompt instead of a raw dump.
    if (/insufficient|not enough|balance|exceeds/i.test(raw)) {
      throw new InsufficientFundsError();
    }
    throw new Error(`Circle transfer failed: ${raw}`);
  }
  if (!res.data?.id) throw new Error("Circle transfer returned no transaction id");
  return { id: res.data.id, state: res.data.state };
}

export class InsufficientFundsError extends Error {
  constructor() {
    super("insufficient_funds");
    this.name = "InsufficientFundsError";
  }
}

export type WalletTx = {
  id: string;
  direction: "in" | "out";
  amount: string;
  address: string; // counterparty
  state: string;
  txHash: string | null;
  date: string;
};

// Recent USDC transactions for a wallet, normalised for the history UI.
export async function listWalletTransactions(walletId: string): Promise<WalletTx[]> {
  const config = getConfig();
  if (!config) return [];

  // Note: the `blockchain` filter is rejected (400) by listTransactions, so we
  // filter by wallet only and rely on that wallet being Arc-only.
  const res = await config.client.listTransactions({ walletIds: [walletId] });

  return (res.data?.transactions ?? []).map((t) => {
    const outgoing = t.transactionType === "OUTBOUND";
    return {
      id: t.id,
      direction: outgoing ? "out" : "in",
      amount: Array.isArray(t.amounts) ? (t.amounts[0] ?? "0") : "0",
      address: outgoing ? (t.destinationAddress ?? "") : (t.sourceAddress ?? ""),
      state: t.state ?? "",
      txHash: t.txHash ?? null,
      date: t.createDate ?? "",
    };
  });
}

// Get the user's Arc developer-controlled wallet, creating it (SCA) on first
// call. refId = X user id makes it idempotent — a repeat call returns the same
// wallet instead of minting a new one. Returns null if Circle isn't configured.
export async function getOrCreateArcWallet(xUserId: string): Promise<ArcWallet | null> {
  const config = getConfig();
  if (!config) return null;
  const { client, walletSetId } = config;

  const existing = await client.listWallets({ refId: xUserId, blockchain: "ARC-TESTNET" });
  const found = existing.data?.wallets?.[0];
  if (found) return { address: found.address, walletId: found.id };

  const created = await client.createWallets({
    blockchains: ["ARC-TESTNET"],
    accountType: "SCA",
    count: 1,
    walletSetId,
    metadata: [{ refId: xUserId, name: `splitsy:${xUserId}` }],
  });
  const wallet = created.data?.wallets?.[0];
  if (!wallet) throw new Error("Circle createWallets returned no wallet");
  return { address: wallet.address, walletId: wallet.id };
}

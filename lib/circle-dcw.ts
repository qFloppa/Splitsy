import { randomUUID } from "node:crypto";
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

// Execute an arbitrary contract call from a DCW on Arc (createBill / approve /
// payDebt / claim). callData is ABI-encoded by the caller (lib/registry-calldata).
// We poll to a terminal state because callers need the result: bill creation
// needs the BillCreated billId (read from chain afterward), and pay/claim need
// to know the tx didn't revert. The wallet pays its own gas in USDC at MEDIUM.
export async function executeContractOnArc(
  walletId: string,
  contractAddress: string,
  callData: `0x${string}`,
): Promise<{ id: string; state: string; txHash: string | null }> {
  const config = getConfig();
  if (!config) throw new Error("Circle is not configured");

  let created;
  try {
    // Cast the input for the same reason transferUsdcOnArc does: SDK 9.2.0's
    // union types lag the API and omit ARC-TESTNET.
    created = await config.client.createContractExecutionTransaction({
      walletId,
      contractAddress,
      callData,
      blockchain: "ARC-TESTNET",
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      idempotencyKey: randomUUID(),
    } as unknown as Parameters<typeof config.client.createContractExecutionTransaction>[0]);
  } catch (e) {
    const body = (e as { response?: { data?: unknown } })?.response?.data;
    const raw = body ? JSON.stringify(body) : (e as Error).message;
    if (/insufficient|not enough|balance|exceeds/i.test(raw)) {
      throw new InsufficientFundsError();
    }
    throw new Error(`Circle contract execution failed: ${raw}`);
  }

  const id = created.data?.id;
  if (!id) throw new Error("Circle contract execution returned no transaction id");

  // Poll to a terminal state (~60s cap). Arc settles fast on testnet.
  const terminalOk = new Set(["COMPLETE", "CONFIRMED"]);
  const terminalBad = new Set(["FAILED", "DENIED", "CANCELLED"]);
  for (let i = 0; i < 30; i++) {
    const tx = await config.client.getTransaction({ id });
    const state = tx.data?.transaction?.state ?? "";
    const txHash = tx.data?.transaction?.txHash ?? null;
    if (terminalOk.has(state)) return { id, state, txHash };
    if (terminalBad.has(state)) throw new Error(`Contract execution ${state.toLowerCase()}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  // Still pending after the cap — return what we have; the caller decides.
  return { id, state: "PENDING", txHash: null };
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
// call. refId = "<provider>:<provider_user_id>" makes it idempotent AND keeps
// providers in separate namespaces — an X and a Discord user whose numeric
// snowflakes happen to collide never share a wallet. A repeat call returns the
// same wallet instead of minting a new one. Returns null if Circle isn't
// configured. (Existing pre-namespacing X users already have a stored
// wallet_address, so the callback skips re-provisioning them.)
export async function getOrCreateArcWallet(
  provider: string,
  providerUserId: string,
): Promise<ArcWallet | null> {
  const config = getConfig();
  if (!config) return null;
  const { client, walletSetId } = config;

  const refId = `${provider}:${providerUserId}`;
  const existing = await client.listWallets({ refId, blockchain: "ARC-TESTNET" });
  const found = existing.data?.wallets?.[0];
  if (found) return { address: found.address, walletId: found.id };

  const created = await client.createWallets({
    blockchains: ["ARC-TESTNET"],
    accountType: "SCA",
    count: 1,
    walletSetId,
    metadata: [{ refId, name: `splitsy:${refId}` }],
  });
  const wallet = created.data?.wallets?.[0];
  if (!wallet) throw new Error("Circle createWallets returned no wallet");
  return { address: wallet.address, walletId: wallet.id };
}

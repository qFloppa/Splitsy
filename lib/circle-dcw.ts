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
// Since the on-chain autopay mandate landed, the AGENT wallet needs gas only —
// never a float. Bill money comes from the debtor under AutopayMandate, so the
// worst a starved agent wallet can do is fail to act. Arc Testnet is documented
// as shipping a preconfigured Gas Station policy for developer-controlled SCA
// wallets, which would remove even that; UNVERIFIED here — confirm a sponsored
// transaction actually appears under the policy in the Circle console before
// relying on it, and keep a couple of test USDC on the agent until you have.
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
//
// pollMs bounds the wait, defaulting to the 60s every existing caller was
// written against. It exists for callers under a platform deadline, where
// waiting longer than the request can live turns a slow settlement into a
// killed one — and a killed request cannot write the row that says what it did.
export async function executeContractOnArc(
  walletId: string,
  contractAddress: string,
  callData: `0x${string}`,
  pollMs = 60_000,
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

  // Poll to a terminal state. Arc settles fast on testnet, so the default cap is
  // generous rather than expected; callers on a platform deadline pass a tighter
  // one (see app/api/agents/autopay/route.ts, which fits six of these plus three
  // chain waits inside Vercel's 300s ceiling).
  const terminalOk = new Set(["COMPLETE", "CONFIRMED"]);
  const terminalBad = new Set(["FAILED", "DENIED", "CANCELLED"]);
  for (let i = 0; i < Math.max(1, Math.ceil(pollMs / 2000)); i++) {
    let tx;
    try {
      tx = await config.client.getTransaction({ id });
    } catch (err) {
      // PAST THE POINT OF NO RETURN. Circle accepted the transaction — it has an
      // id — so it is very likely to mine no matter what this poll saw. Only
      // throws from here carry the tag: a caller settling money has to count
      // this as spent, whereas everything above genuinely moved nothing.
      throw Object.assign(err as Error, { broadcast: true as const });
    }
    const state = tx.data?.transaction?.state ?? "";
    const txHash = tx.data?.transaction?.txHash ?? null;
    if (terminalOk.has(state)) return { id, state, txHash };
    // Deliberately UNTAGGED. DENIED and CANCELLED never reached the chain, and a
    // FAILED transaction reverted — it burned gas but moved no USDC. All three
    // mean the money did not move and never will.
    //
    // Circle fills errorReason/errorDetails on FAILED, and the bare state alone
    // reads as "something went wrong" to whoever is holding the bill. It still
    // won't name a revert's cause (a revert carries no reason string), so the
    // predictable ones are pre-checked instead — see usdcShortfallMessage.
    if (terminalBad.has(state)) {
      const why = [tx.data?.transaction?.errorReason, tx.data?.transaction?.errorDetails]
        .filter(Boolean)
        .join(" — ");
      throw new Error(`Contract execution ${state.toLowerCase()}${why ? `: ${why}` : ""}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  // Still pending after the cap — return what we have; the caller decides.
  return { id, state: "PENDING", txHash: null };
}

// Whether a throw from executeContractOnArc happened AFTER Circle accepted the
// transaction, so the caller must assume it may still mine.
//
// Read through a predicate rather than as a bare property test at each call
// site, for the same reason as lib/settler.ts's isIndeterminate: this decides
// whether a settlement is logged as spent, and a typo would silently pick the
// wrong row. Absence means never-broadcast, which is the safe default — it is
// the only answer that never invents a settlement.
export const isBroadcast = (e: unknown): boolean => (e as { broadcast?: boolean })?.broadcast === true;

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

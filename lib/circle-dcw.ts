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

export type ArcWallet = { address: string; walletId: string };

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

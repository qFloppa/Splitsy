// One-off backfill for identity NFTs minted before the ownership + artwork
// fixes: re-points every registered agent's URI at fresh metadata (which now
// includes the image), then transfers registrar-held NFTs to the payer wallet
// they identify — so every payer owns their own agent NFT. Safe to re-run:
// already-transferred agents just get a metadata refresh, and a failing agent
// is logged and skipped rather than aborting the rest.
//
//   node --env-file=.env.local --experimental-strip-types scripts/reputation-backfill.ts
import { createPublicClient, encodeFunctionData, http } from "viem";
import { arcTestnet } from "viem/chains";
import { executeContractOnArc, getOrCreateArcWallet } from "../lib/circle-dcw.ts";
import { IDENTITY_REGISTRY, uploadMetadataToIPFS } from "../lib/erc8004.ts";
import { createSupabaseServerClient } from "../lib/supabase.ts";

const ABI = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "setAgentURI",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "agentURI", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "transferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const supabase = createSupabaseServerClient();
if (!supabase) throw new Error("Supabase is not configured in .env.local");
const registrar = await getOrCreateArcWallet("splitsy", "reputation-registrar");
if (!registrar) throw new Error("Circle is not configured in .env.local");

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network"),
});

// Circle wallet id for an address we control — looked up by address, NOT via
// getOrCreateArcWallet, which would mint a fresh wallet on a refId miss.
async function findWalletIdByAddress(address: string): Promise<string | null> {
  const params = new URLSearchParams({ address, blockchain: "ARC-TESTNET" });
  const res = await fetch(`https://api.circle.com/v1/w3s/wallets?${params}`, {
    headers: { accept: "application/json", authorization: `Bearer ${process.env.CIRCLE_API_KEY}` },
  });
  const json = (await res.json().catch(() => ({}))) as { data?: { wallets?: { id: string }[] } };
  return json.data?.wallets?.[0]?.id ?? null;
}

const { data: agents, error } = await supabase
  .from("reputation_agents")
  .select("wallet_address, agent_id, created_at")
  .not("agent_id", "is", null);
if (error) throw new Error(error.message);

for (const agent of (agents ?? []) as { wallet_address: string; agent_id: string; created_at: string }[]) {
  try {
    const tokenId = BigInt(agent.agent_id);
    const owner = (
      await publicClient.readContract({
        address: IDENTITY_REGISTRY,
        abi: ABI,
        functionName: "ownerOf",
        args: [tokenId],
      })
    ).toLowerCase();
    console.log(`agent ${agent.agent_id} → payer ${agent.wallet_address}, owned by ${owner}`);

    const signerWalletId =
      owner === registrar.address.toLowerCase() ? registrar.walletId : await findWalletIdByAddress(owner);
    if (!signerWalletId) {
      console.log("  owner has no Circle wallet we control — skipping");
      continue;
    }

    // 1. Fresh metadata (adds the image, stamped with the real registration
    //    date). Must happen while we can still sign as the owner — i.e.
    //    before any transfer to a browser wallet.
    const uri = await uploadMetadataToIPFS(agent.wallet_address, new Date(agent.created_at));
    await executeContractOnArc(
      signerWalletId,
      IDENTITY_REGISTRY,
      encodeFunctionData({ abi: ABI, functionName: "setAgentURI", args: [tokenId, uri] }),
    );
    console.log(`  setAgentURI ok (${uri.slice(0, 64)}…)`);

    // 2. Hand registrar-held NFTs to the payer they identify.
    if (owner === registrar.address.toLowerCase() && agent.wallet_address.toLowerCase() !== owner) {
      await executeContractOnArc(
        registrar.walletId,
        IDENTITY_REGISTRY,
        encodeFunctionData({
          abi: ABI,
          functionName: "transferFrom",
          args: [registrar.address as `0x${string}`, agent.wallet_address as `0x${string}`, tokenId],
        }),
      );
      console.log(`  transferred to ${agent.wallet_address} ok`);
    }
  } catch (err) {
    console.error(`  FAIL agent ${agent.agent_id}:`, err instanceof Error ? err.message : err);
  }
}
console.log("\nDone. Re-run safely if any agent failed (e.g. fund the owner wallet with faucet USDC first).");

// One-off backfill for identity NFTs minted before the ownership + artwork
// fixes: re-points every registered agent's URI at fresh metadata (which now
// includes the image), then sends each NFT to the wallet its row names — a payer
// owns their own reputation NFT, an autopay agent holds its own identity. Safe
// to re-run: already-correct agents just get a metadata refresh, and a failing
// agent is logged and skipped rather than aborting the rest.
//
// The CURRENT holder signs the transfer, so that wallet needs faucet USDC for
// gas (Arc bills gas in USDC) — including a signin DCW holding an autopay
// agent's identity by mistake.
//
//   node --env-file=.env.local --experimental-strip-types scripts/reputation-backfill.ts
//
// Pass agent ids to repair only those — worth having when the rest are fine and
// each extra agent is an on-chain write paid for out of somebody's wallet:
//
//   … scripts/reputation-backfill.ts 870086
import { createPublicClient, encodeFunctionData, http } from "viem";
import { arcTestnet } from "viem/chains";
// CIRCLE-ONLY BY DESIGN, and deliberately NOT re-pointed at lib/wallet-provider.ts:
// findWalletIdByAddress below calls api.circle.com with CIRCLE_API_KEY directly and
// has no Privy analogue, so importing the seam here would produce a HALF-migrated
// script — Privy wallets for the writes, Circle's REST API for the lookup that
// decides who signs them. It fails closed on a Privy deployment anyway, which has no
// Circle credentials: getOrCreateArcWallet returns null and the throw below stops it
// before anything is sent. THE REAL HAZARD is a dev .env.local holding BOTH sets of
// credentials, where this runs happily against the Circle-side agents while the app
// it is repairing signs with Privy.
import { executeContractOnArc, getOrCreateArcWallet } from "../lib/circle-dcw.ts";
import { IDENTITY_REGISTRY, uploadMetadataToIPFS, type AgentType } from "../lib/erc8004.ts";
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

const only = new Set(process.argv.slice(2));

const { data: agents, error } = await supabase
  .from("reputation_agents")
  .select("wallet_address, agent_id, created_at, agent_type")
  .not("agent_id", "is", null);
if (error) throw new Error(error.message);

for (const agent of (agents ?? []) as {
  wallet_address: string;
  agent_id: string;
  created_at: string;
  agent_type: AgentType | null;
}[]) {
  if (only.size > 0 && !only.has(agent.agent_id)) continue;
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
    console.log(
      `agent ${agent.agent_id} → ${agent.agent_type ?? "splitsy-payer"} ${agent.wallet_address}, owned by ${owner}`,
    );

    const signerWalletId =
      owner === registrar.address.toLowerCase() ? registrar.walletId : await findWalletIdByAddress(owner);
    if (!signerWalletId) {
      console.log("  owner has no Circle wallet we control — skipping");
      continue;
    }

    // 1. Fresh metadata (adds the image, stamped with the real registration
    //    date). Must happen while we can still sign as the owner — i.e.
    //    before any transfer to a browser wallet.
    //
    //    The stored role decides what the metadata SAYS. Passing nothing here
    //    would re-describe every agent as a payer, which is how an autopay
    //    agent ends up with a payer's sentence carved into an immutable URI.
    const uri = await uploadMetadataToIPFS(
      agent.wallet_address,
      new Date(agent.created_at),
      agent.agent_type ?? "splitsy-payer",
    );
    await executeContractOnArc(
      signerWalletId,
      IDENTITY_REGISTRY,
      encodeFunctionData({ abi: ABI, functionName: "setAgentURI", args: [tokenId, uri] }),
    );
    console.log(`  setAgentURI ok (${uri.slice(0, 64)}…)`);

    // The explorer caches the OLD metadata, so a re-pointed URI changes nothing
    // a human can see until Blockscout re-reads it — and its own queue runs days
    // behind this registry. Ask it directly; best-effort, never fatal.
    await fetch(
      `${process.env.ARC_TESTNET_EXPLORER_URL ?? "https://testnet.arcscan.app"}/api/v2/tokens/${IDENTITY_REGISTRY}/instances/${tokenId}/refetch-metadata`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}" },
    ).catch(() => undefined);

    // 2. Send the NFT to the wallet the row NAMES, whoever is holding it.
    //
    // Not just registrar-held ones, which is all this used to cover. An identity
    // belongs in the account it identifies, and there is a second way for it to
    // end up elsewhere: user-agent.ts used to hand each autopay agent's identity
    // on to the owner's signin wallet, copying the reputation handover it is not.
    // That left 'splitsy-user-agent' rows naming an agent wallet whose NFT sits
    // in a person's wallet. One rule fixes both, and any future misplacement:
    // owner != wallet_address means move it back. signerWalletId is already the
    // CURRENT owner's wallet — nobody else can sign this — and an owner we do not
    // control was skipped above rather than transferred from.
    if (owner !== agent.wallet_address.toLowerCase()) {
      await executeContractOnArc(
        signerWalletId,
        IDENTITY_REGISTRY,
        encodeFunctionData({
          abi: ABI,
          functionName: "transferFrom",
          args: [owner as `0x${string}`, agent.wallet_address as `0x${string}`, tokenId],
        }),
      );
      console.log(`  transferred ${owner} → ${agent.wallet_address} ok`);
    }
  } catch (err) {
    console.error(`  FAIL agent ${agent.agent_id}:`, err instanceof Error ? err.message : err);
  }
}
console.log("\nDone. Re-run safely if any agent failed (e.g. fund the owner wallet with faucet USDC first).");

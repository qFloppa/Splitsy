export const ARC_TESTNET_NETWORK = "eip155:5042002" as const;
export const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000" as const;
export const ARC_TESTNET_GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" as const;

// The RPC every server-side client and script here talks to.
//
// Read from the environment rather than pinned to the public endpoint, which
// rate-limits: -32011 'request limit reached' surfaces as a failed contract
// READ, so it looks like a broken call rather than a quota. Every other module
// in this repo (lib/arc-read.ts, lib/erc8004.ts, lib/wagmi.ts, …) already reads
// these same two variables; this const was the one place that ignored them, so
// the agent economy alone kept hitting the public node.
//
// The server-only variable wins, so a keyed URL need not be published into the
// browser bundle. Nothing under app/ imports this file today, but the public
// variable is the fallback anyway — it is what the rest of the app uses, and it
// keeps this correct if that ever changes.
export const ARC_TESTNET_RPC =
  process.env.ARC_TESTNET_RPC_URL ??
  process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL ??
  "https://rpc.testnet.arc.network";
export const ARC_IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;

/** "$0.005" -> "5000" (atomic 6-dp USDC string). */
export function usdToAtomic(price: string): string {
  const dollars = parseFloat(price.replace("$", ""));
  if (!Number.isFinite(dollars) || dollars < 0) throw new Error(`Invalid price: ${price}`);
  return Math.round(dollars * 1_000_000).toString();
}

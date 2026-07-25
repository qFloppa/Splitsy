export const ARC_TESTNET_NETWORK = "eip155:5042002" as const;
export const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000" as const;
export const ARC_TESTNET_GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" as const;
export const ARC_TESTNET_RPC = "https://rpc.testnet.arc.network" as const;
export const ARC_IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;

/** "$0.005" -> "5000" (atomic 6-dp USDC string). */
export function usdToAtomic(price: string): string {
  const dollars = parseFloat(price.replace("$", ""));
  if (!Number.isFinite(dollars) || dollars < 0) throw new Error(`Invalid price: ${price}`);
  return Math.round(dollars * 1_000_000).toString();
}

// Server-side (Node runtime) reads of RecurringTabFactory / RecurringTab.
// Mirrors lib/arc-read.ts: kept separate from the "use client"
// lib/recurring-contracts.ts so server routes never pull client code.
import { createPublicClient, decodeEventLog, http } from "viem";
import { arcTestnet } from "viem/chains";

export const RECURRING_TAB_FACTORY_ADDRESS = (
  process.env.NEXT_PUBLIC_RECURRING_TAB_FACTORY_ADDRESS ??
  "0x6c4d980f7a9250e3892a3541b5a62420b628f3c1"
) as `0x${string}`;

const FACTORY_READ_ABI = [
  {
    type: "function",
    name: "nextTabId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "tabs",
    stateMutability: "view",
    inputs: [{ name: "tabId", type: "uint256" }],
    outputs: [{ name: "tab", type: "address" }],
  },
  {
    type: "event",
    name: "TabCreated",
    anonymous: false,
    inputs: [
      { indexed: true, name: "tabId", type: "uint256" },
      { indexed: true, name: "tab", type: "address" },
      { indexed: true, name: "recipient", type: "address" },
      { indexed: false, name: "settlementInterval", type: "uint256" },
      { indexed: false, name: "maxSettlements", type: "uint256" },
    ],
  },
] as const;

const TAB_READ_ABI = [
  { type: "function", name: "tabId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "recipient", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "claimable", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxSettlements", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "isMember",
    stateMutability: "view",
    inputs: [{ name: "member", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "fixedShare",
    stateMutability: "view",
    inputs: [{ name: "member", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "totalSettledByMember",
    stateMutability: "view",
    inputs: [{ name: "member", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network"),
});

export async function getNextTabIdOnchain(): Promise<bigint> {
  return publicClient.readContract({
    address: RECURRING_TAB_FACTORY_ADDRESS,
    abi: FACTORY_READ_ABI,
    functionName: "nextTabId",
  });
}

// Provenance gate for the DCW authorize/claim routes: an arbitrary client-sent
// address is only acted on if OUR factory deployed it — the tab self-reports a
// tabId, and the factory's registry must map that id back to the same address.
// Anything else (an EOA, a look-alike contract) fails the read or the equality.
export async function verifyFactoryTab(tabAddress: `0x${string}`): Promise<boolean> {
  try {
    const tabId = await publicClient.readContract({
      address: tabAddress,
      abi: TAB_READ_ABI,
      functionName: "tabId",
    });
    const registered = await publicClient.readContract({
      address: RECURRING_TAB_FACTORY_ADDRESS,
      abi: FACTORY_READ_ABI,
      functionName: "tabs",
      args: [tabId],
    });
    return registered.toLowerCase() === tabAddress.toLowerCase();
  } catch {
    return false;
  }
}

export async function getTabRecipientOnchain(tabAddress: `0x${string}`): Promise<`0x${string}`> {
  return publicClient.readContract({ address: tabAddress, abi: TAB_READ_ABI, functionName: "recipient" });
}

export async function getTabClaimableOnchain(tabAddress: `0x${string}`): Promise<bigint> {
  return publicClient.readContract({ address: tabAddress, abi: TAB_READ_ABI, functionName: "claimable" });
}

// Member standing on a tab: whether `member` belongs to it, and how much of
// their lifetime debt (fixedShare * maxSettlements) is still uncollected —
// the cap the authorize route applies to any requested allowance.
export async function getTabMemberStandingOnchain(
  tabAddress: `0x${string}`,
  member: `0x${string}`,
): Promise<{ isMember: boolean; remainingTotal: bigint }> {
  const [isMember, fixedShare, maxSettlements, totalSettled] = await publicClient.multicall({
    allowFailure: false,
    contracts: [
      { address: tabAddress, abi: TAB_READ_ABI, functionName: "isMember", args: [member] },
      { address: tabAddress, abi: TAB_READ_ABI, functionName: "fixedShare", args: [member] },
      { address: tabAddress, abi: TAB_READ_ABI, functionName: "maxSettlements" },
      { address: tabAddress, abi: TAB_READ_ABI, functionName: "totalSettledByMember", args: [member] },
    ],
  });
  const totalDebt = fixedShare * maxSettlements;
  return { isMember, remainingTotal: totalSettled >= totalDebt ? 0n : totalDebt - totalSettled };
}

// Pin down the tab a DCW createTab execution just deployed. Preferred: decode
// the TabCreated event straight from the receipt (exact). Fallback (no txHash
// from Circle): scan the ids minted since `beforeNextTabId` for the newest tab
// whose recipient is the creator — the same "re-read and match" pattern the
// bills create route uses.
export async function findCreatedTab(
  txHash: string | null,
  beforeNextTabId: bigint,
  recipient: `0x${string}`,
): Promise<{ tabId: bigint; tabAddress: `0x${string}` } | null> {
  if (txHash && /^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== RECURRING_TAB_FACTORY_ADDRESS.toLowerCase()) continue;
        try {
          const decoded = decodeEventLog({ abi: FACTORY_READ_ABI, data: log.data, topics: log.topics });
          if (decoded.eventName === "TabCreated") {
            return { tabId: decoded.args.tabId, tabAddress: decoded.args.tab };
          }
        } catch {
          continue;
        }
      }
    } catch {
      // Receipt not available yet — fall through to the scan.
    }
  }

  const afterNextTabId = await getNextTabIdOnchain();
  for (let tabId = afterNextTabId - 1n; tabId >= beforeNextTabId; tabId--) {
    try {
      const tabAddress = await publicClient.readContract({
        address: RECURRING_TAB_FACTORY_ADDRESS,
        abi: FACTORY_READ_ABI,
        functionName: "tabs",
        args: [tabId],
      });
      if (tabAddress === "0x0000000000000000000000000000000000000000") continue;
      const tabRecipient = await getTabRecipientOnchain(tabAddress);
      if (tabRecipient.toLowerCase() === recipient.toLowerCase()) {
        return { tabId, tabAddress };
      }
    } catch {
      continue;
    }
  }
  return null;
}

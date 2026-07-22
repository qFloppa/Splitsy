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
  { type: "function", name: "createdAt", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "settlementInterval", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "settlementCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
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

// A tab settlement emits, per member: MemberSettled (amount pulled + success),
// and SettlementShortfall when the member couldn't cover their full cycle due.
// Reputation scores only members who paid IN FULL for the cycle — the pull-based
// analog of BillSplitRegistry.DebtPaid's paidInFull gate — so both events matter:
// a positive MemberSettled with NO accompanying SettlementShortfall.
export const MEMBER_SETTLED_ABI = [
  {
    type: "event",
    name: "MemberSettled",
    anonymous: false,
    inputs: [
      { indexed: true, name: "tabId", type: "uint256" },
      { indexed: true, name: "member", type: "address" },
      { indexed: false, name: "amount", type: "uint256" },
      { indexed: false, name: "success", type: "bool" },
    ],
  },
  {
    type: "event",
    name: "SettlementShortfall",
    anonymous: false,
    inputs: [
      { indexed: true, name: "tabId", type: "uint256" },
      { indexed: true, name: "member", type: "address" },
    ],
  },
] as const;

const publicClient = createPublicClient({
  chain: arcTestnet,
  // batch: coalesce concurrent eth_calls (the per-tab recipient/claimable reads
  // fanned out via Promise.all in listRecipientTabsOnchain) into batched
  // JSON-RPC POSTs. Complements multicall, which batches within a single tab.
  transport: http(process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network", {
    batch: true,
  }),
});

export async function getNextTabIdOnchain(): Promise<bigint> {
  return publicClient.readContract({
    address: RECURRING_TAB_FACTORY_ADDRESS,
    abi: FACTORY_READ_ABI,
    functionName: "nextTabId",
  });
}

// Recurring tabs where `recipient` is the payee (the reverse-lookup the
// dashboard needs). ponytail: full-scan of tab ids, same as the client's
// readRecurringTabsForWallet. Add an id index only if tab count grows enough
// to matter.
export async function listRecipientTabsOnchain(
  recipient: `0x${string}`,
): Promise<Array<{ address: `0x${string}`; claimable: bigint; settlementCount: bigint; maxSettlements: bigint }>> {
  const nextId = await getNextTabIdOnchain();
  const ids = Array.from({ length: Math.max(0, Number(nextId - 1n)) }, (_, i) => BigInt(i + 1));
  if (ids.length === 0) return [];
  const addrs = await publicClient.multicall({
    allowFailure: true,
    contracts: ids.map((id) => ({
      address: RECURRING_TAB_FACTORY_ADDRESS, abi: FACTORY_READ_ABI, functionName: "tabs", args: [id],
    })),
  });
  const tabAddrs = addrs
    .map((r) => (r.status === "success" ? (r.result as unknown as `0x${string}`) : null))
    .filter((a): a is `0x${string}` => Boolean(a) && a !== "0x0000000000000000000000000000000000000000");
  const rows = await Promise.all(
    tabAddrs.map(async (address) => {
      try {
        const [recip, claimable, settlementCount, maxSettlements] = await publicClient.multicall({
          allowFailure: false,
          contracts: [
            { address, abi: TAB_READ_ABI, functionName: "recipient" },
            { address, abi: TAB_READ_ABI, functionName: "claimable" },
            { address, abi: TAB_READ_ABI, functionName: "settlementCount" },
            { address, abi: TAB_READ_ABI, functionName: "maxSettlements" },
          ],
        });
        return { address, recipient: recip as `0x${string}`, claimable, settlementCount, maxSettlements };
      } catch {
        return null;
      }
    }),
  );
  return rows
    .filter((r): r is NonNullable<typeof r> => r !== null && r.recipient.toLowerCase() === recipient.toLowerCase())
    .map(({ address, claimable, settlementCount, maxSettlements }) => ({ address, claimable, settlementCount, maxSettlements }));
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

// Resolve a tab id to its deployed address via the factory registry, or the zero
// address if the id was never minted.
export async function getTabAddressOnchain(tabId: bigint): Promise<`0x${string}`> {
  return publicClient.readContract({
    address: RECURRING_TAB_FACTORY_ADDRESS,
    abi: FACTORY_READ_ABI,
    functionName: "tabs",
    args: [tabId],
  });
}

// A member who paid their full cycle due in a settlement: address + units pulled.
// Reputation scores exactly these (the pull-based analog of a full payDebt).
export type MemberPayment = { member: `0x${string}`; amount: bigint };

// Parse a settleTab receipt into the members who paid their cycle IN FULL. Only
// OUR tab's logs count (a receipt could carry unrelated events). A member is
// scored iff they had a positive MemberSettled AND no SettlementShortfall in the
// same settlement:
//   - shortfall with nothing collected → MemberSettled(amount 0) + Shortfall → skip
//   - partial payment                  → MemberSettled(amount>0) + Shortfall → skip
//   - full payment                     → MemberSettled(amount>0), no Shortfall → score
// Mirrors the bill path's paidInFull gate: positive-only, full-payment-only.
export function getSettledMembersFromLogs(
  logs: { address: string; data: `0x${string}`; topics: [] | [`0x${string}`, ...`0x${string}`[]] }[],
  tabAddress: `0x${string}`,
): MemberPayment[] {
  const collected = new Map<string, bigint>();
  const shortfell = new Set<string>();
  for (const log of logs) {
    if (log.address.toLowerCase() !== tabAddress.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: MEMBER_SETTLED_ABI, data: log.data, topics: log.topics });
      if (decoded.eventName === "MemberSettled") {
        if (decoded.args.success && decoded.args.amount > 0n) {
          collected.set(decoded.args.member.toLowerCase(), decoded.args.amount);
        }
      } else if (decoded.eventName === "SettlementShortfall") {
        shortfell.add(decoded.args.member.toLowerCase());
      }
    } catch {
      continue;
    }
  }
  const paid: MemberPayment[] = [];
  for (const [member, amount] of collected) {
    if (shortfell.has(member)) continue;
    paid.push({ member: member as `0x${string}`, amount });
  }
  return paid;
}

export async function getSettledMembersFromReceipt(
  txHash: `0x${string}`,
  tabAddress: `0x${string}`,
): Promise<MemberPayment[]> {
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  return getSettledMembersFromLogs(
    receipt.logs as { address: string; data: `0x${string}`; topics: [] | [`0x${string}`, ...`0x${string}`[]] }[],
    tabAddress,
  );
}

// The cycle a just-confirmed settlement satisfied and the deadline its members
// are graded against, in one read. Called after the settleTab tx confirms, so
// settlementCount already reflects this settlement: `cycle` is that count (the
// per-member idempotency key), and `dueDate` is that cycle's boundary
// (createdAt + interval * count) — a member collected at or before it is on
// time. A read failure returns { cycle: 0, dueDate: 0 }: dueDate 0 grades as "no
// deadline" (a clean score) so a read miss never penalizes a member.
export async function getTabSettlementContext(
  tabAddress: `0x${string}`,
): Promise<{ cycle: number; dueDate: number }> {
  try {
    const [createdAt, interval, count] = await publicClient.multicall({
      allowFailure: false,
      contracts: [
        { address: tabAddress, abi: TAB_READ_ABI, functionName: "createdAt" },
        { address: tabAddress, abi: TAB_READ_ABI, functionName: "settlementInterval" },
        { address: tabAddress, abi: TAB_READ_ABI, functionName: "settlementCount" },
      ],
    });
    if (count === 0n) return { cycle: 0, dueDate: 0 };
    return { cycle: Number(count), dueDate: Number(createdAt + interval * count) };
  } catch {
    return { cycle: 0, dueDate: 0 };
  }
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

"use client";

import {
  createPublicClient,
  decodeEventLog,
  formatUnits,
  getAddress,
  http,
  parseUnits,
  type Log,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { arcTestnet } from "viem/chains";

export const RECURRING_TAB_FACTORY_ADDRESS = (
  process.env.NEXT_PUBLIC_RECURRING_TAB_FACTORY_ADDRESS ??
  "0x6c4d980f7a9250e3892a3541b5a62420b628f3c1"
) as `0x${string}`;

export const ARC_USDC_ADDRESS = (
  process.env.NEXT_PUBLIC_ARC_TESTNET_USDC_ADDRESS ??
  "0x3600000000000000000000000000000000000000"
) as `0x${string}`;

export const recurringTabFactoryAbi = [
  {
    type: "event",
    name: "TabCreated",
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "tabId", type: "uint256" },
      { indexed: true, internalType: "address", name: "tab", type: "address" },
      { indexed: true, internalType: "address", name: "recipient", type: "address" },
      { indexed: false, internalType: "uint256", name: "settlementInterval", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "maxSettlements", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "createTab",
    stateMutability: "nonpayable",
    inputs: [
      { internalType: "address", name: "recipient", type: "address" },
      { internalType: "uint256", name: "settlementInterval", type: "uint256" },
      { internalType: "uint256", name: "maxSettlements", type: "uint256" },
      { internalType: "address[]", name: "members", type: "address[]" },
      { internalType: "uint256[]", name: "fixedShares", type: "uint256[]" },
    ],
    outputs: [
      { internalType: "uint256", name: "tabId", type: "uint256" },
      { internalType: "address", name: "tab", type: "address" },
    ],
  },
  {
    type: "function",
    name: "tabs",
    stateMutability: "view",
    inputs: [{ internalType: "uint256", name: "tabId", type: "uint256" }],
    outputs: [{ internalType: "address", name: "tab", type: "address" }],
  },
  {
    type: "function",
    name: "nextTabId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
  },
] as const;

export const recurringTabAbi = [
  {
    type: "event",
    name: "MemberSettled",
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "tabId", type: "uint256" },
      { indexed: true, internalType: "address", name: "member", type: "address" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
      { indexed: false, internalType: "bool", name: "success", type: "bool" },
    ],
  },
  {
    type: "event",
    name: "SettlementShortfall",
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "tabId", type: "uint256" },
      { indexed: true, internalType: "address", name: "member", type: "address" },
    ],
  },
  {
    type: "event",
    name: "FundsClaimed",
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "tabId", type: "uint256" },
      { indexed: true, internalType: "address", name: "recipient", type: "address" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "TabSettled",
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "tabId", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "totalAmount", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "timestamp", type: "uint256" },
    ],
  },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "claimable", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "settleTab", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "members", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  { type: "function", name: "recipient", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "settlementInterval", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxSettlements", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "settlementCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "createdAt", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "lastSettledAt", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "nextSettlementAt", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "fixedShare",
    stateMutability: "view",
    inputs: [{ internalType: "address", name: "member", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "totalSettledByMember",
    stateMutability: "view",
    inputs: [{ internalType: "address", name: "member", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const usdcAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { internalType: "address", name: "spender", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { internalType: "address", name: "owner", type: "address" },
      { internalType: "address", name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export type RecurringMemberState = {
  address: `0x${string}`;
  fixedShare: bigint;
  walletBalance: bigint;
  allowance: bigint;
  totalSettled: bigint;
  dueNow: bigint;
  remainingTotal: bigint;
  collectible: boolean;
};

export type RecurringTabState = {
  address: `0x${string}`;
  recipient: `0x${string}`;
  settlementInterval: bigint;
  maxSettlements: bigint;
  settlementCount: bigint;
  claimable: bigint;
  createdAt: bigint;
  lastSettledAt: bigint;
  nextSettlementAt: bigint;
  dueCycles: bigint;
  remainingCycles: bigint;
  members: RecurringMemberState[];
};

export type RecurringEvent = {
  name: string;
  blockNumber: bigint;
  txHash: `0x${string}`;
  summary: string;
  // The member a MemberSettled/SettlementShortfall event is about, so the UI
  // can show a payer only their own activity. Tab-level events leave it unset.
  member?: `0x${string}`;
};

export type RecurringWallet = {
  account: `0x${string}`;
  walletClient: WalletClient;
};

export const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network"),
});

export async function createRecurringWallet(walletClient: WalletClient) {
  const account = walletClient.account?.address;

  if (!account) {
    throw new Error("Wallet did not return an account.");
  }

  if (walletClient.chain?.id !== arcTestnet.id) {
    await walletClient.switchChain({ id: arcTestnet.id });
  }

  return { account: getAddress(account) as `0x${string}`, walletClient };
}

// Recurring writes pin `chain: arcTestnet`, which makes viem throw if the wallet
// is connected to another network. Switch to Arc Testnet first so creating a
// tab, approving, revoking, or claiming works regardless of the active chain.
export async function ensureRecurringWalletOnArc({ walletClient }: RecurringWallet) {
  const chainId = await walletClient.getChainId();

  if (chainId !== arcTestnet.id) {
    await walletClient.switchChain({ id: arcTestnet.id });
  }
}

export async function createRecurringTab({
  walletClient,
  account,
  recipient,
  intervalSeconds,
  maxSettlements,
  members,
  fixedShares,
}: RecurringWallet & {
  recipient: `0x${string}`;
  intervalSeconds: bigint;
  maxSettlements: bigint;
  members: `0x${string}`[];
  fixedShares: bigint[];
}) {
  const hash = await walletClient.writeContract({
    address: RECURRING_TAB_FACTORY_ADDRESS,
    abi: recurringTabFactoryAbi,
    functionName: "createTab",
    args: [recipient, intervalSeconds, maxSettlements, members, fixedShares],
    account,
    chain: arcTestnet,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const created = parseTabCreated(receipt);

  if (!created) {
    throw new Error("Factory transaction succeeded, but no TabCreated event was found.");
  }

  return { hash, ...created };
}

export async function approveUsdc({
  walletClient,
  account,
  spender,
  amount,
}: RecurringWallet & {
  spender: `0x${string}`;
  amount: bigint;
}) {
  const hash = await walletClient.writeContract({
    address: ARC_USDC_ADDRESS,
    abi: usdcAbi,
    functionName: "approve",
    args: [spender, amount],
    account,
    chain: arcTestnet,
  });

  return publicClient.waitForTransactionReceipt({ hash });
}

export async function authorizeRecurringPayment({
  walletClient,
  account,
  tabAddress,
  amount,
}: RecurringWallet & {
  tabAddress: `0x${string}`;
  amount: bigint;
}) {
  return approveUsdc({ walletClient, account, spender: tabAddress, amount });
}

export async function settleRecurringTab({
  walletClient,
  account,
  tabAddress,
}: RecurringWallet & {
  tabAddress: `0x${string}`;
}) {
  const hash = await walletClient.writeContract({
    address: tabAddress,
    abi: recurringTabAbi,
    functionName: "settleTab",
    account,
    chain: arcTestnet,
  });

  return publicClient.waitForTransactionReceipt({ hash });
}

export async function claimRecurringFunds({
  walletClient,
  account,
  tabAddress,
}: RecurringWallet & {
  tabAddress: `0x${string}`;
}) {
  const hash = await walletClient.writeContract({
    address: tabAddress,
    abi: recurringTabAbi,
    functionName: "claim",
    account,
    chain: arcTestnet,
  });

  return publicClient.waitForTransactionReceipt({ hash });
}

export async function readRecurringTab(address: `0x${string}`): Promise<RecurringTabState> {
  const [recipient, settlementInterval, maxSettlements, settlementCount, claimable, lastSettledAt, nextSettlementAt, members] =
    await publicClient.multicall({
      allowFailure: false,
      contracts: [
        { address, abi: recurringTabAbi, functionName: "recipient" },
        { address, abi: recurringTabAbi, functionName: "settlementInterval" },
        { address, abi: recurringTabAbi, functionName: "maxSettlements" },
        { address, abi: recurringTabAbi, functionName: "settlementCount" },
        { address, abi: recurringTabAbi, functionName: "claimable" },
        { address, abi: recurringTabAbi, functionName: "lastSettledAt" },
        { address, abi: recurringTabAbi, functionName: "nextSettlementAt" },
        { address, abi: recurringTabAbi, functionName: "members" },
      ],
    });
  const createdAt = await publicClient
    .readContract({ address, abi: recurringTabAbi, functionName: "createdAt" })
    .catch(() => lastSettledAt);

  const memberRows = await publicClient.multicall({
    allowFailure: true,
    contracts: members.flatMap((member) => [
      { address, abi: recurringTabAbi, functionName: "fixedShare", args: [member] },
      { address: ARC_USDC_ADDRESS, abi: usdcAbi, functionName: "balanceOf", args: [member] },
      { address: ARC_USDC_ADDRESS, abi: usdcAbi, functionName: "allowance", args: [member, address] },
      { address, abi: recurringTabAbi, functionName: "totalSettledByMember", args: [member] },
    ]),
  });

  const latestBlock = await publicClient.getBlock();
  const nowSeconds = latestBlock.timestamp;
  const remainingCycles = maxSettlements > settlementCount ? maxSettlements - settlementCount : 0n;
  const elapsed = nowSeconds > createdAt ? nowSeconds - createdAt : 0n;
  const scheduledCycles = settlementInterval > 0n ? elapsed / settlementInterval : 0n;
  const accruedCycles = scheduledCycles > maxSettlements ? maxSettlements : scheduledCycles;
  const unsettledCycles = scheduledCycles > settlementCount ? scheduledCycles - settlementCount : 0n;
  const dueCycles = unsettledCycles > remainingCycles ? remainingCycles : unsettledCycles;

  return {
    address,
    recipient,
    settlementInterval,
    maxSettlements,
    settlementCount,
    claimable,
    createdAt,
    lastSettledAt,
    nextSettlementAt,
    dueCycles,
    remainingCycles,
    members: members.map((member, index) => {
      const rowOffset = index * 4;
      const fixedShare = multicallValue(memberRows[rowOffset]);
      const walletBalance = multicallValue(memberRows[rowOffset + 1]);
      const allowance = multicallValue(memberRows[rowOffset + 2]);
      const totalSettled = multicallValue(memberRows[rowOffset + 3]);
      const totalDebt = fixedShare * maxSettlements;
      const accruedDue = fixedShare * accruedCycles;
      const dueNow = totalSettled >= accruedDue ? 0n : accruedDue - totalSettled;
      const remainingTotal = totalSettled >= totalDebt ? 0n : totalDebt - totalSettled;
      const collectibleAmount =
        dueNow > 0n ? [dueNow, allowance, walletBalance].reduce((lowest, value) => (value < lowest ? value : lowest)) : 0n;
      return {
        address: member,
        fixedShare,
        walletBalance,
        allowance,
        totalSettled,
        dueNow,
        remainingTotal,
        collectible: collectibleAmount > 0n,
      };
    }),
  };
}

function multicallValue(result: { status: "success"; result: unknown } | { status: "failure"; error: Error }) {
  return result.status === "success" && typeof result.result === "bigint" ? result.result : 0n;
}

export async function readRecurringEvents(address: `0x${string}`): Promise<RecurringEvent[]> {
  const latest = await publicClient.getBlockNumber();
  const fromBlock = latest > 9_000n ? latest - 9_000n : 0n;
  const logs = await publicClient.getLogs({ address, fromBlock, toBlock: latest }).catch(() => []);

  return logs
    .map(decodeRecurringEvent)
    .filter((event): event is RecurringEvent => Boolean(event))
    .reverse();
}

export async function readRecurringTabsForWallet(account: `0x${string}` | `0x${string}`[]): Promise<RecurringTabState[]> {
  const accounts = (Array.isArray(account) ? account : [account]).map((value) => value.toLowerCase());
  const nextTabId = await publicClient.readContract({
    address: RECURRING_TAB_FACTORY_ADDRESS,
    abi: recurringTabFactoryAbi,
    functionName: "nextTabId",
  });
  const tabIds = Array.from({ length: Math.max(0, Number(nextTabId - 1n)) }, (_, index) => BigInt(index + 1));

  if (tabIds.length === 0) {
    return [];
  }

  const tabAddresses = await publicClient.multicall({
    allowFailure: true,
    contracts: tabIds.map((tabId) => ({
      address: RECURRING_TAB_FACTORY_ADDRESS,
      abi: recurringTabFactoryAbi,
      functionName: "tabs",
      args: [tabId],
    })),
  });

  const states = await Promise.all(
    tabAddresses
      .map((result) => (result.status === "success" ? (result.result as unknown as `0x${string}`) : null))
      .filter((address): address is `0x${string}` => Boolean(address) && address !== "0x0000000000000000000000000000000000000000")
      .map(async (address) => {
        try {
          return await readRecurringTab(address);
        } catch {
          return null;
        }
      }),
  );

  return states
    .filter((state): state is RecurringTabState => Boolean(state))
    .filter(
      (state) =>
        accounts.includes(state.recipient.toLowerCase()) ||
        state.members.some((member) => accounts.includes(member.address.toLowerCase())),
    );
}

export function usdcToUnits(value: string) {
  return parseUnits(value || "0", 6);
}

export function unitsToUsdc(value: bigint) {
  return Number(formatUnits(value, 6)).toFixed(2);
}

function decodeRecurringEvent(log: Log): RecurringEvent | null {
  try {
    const decoded = decodeEventLog({
      abi: recurringTabAbi,
      data: log.data,
      topics: log.topics,
    });

    const args = decoded.args as Record<string, unknown>;
    return {
      name: decoded.eventName,
      blockNumber: log.blockNumber ?? 0n,
      txHash: log.transactionHash ?? "0x",
      summary: eventSummary(decoded.eventName, args),
      member: typeof args.member === "string" ? (args.member as `0x${string}`) : undefined,
    };
  } catch {
    return null;
  }
}

function parseTabCreated(receipt: TransactionReceipt) {
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: recurringTabFactoryAbi,
        data: log.data,
        topics: log.topics,
      });

      if (decoded.eventName === "TabCreated") {
        return {
          tabId: decoded.args.tabId,
          tabAddress: decoded.args.tab,
          recipient: decoded.args.recipient,
          settlementInterval: decoded.args.settlementInterval,
          maxSettlements: decoded.args.maxSettlements,
        };
      }
    } catch {
      continue;
    }
  }

  return null;
}

function eventSummary(name: string, args: Record<string, unknown>) {
  if (name === "MemberSettled") {
    return `${String(args.member)} ${args.success ? "paid" : "skipped"} ${unitsToUsdc(args.amount as bigint)} USDC`;
  }

  if (name === "SettlementShortfall") {
    return `Shortfall from ${String(args.member)}`;
  }

  if (name === "TabSettled") {
    return `Tab settled ${unitsToUsdc(args.totalAmount as bigint)} USDC`;
  }

  if (name === "FundsClaimed") {
    return `Recipient claimed ${unitsToUsdc(args.amount as bigint)} USDC`;
  }

  return name;
}

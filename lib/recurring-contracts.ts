"use client";

import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeEventLog,
  formatUnits,
  getAddress,
  http,
  parseUnits,
  type EIP1193Provider,
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
    ],
  },
  {
    type: "function",
    name: "createTab",
    stateMutability: "nonpayable",
    inputs: [
      { internalType: "address", name: "recipient", type: "address" },
      { internalType: "uint256", name: "settlementInterval", type: "uint256" },
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
    name: "TabSettled",
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "tabId", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "totalAmount", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "timestamp", type: "uint256" },
    ],
  },
  { type: "function", name: "settleTab", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "members", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  { type: "function", name: "recipient", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "settlementInterval", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
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
  collectible: boolean;
};

export type RecurringTabState = {
  address: `0x${string}`;
  recipient: `0x${string}`;
  settlementInterval: bigint;
  lastSettledAt: bigint;
  nextSettlementAt: bigint;
  members: RecurringMemberState[];
};

export type RecurringEvent = {
  name: string;
  blockNumber: bigint;
  txHash: `0x${string}`;
  summary: string;
};

export type RecurringWallet = {
  account: `0x${string}`;
  walletClient: WalletClient;
};

export const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network"),
});

export async function createRecurringWallet(provider: EIP1193Provider) {
  await provider.request({ method: "eth_requestAccounts", params: undefined });
  const accounts = (await provider.request({ method: "eth_accounts", params: undefined })) as string[];
  const account = getAddress(accounts[0] ?? "") as `0x${string}`;
  const walletClient = createWalletClient({
    account,
    chain: arcTestnet,
    transport: custom(provider),
  });

  await walletClient.switchChain({ id: arcTestnet.id });

  return { account, walletClient };
}

export async function createRecurringTab({
  walletClient,
  account,
  recipient,
  intervalSeconds,
  members,
  fixedShares,
}: RecurringWallet & {
  recipient: `0x${string}`;
  intervalSeconds: bigint;
  members: `0x${string}`[];
  fixedShares: bigint[];
}) {
  const hash = await walletClient.writeContract({
    address: RECURRING_TAB_FACTORY_ADDRESS,
    abi: recurringTabFactoryAbi,
    functionName: "createTab",
    args: [recipient, intervalSeconds, members, fixedShares],
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

export async function readRecurringTab(address: `0x${string}`): Promise<RecurringTabState> {
  const [recipient, settlementInterval, lastSettledAt, nextSettlementAt, members] =
    await publicClient.multicall({
      allowFailure: false,
      contracts: [
        { address, abi: recurringTabAbi, functionName: "recipient" },
        { address, abi: recurringTabAbi, functionName: "settlementInterval" },
        { address, abi: recurringTabAbi, functionName: "lastSettledAt" },
        { address, abi: recurringTabAbi, functionName: "nextSettlementAt" },
        { address, abi: recurringTabAbi, functionName: "members" },
      ],
    });

  const memberRows = await publicClient.multicall({
    allowFailure: false,
    contracts: members.flatMap((member) => [
      { address, abi: recurringTabAbi, functionName: "fixedShare", args: [member] },
      { address: ARC_USDC_ADDRESS, abi: usdcAbi, functionName: "balanceOf", args: [member] },
      { address: ARC_USDC_ADDRESS, abi: usdcAbi, functionName: "allowance", args: [member, address] },
      { address, abi: recurringTabAbi, functionName: "totalSettledByMember", args: [member] },
    ]),
  });

  return {
    address,
    recipient,
    settlementInterval,
    lastSettledAt,
    nextSettlementAt,
    members: members.map((member, index) => {
      const rowOffset = index * 4;
      const fixedShare = memberRows[rowOffset] as bigint;
      const walletBalance = memberRows[rowOffset + 1] as bigint;
      const allowance = memberRows[rowOffset + 2] as bigint;
      const totalSettled = memberRows[rowOffset + 3] as bigint;
      return {
        address: member,
        fixedShare,
        walletBalance,
        allowance,
        totalSettled,
        collectible: allowance >= fixedShare && walletBalance >= fixedShare,
      };
    }),
  };
}

export async function readRecurringEvents(address: `0x${string}`): Promise<RecurringEvent[]> {
  const latest = await publicClient.getBlockNumber();
  const fromBlock = latest > 20_000n ? latest - 20_000n : 0n;
  const logs = await publicClient.getLogs({ address, fromBlock, toBlock: latest });

  return logs
    .map(decodeRecurringEvent)
    .filter((event): event is RecurringEvent => Boolean(event))
    .reverse();
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

    return {
      name: decoded.eventName,
      blockNumber: log.blockNumber ?? 0n,
      txHash: log.transactionHash ?? "0x",
      summary: eventSummary(decoded.eventName, decoded.args as Record<string, unknown>),
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

  return name;
}

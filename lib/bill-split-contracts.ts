"use client";

import {
  createWalletClient,
  custom,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  getAddress,
  keccak256,
  parseAbiParameters,
  parseUnits,
  type EIP1193Provider,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { arcTestnet } from "viem/chains";
import { ARC_USDC_ADDRESS, publicClient, usdcAbi } from "@/lib/recurring-contracts";

export const BILL_SPLIT_REGISTRY_ADDRESS = (
  process.env.NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS ?? "0x0000000000000000000000000000000000000000"
) as `0x${string}`;

export const ARC_MEMO_ADDRESS = "0x5294E9927c3306DcBaDb03fe70b92e01cCede505" as const;

export const memoAbi = [
  {
    type: "function",
    name: "memo",
    stateMutability: "nonpayable",
    inputs: [
      { internalType: "address", name: "target", type: "address" },
      { internalType: "bytes", name: "data", type: "bytes" },
      { internalType: "bytes32", name: "memoId", type: "bytes32" },
      { internalType: "bytes", name: "memoData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "Memo",
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "sender", type: "address" },
      { indexed: true, internalType: "address", name: "target", type: "address" },
      { indexed: false, internalType: "bytes32", name: "callDataHash", type: "bytes32" },
      { indexed: true, internalType: "bytes32", name: "memoId", type: "bytes32" },
      { indexed: false, internalType: "bytes", name: "memo", type: "bytes" },
      { indexed: false, internalType: "uint256", name: "memoIndex", type: "uint256" },
    ],
  },
] as const;

export const billSplitRegistryAbi = [
  {
    type: "event",
    name: "BillCreated",
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "billId", type: "uint256" },
      { indexed: true, internalType: "address", name: "splitter", type: "address" },
      { indexed: true, internalType: "bytes32", name: "metadataHash", type: "bytes32" },
      { indexed: false, internalType: "uint256", name: "totalOwed", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "DebtPaid",
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "billId", type: "uint256" },
      { indexed: true, internalType: "address", name: "payer", type: "address" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "paidTotal", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "owedTotal", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "FundsClaimed",
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "billId", type: "uint256" },
      { indexed: true, internalType: "address", name: "splitter", type: "address" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "createBill",
    stateMutability: "nonpayable",
    inputs: [
      { internalType: "bytes32", name: "metadataHash", type: "bytes32" },
      { internalType: "address[]", name: "participantAddresses", type: "address[]" },
      { internalType: "uint256[]", name: "owedAmounts", type: "uint256[]" },
    ],
    outputs: [{ internalType: "uint256", name: "billId", type: "uint256" }],
  },
  {
    type: "function",
    name: "payDebt",
    stateMutability: "nonpayable",
    inputs: [
      { internalType: "uint256", name: "billId", type: "uint256" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { internalType: "uint256", name: "billId", type: "uint256" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claimable",
    stateMutability: "view",
    inputs: [{ internalType: "uint256", name: "billId", type: "uint256" }],
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getBill",
    stateMutability: "view",
    inputs: [{ internalType: "uint256", name: "billId", type: "uint256" }],
    outputs: [
      { internalType: "address", name: "splitter", type: "address" },
      { internalType: "bytes32", name: "metadataHash", type: "bytes32" },
      { internalType: "uint256", name: "totalOwed", type: "uint256" },
      { internalType: "uint256", name: "totalPaid", type: "uint256" },
      { internalType: "uint256", name: "claimed", type: "uint256" },
      { internalType: "address[]", name: "participantList", type: "address[]" },
    ],
  },
  {
    type: "function",
    name: "getParticipant",
    stateMutability: "view",
    inputs: [
      { internalType: "uint256", name: "billId", type: "uint256" },
      { internalType: "address", name: "participantAddress", type: "address" },
    ],
    outputs: [
      { internalType: "uint256", name: "owed", type: "uint256" },
      { internalType: "uint256", name: "paid", type: "uint256" },
      { internalType: "bool", name: "exists", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "billIdsForParticipant",
    stateMutability: "view",
    inputs: [{ internalType: "address", name: "participantAddress", type: "address" }],
    outputs: [{ internalType: "uint256[]", name: "", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "billIdsForSplitter",
    stateMutability: "view",
    inputs: [{ internalType: "address", name: "splitter", type: "address" }],
    outputs: [{ internalType: "uint256[]", name: "", type: "uint256[]" }],
  },
] as const;

export type BillSplitWallet = {
  account: `0x${string}`;
  walletClient: WalletClient;
};

export type BillSplitDebt = {
  billId: bigint;
  splitter: `0x${string}`;
  metadataHash: `0x${string}`;
  totalOwed: bigint;
  totalPaid: bigint;
  claimed: bigint;
  participantList: readonly `0x${string}`[];
  owed: bigint;
  paid: bigint;
  remaining: bigint;
  claimable: bigint;
};

export async function createBillSplitWallet(provider: EIP1193Provider): Promise<BillSplitWallet> {
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

export async function ensureBillSplitWalletOnArc({ walletClient }: BillSplitWallet) {
  const chainId = await walletClient.getChainId();

  if (chainId !== arcTestnet.id) {
    await walletClient.switchChain({ id: arcTestnet.id });
  }
}

export async function createBillSplit({
  walletClient,
  account,
  metadataHash,
  participants,
  owedAmounts,
}: BillSplitWallet & {
  metadataHash: `0x${string}`;
  participants: `0x${string}`[];
  owedAmounts: bigint[];
}) {
  ensureRegistryConfigured();

  const hash = await walletClient.writeContract({
    address: BILL_SPLIT_REGISTRY_ADDRESS,
    abi: billSplitRegistryAbi,
    functionName: "createBill",
    args: [metadataHash, participants, owedAmounts],
    account,
    chain: arcTestnet,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const created = parseBillCreated(receipt);

  if (!created) {
    throw new Error("Bill transaction succeeded, but no BillCreated event was found.");
  }

  return { hash, ...created };
}

export async function approveBillRegistry({ walletClient, account, amount }: BillSplitWallet & { amount: bigint }) {
  ensureRegistryConfigured();

  const hash = await walletClient.writeContract({
    address: ARC_USDC_ADDRESS,
    abi: usdcAbi,
    functionName: "approve",
    args: [BILL_SPLIT_REGISTRY_ADDRESS, amount],
    account,
    chain: arcTestnet,
  });

  return publicClient.waitForTransactionReceipt({ hash });
}

export async function payBillDebt({
  walletClient,
  account,
  billId,
  amount,
}: BillSplitWallet & {
  billId: bigint;
  amount: bigint;
}) {
  ensureRegistryConfigured();

  const hash = await walletClient.writeContract({
    address: BILL_SPLIT_REGISTRY_ADDRESS,
    abi: billSplitRegistryAbi,
    functionName: "payDebt",
    args: [billId, amount],
    account,
    chain: arcTestnet,
  });

  return publicClient.waitForTransactionReceipt({ hash });
}

export async function payBillDebtWithMemo({
  walletClient,
  account,
  billId,
  amount,
}: BillSplitWallet & {
  billId: bigint;
  amount: bigint;
}) {
  ensureRegistryConfigured();

  const data = encodeFunctionData({
    abi: billSplitRegistryAbi,
    functionName: "payDebt",
    args: [billId, amount],
  });
  const memoId = billPaymentMemoId({ billId, payer: account });
  const memoData = encodeAbiParameters(
    parseAbiParameters("string app, uint256 billId, address payer, uint256 amount"),
    ["snapsplit.bill-payment", billId, account, amount],
  );

  const hash = await walletClient.writeContract({
    address: ARC_MEMO_ADDRESS,
    abi: memoAbi,
    functionName: "memo",
    args: [BILL_SPLIT_REGISTRY_ADDRESS, data, memoId, memoData],
    account,
    chain: arcTestnet,
  });

  return publicClient.waitForTransactionReceipt({ hash });
}

export async function claimBillFunds({
  walletClient,
  account,
  billId,
  amount,
}: BillSplitWallet & {
  billId: bigint;
  amount: bigint;
}) {
  ensureRegistryConfigured();

  const hash = await walletClient.writeContract({
    address: BILL_SPLIT_REGISTRY_ADDRESS,
    abi: billSplitRegistryAbi,
    functionName: "claim",
    args: [billId, amount],
    account,
    chain: arcTestnet,
  });

  return publicClient.waitForTransactionReceipt({ hash });
}

export async function readDebtsForWallet(account: `0x${string}`) {
  ensureRegistryConfigured();

  const billIds = await publicClient.readContract({
    address: BILL_SPLIT_REGISTRY_ADDRESS,
    abi: billSplitRegistryAbi,
    functionName: "billIdsForParticipant",
    args: [account],
  });

  return Promise.all(billIds.map((billId) => readDebt(billId, account)));
}

export async function readBillsForSplitter(account: `0x${string}`) {
  ensureRegistryConfigured();

  const billIds = await publicClient.readContract({
    address: BILL_SPLIT_REGISTRY_ADDRESS,
    abi: billSplitRegistryAbi,
    functionName: "billIdsForSplitter",
    args: [account],
  });

  return Promise.all(billIds.map((billId) => readDebt(billId, account)));
}

export async function readDebt(billId: bigint, account: `0x${string}`): Promise<BillSplitDebt> {
  const [[splitter, metadataHash, totalOwed, totalPaid, claimed, participantList], [owed, paid, exists], claimable] =
    await Promise.all([
      publicClient.readContract({
        address: BILL_SPLIT_REGISTRY_ADDRESS,
        abi: billSplitRegistryAbi,
        functionName: "getBill",
        args: [billId],
      }),
      publicClient.readContract({
        address: BILL_SPLIT_REGISTRY_ADDRESS,
        abi: billSplitRegistryAbi,
        functionName: "getParticipant",
        args: [billId, account],
      }),
      publicClient.readContract({
        address: BILL_SPLIT_REGISTRY_ADDRESS,
        abi: billSplitRegistryAbi,
        functionName: "claimable",
        args: [billId],
      }),
    ]);

  return {
    billId,
    splitter,
    metadataHash,
    totalOwed,
    totalPaid,
    claimed,
    participantList: [...participantList],
    owed: exists ? owed : 0n,
    paid: exists ? paid : 0n,
    remaining: exists ? owed - paid : 0n,
    claimable,
  };
}

export function billMetadataHash({
  merchant,
  currency,
  total,
  participantLabels,
}: {
  merchant: string;
  currency: string;
  total: number;
  participantLabels: string[];
}) {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("string merchant, string currency, uint256 cents, string labels"), [
      merchant,
      currency,
      BigInt(Math.round(total * 100)),
      participantLabels.join("|"),
    ]),
  );
}

export function billPaymentMemoId({ billId, payer }: { billId: bigint; payer: `0x${string}` }) {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("string app, uint256 billId, address payer"), [
      "snapsplit.bill-payment",
      billId,
      payer,
    ]),
  );
}

export function usdcToBillUnits(value: string) {
  return parseUnits(value || "0", 6);
}

export function billUnitsToUsdc(value: bigint) {
  return Number(formatUnits(value, 6)).toFixed(2);
}

export function isBillRegistryConfigured() {
  return BILL_SPLIT_REGISTRY_ADDRESS !== "0x0000000000000000000000000000000000000000";
}

function ensureRegistryConfigured() {
  if (!isBillRegistryConfigured()) {
    throw new Error("Bill split registry is not configured. Set NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS.");
  }
}

function parseBillCreated(receipt: TransactionReceipt) {
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: billSplitRegistryAbi,
        data: log.data,
        topics: log.topics,
      });

      if (decoded.eventName === "BillCreated") {
        return {
          billId: decoded.args.billId,
          splitter: decoded.args.splitter,
          metadataHash: decoded.args.metadataHash,
          totalOwed: decoded.args.totalOwed,
        };
      }
    } catch {
      continue;
    }
  }

  return null;
}

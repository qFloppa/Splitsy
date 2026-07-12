"use client";

import {
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  getAbiItem,
  getAddress,
  keccak256,
  parseAbiParameters,
  parseUnits,
  stringToHex,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { arcTestnet } from "viem/chains";
import { ARC_USDC_ADDRESS, publicClient, usdcAbi } from "@/lib/recurring-contracts";

export const BILL_SPLIT_REGISTRY_ADDRESS = (
  process.env.NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS ?? "0x0000000000000000000000000000000000000000"
) as `0x${string}`;

export const ARC_MEMO_ADDRESS = "0x5294E9927c3306DcBaDb03fe70b92e01cCede505" as const;
const SPLITSY_MEMO_APP = "Splitsy";
const BILL_PAYMENT_MEMO_TYPE = "bill-payment";

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

export type BillPaymentRecord = {
  payer: `0x${string}`;
  amount: bigint;
  paidTotal: bigint;
  timestamp: bigint | null; // unix seconds; null if the block timestamp could not be read
  txHash: `0x${string}`;
};

export type BillClaimRecord = {
  splitter: `0x${string}`;
  amount: bigint;
  timestamp: bigint | null;
  txHash: `0x${string}`;
};

export type BillActivity = {
  billId: bigint;
  createdAt: bigint | null; // null if the bill's creation predates the scanned log window
  createdTxHash: `0x${string}` | null;
  payments: BillPaymentRecord[]; // oldest first
  claims: BillClaimRecord[]; // oldest first
};

export async function createBillSplitWallet(walletClient: WalletClient): Promise<BillSplitWallet> {
  const account = walletClient.account?.address;

  if (!account) {
    throw new Error("Wallet did not return an account.");
  }

  if (walletClient.chain?.id !== arcTestnet.id) {
    await walletClient.switchChain({ id: arcTestnet.id });
  }

  return { account: getAddress(account) as `0x${string}`, walletClient };
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
  const receipt = assertReceiptSuccess(await publicClient.waitForTransactionReceipt({ hash }), "Bill creation");
  const created = parseBillCreated(receipt);

  if (!created) {
    throw new Error("Bill transaction succeeded, but no BillCreated event was found.");
  }

  return { hash, ...created };
}

function assertReceiptSuccess(receipt: TransactionReceipt, action: string): TransactionReceipt {
  if (receipt.status !== "success") {
    throw new Error(`${action} failed: the transaction reverted on Arc and no funds were moved.`);
  }
  return receipt;
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

  return assertReceiptSuccess(await publicClient.waitForTransactionReceipt({ hash }), "USDC approval");
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

  return assertReceiptSuccess(await publicClient.waitForTransactionReceipt({ hash }), "Payment");
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
  const memoData = billPaymentMemoData({ billId, payer: account, amount });

  const hash = await walletClient.writeContract({
    address: ARC_MEMO_ADDRESS,
    abi: memoAbi,
    functionName: "memo",
    args: [BILL_SPLIT_REGISTRY_ADDRESS, data, memoId, memoData],
    account,
    chain: arcTestnet,
  });

  return assertReceiptSuccess(await publicClient.waitForTransactionReceipt({ hash }), "Payment");
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

  return assertReceiptSuccess(await publicClient.waitForTransactionReceipt({ hash }), "Claim");
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

export async function readArcUsdcBalance(account: `0x${string}`) {
  return publicClient.readContract({
    address: ARC_USDC_ADDRESS,
    abi: usdcAbi,
    functionName: "balanceOf",
    args: [account],
  });
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

// Reads the on-chain event history for a single bill: when it was created, every
// payment (payer + amount + time + tx), and every claim (amount + time + tx).
// Used by the History tab's expandable records. Tolerates RPC limits and old
// bills by scanning a recent block window and degrading to nulls/empty arrays.
export async function readBillActivity(billId: bigint): Promise<BillActivity> {
  const empty: BillActivity = {
    billId,
    createdAt: null,
    createdTxHash: null,
    payments: [],
    claims: [],
  };
  const billCreatedEvent = getAbiItem({ abi: billSplitRegistryAbi, name: "BillCreated" });

  try {
    const latest = await publicClient.getBlockNumber();
    const fromBlock = latest > 9_000n ? latest - 9_000n : 0n;
    const logs = await publicClient
      .getLogs({ address: BILL_SPLIT_REGISTRY_ADDRESS, fromBlock, toBlock: latest })
      .catch(() => []);

    type DecodedBillLog = {
      eventName: string;
      args: Record<string, unknown>;
      blockNumber: bigint;
      txHash: `0x${string}`;
    };

    const decoded: DecodedBillLog[] = [];
    for (const log of logs) {
      if (log.blockNumber === null || log.transactionHash === null) {
        continue;
      }

      try {
        const event = decodeEventLog({ abi: billSplitRegistryAbi, data: log.data, topics: log.topics });
        decoded.push({
          eventName: event.eventName,
          args: event.args as Record<string, unknown>,
          blockNumber: log.blockNumber,
          txHash: log.transactionHash,
        });
      } catch {
        continue;
      }
    }

    const forThisBill = decoded.filter((entry) => entry.args.billId === billId);

    // The BillCreated event may sit outside the recent scan window for older
    // bills. Because billId is indexed, we can pull just that one event across
    // the full range cheaply — this lets us always surface at least the
    // creation tx (and its timestamp when the block is still readable).
    let created =
      forThisBill.find((entry) => entry.eventName === "BillCreated") ?? null;

    if (!created) {
      // The RPC caps eth_getLogs at a 10,000-block range, so we can't scan from
      // genesis in one call. Walk backwards in safe chunks; because billId is
      // indexed each chunk returns at most one BillCreated log, so we stop at
      // the first hit. Bounded so a missing/very old bill degrades gracefully.
      const CHUNK = 9_000n;
      const MAX_CHUNKS = 40;
      let toBlock = fromBlock > 0n ? fromBlock - 1n : 0n;

      for (let scanned = 0; scanned < MAX_CHUNKS && created === null; scanned += 1) {
        const chunkFrom = toBlock > CHUNK ? toBlock - CHUNK : 0n;
        const createdLog = await publicClient
          .getLogs({
            address: BILL_SPLIT_REGISTRY_ADDRESS,
            event: billCreatedEvent,
            args: { billId },
            fromBlock: chunkFrom,
            toBlock,
          })
          .then((entries) => entries[0])
          .catch(() => undefined);

        if (createdLog && createdLog.blockNumber !== null && createdLog.transactionHash !== null) {
          created = {
            eventName: "BillCreated",
            args: createdLog.args as Record<string, unknown>,
            blockNumber: createdLog.blockNumber,
            txHash: createdLog.transactionHash,
          };
          break;
        }

        if (chunkFrom === 0n) {
          break;
        }
        toBlock = chunkFrom - 1n;
      }
    }

    if (forThisBill.length === 0 && !created) {
      return empty;
    }

    // Resolve each distinct block's timestamp once.
    const relevant = created ? [...forThisBill, created] : forThisBill;
    const blockNumbers = [...new Set(relevant.map((entry) => entry.blockNumber))];
    const timestamps = new Map<bigint, bigint>();
    await Promise.all(
      blockNumbers.map(async (blockNumber) => {
        try {
          const block = await publicClient.getBlock({ blockNumber });
          timestamps.set(blockNumber, block.timestamp);
        } catch {
          // Missing entry is treated as null below.
        }
      }),
    );
    const timestampFor = (blockNumber: bigint) => timestamps.get(blockNumber) ?? null;

    const sorted = [...forThisBill].sort((a, b) => Number(a.blockNumber - b.blockNumber));

    const payments: BillPaymentRecord[] = sorted
      .filter((entry) => entry.eventName === "DebtPaid")
      .map((entry) => ({
        payer: getAddress(entry.args.payer as `0x${string}`),
        amount: entry.args.amount as bigint,
        paidTotal: entry.args.paidTotal as bigint,
        timestamp: timestampFor(entry.blockNumber),
        txHash: entry.txHash,
      }));

    const claims: BillClaimRecord[] = sorted
      .filter((entry) => entry.eventName === "FundsClaimed")
      .map((entry) => ({
        splitter: getAddress(entry.args.splitter as `0x${string}`),
        amount: entry.args.amount as bigint,
        timestamp: timestampFor(entry.blockNumber),
        txHash: entry.txHash,
      }));

    return {
      billId,
      createdAt: created ? timestampFor(created.blockNumber) : null,
      createdTxHash: created ? created.txHash : null,
      payments,
      claims,
    };
  } catch {
    return empty;
  }
}

// Re-exported from the isomorphic module so server routes can hash without
// pulling in this "use client" file. See lib/bill-metadata.ts.
export { billMetadataHash, verifyBillPreimage, type BillPreimage } from "@/lib/bill-metadata";

export function billPaymentMemoId({ billId, payer }: { billId: bigint; payer: `0x${string}` }) {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("string app, string type, uint256 billId, address payer"), [
      SPLITSY_MEMO_APP,
      BILL_PAYMENT_MEMO_TYPE,
      billId,
      payer,
    ]),
  );
}

export function billPaymentMemoData({
  billId,
  payer,
  amount,
}: {
  billId: bigint;
  payer: `0x${string}`;
  amount: bigint;
}) {
  return stringToHex(
    JSON.stringify({
      app: SPLITSY_MEMO_APP,
      type: BILL_PAYMENT_MEMO_TYPE,
      billId: billId.toString(),
      payer,
      amountUnits: amount.toString(),
      amountUsdc: billUnitsToUsdc(amount),
      target: BILL_SPLIT_REGISTRY_ADDRESS,
    }),
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

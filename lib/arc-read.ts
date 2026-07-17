// Server-side (Node runtime) reads of BillSplitRegistry. Mirrors the publicClient
// pattern in app/api/onchain-bills/preimage/route.ts. Kept separate from the
// "use client" lib/bill-split-contracts.ts so server routes never pull client code.
import { createPublicClient, decodeEventLog, http, parseAbiItem } from "viem";
import { arcTestnet } from "viem/chains";

export const REGISTRY_ADDRESS = (process.env.NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS ??
  "0x0000000000000000000000000000000000000000") as `0x${string}`;

const READ_ABI = [
  {
    type: "function",
    name: "getBill",
    stateMutability: "view",
    inputs: [{ name: "billId", type: "uint256" }],
    outputs: [
      { name: "splitter", type: "address" },
      { name: "metadataHash", type: "bytes32" },
      { name: "totalOwed", type: "uint256" },
      { name: "totalPaid", type: "uint256" },
      { name: "claimed", type: "uint256" },
      { name: "participantList", type: "address[]" },
    ],
  },
  {
    type: "function",
    name: "getParticipant",
    stateMutability: "view",
    inputs: [
      { name: "billId", type: "uint256" },
      { name: "participantAddress", type: "address" },
    ],
    outputs: [
      { name: "owed", type: "uint256" },
      { name: "paid", type: "uint256" },
      { name: "exists", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "claimable",
    stateMutability: "view",
    inputs: [{ name: "billId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "billIdsForSplitter",
    stateMutability: "view",
    inputs: [{ name: "splitter", type: "address" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
] as const;

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network"),
});

export async function getBillOnchain(billId: bigint) {
  const r = await publicClient.readContract({
    address: REGISTRY_ADDRESS,
    abi: READ_ABI,
    functionName: "getBill",
    args: [billId],
  });
  return {
    splitter: r[0],
    metadataHash: r[1],
    totalOwed: r[2],
    totalPaid: r[3],
    claimed: r[4],
    participantList: r[5],
  };
}

export async function getParticipantOnchain(billId: bigint, addr: `0x${string}`) {
  const r = await publicClient.readContract({
    address: REGISTRY_ADDRESS,
    abi: READ_ABI,
    functionName: "getParticipant",
    args: [billId, addr],
  });
  return { owed: r[0], paid: r[1], exists: r[2] };
}

export async function getClaimableOnchain(billId: bigint) {
  return publicClient.readContract({
    address: REGISTRY_ADDRESS,
    abi: READ_ABI,
    functionName: "claimable",
    args: [billId],
  });
}

export async function getBillIdsForSplitterOnchain(addr: `0x${string}`): Promise<readonly bigint[]> {
  return publicClient.readContract({
    address: REGISTRY_ADDRESS,
    abi: READ_ABI,
    functionName: "billIdsForSplitter",
    args: [addr],
  });
}

const ARC_USDC_ADDRESS = (process.env.ARC_TESTNET_USDC_ADDRESS ??
  "0x3600000000000000000000000000000000000000") as `0x${string}`;

const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

// How much USDC `wallet` sent/received in a mined tx, from the receipt's
// Transfer logs. Circle's listTransactions reports contract executions
// (approve/payDebt/claim) with no `amounts`, so the wallet history would show
// $0 for them — this recovers the real figure from chain. Base units (6 dp).
export async function readUsdcMovedInTx(
  txHash: `0x${string}`,
  wallet: `0x${string}`,
): Promise<{ sent: bigint; received: bigint }> {
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  const me = wallet.toLowerCase();
  let sent = 0n;
  let received = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ARC_USDC_ADDRESS.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: [TRANSFER_EVENT], data: log.data, topics: log.topics });
      if (ev.args.from.toLowerCase() === me) sent += ev.args.value;
      if (ev.args.to.toLowerCase() === me) received += ev.args.value;
    } catch {
      // Non-Transfer USDC log (e.g. Approval) — not a movement.
    }
  }
  return { sent, received };
}

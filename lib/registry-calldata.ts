// Isomorphic calldata builders for BillSplitRegistry, RecurringTabFactory /
// RecurringTab, and ERC20 approve. No
// "use client" and no browser globals, so server routes can import this to
// build the callData for a Circle DCW contract-execution. The ABI fragments
// below are byte-identical copies of the ones in lib/bill-split-contracts.ts
// and lib/recurring-contracts.ts (bill-split-contracts.ts is "use client" and
// must not be imported server-side).
import { encodeFunctionData } from "viem";

export const REGISTRY_CALL_ABI = [
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
] as const;

export const RECURRING_FACTORY_CALL_ABI = [
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
] as const;

export const RECURRING_TAB_CALL_ABI = [
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [], outputs: [] },
] as const;

export const ERC20_APPROVE_ABI = [
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
] as const;

export function encodeCreateBill(
  metadataHash: `0x${string}`,
  participants: `0x${string}`[],
  owedAmounts: bigint[],
): `0x${string}` {
  return encodeFunctionData({
    abi: REGISTRY_CALL_ABI,
    functionName: "createBill",
    args: [metadataHash, participants, owedAmounts],
  });
}

export function encodePayDebt(billId: bigint, amount: bigint): `0x${string}` {
  return encodeFunctionData({ abi: REGISTRY_CALL_ABI, functionName: "payDebt", args: [billId, amount] });
}

export function encodeClaim(billId: bigint, amount: bigint): `0x${string}` {
  return encodeFunctionData({ abi: REGISTRY_CALL_ABI, functionName: "claim", args: [billId, amount] });
}

export function encodeApprove(spender: `0x${string}`, amount: bigint): `0x${string}` {
  return encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve", args: [spender, amount] });
}

export function encodeCreateTab(
  recipient: `0x${string}`,
  settlementInterval: bigint,
  maxSettlements: bigint,
  members: `0x${string}`[],
  fixedShares: bigint[],
): `0x${string}` {
  return encodeFunctionData({
    abi: RECURRING_FACTORY_CALL_ABI,
    functionName: "createTab",
    args: [recipient, settlementInterval, maxSettlements, members, fixedShares],
  });
}

// RecurringTab.claim() takes no arguments — unlike the registry's claim(billId, amount).
export function encodeTabClaim(): `0x${string}` {
  return encodeFunctionData({ abi: RECURRING_TAB_CALL_ABI, functionName: "claim", args: [] });
}

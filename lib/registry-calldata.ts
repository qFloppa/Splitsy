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
      { internalType: "uint64", name: "dueDate", type: "uint64" },
      { internalType: "bool", name: "escrowUntilFull", type: "bool" },
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
    name: "payDebtFor",
    stateMutability: "nonpayable",
    inputs: [
      { internalType: "uint256", name: "billId", type: "uint256" },
      { internalType: "address", name: "debtor", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "authorizeCollect",
    stateMutability: "nonpayable",
    inputs: [{ internalType: "uint256", name: "billId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "revokeCollect",
    stateMutability: "nonpayable",
    inputs: [{ internalType: "uint256", name: "billId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "collectDebt",
    stateMutability: "nonpayable",
    inputs: [
      { internalType: "uint256", name: "billId", type: "uint256" },
      { internalType: "address", name: "debtor", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "refund",
    stateMutability: "nonpayable",
    inputs: [{ internalType: "uint256", name: "billId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "settle",
    stateMutability: "nonpayable",
    inputs: [
      { internalType: "uint256[]", name: "claimBillIds", type: "uint256[]" },
      { internalType: "uint256[]", name: "payBillIds", type: "uint256[]" },
      { internalType: "uint256[]", name: "payAmounts", type: "uint256[]" },
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

// `dueDate` is Unix seconds (0 = no deadline) and `escrowUntilFull` withholds
// the creator's claim until everyone has paid. The contract rejects escrow
// without a due date, so callers must not offer that pair.
export function encodeCreateBill(
  metadataHash: `0x${string}`,
  participants: `0x${string}`[],
  owedAmounts: bigint[],
  dueDate: bigint = 0n,
  escrowUntilFull = false,
): `0x${string}` {
  return encodeFunctionData({
    abi: REGISTRY_CALL_ABI,
    functionName: "createBill",
    args: [metadataHash, participants, owedAmounts, dueDate, escrowUntilFull],
  });
}

export function encodePayDebt(billId: bigint, amount: bigint): `0x${string}` {
  return encodeFunctionData({ abi: REGISTRY_CALL_ABI, functionName: "payDebt", args: [billId, amount] });
}

// Third-party funding: `debtor`'s debt is credited, the caller's USDC pays it.
// This is what lets the autopay agent settle a debt out of its own wallet.
export function encodePayDebtFor(billId: bigint, debtor: `0x${string}`, amount: bigint): `0x${string}` {
  return encodeFunctionData({ abi: REGISTRY_CALL_ABI, functionName: "payDebtFor", args: [billId, debtor, amount] });
}

export function encodeAuthorizeCollect(billId: bigint): `0x${string}` {
  return encodeFunctionData({ abi: REGISTRY_CALL_ABI, functionName: "authorizeCollect", args: [billId] });
}

export function encodeRevokeCollect(billId: bigint): `0x${string}` {
  return encodeFunctionData({ abi: REGISTRY_CALL_ABI, functionName: "revokeCollect", args: [billId] });
}

// Creditor pull, only after the bill's due date and only under the debtor's
// mandate. `amount` is an upper bound — the contract caps it at the debtor's
// remaining share, allowance and balance.
export function encodeCollectDebt(billId: bigint, debtor: `0x${string}`, amount: bigint): `0x${string}` {
  return encodeFunctionData({ abi: REGISTRY_CALL_ABI, functionName: "collectDebt", args: [billId, debtor, amount] });
}

// One transaction for "claim everything owed to me, then pay everything I owe".
// Claims run first so their proceeds fund the pay legs. A pay amount of 0 means
// "my whole remaining share". All-or-nothing: one bad leg reverts the batch.
export function encodeSettle(
  claimBillIds: bigint[],
  payBillIds: bigint[],
  payAmounts: bigint[],
): `0x${string}` {
  return encodeFunctionData({
    abi: REGISTRY_CALL_ABI,
    functionName: "settle",
    args: [claimBillIds, payBillIds, payAmounts],
  });
}

export function encodeClaim(billId: bigint, amount: bigint): `0x${string}` {
  return encodeFunctionData({ abi: REGISTRY_CALL_ABI, functionName: "claim", args: [billId, amount] });
}

// Payer pull-back from a failed all-or-nothing bill: escrowUntilFull, past its
// due date, still short of totalOwed. No amount — the contract always returns
// the caller's whole contribution.
export function encodeRefund(billId: bigint): `0x${string}` {
  return encodeFunctionData({ abi: REGISTRY_CALL_ABI, functionName: "refund", args: [billId] });
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

// Circle SCA wallets expose executeBatch on the wallet address itself: each
// tuple is (target contract, native value, calldata) and the whole batch lands
// as ONE atomic transaction — any reverting leg reverts all of it.
// See https://developers.circle.com/wallets/batch-operations.md
// Encoded here rather than passed as abiFunctionSignature/abiParameters because
// Circle treats those as mutually exclusive with callData, and
// executeContractOnArc already sends callData.
export const SCA_BATCH_ABI = [
  {
    type: "function",
    name: "executeBatch",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

export function encodeExecuteBatch(
  calls: { to: string; value?: bigint; data: `0x${string}` }[],
): `0x${string}` {
  if (calls.length === 0) throw new Error("encodeExecuteBatch: no calls");
  return encodeFunctionData({
    abi: SCA_BATCH_ABI,
    functionName: "executeBatch",
    args: [calls.map((c) => ({ target: c.to as `0x${string}`, value: c.value ?? 0n, data: c.data }))],
  });
}

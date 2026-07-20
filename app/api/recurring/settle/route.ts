import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import {
  getTabAddressOnchain,
  getSettledMembersFromReceipt,
  getTabSettlementContext,
} from "@/lib/recurring-read";
import { recordRecurringPaidFeedbackSafely } from "@/lib/erc8004";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const factoryAddress = (
  process.env.NEXT_PUBLIC_RECURRING_TAB_FACTORY_ADDRESS ?? "0x6c4d980f7a9250e3892a3541b5a62420b628f3c1"
) as `0x${string}`;

const rpcUrl = process.env.ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network";

const recurringTabFactoryAbi = [
  { type: "error", name: "AlreadySettledForPeriod", inputs: [] },
  { type: "error", name: "InvalidConfiguration", inputs: [] },
  { type: "error", name: "MemberPaymentFailed", inputs: [{ internalType: "address", name: "member", type: "address" }] },
  { type: "error", name: "NoCollectibleMembers", inputs: [] },
  { type: "error", name: "TabComplete", inputs: [] },
  { type: "error", name: "UnknownTab", inputs: [{ internalType: "uint256", name: "tabId", type: "uint256" }] },
  {
    type: "function",
    name: "nextTabId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "settleTab",
    stateMutability: "nonpayable",
    inputs: [{ internalType: "uint256", name: "tabId", type: "uint256" }],
    outputs: [],
  },
] as const;

const ignorableSettlementErrors = new Set([
  "AlreadySettledForPeriod",
  "NoCollectibleMembers",
  "TabComplete",
  "UnknownTab",
]);

type SettlementResult = {
  tabId: string;
  status: "settled" | "skipped" | "failed";
  reason?: string;
  txHash?: `0x${string}`;
};

export async function GET(request: Request) {
  return settleRecurringTabs(request);
}

export async function POST(request: Request) {
  return settleRecurringTabs(request);
}

async function settleRecurringTabs(request: Request) {
  const authError = authorize(request);
  if (authError) {
    return authError;
  }

  const privateKey = normalizePrivateKey(process.env.RECURRING_SETTLER_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY);
  if (!privateKey) {
    return Response.json(
      { error: "Missing RECURRING_SETTLER_PRIVATE_KEY on the server." },
      { status: 500 },
    );
  }

  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({
    chain: arcTestnet,
    transport: http(rpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(rpcUrl),
  });

  try {
    const nextTabId = await publicClient.readContract({
      address: factoryAddress,
      abi: recurringTabFactoryAbi,
      functionName: "nextTabId",
    });
    const results: SettlementResult[] = [];

    for (let tabId = 1n; tabId < nextTabId; tabId++) {
      results.push(await settleTab({ publicClient, walletClient, tabId }));
    }

    return Response.json({
      settledAt: new Date().toISOString(),
      factory: factoryAddress,
      settler: account.address,
      checked: results.length,
      settled: results.filter((result) => result.status === "settled").length,
      skipped: results.filter((result) => result.status === "skipped").length,
      failed: results.filter((result) => result.status === "failed").length,
      results,
    });
  } catch (caught) {
    return Response.json({ error: errorMessage(caught) }, { status: 500 });
  }
}

async function settleTab({
  publicClient,
  walletClient,
  tabId,
}: {
  publicClient: ReturnType<typeof createPublicClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  tabId: bigint;
}): Promise<SettlementResult> {
  try {
    const { request } = await publicClient.simulateContract({
      address: factoryAddress,
      abi: recurringTabFactoryAbi,
      functionName: "settleTab",
      args: [tabId],
      account: walletClient.account,
    });
    const txHash = await walletClient.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    // ERC-8004 reputation: each member the settlement actually collected from
    // earns a "paid on time" score, graded against the cycle boundary. Consent
    // is their standing approval to the tab; the pull is the payment. Best-effort
    // and non-blocking — a scoring miss must never fail an on-chain settlement
    // that already succeeded (recordRecurringPaidFeedbackSafely swallows errors).
    await scoreSettledMembers({ tabId, txHash });

    return { tabId: tabId.toString(), status: "settled", txHash };
  } catch (caught) {
    const reason = errorName(caught);

    if (reason && ignorableSettlementErrors.has(reason)) {
      return { tabId: tabId.toString(), status: "skipped", reason };
    }

    return { tabId: tabId.toString(), status: "failed", reason: errorMessage(caught) };
  }
}

// Score every member collected in a just-confirmed settlement. Reads run
// against the settled tab (the factory only settles ids it deployed, so the
// address is trusted). The cycle number = the tab's post-settlement
// settlementCount, which keys each score per (member, tab, cycle) so a member
// paying N cycles earns N independent scores. Entirely best-effort: any failure
// here is logged and swallowed so the settlement result stays authoritative.
async function scoreSettledMembers({ tabId, txHash }: { tabId: bigint; txHash: `0x${string}` }): Promise<void> {
  try {
    const tabAddress = await getTabAddressOnchain(tabId);
    if (tabAddress === "0x0000000000000000000000000000000000000000") return;

    const [paidMembers, { cycle, dueDate }] = await Promise.all([
      getSettledMembersFromReceipt(txHash, tabAddress),
      getTabSettlementContext(tabAddress),
    ]);
    // cycle 0 means the context read failed; without a cycle key we can't keep
    // scoring idempotent, so skip rather than risk double-scoring on retry.
    if (cycle === 0) return;

    await Promise.all(
      paidMembers.map((p) =>
        recordRecurringPaidFeedbackSafely({
          memberAddress: p.member,
          tabId: tabId.toString(),
          cycle,
          settlementTxHash: txHash,
          dueDate,
          shareUnits: Number(p.amount),
        }),
      ),
    );
  } catch (caught) {
    console.error(`reputation[recurring]: scoring settlement of tab ${tabId} failed:`, errorMessage(caught));
  }
}

function authorize(request: Request) {
  const secret = process.env.RECURRING_SETTLER_SECRET ?? process.env.CRON_SECRET;
  if (!secret) {
    return Response.json(
      { error: "Missing RECURRING_SETTLER_SECRET or CRON_SECRET on the server." },
      { status: 500 },
    );
  }

  const authorization = request.headers.get("authorization");
  if (authorization !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized recurring settler request." }, { status: 401 });
  }

  return null;
}

function normalizePrivateKey(value: string | undefined): Hex | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return /^0x[a-fA-F0-9]{64}$/.test(trimmed) ? (trimmed as Hex) : null;
}

function errorName(caught: unknown) {
  const message = errorMessage(caught);

  for (const name of ignorableSettlementErrors) {
    if (message.includes(name) || message.includes(errorSelector(name))) {
      return name;
    }
  }

  return null;
}

function errorMessage(caught: unknown) {
  return caught instanceof Error ? caught.message : "Unexpected recurring settlement error.";
}

function errorSelector(name: string) {
  switch (name) {
    case "AlreadySettledForPeriod":
      return "0x8d551f43";
    case "NoCollectibleMembers":
      return "0xcf1c99b2";
    case "TabComplete":
      return "0xadf8f88b";
    case "UnknownTab":
      return "0x7881bfaa";
    default:
      return "";
  }
}

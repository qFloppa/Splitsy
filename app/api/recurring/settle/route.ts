import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const factoryAddress = (
  process.env.NEXT_PUBLIC_RECURRING_TAB_FACTORY_ADDRESS ?? "0x6c4d980f7a9250e3892a3541b5a62420b628f3c1"
) as `0x${string}`;

const rpcUrl = process.env.ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network";

const recurringTabFactoryAbi = [
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

    return { tabId: tabId.toString(), status: "settled", txHash };
  } catch (caught) {
    const reason = errorName(caught);

    if (reason && ignorableSettlementErrors.has(reason)) {
      return { tabId: tabId.toString(), status: "skipped", reason };
    }

    return { tabId: tabId.toString(), status: "failed", reason: errorMessage(caught) };
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
    if (message.includes(name)) {
      return name;
    }
  }

  return null;
}

function errorMessage(caught: unknown) {
  return caught instanceof Error ? caught.message : "Unexpected recurring settlement error.";
}

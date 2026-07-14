# On-chain (Registry) Bills with Social Participants — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the deployed `BillSplitRegistry` escrow accept social participants (X / Discord / email) in both directions — a non-custodial wallet creator can split an on-chain bill among social users, and a signed-in social user can create/pay/claim on-chain bills from their custodial Circle DCW.

**Architecture:** Social identity is bridged to an Arc address exactly once, at bill creation, by a server resolver that reuses an existing Splitsy user's wallet or pre-mints a handle-keyed Circle DCW into a new `pending_wallets` table. The chain stays the only ledger for these bills (no `bill_debts` mirror); each participant's handle rides inside the already-existing preimage `participantLabels` for display and verification. Social-side signing (createBill / approve+payDebt / claim) runs server-side via a new generic Circle contract-execution helper; non-custodial signing stays client-side and unchanged. At sign-in the OAuth callback adopts any matching pending wallet as the user's own.

**Tech Stack:** Next.js (App Router, `runtime = "nodejs"` routes), TypeScript, viem (isomorphic ABI encoding + Arc reads), Circle Developer-Controlled Wallets SDK `@circle-fin/developer-controlled-wallets@9.2.0`, Supabase (Postgres), `node --test --experimental-strip-types` for unit tests.

## Global Constraints

- **Read the bundled Next.js docs before writing route/framework code.** Per `AGENTS.md`, this Next.js has breaking changes vs. training data — consult `node_modules/next/dist/docs/` and heed deprecation notices.
- All new API routes are Node runtime: `export const runtime = "nodejs";` and `export const dynamic = "force-dynamic";` (match `app/api/onchain-bills/preimage/route.ts`).
- **Never trust client-sent amounts or hashes.** Server reads owed/remaining from chain (`getParticipant`) and metadataHash from chain (`getBill`) — mirror the existing preimage route's pattern.
- Handle normalization is `handle.replace(/^@/, "").toLowerCase()` — identical to `lib/bills-repo.ts:42`. Any handle used as a key or a preimage label must be normalized the same way everywhere.
- **`participantLabels` is hashed into the on-chain commitment**, so both creation paths (client non-custodial and server social) MUST build labels identically: for a social row the label is `@<normalizedHandle>`; for a raw-address row the label is the participant's existing display label. Order of labels MUST match the order of `participantAddresses`/`owedAmounts` passed to `createBill`.
- Circle blockchain string is `"ARC-TESTNET"`; USDC amounts to Circle are strings; bill units use existing `usdcToBillUnits` / `billUnitsToUsdc`.
- Circle is optional at runtime: `getConfig()` returns null when unconfigured. New server code that needs Circle must fail clearly (throw / 503-shaped error), never crash login or bill creation.
- Do not modify or redeploy the smart contract. Use `billSplitRegistryAbi` and `BILL_SPLIT_REGISTRY_ADDRESS` from `lib/bill-split-contracts.ts` as-is.
- Reuse `publishOnchainBillPreimage` / `getOnchainBillPreimage` and the `BillVerification` component unchanged.

---

## File Structure

**New files:**
- `schema-pending-wallets.sql` — `pending_wallets` table (bridge from social handle → pre-minted DCW).
- `lib/pending-wallets-repo.ts` — CRUD for `pending_wallets` (get, insert, delete-by-handle).
- `lib/registry-calldata.ts` — isomorphic viem `encodeFunctionData` helpers for `createBill` / `payDebt` / `approve` / `claim` (importable from server routes; no `"use client"`).
- `lib/registry-calldata.test.ts` — encoding vectors.
- `lib/wallet-resolve.ts` — `resolveParticipantAddress(provider, handle)` (user → pending → mint) and `resolveParticipants(rows)`.
- `lib/wallet-resolve.test.ts` — resolution-ordering tests with stubbed repos.
- `lib/arc-read.ts` — server-side viem `publicClient` + thin reads (`getBillOnchain`, `getParticipantOnchain`, `getClaimableOnchain`) reusing `billSplitRegistryAbi`.
- `app/api/onchain-bills/resolve/route.ts` — POST: resolve social rows → addresses (for the non-custodial creator path).
- `app/api/onchain-bills/create/route.ts` — POST (session): social creator writes a bill from their DCW.
- `app/api/onchain-bills/[billId]/pay/route.ts` — POST (session): social payer pays their full remaining share from their DCW.
- `app/api/onchain-bills/[billId]/claim/route.ts` — POST (session): social creator claims from their DCW.

**Modified files:**
- `lib/circle-dcw.ts` — add `executeContractOnArc(walletId, contractAddress, callData)` (create + poll to terminal state).
- `lib/oauth-callback.ts` — adopt a matching `pending_wallets` row at first login before falling back to `getOrCreateArcWallet`.
- `app/HomeClient.tsx` — allow social rows in the on-chain form; resolve before signing; label building; wire social-side pay/claim/create calls.
- `lib/bill-metadata.test.ts` — add a vector with `@handle` labels.

---

### Task 1: `pending_wallets` schema + repo

**Files:**
- Create: `schema-pending-wallets.sql`
- Create: `lib/pending-wallets-repo.ts`
- Test: `lib/pending-wallets-repo.test.ts`

**Interfaces:**
- Consumes: `createSupabaseServerClient` from `@/lib/supabase`; `IdentityProvider` from `@/lib/types`.
- Produces:
  - `type PendingWallet = { provider: IdentityProvider; handle: string; wallet_address: string; circle_wallet_id: string }`
  - `getPendingWallet(provider: IdentityProvider, handle: string): Promise<PendingWallet | null>`
  - `insertPendingWallet(row: PendingWallet): Promise<void>` (idempotent: `upsert` with `onConflict: "provider,handle", ignoreDuplicates: true`)
  - `deletePendingWallet(provider: IdentityProvider, handle: string): Promise<void>`
  - `normalizePendingHandle(handle: string): string` (`handle.replace(/^@/, "").toLowerCase()`) — exported so callers key consistently.

- [ ] **Step 1: Write the schema file**

Create `schema-pending-wallets.sql`:

```sql
-- schema-pending-wallets.sql — run in the Supabase SQL editor (additive).
--
-- Bridges a social handle (X / Discord / email) to a Circle DCW that was
-- pre-minted when the handle was tagged on an ON-CHAIN bill, before that person
-- ever signed into Splitsy. createBill needs a real Arc address for every
-- participant, so we mint one here and remember it. When the person signs in,
-- the OAuth callback ADOPTS this wallet (sets it on their user row) and deletes
-- the pending row, so their escrow position is theirs.
--
-- Keyed by (provider, handle): the same normalized pair used to match debts.
create table if not exists pending_wallets (
  provider          text not null,   -- 'x' | 'discord' | 'email'
  handle            text not null,   -- normalized: leading @ stripped, lowercased
  wallet_address    text not null,   -- 0x Arc address of the pre-minted DCW
  circle_wallet_id  text not null,   -- Circle wallet id (for server-side signing)
  created_at        timestamptz not null default now(),
  primary key (provider, handle)
);
```

- [ ] **Step 2: Write the failing repo test**

Create `lib/pending-wallets-repo.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizePendingHandle } from "./pending-wallets-repo.ts";

test("normalizePendingHandle strips a leading @ and lowercases", () => {
  assert.equal(normalizePendingHandle("@Alice"), "alice");
  assert.equal(normalizePendingHandle("BOB"), "bob");
  assert.equal(normalizePendingHandle("a@b.com"), "a@b.com");
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test --experimental-strip-types lib/pending-wallets-repo.test.ts`
Expected: FAIL — cannot find module / `normalizePendingHandle is not a function`.

- [ ] **Step 4: Write the repo**

Create `lib/pending-wallets-repo.ts`:

```ts
import { createSupabaseServerClient } from "@/lib/supabase";
import type { IdentityProvider } from "@/lib/types";

export type PendingWallet = {
  provider: IdentityProvider;
  handle: string;
  wallet_address: string;
  circle_wallet_id: string;
};

// Same normalization the debt matcher uses (lib/bills-repo.ts), so a handle
// keys identically whether it is tagged, resolved, or adopted at login.
export function normalizePendingHandle(handle: string): string {
  return handle.replace(/^@/, "").toLowerCase();
}

function requireClient() {
  const client = createSupabaseServerClient();
  if (!client) throw new Error("Supabase is not configured");
  return client;
}

export async function getPendingWallet(
  provider: IdentityProvider,
  handle: string,
): Promise<PendingWallet | null> {
  const client = requireClient();
  const { data, error } = await client
    .from("pending_wallets")
    .select("provider, handle, wallet_address, circle_wallet_id")
    .eq("provider", provider)
    .eq("handle", normalizePendingHandle(handle))
    .maybeSingle();
  if (error) throw new Error(`Failed to read pending wallet: ${error.message}`);
  return (data as PendingWallet) ?? null;
}

export async function insertPendingWallet(row: PendingWallet): Promise<void> {
  const client = requireClient();
  const { error } = await client.from("pending_wallets").upsert(
    {
      provider: row.provider,
      handle: normalizePendingHandle(row.handle),
      wallet_address: row.wallet_address,
      circle_wallet_id: row.circle_wallet_id,
    },
    { onConflict: "provider,handle", ignoreDuplicates: true },
  );
  if (error) throw new Error(`Failed to insert pending wallet: ${error.message}`);
}

export async function deletePendingWallet(
  provider: IdentityProvider,
  handle: string,
): Promise<void> {
  const client = requireClient();
  const { error } = await client
    .from("pending_wallets")
    .delete()
    .eq("provider", provider)
    .eq("handle", normalizePendingHandle(handle));
  if (error) throw new Error(`Failed to delete pending wallet: ${error.message}`);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test --experimental-strip-types lib/pending-wallets-repo.test.ts`
Expected: PASS (3 assertions).

- [ ] **Step 6: Commit**

```bash
git add schema-pending-wallets.sql lib/pending-wallets-repo.ts lib/pending-wallets-repo.test.ts
git commit -m "feat: pending_wallets bridge table + repo for social on-chain bills"
```

**Note for the operator:** `schema-pending-wallets.sql` must be run in the Supabase SQL editor before the feature works end to end (same manual step as prior schema files).

---

### Task 2: Registry calldata encoders (isomorphic)

**Files:**
- Create: `lib/registry-calldata.ts`
- Test: `lib/registry-calldata.test.ts`

**Interfaces:**
- Consumes: `billSplitRegistryAbi` from `@/lib/bill-split-contracts` (re-exported ABI is data-only, safe to import server-side — it is a `const` array, importing it does not execute client code); `usdcAbi`, `ARC_USDC_ADDRESS` from `@/lib/recurring-contracts`. NOTE: `lib/bill-split-contracts.ts` is `"use client"`, so DO NOT import it from a server route. Instead this module re-declares the two ABI fragments it needs (createBill/payDebt/claim and ERC20 approve) locally so it stays server-safe. Keep the fragments byte-identical to the originals.
- Produces (all return `` `0x${string}` `` calldata):
  - `encodeCreateBill(metadataHash: \`0x${string}\`, participants: \`0x${string}\`[], owedAmounts: bigint[])`
  - `encodePayDebt(billId: bigint, amount: bigint)`
  - `encodeClaim(billId: bigint, amount: bigint)`
  - `encodeApprove(spender: \`0x${string}\`, amount: bigint)`

- [ ] **Step 1: Write the failing test**

Create `lib/registry-calldata.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData } from "viem";
import {
  encodeApprove,
  encodeClaim,
  encodeCreateBill,
  encodePayDebt,
  REGISTRY_CALL_ABI,
  ERC20_APPROVE_ABI,
} from "./registry-calldata.ts";

test("encodeCreateBill round-trips through decodeFunctionData", () => {
  const data = encodeCreateBill(
    ("0x" + "ab".repeat(32)) as `0x${string}`,
    [("0x" + "11".repeat(20)) as `0x${string}`],
    [1000000n],
  );
  const decoded = decodeFunctionData({ abi: REGISTRY_CALL_ABI, data });
  assert.equal(decoded.functionName, "createBill");
  assert.equal(decoded.args[2][0], 1000000n);
});

test("encodePayDebt and encodeClaim encode billId + amount", () => {
  const pay = decodeFunctionData({ abi: REGISTRY_CALL_ABI, data: encodePayDebt(5n, 250n) });
  assert.equal(pay.functionName, "payDebt");
  assert.deepEqual(pay.args, [5n, 250n]);
  const claim = decodeFunctionData({ abi: REGISTRY_CALL_ABI, data: encodeClaim(5n, 250n) });
  assert.equal(claim.functionName, "claim");
  assert.deepEqual(claim.args, [5n, 250n]);
});

test("encodeApprove encodes spender + amount", () => {
  const spender = ("0x" + "22".repeat(20)) as `0x${string}`;
  const decoded = decodeFunctionData({ abi: ERC20_APPROVE_ABI, data: encodeApprove(spender, 999n) });
  assert.equal(decoded.functionName, "approve");
  assert.equal(decoded.args[1], 999n);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --experimental-strip-types lib/registry-calldata.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the encoder module**

Create `lib/registry-calldata.ts`:

```ts
// Isomorphic calldata builders for BillSplitRegistry + ERC20 approve. No
// "use client" and no browser globals, so server routes can import this to
// build the callData for a Circle DCW contract-execution. The ABI fragments
// below are byte-identical copies of the ones in lib/bill-split-contracts.ts
// (which is "use client" and must not be imported server-side).
import { encodeFunctionData } from "viem";

export const REGISTRY_CALL_ABI = [
  {
    type: "function",
    name: "createBill",
    stateMutability: "nonpayable",
    inputs: [
      { name: "metadataHash", type: "bytes32" },
      { name: "participantAddresses", type: "address[]" },
      { name: "owedAmounts", type: "uint256[]" },
    ],
    outputs: [{ name: "billId", type: "uint256" }],
  },
  {
    type: "function",
    name: "payDebt",
    stateMutability: "nonpayable",
    inputs: [
      { name: "billId", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "billId", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export const ERC20_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --experimental-strip-types lib/registry-calldata.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/registry-calldata.ts lib/registry-calldata.test.ts
git commit -m "feat: isomorphic registry + approve calldata encoders"
```

---

### Task 3: Server-side Arc reads

**Files:**
- Create: `lib/arc-read.ts`

**Interfaces:**
- Consumes: `viem` (`createPublicClient`, `http`), `arcTestnet` from `viem/chains`, `REGISTRY_CALL_ABI` is call-only so this module declares its own read ABI (getBill / getParticipant / claimable), `BILL_SPLIT_REGISTRY_ADDRESS` — re-declared here from `process.env.NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS` (do NOT import the "use client" `bill-split-contracts.ts`).
- Produces:
  - `REGISTRY_ADDRESS: \`0x${string}\``
  - `getBillOnchain(billId: bigint): Promise<{ splitter: \`0x${string}\`; metadataHash: \`0x${string}\`; totalOwed: bigint; totalPaid: bigint; claimed: bigint; participantList: readonly \`0x${string}\`[] }>`
  - `getParticipantOnchain(billId: bigint, addr: \`0x${string}\`): Promise<{ owed: bigint; paid: bigint; exists: boolean }>`
  - `getClaimableOnchain(billId: bigint): Promise<bigint>`

- [ ] **Step 1: Write the module** (no unit test — it is a thin RPC wrapper verified via the route round-trips in later tasks)

Create `lib/arc-read.ts`:

```ts
// Server-side (Node runtime) reads of BillSplitRegistry. Mirrors the publicClient
// pattern in app/api/onchain-bills/preimage/route.ts. Kept separate from the
// "use client" lib/bill-split-contracts.ts so server routes never pull client code.
import { createPublicClient, http } from "viem";
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
```

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep arc-read || echo "no arc-read type errors"`
Expected: `no arc-read type errors`.

- [ ] **Step 3: Commit**

```bash
git add lib/arc-read.ts
git commit -m "feat: server-side Arc registry reads (getBill/getParticipant/claimable)"
```

---

### Task 4: DCW contract-execution helper

**Files:**
- Modify: `lib/circle-dcw.ts` (add `executeContractOnArc`; reuse the existing `getConfig`, `InsufficientFundsError`)

**Interfaces:**
- Consumes: the module-private `getConfig()` and `InsufficientFundsError` already in `lib/circle-dcw.ts`; `randomUUID` from `node:crypto`.
- Produces:
  - `executeContractOnArc(walletId: string, contractAddress: string, callData: \`0x${string}\`): Promise<{ id: string; state: string; txHash: string | null }>` — creates a contract-execution transaction from the DCW and polls `getTransaction` until a terminal state (`COMPLETE`/`CONFIRMED` success, or `FAILED`/`DENIED`/`CANCELLED` throw). Throws `InsufficientFundsError` when Circle reports insufficient balance/gas (same detection as `transferUsdcOnArc`).

- [ ] **Step 1: Add the helper to `lib/circle-dcw.ts`**

Add `import { randomUUID } from "node:crypto";` at the top, then insert this function (after `transferUsdcOnArc`, before `InsufficientFundsError`'s class or anywhere in module scope):

```ts
// Execute an arbitrary contract call from a DCW on Arc (createBill / approve /
// payDebt / claim). callData is ABI-encoded by the caller (lib/registry-calldata).
// We poll to a terminal state because callers need the result: bill creation
// needs the BillCreated billId (read from chain afterward), and pay/claim need
// to know the tx didn't revert. The wallet pays its own gas in USDC at MEDIUM.
export async function executeContractOnArc(
  walletId: string,
  contractAddress: string,
  callData: `0x${string}`,
): Promise<{ id: string; state: string; txHash: string | null }> {
  const config = getConfig();
  if (!config) throw new Error("Circle is not configured");

  let created;
  try {
    // Cast the input for the same reason transferUsdcOnArc does: SDK 9.2.0's
    // union types lag the API and omit ARC-TESTNET.
    created = await config.client.createContractExecutionTransaction({
      walletId,
      contractAddress,
      callData,
      blockchain: "ARC-TESTNET",
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      idempotencyKey: randomUUID(),
    } as unknown as Parameters<typeof config.client.createContractExecutionTransaction>[0]);
  } catch (e) {
    const body = (e as { response?: { data?: unknown } })?.response?.data;
    const raw = body ? JSON.stringify(body) : (e as Error).message;
    if (/insufficient|not enough|balance|exceeds/i.test(raw)) {
      throw new InsufficientFundsError();
    }
    throw new Error(`Circle contract execution failed: ${raw}`);
  }

  const id = created.data?.id;
  if (!id) throw new Error("Circle contract execution returned no transaction id");

  // Poll to a terminal state (~60s cap). Arc settles fast on testnet.
  const terminalOk = new Set(["COMPLETE", "CONFIRMED"]);
  const terminalBad = new Set(["FAILED", "DENIED", "CANCELLED"]);
  for (let i = 0; i < 30; i++) {
    const tx = await config.client.getTransaction({ id });
    const state = tx.data?.transaction?.state ?? "";
    const txHash = tx.data?.transaction?.txHash ?? null;
    if (terminalOk.has(state)) return { id, state, txHash };
    if (terminalBad.has(state)) throw new Error(`Contract execution ${state.toLowerCase()}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  // Still pending after the cap — return what we have; the caller decides.
  return { id, state: "PENDING", txHash: null };
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep circle-dcw || echo "no circle-dcw type errors"`
Expected: `no circle-dcw type errors`. (If `getTransaction`'s response shape differs, adjust the `tx.data?.transaction?.…` access to match the SDK — the `createTransaction` return in the same file confirms `res.data?.id`/`res.data?.state`; `getTransaction` wraps a single `transaction` object.)

- [ ] **Step 3: Commit**

```bash
git add lib/circle-dcw.ts
git commit -m "feat: executeContractOnArc — run registry calls from a DCW"
```

---

### Task 5: `wallet-resolve` — social handle → Arc address

**Files:**
- Create: `lib/wallet-resolve.ts`
- Test: `lib/wallet-resolve.test.ts`

**Interfaces:**
- Consumes: `getPendingWallet`, `insertPendingWallet`, `normalizePendingHandle` from `@/lib/pending-wallets-repo`; `getUserByProviderHandle` (NEW — added to `lib/users-repo.ts` in this task); `getOrCreateArcWallet` from `@/lib/circle-dcw`; `IdentityProvider` from `@/lib/types`.
- Produces:
  - `type ResolvedParticipant = { provider: IdentityProvider; handle: string; address: string }`
  - `resolveParticipantAddress(provider: IdentityProvider, handle: string, deps?: ResolveDeps): Promise<string>` — user → pending → mint. `deps` is an optional injection seam for tests (defaults to the real repos/Circle).
  - `type ResolveDeps` = the three functions it depends on, injectable.
  - `resolveParticipants(rows: { provider: IdentityProvider; handle: string }[], deps?: ResolveDeps): Promise<ResolvedParticipant[]>`

Also in `lib/users-repo.ts` add:
  - `getUserByProviderHandle(provider: IdentityProvider, handle: string): Promise<AppUser | null>` — selects a user by `(provider, handle)` with `handle` normalized; returns the row so callers can read `wallet_address`.

- [ ] **Step 1: Add `getUserByProviderHandle` to `lib/users-repo.ts`**

```ts
// Find a user by (provider, handle) — handle normalized like bills-repo. Used by
// address resolution to reuse an existing person's wallet before pre-minting.
export async function getUserByProviderHandle(
  provider: IdentityProvider,
  handle: string,
): Promise<AppUser | null> {
  const client = requireClient();
  const { data, error } = await client
    .from("users")
    .select()
    .eq("provider", provider)
    .eq("handle", handle.replace(/^@/, "").toLowerCase())
    .maybeSingle();
  if (error) throw new Error(`Failed to read user by handle: ${error.message}`);
  return (data as AppUser) ?? null;
}
```

- [ ] **Step 2: Write the failing test**

Create `lib/wallet-resolve.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveParticipantAddress, type ResolveDeps } from "./wallet-resolve.ts";

const ADDR_USER = "0x" + "11".repeat(20);
const ADDR_PENDING = "0x" + "22".repeat(20);
const ADDR_MINTED = "0x" + "33".repeat(20);

test("prefers an existing user's wallet", async () => {
  const deps: ResolveDeps = {
    getUserByProviderHandle: async () => ({ wallet_address: ADDR_USER }) as never,
    getPendingWallet: async () => {
      throw new Error("should not be called");
    },
    mintPending: async () => {
      throw new Error("should not be called");
    },
  };
  assert.equal(await resolveParticipantAddress("x", "alice", deps), ADDR_USER);
});

test("falls back to a pending wallet", async () => {
  const deps: ResolveDeps = {
    getUserByProviderHandle: async () => null,
    getPendingWallet: async () => ({ wallet_address: ADDR_PENDING }) as never,
    mintPending: async () => {
      throw new Error("should not be called");
    },
  };
  assert.equal(await resolveParticipantAddress("x", "alice", deps), ADDR_PENDING);
});

test("mints when neither exists", async () => {
  let minted = false;
  const deps: ResolveDeps = {
    getUserByProviderHandle: async () => null,
    getPendingWallet: async () => null,
    mintPending: async () => {
      minted = true;
      return ADDR_MINTED;
    },
  };
  assert.equal(await resolveParticipantAddress("x", "alice", deps), ADDR_MINTED);
  assert.equal(minted, true);
});

test("a user with no wallet_address yet falls through to pending/mint", async () => {
  const deps: ResolveDeps = {
    getUserByProviderHandle: async () => ({ wallet_address: null }) as never,
    getPendingWallet: async () => null,
    mintPending: async () => ADDR_MINTED,
  };
  assert.equal(await resolveParticipantAddress("x", "alice", deps), ADDR_MINTED);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test --experimental-strip-types lib/wallet-resolve.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the module**

Create `lib/wallet-resolve.ts`:

```ts
import type { IdentityProvider } from "@/lib/types";
import { getUserByProviderHandle } from "@/lib/users-repo";
import {
  getPendingWallet,
  insertPendingWallet,
  normalizePendingHandle,
} from "@/lib/pending-wallets-repo";
import { getOrCreateArcWallet } from "@/lib/circle-dcw";

export type ResolvedParticipant = { provider: IdentityProvider; handle: string; address: string };

// Injection seam so unit tests can stub the three side-effecting dependencies.
export type ResolveDeps = {
  getUserByProviderHandle: (p: IdentityProvider, h: string) => Promise<{ wallet_address: string | null } | null>;
  getPendingWallet: (p: IdentityProvider, h: string) => Promise<{ wallet_address: string } | null>;
  // Pre-mint a DCW for this handle, persist it to pending_wallets, return its address.
  mintPending: (p: IdentityProvider, h: string) => Promise<string>;
};

async function defaultMintPending(provider: IdentityProvider, handle: string): Promise<string> {
  const norm = normalizePendingHandle(handle);
  // Namespaced refId so a pre-mint can never collide with a real signin wallet
  // ("<provider>:<providerUserId>"). Keyed by handle, not user id.
  const wallet = await getOrCreateArcWallet("prem", `${provider}:${norm}`);
  if (!wallet) throw new Error("Circle is not configured — cannot pre-mint a wallet");
  await insertPendingWallet({
    provider,
    handle: norm,
    wallet_address: wallet.address,
    circle_wallet_id: wallet.walletId,
  });
  return wallet.address;
}

const realDeps: ResolveDeps = {
  getUserByProviderHandle,
  getPendingWallet,
  mintPending: defaultMintPending,
};

// user wallet → pending wallet → freshly minted DCW. Idempotent per handle:
// two tags of the same @alice on two bills resolve to the same address.
export async function resolveParticipantAddress(
  provider: IdentityProvider,
  handle: string,
  deps: ResolveDeps = realDeps,
): Promise<string> {
  const user = await deps.getUserByProviderHandle(provider, handle);
  if (user?.wallet_address) return user.wallet_address;

  const pending = await deps.getPendingWallet(provider, handle);
  if (pending?.wallet_address) return pending.wallet_address;

  return deps.mintPending(provider, handle);
}

export async function resolveParticipants(
  rows: { provider: IdentityProvider; handle: string }[],
  deps: ResolveDeps = realDeps,
): Promise<ResolvedParticipant[]> {
  const out: ResolvedParticipant[] = [];
  for (const row of rows) {
    // Sequential, not Promise.all: two rows tagging the same handle must not race
    // to mint two wallets. Bills have few participants, so this is cheap.
    const address = await resolveParticipantAddress(row.provider, row.handle, deps);
    out.push({ provider: row.provider, handle: normalizePendingHandle(row.handle), address });
  }
  return out;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test --experimental-strip-types lib/wallet-resolve.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/wallet-resolve.ts lib/wallet-resolve.test.ts lib/users-repo.ts
git commit -m "feat: resolve social handles to Arc addresses (user/pending/mint)"
```

---

### Task 6: Adopt a pending wallet at sign-in

**Files:**
- Modify: `lib/oauth-callback.ts:66-74` (the wallet-provisioning block inside `finishProviderLogin`)

**Interfaces:**
- Consumes: `getPendingWallet`, `deletePendingWallet` from `@/lib/pending-wallets-repo`; existing `setUserWallet`, `getOrCreateArcWallet`.
- Produces: no new exports — behavior change only. After this task, a first-time login for `(provider, handle)` that has a `pending_wallets` row adopts that wallet (so the person controls the DCW that already holds their escrow position) instead of minting a fresh one.

- [ ] **Step 1: Replace the provisioning block**

In `lib/oauth-callback.ts`, change the `if (!appUser.wallet_address) { … }` block (currently lines ~66-74) to check for a pending wallet first:

```ts
  // Provision a wallet on first login (idempotent). Prefer ADOPTING a wallet that
  // was pre-minted when this handle was tagged on an on-chain bill — that DCW may
  // already hold an escrow position, so it must become this user's wallet. Only
  // if there is no pending wallet do we mint a fresh one. Best-effort: never block
  // login if Circle/Supabase is down.
  if (!appUser.wallet_address) {
    try {
      const pending = await getPendingWallet(provider, appUser.handle);
      if (pending) {
        await setUserWallet(appUser.id, pending.wallet_address, pending.circle_wallet_id);
        await deletePendingWallet(provider, appUser.handle);
      } else {
        const wallet = await getOrCreateArcWallet(provider, profile.providerUserId);
        if (wallet) await setUserWallet(appUser.id, wallet.address, wallet.walletId);
      }
    } catch (walletErr) {
      console.error("Wallet provisioning/adoption failed (login continues):", walletErr);
    }
  }
```

Add the import at the top:

```ts
import { getPendingWallet, deletePendingWallet } from "@/lib/pending-wallets-repo";
```

- [ ] **Step 2: Verify it type-checks and existing session tests still pass**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep oauth-callback || echo "no oauth-callback type errors"`
Then: `node --test --experimental-strip-types lib/session.test.ts`
Expected: `no oauth-callback type errors`; session tests PASS unchanged.

- [ ] **Step 3: Commit**

```bash
git add lib/oauth-callback.ts
git commit -m "feat: adopt a pending pre-minted wallet on first social login"
```

---

### Task 7: Resolve route (non-custodial creator path)

**Files:**
- Create: `app/api/onchain-bills/resolve/route.ts`

**Interfaces:**
- Consumes: `resolveParticipants` from `@/lib/wallet-resolve`; `IdentityProvider` from `@/lib/types`.
- Produces: `POST /api/onchain-bills/resolve` — body `{ participants: { provider: "x"|"discord"|"email"; handle: string }[] }` → `{ resolved: { provider, handle, address }[] }` in the SAME order as input. Errors: 400 invalid body / empty / too many; 503 when Circle unconfigured (pre-mint impossible); 500 otherwise.

This route is intentionally session-agnostic: a non-custodial creator is wallet-connected, not signed into Splitsy. It only mints wallets, which is why it caps participant count and requires valid handles (griefing mitigation).

- [ ] **Step 1: Write the route**

```ts
import { resolveParticipants } from "@/lib/wallet-resolve";
import type { IdentityProvider } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVIDERS: IdentityProvider[] = ["x", "discord", "email"];
const MAX_PARTICIPANTS = 20;

// Per-provider handle validity — same rules as HomeClient's HandleField.
function validHandle(provider: IdentityProvider, handle: string): boolean {
  const h = handle.replace(/^@/, "").trim();
  if (provider === "x") return /^[a-zA-Z0-9_]{1,15}$/.test(h);
  if (provider === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(h);
  if (provider === "discord") return /^[a-z0-9._]{2,32}$/.test(h.toLowerCase());
  return false;
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    participants?: { provider?: unknown; handle?: unknown }[];
  } | null;
  const rows = body?.participants;
  if (!Array.isArray(rows) || rows.length === 0) {
    return Response.json({ error: "participants required" }, { status: 400 });
  }
  if (rows.length > MAX_PARTICIPANTS) {
    return Response.json({ error: "too many participants" }, { status: 400 });
  }
  const clean: { provider: IdentityProvider; handle: string }[] = [];
  for (const r of rows) {
    if (typeof r?.provider !== "string" || !PROVIDERS.includes(r.provider as IdentityProvider)) {
      return Response.json({ error: "invalid provider" }, { status: 400 });
    }
    if (typeof r?.handle !== "string" || !validHandle(r.provider as IdentityProvider, r.handle)) {
      return Response.json({ error: `invalid handle for ${r.provider}` }, { status: 400 });
    }
    clean.push({ provider: r.provider as IdentityProvider, handle: r.handle });
  }

  try {
    const resolved = await resolveParticipants(clean);
    return Response.json({ resolved });
  } catch (err) {
    const message = err instanceof Error ? err.message : "resolve failed";
    const status = /not configured/i.test(message) ? 503 : 500;
    return Response.json({ error: message }, { status });
  }
}
```

- [ ] **Step 2: Verify build registers the route**

Run: `npx next build 2>&1 | grep "onchain-bills/resolve" || echo "route missing"`
Expected: the route path appears in the build output (NOT "route missing"). If `next build` is too slow in the loop, instead run `npx tsc --noEmit -p tsconfig.json 2>&1 | grep resolve/route || echo "no type errors"`.

- [ ] **Step 3: Commit**

```bash
git add app/api/onchain-bills/resolve/route.ts
git commit -m "feat: /api/onchain-bills/resolve — social handles to addresses"
```

---

### Task 8: Create route (social creator path)

**Files:**
- Create: `app/api/onchain-bills/create/route.ts`

**Interfaces:**
- Consumes: `getSessionUser` from `@/lib/session`; `resolveParticipants` from `@/lib/wallet-resolve`; `billMetadataHash` from `@/lib/bill-metadata`; `usdcToBillUnits` — NOTE it lives in the `"use client"` file, so re-implement inline: `BigInt(Math.round(Number(x) * 1e6))`; `encodeCreateBill` from `@/lib/registry-calldata`; `executeContractOnArc` from `@/lib/circle-dcw`; `REGISTRY_ADDRESS`, `getBillOnchain` from `@/lib/arc-read`; `publishOnchainBillPreimage` from `@/lib/onchain-bill-preimage-repo`; `hashReceiptBytes` from `@/lib/bill-metadata`.
- Produces: `POST /api/onchain-bills/create` (session required) — body `{ merchant, currency, total, participants: { provider?, handle?, address?, amountUsd }[], receiptHash?, receiptImageBase64? }` → `{ billId: string }`.

**Label rule (must match the client path in Task 10):** a participant with a `handle` gets label `@<normalizedHandle>`; a participant with a raw `address` gets label = its provided `label` or `Payer N`. Label order === address order === owed order.

**Finding the new billId:** `createBill` returns the id, but a DCW execution gives us a txHash, not a return value. Read it from the `BillCreated` event in the tx receipt via `getBillOnchain` is not enough (needs the id first). Instead: after the execution confirms, call `billIdsForSplitter(creatorAddress)` and take the highest id whose `getBillOnchain` metadataHash matches the one we just committed. Add `getBillIdsForSplitterOnchain(addr)` to `lib/arc-read.ts` (reads the `billIdsForSplitter` view — add its ABI fragment to `READ_ABI`).

- [ ] **Step 1: Add `getBillIdsForSplitterOnchain` to `lib/arc-read.ts`**

Add this fragment to `READ_ABI`:

```ts
  {
    type: "function",
    name: "billIdsForSplitter",
    stateMutability: "view",
    inputs: [{ name: "splitter", type: "address" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
```

And export:

```ts
export async function getBillIdsForSplitterOnchain(addr: `0x${string}`): Promise<readonly bigint[]> {
  return publicClient.readContract({
    address: REGISTRY_ADDRESS,
    abi: READ_ABI,
    functionName: "billIdsForSplitter",
    args: [addr],
  });
}
```

- [ ] **Step 2: Write the route**

```ts
import { getSessionUser } from "@/lib/session";
import { resolveParticipants } from "@/lib/wallet-resolve";
import { billMetadataHash, hashReceiptBytes } from "@/lib/bill-metadata";
import { encodeCreateBill } from "@/lib/registry-calldata";
import { executeContractOnArc, InsufficientFundsError } from "@/lib/circle-dcw";
import { REGISTRY_ADDRESS, getBillOnchain, getBillIdsForSplitterOnchain } from "@/lib/arc-read";
import { publishOnchainBillPreimage } from "@/lib/onchain-bill-preimage-repo";
import type { IdentityProvider } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVIDERS: IdentityProvider[] = ["x", "discord", "email"];
const toUnits = (usd: number) => BigInt(Math.round(usd * 1e6));

type InRow = { provider?: unknown; handle?: unknown; address?: unknown; label?: unknown; amountUsd?: unknown };

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  if (!user.circle_wallet_id || !user.wallet_address) {
    return Response.json({ error: "Your wallet isn't provisioned yet. Log in again." }, { status: 409 });
  }

  const body = (await request.json().catch(() => null)) as {
    merchant?: unknown; currency?: unknown; total?: unknown;
    participants?: InRow[]; receiptHash?: unknown; receiptImageBase64?: unknown;
  } | null;
  if (!body || !Array.isArray(body.participants) || body.participants.length === 0) {
    return Response.json({ error: "participants required" }, { status: 400 });
  }
  const merchant = typeof body.merchant === "string" ? body.merchant : "";
  const currency = typeof body.currency === "string" ? body.currency : "USD";
  const total = typeof body.total === "number" && Number.isFinite(body.total) ? body.total : NaN;
  if (!Number.isFinite(total)) return Response.json({ error: "invalid total" }, { status: 400 });
  const receiptHash = typeof body.receiptHash === "string" ? body.receiptHash : "";
  const receiptImageBase64 = typeof body.receiptImageBase64 === "string" ? body.receiptImageBase64 : undefined;

  // Split rows into social (need resolving) and raw-address, remembering order.
  const socialRows: { provider: IdentityProvider; handle: string }[] = [];
  const slots: ({ kind: "social"; idx: number; amountUsd: number; label: string } |
                { kind: "address"; address: `0x${string}`; amountUsd: number; label: string })[] = [];
  let payerN = 0;
  for (const r of body.participants) {
    const amountUsd = typeof r.amountUsd === "number" ? r.amountUsd : 0;
    if (amountUsd <= 0) continue;
    payerN += 1;
    if (typeof r.address === "string" && /^0x[a-fA-F0-9]{40}$/.test(r.address)) {
      const label = typeof r.label === "string" && r.label.trim() ? r.label.trim() : `Payer ${payerN}`;
      slots.push({ kind: "address", address: r.address as `0x${string}`, amountUsd, label });
    } else if (typeof r.provider === "string" && PROVIDERS.includes(r.provider as IdentityProvider) && typeof r.handle === "string") {
      const norm = r.handle.replace(/^@/, "").toLowerCase();
      socialRows.push({ provider: r.provider as IdentityProvider, handle: norm });
      slots.push({ kind: "social", idx: socialRows.length - 1, amountUsd, label: `@${norm}` });
    } else {
      return Response.json({ error: "each participant needs an address or provider+handle" }, { status: 400 });
    }
  }
  if (slots.length === 0) return Response.json({ error: "no participants with a positive share" }, { status: 400 });

  let resolvedSocial;
  try {
    resolvedSocial = await resolveParticipants(socialRows);
  } catch (err) {
    const message = err instanceof Error ? err.message : "resolve failed";
    return Response.json({ error: message }, { status: /not configured/i.test(message) ? 503 : 500 });
  }

  const addresses: `0x${string}`[] = [];
  const owed: bigint[] = [];
  const labels: string[] = [];
  for (const s of slots) {
    addresses.push(s.kind === "address" ? s.address : (resolvedSocial[s.idx].address as `0x${string}`));
    owed.push(toUnits(s.amountUsd));
    labels.push(s.label);
  }

  const metadataHash = billMetadataHash({ merchant, currency, total, participantLabels: labels, receiptHash });

  // Execute createBill from the creator's DCW.
  try {
    await executeContractOnArc(user.circle_wallet_id, REGISTRY_ADDRESS, encodeCreateBill(metadataHash, addresses, owed));
  } catch (err) {
    if (err instanceof InsufficientFundsError) return Response.json({ error: "insufficient_funds" }, { status: 402 });
    return Response.json({ error: err instanceof Error ? err.message : "createBill failed" }, { status: 502 });
  }

  // The DCW execution has no return value, so find the new bill: the highest id
  // for this splitter whose committed metadataHash matches what we just sent.
  let billId: bigint | null = null;
  try {
    const ids = await getBillIdsForSplitterOnchain(user.wallet_address as `0x${string}`);
    for (const id of [...ids].sort((a, b) => (a > b ? -1 : 1))) {
      const bill = await getBillOnchain(id);
      if (bill.metadataHash.toLowerCase() === metadataHash.toLowerCase()) { billId = id; break; }
    }
  } catch {
    // fall through — creation succeeded even if we can't pin the id right now
  }
  if (billId === null) {
    return Response.json({ error: "Bill created, but its id could not be confirmed. Refresh to see it." }, { status: 202 });
  }

  // Publish the preimage (best-effort) so payers can verify. Reuses the server
  // publisher, which re-reads the on-chain hash and hard-gates a mismatch.
  try {
    const receiptBytes = receiptImageBase64 ? new Uint8Array(Buffer.from(receiptImageBase64, "base64")) : null;
    if (receiptBytes && hashReceiptBytes(receiptBytes).toLowerCase() !== receiptHash.toLowerCase()) {
      // Non-fatal: skip the receipt image if it doesn't match, still publish text.
    }
    await publishOnchainBillPreimage(
      { registryAddress: REGISTRY_ADDRESS, billId: billId.toString(), merchant, currency, total, participantLabels: labels, receiptHash },
      metadataHash,
      receiptBytes,
    );
  } catch (err) {
    console.error("Preimage publish failed (bill still created):", err);
  }

  return Response.json({ billId: billId.toString() });
}
```

- [ ] **Step 3: Verify it type-checks / registers**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep "create/route\|arc-read" || echo "no type errors"`
Expected: `no type errors`.

- [ ] **Step 4: Commit**

```bash
git add app/api/onchain-bills/create/route.ts lib/arc-read.ts
git commit -m "feat: /api/onchain-bills/create — social creator writes escrow bill from DCW"
```

---

### Task 9: Pay + Claim routes (social payer / social creator)

**Files:**
- Create: `app/api/onchain-bills/[billId]/pay/route.ts`
- Create: `app/api/onchain-bills/[billId]/claim/route.ts`

**Interfaces:**
- Consumes: `getSessionUser`; `WALLET_UNLOCK_COOKIE`, `verifyWalletUnlock` from `@/lib/session-core`; `cookies` from `next/headers`; `encodeApprove`, `encodePayDebt`, `encodeClaim` from `@/lib/registry-calldata`; `ARC_USDC_ADDRESS` — re-declare inline from `process.env.ARC_TESTNET_USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000"` (matches `lib/circle-dcw.ts`); `executeContractOnArc`, `InsufficientFundsError`; `REGISTRY_ADDRESS`, `getParticipantOnchain`, `getBillOnchain`, `getClaimableOnchain` from `@/lib/arc-read`.
- Produces: `POST /api/onchain-bills/[billId]/pay` → `{ ok, txHash }`; `POST /api/onchain-bills/[billId]/claim` → `{ ok, txHash }`. Both session-gated + wallet-unlock-gated (same second factor as `app/api/debts/[id]/pay/route.ts`).

**Why unlock-gated:** these routes spend from the user's custodial DCW, exactly like the off-chain pay route. Reuse the same `verifyWalletUnlock` check so a hijacked social login alone can't drain a wallet.

- [ ] **Step 1: Write the pay route**

`app/api/onchain-bills/[billId]/pay/route.ts`:

```ts
import { cookies } from "next/headers";
import { getSessionUser } from "@/lib/session";
import { verifyWalletUnlock, WALLET_UNLOCK_COOKIE } from "@/lib/session-core";
import { encodeApprove, encodePayDebt } from "@/lib/registry-calldata";
import { executeContractOnArc, InsufficientFundsError } from "@/lib/circle-dcw";
import { REGISTRY_ADDRESS, getParticipantOnchain } from "@/lib/arc-read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ARC_USDC_ADDRESS = process.env.ARC_TESTNET_USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000";

function isBillId(v: string): boolean {
  return /^[0-9]+$/.test(v);
}

export async function POST(_request: Request, { params }: { params: Promise<{ billId: string }> }) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });

  const secret = process.env.SESSION_SECRET ?? "";
  const unlockToken = (await cookies()).get(WALLET_UNLOCK_COOKIE)?.value ?? "";
  if (verifyWalletUnlock(unlockToken, secret, Date.now()) !== user.id) {
    return Response.json({ error: "locked" }, { status: 403 });
  }
  if (!user.circle_wallet_id || !user.wallet_address) {
    return Response.json({ error: "Your wallet isn't provisioned yet. Log in again." }, { status: 409 });
  }

  const { billId } = await params;
  if (!isBillId(billId)) return Response.json({ error: "bad bill id" }, { status: 400 });

  // Read the debt from chain — never trust a client amount.
  const part = await getParticipantOnchain(BigInt(billId), user.wallet_address as `0x${string}`);
  if (!part.exists) return Response.json({ error: "You're not a participant on this bill." }, { status: 403 });
  const remaining = part.owed - part.paid;
  if (remaining <= 0n) return Response.json({ error: "Already paid" }, { status: 409 });

  // approve(registry, remaining) then payDebt(billId, remaining), both from the DCW.
  try {
    await executeContractOnArc(user.circle_wallet_id, ARC_USDC_ADDRESS, encodeApprove(REGISTRY_ADDRESS, remaining));
    const tx = await executeContractOnArc(user.circle_wallet_id, REGISTRY_ADDRESS, encodePayDebt(BigInt(billId), remaining));
    return Response.json({ ok: true, txHash: tx.txHash });
  } catch (err) {
    if (err instanceof InsufficientFundsError) return Response.json({ error: "insufficient_funds" }, { status: 402 });
    return Response.json({ error: err instanceof Error ? err.message : "payment failed" }, { status: 502 });
  }
}
```

- [ ] **Step 2: Write the claim route**

`app/api/onchain-bills/[billId]/claim/route.ts`:

```ts
import { cookies } from "next/headers";
import { getSessionUser } from "@/lib/session";
import { verifyWalletUnlock, WALLET_UNLOCK_COOKIE } from "@/lib/session-core";
import { encodeClaim } from "@/lib/registry-calldata";
import { executeContractOnArc } from "@/lib/circle-dcw";
import { REGISTRY_ADDRESS, getBillOnchain, getClaimableOnchain } from "@/lib/arc-read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isBillId(v: string): boolean {
  return /^[0-9]+$/.test(v);
}

export async function POST(_request: Request, { params }: { params: Promise<{ billId: string }> }) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });

  const secret = process.env.SESSION_SECRET ?? "";
  const unlockToken = (await cookies()).get(WALLET_UNLOCK_COOKIE)?.value ?? "";
  if (verifyWalletUnlock(unlockToken, secret, Date.now()) !== user.id) {
    return Response.json({ error: "locked" }, { status: 403 });
  }
  if (!user.circle_wallet_id || !user.wallet_address) {
    return Response.json({ error: "Your wallet isn't provisioned yet. Log in again." }, { status: 409 });
  }

  const { billId } = await params;
  if (!isBillId(billId)) return Response.json({ error: "bad bill id" }, { status: 400 });

  // Only the splitter can claim, and only what's claimable.
  const bill = await getBillOnchain(BigInt(billId));
  if (bill.splitter.toLowerCase() !== (user.wallet_address as string).toLowerCase()) {
    return Response.json({ error: "You didn't create this bill." }, { status: 403 });
  }
  const claimable = await getClaimableOnchain(BigInt(billId));
  if (claimable <= 0n) return Response.json({ error: "Nothing to claim yet." }, { status: 409 });

  try {
    const tx = await executeContractOnArc(user.circle_wallet_id, REGISTRY_ADDRESS, encodeClaim(BigInt(billId), claimable));
    return Response.json({ ok: true, txHash: tx.txHash });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "claim failed" }, { status: 502 });
  }
}
```

- [ ] **Step 3: Verify it type-checks**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep "onchain-bills/\[billId\]" || echo "no type errors"`
Expected: `no type errors`.

- [ ] **Step 4: Commit**

```bash
git add "app/api/onchain-bills/[billId]/pay/route.ts" "app/api/onchain-bills/[billId]/claim/route.ts"
git commit -m "feat: social payer pays + social creator claims on-chain escrow from DCW"
```

---

### Task 10: Extend the bill-metadata test with a handle-label vector

**Files:**
- Modify: `lib/bill-metadata.test.ts`

**Interfaces:** none new — a regression guard that `@handle` labels hash and verify like any other label (since labels now carry identities).

- [ ] **Step 1: Add the test**

Append to `lib/bill-metadata.test.ts`:

```ts
test("handle labels hash and verify like plain labels", () => {
  const social: BillPreimage = {
    merchant: "Joe's Diner",
    currency: "USD",
    total: 30,
    participantLabels: ["@alice", "@bob", "carol@example.com"],
    receiptHash: "",
  };
  const hash = billMetadataHash(social);
  assert.equal(verifyBillPreimage(social, hash), true);
  // Reordering identities is a different bill (order is part of the commitment).
  assert.equal(verifyBillPreimage({ ...social, participantLabels: ["@bob", "@alice", "carol@example.com"] }, hash), false);
});
```

- [ ] **Step 2: Run + commit**

Run: `node --test --experimental-strip-types lib/bill-metadata.test.ts`
Expected: PASS (5 tests).

```bash
git add lib/bill-metadata.test.ts
git commit -m "test: handle labels hash + verify in the bill commitment"
```

---

### Task 11: UI — allow social rows on the on-chain form + wire social create

**Files:**
- Modify: `app/HomeClient.tsx` (the "Review your split" mode selector ~line 1817-1835; the participant row ~line 1866-1885; the submit button ~line 1921-1929; `submitBillOnchain` ~line 746; add a new mode state near line 270)

**Interfaces:**
- Consumes: existing `createBillSplit`, `billMetadataHash`, `BILL_SPLIT_REGISTRY_ADDRESS`, `HandleField`, `SplitParticipant.provider`; `/api/onchain-bills/resolve` (Task 7); `/api/onchain-bills/create` (Task 8); `/api/me` to know if the creator is a signed-in social user.
- Produces: a `settle` mode state (`"onchain" | "offchain"`) that replaces the current binary `splitBy` semantics for routing the submit, while participant rows can now hold either an address or a provider+handle in BOTH modes.

**Design note on the mode selector.** Today the selector is Wallet (`splitBy="address"`, on-chain) vs Tag people (`splitBy="handle"`, off-chain). This task keeps `splitBy` for the input-shape of a row but adds an explicit settlement choice so a bill with social rows can go on-chain. Minimal change: keep the two existing buttons but rename the routing so that:
  - **On-chain (escrow)** → `submitBillOnchainMixed()` (new): resolves social rows via `/api/onchain-bills/resolve`, then either signs `createBill` in the connected wallet (non-custodial creator) OR posts to `/api/onchain-bills/create` (signed-in social creator with no connected wallet).
  - **Off-chain (direct)** → `submitBillOffchain()` (unchanged).

- [ ] **Step 1: Add state + a helper to detect a signed-in social creator**

Near the other `useState` calls (~line 270), add:

```tsx
  // Whether the create form settles into the on-chain escrow (registry) or the
  // off-chain direct ledger. Rows can carry addresses or @handles in either mode.
  const [settleMode, setSettleMode] = useState<"onchain" | "offchain">("onchain");
  // The signed-in Splitsy user (social creator), if any — lets a DCW user create
  // an on-chain bill server-side without a browser wallet.
  const [me, setMe] = useState<{ walletAddress: string | null } | null>(null);
```

And in an effect after mount (near other init effects):

```tsx
  useEffect(() => {
    fetch("/api/me").then((r) => r.json()).then((d) => setMe(d.user ?? null)).catch(() => {});
  }, []);
```

- [ ] **Step 2: Add `submitBillOnchainMixed`**

Add next to `submitBillOnchain` (~line 746). It reuses the existing manual-total guard and `confirmedUsd`:

```tsx
  // On-chain path that ALSO accepts @handle participants. Social rows are resolved
  // to Arc addresses server-side (pre-minting a DCW when needed); then either the
  // connected wallet signs createBill, or — for a signed-in social creator with no
  // browser wallet — the server signs it from their DCW.
  async function submitBillOnchainMixed() {
    if (splitMode === "manual" && splitTotal - confirmedUsd > 0.009) {
      setBillState("error");
      setBillMessage("Manual shares cannot be larger than the bill Total USD amount.");
      return;
    }
    const rows = displayParticipants.filter((p) => p.amountUsd > 0 && p.walletAddress.trim());
    if (rows.length === 0) {
      setBillState("error");
      setBillMessage("Add at least one participant with a positive share.");
      return;
    }

    // Build ordered slots; social rows are those whose input isn't a 0x address.
    const isAddr = (v: string) => /^0x[a-fA-F0-9]{40}$/.test(v.trim());
    const socialRows = rows
      .filter((p) => !isAddr(p.walletAddress))
      .map((p) => ({ provider: p.provider ?? "x", handle: p.walletAddress.trim() }));

    try {
      setBillState("working");

      // Resolve social handles → addresses (pre-mints as needed).
      let resolvedByHandle = new Map<string, string>();
      if (socialRows.length > 0) {
        setBillMessage("Resolving tagged people…");
        const res = await fetch("/api/onchain-bills/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ participants: socialRows }),
        });
        const data = await res.json();
        if (!res.ok) {
          setBillState("error");
          setBillMessage(data.error === "insufficient_funds" || res.status === 503
            ? "Wallet service isn't configured, so tagged people can't be added on-chain yet."
            : (data.error ?? "Could not resolve tagged people."));
          return;
        }
        resolvedByHandle = new Map(
          (data.resolved as { provider: string; handle: string; address: string }[])
            .map((r) => [`${r.provider}:${r.handle}`, r.address]),
        );
      }

      // Ordered addresses / owed / labels — labels MUST match the server path:
      // "@<handle>" for social, existing label for address rows.
      const addresses: string[] = [];
      const owedAmounts: bigint[] = [];
      const labels: string[] = [];
      for (const p of rows) {
        if (isAddr(p.walletAddress)) {
          addresses.push(normalizeAddress(p.walletAddress));
          labels.push(p.label);
        } else {
          const norm = p.walletAddress.trim().replace(/^@/, "").toLowerCase();
          const addr = resolvedByHandle.get(`${p.provider ?? "x"}:${norm}`);
          if (!addr) throw new Error(`Could not resolve @${norm}`);
          addresses.push(addr);
          labels.push(`@${norm}`);
        }
        owedAmounts.push(usdcToBillUnits(p.amountUsd.toFixed(2)));
      }

      const receiptHash = receiptCommit?.hash ?? "";

      // Signed-in social creator with NO connected browser wallet → server signs.
      if (!billWallet && me?.walletAddress) {
        setBillMessage("Writing the split to Arc from your wallet…");
        const res = await fetch("/api/onchain-bills/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            merchant: bill.merchant,
            currency: bill.currency,
            total: confirmedUsd,
            participants: rows.map((p) => ({
              provider: isAddr(p.walletAddress) ? undefined : (p.provider ?? "x"),
              handle: isAddr(p.walletAddress) ? undefined : p.walletAddress.trim(),
              address: isAddr(p.walletAddress) ? normalizeAddress(p.walletAddress) : undefined,
              label: p.label,
              amountUsd: p.amountUsd,
            })),
            receiptHash,
            receiptImageBase64: receiptCommit ? bytesToBase64(receiptCommit.bytes) : undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setBillState("error");
          setBillMessage(data.error === "insufficient_funds"
            ? "Your wallet needs more test USDC to cover the gas for creating this bill."
            : (data.error ?? "Could not create the bill."));
          return;
        }
        setBillState("success");
        setBillMessage(`Bill #${data.billId} is live on Arc. Tagged people will see it after signing in.`);
        return;
      }

      // Otherwise: non-custodial creator signs createBill in their own wallet.
      const wallet = billWallet ?? (await connectBillWallet());
      if (!wallet) return;
      if (!isBillRegistryConfigured()) {
        setBillState("error");
        setBillMessage("Bill registry is not configured yet.");
        return;
      }
      setBillMessage("Switching to Arc Testnet…");
      await ensureBillSplitWalletOnArc(wallet);
      setBillMessage("Writing the split to Arc.");
      const result = await createBillSplit({
        ...wallet,
        metadataHash: billMetadataHash({
          merchant: bill.merchant, currency: bill.currency, total: confirmedUsd,
          participantLabels: labels, receiptHash,
        }),
        participants: addresses.map((a) => normalizeAddress(a)),
        owedAmounts,
      });
      setSubmittedBillId(result.billId);
      setBillState("success");
      setBillMessage(`Bill #${result.billId.toString()} is live on Arc. Payers will see it when they connect.`);
      void fetch("/api/onchain-bills/preimage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          registryAddress: BILL_SPLIT_REGISTRY_ADDRESS,
          billId: result.billId.toString(),
          merchant: bill.merchant, currency: bill.currency, total: confirmedUsd,
          participantLabels: labels, receiptHash,
          receiptImageBase64: receiptCommit ? bytesToBase64(receiptCommit.bytes) : undefined,
        }),
      }).catch(() => {});
      await refreshBillRegistry(wallet.account);
    } catch (caught) {
      setBillState("error");
      setBillMessage(errorMessage(caught));
    }
  }
```

- [ ] **Step 3: Update the mode selector + submit wiring**

Replace the settlement `segmented-control` (~line 1819-1826) so both buttons keep the row-input shape but the label reflects settlement, and the row always uses `HandleField` when the input isn't an address. Simplest concrete change that preserves current behavior:

- Keep the existing Wallet / Tag people buttons and `chooseSplitTarget`, but ADD a second small segmented control for settlement:

```tsx
                          <div className="segmented-control">
                            <ModeButton active={settleMode === "onchain"} onClick={() => setSettleMode("onchain")}>
                              On-chain
                            </ModeButton>
                            <ModeButton active={settleMode === "offchain"} onClick={() => setSettleMode("offchain")}>
                              Off-chain
                            </ModeButton>
                          </div>
```

Then change the submit button's `onClick` and label (~line 1924-1928):

```tsx
                      onClick={settleMode === "offchain" ? submitBillOffchain : submitBillOnchainMixed}
                      type="button"
                    >
                      {billState === "working" ? <Loader2 className="animate-spin" size={16} /> : <Landmark size={16} />}
                      {settleMode === "offchain" ? "Create bill" : "Write on Arc"}
```

And make the participant field render `HandleField` whenever the row's value is not an address, regardless of `splitBy` (so on-chain bills can tag people). Replace the `splitBy === "handle" ? <HandleField…> : <Field…>` ternary (~line 1872) with a check that shows `HandleField` when tagging is possible:

```tsx
                          {splitBy === "handle" ? (
                            <HandleField
                              provider={participant.provider ?? "x"}
                              onProviderChange={(value) => updateParticipant(participant.id, "provider", value)}
                              value={participant.walletAddress}
                              onChange={(value) => updateParticipant(participant.id, "walletAddress", value)}
                            />
                          ) : (
                            <Field
                              label="Wallet"
                              value={participant.walletAddress}
                              onChange={(value) => updateParticipant(participant.id, "walletAddress", value)}
                            />
                          )}
```

(Leaving the `splitBy` toggle to choose address-input vs handle-input, while `settleMode` chooses where it settles. A "Tag people" + "On-chain" combination is the new capability; "Wallet" + "On-chain" is the old behavior; "Tag people" + "Off-chain" is the old off-chain flow.)

- [ ] **Step 4: Update the route-strip helper copy** (~line 1841-1847) so it reflects `settleMode` rather than `splitBy`:

```tsx
                    <p className="font-semibold text-[var(--text)]">
                      {settleMode === "offchain" ? "Off-chain bill" : "Bill registry (escrow)"}
                    </p>
                    <p className="mt-1 text-[var(--text-muted)]">
                      {settleMode === "offchain"
                        ? "Tag each payer by X, Discord, or email — they settle directly after signing in."
                        : "Written to the on-chain escrow. Tagged people get a wallet and can pay + be claimed on Arc."}
                    </p>
```

- [ ] **Step 5: Verify build + typecheck**

Run: `npx next build 2>&1 | tail -20`
Expected: build succeeds; all `onchain-bills/*` routes registered; no new type errors. Pre-existing `react-hooks/set-state-in-effect` lint at `HandleField` is NOT a regression (documented in memory).

- [ ] **Step 6: Commit**

```bash
git add app/HomeClient.tsx
git commit -m "feat: on-chain bills can tag social participants; social creators write from their DCW"
```

---

### Task 12: UI — one-click pay + claim for social users on registry bills

**Files:**
- Modify: `app/HomeClient.tsx` (the payer's registry-debt card ~line 2094 area; the creator's claim card ~line 1204 `claimBillFunds` handler and its button)

**Interfaces:**
- Consumes: `/api/onchain-bills/[billId]/pay`, `/api/onchain-bills/[billId]/claim` (Task 9); existing `/api/wallet/pin` + `/api/wallet/unlock` flow (see `app/XDebtsPanel.tsx` for the unlock-then-act pattern); `me` (Task 11) to know if the current user is a social/DCW user vs a connected browser wallet.
- Produces: for a signed-in social user viewing a registry bill, Pay and Claim call the server routes (DCW signs) instead of requiring a browser wallet. Non-custodial users keep the existing in-wallet `payBillDebtWithMemo` / `claimBillFunds`.

**Key decision:** a social (DCW) user has no browser wallet, so the existing registry debt discovery (`readDebtsForWallet(billWallet.account)`) won't run for them. For this task, a signed-in social user's registry debts are discovered by calling a small read using their `me.walletAddress`. Add a client read path: when `me?.walletAddress` and no `billWallet`, call `readDebtsForWallet(me.walletAddress)` (already exported, client-side) to populate `debts`, and render the same cards but with server-backed Pay/Claim.

- [ ] **Step 1: Populate registry debts for a signed-in social user**

In the effect/area that calls `refreshBillRegistry`, add a branch: if `!billWallet && me?.walletAddress`, call `refreshBillRegistry(me.walletAddress as \`0x${string}\`)`. `refreshBillRegistry(account = billWallet?.account)` already accepts an address and internally runs `readDebtsForWallet` + `readBillsForSplitter` + `readArcUsdcBalance`, so no new read wiring is needed — just pass the social user's address.

Concretely, generalize `refreshBillRegistry(account = billWallet?.account)` so it accepts `me.walletAddress` when there's no connected wallet:

```tsx
  const registryReadAddress = (billWallet?.account ?? me?.walletAddress ?? null) as `0x${string}` | null;
  useEffect(() => {
    if (registryReadAddress) void refreshBillRegistry(registryReadAddress);
  }, [registryReadAddress]);
```

- [ ] **Step 2: Route Pay through the server for social users**

In the debt Pay handler (~line 961 `payBillDebt`), branch at the top:

```tsx
    // Social (DCW) user: no browser wallet — pay from the server, gated by the
    // same PIN unlock the off-chain pay flow uses.
    if (!billWallet && me?.walletAddress) {
      const pin = await fetch("/api/wallet/pin").then((r) => r.json()).catch(() => ({}));
      if (!pin.unlocked) {
        // HomeClient has no PIN modal of its own (it lives in XAuthControl/XDebtsPanel).
        // Direct the user to unlock via the wallet panel, then retry Pay. See Step 4.
        setDebtMessages((m) => ({ ...m, [debtKey]: { message: "Unlock your wallet (top-right wallet panel), then tap Pay again.", tone: "neutral" } }));
        return;
      }
      const res = await fetch(`/api/onchain-bills/${debt.billId.toString()}/pay`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setDebtMessages((m) => ({ ...m, [debtKey]: {
          message: data.error === "insufficient_funds" ? "Your wallet needs more test USDC." : (data.error ?? "Payment failed."),
          tone: "error" } }));
        return;
      }
      await refreshBillRegistry(me.walletAddress as `0x${string}`);
      return;
    }
```

Leave the existing `approveBillRegistry` + `payBillDebtWithMemo` path for connected wallets untouched below the branch.

- [ ] **Step 3: Route Claim through the server for social creators**

In the claim handler (~line 1185 `claimBill`), add the same branch before the in-wallet `claimBillFunds`:

```tsx
    if (!billWallet && me?.walletAddress) {
      const pin = await fetch("/api/wallet/pin").then((r) => r.json()).catch(() => ({}));
      if (!pin.unlocked) {
        setClaimMessage("Unlock your wallet (top-right wallet panel), then tap Claim again.");
        setClaimMessageTone("neutral");
        return;
      }
      const res = await fetch(`/api/onchain-bills/${debt.billId.toString()}/claim`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setClaimMessage(data.error ?? "Claim failed.");
        setClaimMessageTone("error");
        return;
      }
      await refreshBillRegistry(me.walletAddress as `0x${string}`);
      return;
    }
```

- [ ] **Step 4: Reuse the PIN unlock modal**

The off-chain flow already has a PIN modal (`app/XDebtsPanel.tsx`, `UnlockPanel`). For this task, if a dedicated modal isn't already reachable from HomeClient, gate on the `/api/wallet/pin` `unlocked` flag and surface a message directing the user to unlock via the existing wallet panel (`XAuthControl`) — do NOT build a second modal. Confirm during implementation whether HomeClient already renders an unlock affordance; if yes, trigger it; if no, the message-based fallback is acceptable for this iteration.

- [ ] **Step 5: Verify build**

Run: `npx next build 2>&1 | tail -20`
Expected: build succeeds, no new type errors.

- [ ] **Step 6: Commit**

```bash
git add app/HomeClient.tsx
git commit -m "feat: social users pay + claim registry bills from their DCW (one-click)"
```

---

## Manual Verification (post-implementation)

These require Circle creds + funded wallets + the Supabase schema run; they are not automatable in the plan loop.

1. Run `schema-pending-wallets.sql` in Supabase.
2. **Non-custodial → social:** connect a browser wallet, create an on-chain bill tagging an email handle with a share. Confirm a `pending_wallets` row appears and the bill is on Arc (`BillCreated`).
3. Sign in as that email user; confirm the pending wallet is adopted (user row gets `wallet_address`, pending row deleted) and the escrow debt shows on their card.
4. Unlock + Pay from their DCW; confirm `payDebt` lands and remaining → 0.
5. As the creator, Claim; confirm funds arrive.
6. **Social → wallet/social (vice versa):** as a signed-in DCW user (no browser wallet), create an on-chain bill mixing a raw address and an @handle. Confirm `/api/onchain-bills/create` returns a billId and the bill verifies (`BillVerification` ✅).

---

## Self-Review

**Spec coverage:**
- Address resolution (user→pending→mint) + `pending_wallets` → Tasks 1, 5.
- Sign-in adoption → Task 6.
- DCW contract execution → Task 4.
- Non-custodial creator with social participants → Tasks 7, 11.
- Social creator (vice versa) → Task 8, 11.
- Social payer one-click pay → Tasks 9, 12.
- Creator claims (non-custodial in-wallet unchanged; social via server) → Tasks 9, 12.
- Labels pinned + carried in preimage; verification reused → Tasks 8, 10, 11 (label rule repeated identically in both create paths).
- Chain as source of truth, no bill_debts mirror → no DB writes for on-chain bills anywhere in the plan. ✓
- No contract changes → only ABI reuse/reads. ✓

**Known follow-ups / accepted limits (from the spec):** handle-rename orphaning (no recovery), Gas Station deferred (DCW needs a little USDC for gas), partial payments from DCWs not supported (full remaining only), PIN unlock modal reuse in HomeClient may fall back to a directed message (Task 12 Step 4).


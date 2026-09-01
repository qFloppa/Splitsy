# Privy Wallet Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a second, Privy-backed wallet stack alongside the existing Circle DCW stack, selected by one env var, so `splitsy.xyz` can run non-custodial exportable wallets while `testnet.splitsy.xyz` keeps today's behaviour unchanged.

**Architecture:** Extract the four functions `lib/circle-dcw.ts` already exports into a `WalletBackend` interface (`lib/wallet-provider.ts`), give it two implementations — the existing Circle one and a new Privy one — and select between them with `WALLET_PROVIDER`. All 19 API routes plus `oauth-callback.ts`, `wallet-resolve.ts` and `user-agent.ts` import the seam instead of the Circle module. Both stacks run Arc Testnet in this plan; Arc mainnet is a separate plan.

**Tech Stack:** Next.js 16.2.9 (App Router), TypeScript, viem 2.52.2, Supabase, `@privy-io/server-auth` (new), `@circle-fin/developer-controlled-wallets` 9.2.0 (retained), `node --test --experimental-strip-types`.

**Spec:** `docs/superpowers/specs/2026-09-01-privy-wallet-stack-design.md`

## Global Constraints

- **This is not the Next.js you know.** Per `AGENTS.md`, read the relevant guide in `node_modules/next/dist/docs/` before writing any code, and heed deprecation notices. This repo uses `proxy.ts`, not `middleware.ts`.
- **Tests:** `node --test --experimental-strip-types`. Test files import siblings with an explicit `.ts` extension (`./foo.ts`), never the `@/lib/...` alias — the alias only resolves under Next's bundler.
- **Test gotcha:** `--experimental-strip-types` chokes on TypeScript constructor parameter properties (`constructor(readonly x: T)`). Any module imported by a test must use plain field assignment instead. `InsufficientFundsError` already follows this.
- **Dependency versions are pinned exactly** in `package.json` (no `^`), except `@types/*` and tooling. Add `@privy-io/server-auth` pinned to the exact version resolved at install time.
- **`.env.example` is gitignored repo-wide.** Document every new env var as a comment block in `.env.local` only.
- **One branch, both stacks.** Every change must leave `WALLET_PROVIDER=circle` behaviourally identical to today. A task that changes Circle-stack behaviour is a failed task.
- **All work happens on the branch `privy-wallet-stack`, never on `main`.** The live `splitsy.xyz` deployment tracks `main`, so a push to `main` reaches production even when behaviour is meant to be identical. The branch is what makes "no risk to the live build" a structural fact rather than a promise. Merging to `main` is a separate decision (see Task 8), and merging still changes nothing for users because `WALLET_PROVIDER` stays unset in the Production environment.
- **No production configuration changes before Task 8.** Tasks 1–7 touch only local files, the `splitsy-test` Supabase project, and Vercel's **Preview** environment.
- **Both stacks target Arc Testnet** (chain id `5042002`, USDC `0x3600000000000000000000000000000000000000`). Do not introduce mainnet constants.
- **No new client-side dependency.** Privy is server-only in this plan; do not add `@privy-io/react-auth` or touch `proxy.ts`'s CSP.

## File Structure

**Create:**
- `lib/wallet-provider.ts` — the `WalletBackend` interface, shared types, shared errors, and the env-driven selector. The only module the routes import.
- `lib/privy-wallet.ts` — Privy implementation of `WalletBackend`.
- `lib/privy-wallet.test.ts` — unit tests for the pure parts (refId keying, `WalletTx` mapping).
- `lib/wallet-provider.test.ts` — unit tests for the selector and the tx-hash discriminator.
- `scripts/privy-setup.ts` — the Task 1 spike, kept as the runnable proof and the setup script.

**Modify:**
- `lib/circle-dcw.ts` — conform its return types to the shared ones. No logic change.
- `lib/oauth-callback.ts:100` — provision through the seam.
- `lib/wallet-resolve.ts:21-25` — pre-mint through the seam.
- `lib/user-agent.ts:16,41,135` — agent wallet through the seam, at `wallet_index: 1`.
- 19 route files under `app/api/**` — swap the import.
- `app/XHistoryPanel.tsx:86` and `app/XAuthControl.tsx:321` — tx-hash discriminator and copy.
- `package.json` — new dep, new test scripts.

**Do not touch:** `lib/pin.ts`, `lib/session-core.ts`, the PIN routes, `lib/settler.ts`, `lib/scout/wallet.ts`, `proxy.ts`.

---

### Task 1: Prove Privy works on Arc Testnet

The walking skeleton. Nothing else in this plan is worth writing until a real
USDC transfer from a Privy wallet is visible on `testnet.arcscan.app`. This task
also resolves the spec's open question 2 (whether a social handle can be a
pregenerated linked account).

**Files:**
- Create: `scripts/privy-setup.ts`
- Modify: `package.json` (dependency + `privy:setup` script)
- Modify: `.env.local` (document `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_KEY_QUORUM_ID`)

**Interfaces:**
- Consumes: `ARC_TESTNET_NETWORK` and `ARC_TESTNET_USDC` from `lib/x402/constants.ts:1-2`.
- Produces: the confirmed request shapes for create-user-with-wallet and send-transaction, recorded in this script. Tasks 3 and 5 copy their calls from here rather than from documentation.

- [ ] **Step 1: Create a Privy app and record its credentials**

In the Privy dashboard: create an app, copy the app id and app secret, then
create a key quorum (Wallets → Signers → configure) and copy its id. Add to
`.env.local` with a comment block:

```
# Privy (WALLET_PROVIDER=privy stack only). App id + secret authenticate the
# server SDK; the key quorum is the signer attached to every wallet at creation
# so the server can transact without the user present.
PRIVY_APP_ID=
PRIVY_APP_SECRET=
PRIVY_KEY_QUORUM_ID=
```

- [ ] **Step 2: Install the server SDK**

Run: `npm install @privy-io/server-auth`

Then edit `package.json` to pin the resolved version exactly (strip the `^`), matching every other dependency in the file.

- [ ] **Step 3: Confirm the two API shapes against the docs**

Read these two pages and note the exact request bodies:
- `https://docs.privy.io/recipes/pregenerate-wallets` — create a user with wallets before signup.
- `https://docs.privy.io/wallets/using-wallets/ethereum/send-a-transaction` — the NodeJS/REST server path.

Two things to confirm, because the script below assumes them:
1. `POST https://auth.privy.io/api/v1/users` accepts `linked_accounts` plus a
   `wallets` array carrying `chain_type`, `wallet_index` and `additional_signers`.
2. The send path is a wallet-scoped RPC call taking a CAIP-2 chain id and an
   `eth_sendTransaction`-shaped transaction.

Also check whether `linked_accounts` accepts a Twitter or Discord username type. Record the answer as a comment at the top of the script — the spec's open question 2 depends on it.

- [ ] **Step 4: Write the spike script**

Create `scripts/privy-setup.ts`:

```ts
// Proof that a Privy wallet can hold and move USDC on Arc Testnet, and the
// record of the exact calls lib/privy-wallet.ts is built from.
//
// Run: npm run privy:setup
// Then fund the printed address from https://faucet.circle.com and run again
// with an amount to send:  npm run privy:setup -- 0.01 0xRecipient
import { PrivyClient } from "@privy-io/server-auth";
import { createPublicClient, encodeFunctionData, erc20Abi, http, parseUnits } from "viem";
import { arcTestnet } from "viem/chains";
import { ARC_TESTNET_NETWORK, ARC_TESTNET_RPC, ARC_TESTNET_USDC } from "../lib/x402/constants.ts";

const appId = process.env.PRIVY_APP_ID ?? "";
const appSecret = process.env.PRIVY_APP_SECRET ?? "";
const quorumId = process.env.PRIVY_KEY_QUORUM_ID ?? "";
if (!appId || !appSecret || !quorumId) {
  throw new Error("Set PRIVY_APP_ID, PRIVY_APP_SECRET and PRIVY_KEY_QUORUM_ID in .env.local");
}

const privy = new PrivyClient(appId, appSecret);
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(ARC_TESTNET_RPC) });

const [amount, recipient] = process.argv.slice(2);

// A stable test identity so re-runs reuse the same wallet instead of minting one
// per invocation — the same idempotency lib/privy-wallet.ts needs.
const TEST_KEY = "spike:arc-testnet-proof";

const user = await privy.users().create({
  linked_accounts: [{ type: "custom_jwt", custom_user_id: TEST_KEY }],
  wallets: [{ chain_type: "ethereum", wallet_index: 0, additional_signers: [{ signer_id: quorumId }] }],
});
const wallet = user.linked_accounts.find((a) => a.type === "wallet");
if (!wallet) throw new Error("Privy returned no wallet");
console.log(`privy user  ${user.id}`);
console.log(`wallet      ${wallet.address}  (id ${wallet.id})`);
console.log(`balance     ${await publicClient.readContract({
  address: ARC_TESTNET_USDC,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [wallet.address as `0x${string}`],
})} atomic USDC`);

if (!amount || !recipient) {
  console.log("\nFund that address at https://faucet.circle.com, then re-run with:");
  console.log("  npm run privy:setup -- 0.01 0xYourOtherAddress");
  process.exit(0);
}

// Confirm this call against the send-a-transaction doc before running.
const { hash } = await privy.wallets().ethereum().sendTransaction({
  walletId: wallet.id,
  caip2: ARC_TESTNET_NETWORK,
  transaction: {
    to: ARC_TESTNET_USDC,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [recipient as `0x${string}`, parseUnits(amount, 6)],
    }),
  },
});
console.log(`sent        https://testnet.arcscan.app/tx/${hash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
console.log(`status      ${receipt.status}`);
```

- [ ] **Step 5: Add the script to package.json**

Add to `scripts`, matching the existing `settler:setup` form:

```json
"privy:setup": "node --experimental-strip-types --env-file=.env.local scripts/privy-setup.ts",
```

- [ ] **Step 6: Run it and fund the wallet**

Run: `npm run privy:setup`
Expected: prints a Privy user id, a `0x` wallet address, and `0 atomic USDC`.

If `sendTransaction` or `users().create()` does not exist under those names, fix the call from the docs read in Step 3 — that is this task's real deliverable.

Fund the printed address at `https://faucet.circle.com` (Arc Testnet USDC).

- [ ] **Step 7: Run the transfer and verify on the explorer**

Run: `npm run privy:setup -- 0.01 <any address you can check>`
Expected: prints a `testnet.arcscan.app` link and `status success`. Open the link and confirm 0.01 USDC moved.

This is the gate for the whole plan. If Arc Testnet is not a chain Privy will sign for, stop and report — nothing downstream is worth building.

- [ ] **Step 8: Commit**

```bash
git add scripts/privy-setup.ts package.json package-lock.json
git commit -m "feat(privy): prove a Privy wallet can move USDC on Arc Testnet"
```

---

### Task 2: The seam — one dispatcher, two backends

Pure refactor. `WALLET_PROVIDER=circle` must behave identically to today when this
task ends; the Privy backend is a stub that throws until Task 3.

**Files:**
- Create: `lib/wallet-provider.ts`, `lib/wallet-provider.test.ts`
- Modify: `lib/circle-dcw.ts` (return types only)
- Modify: `lib/oauth-callback.ts`, `lib/wallet-resolve.ts`, `lib/user-agent.ts`
- Modify: 19 route files under `app/api/**`
- Modify: `package.json` (test script)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the module every caller imports from here on.

```ts
export type ProviderWallet = { address: string; walletId: string };
export type TxResult = { id: string; state: string; txHash: string | null };
export type WalletTx = {
  id: string;
  direction: "in" | "out";
  amount: string;
  address: string;
  state: string;
  txHash: string | null;
  date: string;
};
export type WalletBackend = {
  getOrCreateWallet: (namespace: string, key: string) => Promise<ProviderWallet | null>;
  transferUsdc: (walletId: string, to: string, amountUsdc: string) => Promise<TxResult>;
  executeContract: (
    walletId: string,
    to: `0x${string}`,
    callData: `0x${string}`,
    pollMs?: number,
  ) => Promise<TxResult>;
  listTransactions: (walletId: string, address: string) => Promise<WalletTx[]>;
};
export function walletProviderName(): "circle" | "privy";
export function looksLikeTxHash(value: string | null): boolean;
export async function getOrCreateWallet(namespace: string, key: string): Promise<ProviderWallet | null>;
export async function transferUsdc(walletId: string, to: string, amountUsdc: string): Promise<TxResult>;
export async function executeContract(
  walletId: string,
  to: `0x${string}`,
  callData: `0x${string}`,
  pollMs?: number,
): Promise<TxResult>;
export async function listTransactions(walletId: string, address: string): Promise<WalletTx[]>;
export class InsufficientFundsError extends Error {}
export const isBroadcast: (e: unknown) => boolean;
```

- [ ] **Step 1: Write the failing test**

Create `lib/wallet-provider.test.ts`:

```ts
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { looksLikeTxHash, walletProviderName } from "./wallet-provider.ts";

const original = process.env.WALLET_PROVIDER;
afterEach(() => {
  if (original === undefined) delete process.env.WALLET_PROVIDER;
  else process.env.WALLET_PROVIDER = original;
});

test("circle is the default, so an unset var can never silently pick Privy", () => {
  delete process.env.WALLET_PROVIDER;
  assert.equal(walletProviderName(), "circle");
});

test("only the exact string 'privy' selects Privy", () => {
  process.env.WALLET_PROVIDER = "privy";
  assert.equal(walletProviderName(), "privy");
  for (const wrong of ["Privy", "privy ", "prvy", "", "true"]) {
    process.env.WALLET_PROVIDER = wrong;
    assert.equal(walletProviderName(), "circle", `${JSON.stringify(wrong)} must not select Privy`);
  }
});

test("a tx hash is 0x + 64 hex; a Circle transaction id is not", () => {
  assert.equal(looksLikeTxHash(`0x${"a".repeat(64)}`), true);
  assert.equal(looksLikeTxHash(`0x${"A".repeat(64)}`), true);
  // A real Circle id, which is what paid_tx_hash holds on the circle stack.
  assert.equal(looksLikeTxHash("6f8a1d3e-1b2c-4d5e-8f90-1234567890ab"), false);
  assert.equal(looksLikeTxHash(`0x${"a".repeat(63)}`), false);
  assert.equal(looksLikeTxHash(`0x${"z".repeat(64)}`), false);
  assert.equal(looksLikeTxHash(null), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --experimental-strip-types lib/wallet-provider.test.ts`
Expected: FAIL — `Cannot find module './wallet-provider.ts'`.

- [ ] **Step 3: Write the dispatcher**

Create `lib/wallet-provider.ts`:

```ts
// Which wallet backend this deployment signs with. Two live implementations,
// selected per deployment rather than per user: testnet.splitsy.xyz runs Circle
// DCWs, splitsy.xyz runs Privy. See
// docs/superpowers/specs/2026-09-01-privy-wallet-stack-design.md
//
// Backends are LAZY-IMPORTED so a request only ever loads the SDK it needs, and
// so unit tests can import this module without either one. Same reason
// lib/wallet-resolve.ts defers its imports.
export type ProviderWallet = { address: string; walletId: string };

// txHash is null when the backend has accepted the transaction but cannot yet
// name it. Circle returns an internal id first and the hash only after polling;
// Privy returns the hash directly. Callers that persist one of these must use
// looksLikeTxHash to tell which they were handed.
export type TxResult = { id: string; state: string; txHash: string | null };

export type WalletTx = {
  id: string;
  direction: "in" | "out";
  amount: string;
  address: string; // counterparty
  state: string;
  txHash: string | null;
  date: string;
};

export type WalletBackend = {
  getOrCreateWallet: (namespace: string, key: string) => Promise<ProviderWallet | null>;
  transferUsdc: (walletId: string, to: string, amountUsdc: string) => Promise<TxResult>;
  executeContract: (
    walletId: string,
    to: `0x${string}`,
    callData: `0x${string}`,
    pollMs?: number,
  ) => Promise<TxResult>;
  listTransactions: (walletId: string, address: string) => Promise<WalletTx[]>;
};

// Exact match only, and circle is the default. Anything else — a typo, a
// capitalised value, an unset var in a new environment — must land on the stack
// whose money is worthless, never on the one holding real USDC.
export function walletProviderName(): "circle" | "privy" {
  return process.env.WALLET_PROVIDER === "privy" ? "privy" : "circle";
}
```

Append to the same file:

```ts
async function backend(): Promise<WalletBackend> {
  return walletProviderName() === "privy"
    ? (await import("./privy-wallet.ts")).backend
    : (await import("./circle-dcw.ts")).backend;
}

export async function getOrCreateWallet(namespace: string, key: string) {
  return (await backend()).getOrCreateWallet(namespace, key);
}
export async function transferUsdc(walletId: string, to: string, amountUsdc: string) {
  return (await backend()).transferUsdc(walletId, to, amountUsdc);
}
export async function executeContract(
  walletId: string,
  to: `0x${string}`,
  callData: `0x${string}`,
  pollMs?: number,
) {
  return (await backend()).executeContract(walletId, to, callData, pollMs);
}
export async function listTransactions(walletId: string, address: string) {
  return (await backend()).listTransactions(walletId, address);
}

// 0x + 64 hex. The discriminator exists because bill_debts.paid_tx_hash holds a
// Circle transaction UUID on the circle stack and a real hash on the privy one,
// and the history UI has to know which it is reading.
export function looksLikeTxHash(value: string | null): boolean {
  return value !== null && /^0x[0-9a-fA-F]{64}$/.test(value);
}

export class InsufficientFundsError extends Error {
  // Plain assignment, not a constructor parameter property: this module is
  // imported by unit tests, and --experimental-strip-types rejects those.
  constructor() {
    super("insufficient_funds");
    this.name = "InsufficientFundsError";
  }
}

// Whether a throw happened AFTER the backend accepted the transaction, so the
// caller must assume it may still mine. Absence means never-broadcast, which is
// the safe default — the only answer that never invents a settlement.
export const isBroadcast = (e: unknown): boolean => (e as { broadcast?: boolean })?.broadcast === true;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --experimental-strip-types lib/wallet-provider.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 5: Add the test script**

In `package.json` `scripts`, add:

```json
"test:wallet-provider": "node --test --experimental-strip-types lib/wallet-provider.test.ts lib/privy-wallet.test.ts",
```

`lib/privy-wallet.test.ts` arrives in Task 3; the script is written once here so Task 3 adds no `package.json` churn. Until then run only the first file.

- [ ] **Step 6: Create the Privy stub so the lazy import resolves**

Create `lib/privy-wallet.ts`:

```ts
// Privy implementation of WalletBackend. Filled in by Task 3.
import type { WalletBackend } from "./wallet-provider.ts";

const notYet = (): never => {
  throw new Error("The Privy backend is not implemented yet — set WALLET_PROVIDER=circle");
};

export const backend: WalletBackend = {
  getOrCreateWallet: async () => notYet(),
  transferUsdc: async () => notYet(),
  executeContract: async () => notYet(),
  listTransactions: async () => notYet(),
};
```

- [ ] **Step 7: Conform `lib/circle-dcw.ts` to the shared types**

Four edits, no logic change:

1. Replace the local `InsufficientFundsError` class (lines 165-170) and `isBroadcast` (line 163) with re-exports so existing behaviour and `instanceof` checks survive:

```ts
import { InsufficientFundsError, type ProviderWallet, type TxResult, type WalletBackend, type WalletTx } from "./wallet-provider.ts";
export { InsufficientFundsError, isBroadcast } from "./wallet-provider.ts";
```

2. Delete the local `ArcWallet` and `WalletTx` type declarations; use `ProviderWallet` and the imported `WalletTx`.
3. Change `transferUsdcOnArc`'s return to `TxResult` by adding `txHash: null` to the success return at line 69 — Circle's `createTransaction` does not carry a hash, and the caller now learns that from the type instead of from absence.
4. Append the backend object at the end of the file:

```ts
export const backend: WalletBackend = {
  getOrCreateWallet: getOrCreateArcWallet,
  transferUsdc: transferUsdcOnArc,
  executeContract: executeContractOnArc,
  // Circle's own indexer already answers this; the address argument is unused.
  listTransactions: (walletId) => listWalletTransactions(walletId),
};
```

Leave the four functions exported under their existing names — `scripts/circle-dcw-setup.ts` is the Circle stack's own provisioning script and keeps importing them directly.

- [ ] **Step 8: Re-point every caller at the seam**

Swap the import source and the function names in each file below. The mapping is
one-to-one: `getOrCreateArcWallet`→`getOrCreateWallet`, `transferUsdcOnArc`→
`transferUsdc`, `executeContractOnArc`→`executeContract`,
`listWalletTransactions`→`listTransactions`, and `InsufficientFundsError` /
`isBroadcast` now come from `@/lib/wallet-provider`.

Routes (18):

```
app/api/wallet/send/route.ts                       app/api/recurring/create/route.ts
app/api/wallet/transactions/route.ts               app/api/recurring/[tabAddress]/authorize/route.ts
app/api/debts/[id]/pay/route.ts                    app/api/recurring/[tabAddress]/claim/route.ts
app/api/onchain-bills/create/route.ts              app/api/pay/[token]/social/route.ts
app/api/onchain-bills/[billId]/pay/route.ts        app/api/pay/[token]/gateway/route.ts
app/api/onchain-bills/[billId]/claim/route.ts      app/api/agents/autopay/route.ts
app/api/onchain-bills/[billId]/refund/route.ts     app/api/agents/review/route.ts
app/api/treasury/settle/route.ts                   app/api/agents/grants/route.ts
app/api/agents/dunning/route.ts                    app/api/agents/mandate/route.ts
```

Lib modules (5): `lib/oauth-callback.ts:4,100`, `lib/wallet-resolve.ts:21,25`, `lib/user-agent.ts:16,135`, `lib/erc8004.ts`, `lib/gateway-pay.ts`.

Two notes that matter:
- `lib/wallet-resolve.ts:21` already lazy-imports (`await import("./circle-dcw.ts")`) so its unit tests can load the module with stub deps. Keep the lazy import, just change the path to `./wallet-provider.ts`.
- `lib/user-agent.ts:16` imports statically. That is fine — the dispatcher's own imports are the lazy ones.

Scripts: check `scripts/reputation-backfill.ts` and `scripts/service-agents-setup.ts`. Re-point them if they are provider-agnostic; leave them on `circle-dcw` if they configure Circle specifically. Leave `scripts/circle-dcw-setup.ts` alone.

- [ ] **Step 9: Verify nothing still reaches around the seam**

Run: `grep -rn "circle-dcw" app lib --include=*.ts --include=*.tsx`
Expected: only `lib/wallet-provider.ts`'s lazy import.

- [ ] **Step 10: Run the full check**

Run: `npm run build`
Expected: clean, full typecheck pass, every route registered.

Run: `npm run lint`
Expected: no new errors. One pre-existing `react-hooks/set-state-in-effect` in `app/HomeClient.tsx` is carried, not a regression.

Run every unit suite: `npm run test:agents && npm run test:wallet-provider && npm run test:settle && npm run test:pay-link`
Expected: all green.

- [ ] **Step 11: Smoke the Circle stack for real**

With `WALLET_PROVIDER` unset, run `npm run dev`, sign in, open the wallet panel, and pay one off-chain debt. Expected: identical to before — balance reads, PIN unlock works, the transfer completes, history lists it.

This is the task's actual acceptance test. The refactor is only correct if the Circle stack cannot tell it happened.

- [ ] **Step 12: Commit**

```bash
git add lib/wallet-provider.ts lib/wallet-provider.test.ts lib/privy-wallet.ts lib/circle-dcw.ts lib/oauth-callback.ts lib/wallet-resolve.ts lib/user-agent.ts lib/erc8004.ts lib/gateway-pay.ts app/api package.json
git commit -m "refactor(wallets): route every caller through a provider seam"
```

---

### Task 3: The Privy backend

**Files:**
- Create: `schema-privy-wallets.sql`
- Create: `lib/privy-wallets-repo.ts`
- Modify: `lib/privy-wallet.ts` (replace the Task 2 stub)
- Create: `lib/privy-wallet.test.ts`

**Interfaces:**
- Consumes: `WalletBackend`, `ProviderWallet`, `TxResult`, `WalletTx`, `InsufficientFundsError` from `lib/wallet-provider.ts` (Task 2). The exact `PrivyClient` call names confirmed in Task 1.
- Produces:
  ```ts
  // lib/privy-wallets-repo.ts
  export type PrivyWalletRow = { namespace: string; key: string; privy_user_id: string; wallet_id: string; address: string };
  export async function getPrivyWallet(namespace: string, key: string): Promise<PrivyWalletRow | null>;
  export async function insertPrivyWallet(row: PrivyWalletRow): Promise<void>;
  // lib/privy-wallet.ts
  export const backend: WalletBackend;
  export function receiptToState(status: "success" | "reverted"): "COMPLETE" | "FAILED";
  export function logsToWalletTxs(logs: TransferLog[], self: string): WalletTx[];
  export type TransferLog = { transactionHash: string; blockNumber: bigint; args: { from: string; to: string; value: bigint } };
  ```

**Known incompatibility to respect:** Privy embedded wallets are **EOAs**; Circle DCWs are SCAs. `encodeExecuteBatch` (used at `app/api/agents/grants/route.ts:352` to call the wallet's own address) has no EOA equivalent. That is the retired AutopayMandate path, and Task 5 keeps it off the Privy stack. Do not attempt to emulate batching here.

**Why our own table rather than Privy lookups:** every caller of `getOrCreateWallet` already guards on a database row — `lib/oauth-callback.ts:91` on `wallet_address`, `lib/wallet-resolve.ts:58` on `pending_wallets`, `lib/user-agent.ts:34` on the cached columns. Circle's `listWallets({refId})` is the safety net under that; a table of our own is the same net, is deterministic, and needs no undocumented Privy query. Same shape as the existing `pending_wallets`.

- [ ] **Step 1: Create the table**

Create `schema-privy-wallets.sql`:

```sql
-- Maps a Splitsy wallet key to the Privy user and wallet that serve it.
--
-- The Circle stack gets this idempotency free from listWallets({refId}); Privy
-- has no equivalent we depend on, so the mapping is ours. (namespace, key) is
-- the same composite the Circle refId encodes as "<namespace>:<key>" —
-- 'x'/'discord'/'email'/'wallet' for a signin wallet, 'prem' for a pre-mint,
-- 'agent' for a user's agent.
create table if not exists privy_wallets (
  namespace     text        not null,
  key           text        not null,
  privy_user_id text        not null,
  wallet_id     text        not null,
  address       text        not null,
  created_at    timestamptz not null default now(),
  primary key (namespace, key)
);

create index if not exists idx_privy_wallets_address on privy_wallets (lower(address));
```

Run it in the Supabase SQL editor for the Privy stack's project (Task 6 creates that project; until then use the existing one — the table is inert while `WALLET_PROVIDER=circle`).

- [ ] **Step 2: Write the failing test**

Create `lib/privy-wallet.test.ts`. Only the pure mappers are tested; the I/O is covered by Task 1's script and Task 7's smoke run.

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { logsToWalletTxs, receiptToState } from "./privy-wallet.ts";

const SELF = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const log = (from: string, to: string, value: bigint, block: bigint, hash: string) => ({
  transactionHash: hash,
  blockNumber: block,
  args: { from, to, value },
});

test("a reverted receipt is FAILED, so callers checking Circle's states still work", () => {
  assert.equal(receiptToState("success"), "COMPLETE");
  assert.equal(receiptToState("reverted"), "FAILED");
});

test("direction is read from our own address, not from the log order", () => {
  const txs = logsToWalletTxs(
    [log(SELF, OTHER, 2_500_000n, 10n, "0xaa"), log(OTHER, SELF, 1_000_000n, 11n, "0xbb")],
    SELF,
  );
  assert.equal(txs[0]?.direction, "in", "newest block first");
  assert.equal(txs[0]?.amount, "1");
  assert.equal(txs[0]?.address, OTHER);
  assert.equal(txs[1]?.direction, "out");
  assert.equal(txs[1]?.amount, "2.5");
});

test("a self-transfer counts once as outgoing rather than twice", () => {
  const txs = logsToWalletTxs([log(SELF, SELF, 1n, 1n, "0xcc")], SELF);
  assert.equal(txs.length, 1);
  assert.equal(txs[0]?.direction, "out");
});

test("case never decides direction — an address is an address", () => {
  const txs = logsToWalletTxs([log(OTHER.toUpperCase(), SELF.toUpperCase(), 1_000_000n, 1n, "0xdd")], SELF);
  assert.equal(txs[0]?.direction, "in");
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test --experimental-strip-types lib/privy-wallet.test.ts`
Expected: FAIL — `logsToWalletTxs` and `receiptToState` are not exported by the Task 2 stub.

- [ ] **Step 4: Write the repo module**

Create `lib/privy-wallets-repo.ts`, mirroring `lib/pending-wallets-repo.ts:1-27` exactly (same import path, same `requireClient` guard, same `.ts` extensions):

```ts
import { createSupabaseServerClient } from "./supabase.ts";

export type PrivyWalletRow = {
  namespace: string;
  key: string;
  privy_user_id: string;
  wallet_id: string;
  address: string;
};

let cached: ReturnType<typeof createSupabaseServerClient> | null = null;
function requireClient() {
  cached ??= createSupabaseServerClient();
  if (!cached) throw new Error("Supabase is not configured");
  return cached;
}

export async function getPrivyWallet(namespace: string, key: string): Promise<PrivyWalletRow | null> {
  const { data, error } = await requireClient()
    .from("privy_wallets")
    .select("namespace, key, privy_user_id, wallet_id, address")
    .eq("namespace", namespace)
    .eq("key", key)
    .maybeSingle();
  if (error) throw new Error(`Failed to read privy_wallets: ${error.message}`);
  return data ?? null;
}

// Upsert, not insert: two concurrent taggings of the same handle both reach here
// and the second must return the FIRST wallet rather than raise. The primary key
// makes that a no-op collision instead of a duplicate wallet in use.
export async function insertPrivyWallet(row: PrivyWalletRow): Promise<void> {
  const { error } = await requireClient()
    .from("privy_wallets")
    .upsert(row, { onConflict: "namespace,key", ignoreDuplicates: true });
  if (error) throw new Error(`Failed to save privy_wallets: ${error.message}`);
}
```

Check `lib/supabase.ts` for the real export name and copy the `requireClient` body from `lib/pending-wallets-repo.ts:17-21` verbatim rather than the sketch above if it differs.

- [ ] **Step 5a: Write the backend — imports, config and the pure mappers**

Replace the whole of `lib/privy-wallet.ts`:

```ts
// Privy implementation of WalletBackend — the splitsy.xyz stack's wallets.
//
// Wallets are app-created with our key quorum attached as an additional signer
// AT CREATION, so the server transacts without the user present, exactly as the
// Circle stack does. Two differences are the point of the change: the user can
// export the wallet, and a Privy policy can refuse a transaction our own code
// would have allowed. See the design doc for what this is and is not.
import { PrivyClient } from "@privy-io/server-auth";
import { createPublicClient, encodeFunctionData, erc20Abi, formatUnits, http, parseUnits } from "viem";
import { arcTestnet } from "viem/chains";
import { getPrivyWallet, insertPrivyWallet } from "./privy-wallets-repo.ts";
import { ARC_TESTNET_NETWORK, ARC_TESTNET_RPC, ARC_TESTNET_USDC } from "./x402/constants.ts";
import {
  InsufficientFundsError,
  type ProviderWallet,
  type TxResult,
  type WalletBackend,
  type WalletTx,
} from "./wallet-provider.ts";

let cached: PrivyClient | null = null;
function privy(): PrivyClient {
  const appId = process.env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) throw new Error("Privy is not configured (PRIVY_APP_ID / PRIVY_APP_SECRET)");
  cached ??= new PrivyClient(appId, appSecret);
  return cached;
}

// The signer attached to every wallet at creation. Without it the server cannot
// transact at all, so an unset value is a hard error rather than a degraded mode.
function quorumId(): string {
  const id = process.env.PRIVY_KEY_QUORUM_ID;
  if (!id) throw new Error("PRIVY_KEY_QUORUM_ID is not set — the server cannot sign");
  return id;
}

const publicClient = createPublicClient({ chain: arcTestnet, transport: http(ARC_TESTNET_RPC) });

export function receiptToState(status: "success" | "reverted"): "COMPLETE" | "FAILED" {
  return status === "success" ? "COMPLETE" : "FAILED";
}
```

- [ ] **Step 5b: Append the log mapper**

```ts
export type TransferLog = {
  transactionHash: string;
  blockNumber: bigint;
  args: { from: string; to: string; value: bigint };
};

// USDC Transfer logs → the history rows the wallet panel renders.
//
// ONE ROW PER LOG, never one per direction: a self-transfer matches both the
// `from` and the `to` filter, and splitting by direction would print it twice as
// a send and a receive of money that never left. `from === self` decides, so a
// self-transfer reads as outgoing, which is what the wallet actually did.
//
// ponytail: no block timestamps — that is one eth_getBlockByNumber per row, and
// the panel already renders a row without a date (app/XAuthControl.tsx:738).
// Fetch them if the history ever needs to be sorted by time rather than height.
export function logsToWalletTxs(logs: TransferLog[], self: string): WalletTx[] {
  const me = self.toLowerCase();
  return [...logs]
    .sort((a, b) => (b.blockNumber === a.blockNumber ? 0 : b.blockNumber > a.blockNumber ? 1 : -1))
    .map((log) => {
      const outgoing = log.args.from.toLowerCase() === me;
      return {
        id: log.transactionHash,
        direction: outgoing ? ("out" as const) : ("in" as const),
        amount: formatUnits(log.args.value, 6),
        address: outgoing ? log.args.to : log.args.from,
        state: "COMPLETE",
        txHash: log.transactionHash,
        date: "",
      };
    });
}
```

- [ ] **Step 6: Run the mapper tests**

Run: `node --test --experimental-strip-types lib/privy-wallet.test.ts`
Expected: PASS, 4/4. Do not run `npm run build` yet — the `backend` export the dispatcher imports is added in Step 7, so a typecheck now fails on purpose.

- [ ] **Step 7a: Append the shared send path**

```ts
// One contract write, waited to a receipt.
//
// A THROW AFTER THE SEND IS INDETERMINATE, NOT "DIDN'T HAPPEN". Once Privy
// returns a hash the transaction is broadcast and may mine no matter what the
// wait saw, so every throw past that point carries `broadcast: true` and callers
// read it through isBroadcast() to count the money as spent. Only a throw from
// the send itself means nothing left.
//
// Deliberately unlike executeContractOnArc, which RETURNS state "PENDING" on a
// poll timeout: there is no equivalent quiet outcome here, because a hash in hand
// already proves broadcast. lib/user-agent.ts's ensureAgentAllowance converts
// that PENDING into a throw anyway, so throwing here matches what callers want.
async function send(
  walletId: string,
  to: `0x${string}`,
  data: `0x${string}`,
  pollMs = 60_000,
): Promise<TxResult> {
  let hash: `0x${string}`;
  try {
    const sent = await privy().wallets().ethereum().sendTransaction({
      walletId,
      caip2: ARC_TESTNET_NETWORK,
      transaction: { to, data },
    });
    hash = sent.hash as `0x${string}`;
  } catch (e) {
    const raw = e instanceof Error ? e.message : JSON.stringify(e);
    // Arc charges gas in USDC, so "not enough USDC" covers both the amount and
    // the gas. Same detection the Circle backend does at lib/circle-dcw.ts:63.
    if (/insufficient|not enough|balance|exceeds/i.test(raw)) throw new InsufficientFundsError();
    throw new Error(`Privy send failed: ${raw}`);
  }

  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: pollMs });
    return { id: hash, state: receiptToState(receipt.status), txHash: hash };
  } catch (err) {
    throw Object.assign(new Error(`Privy tx indeterminate — broadcast but unconfirmed: ${hash}`, { cause: err }), {
      broadcast: true as const,
      txHash: hash,
    });
  }
}
```

- [ ] **Step 7b: Append the backend object**

```ts
// Bounded lookback so one wallet's history is one getLogs call rather than a
// scan from genesis, which public RPCs reject outright.
// ponytail: 200k blocks is "recent enough" for a demo history — page backwards
// from the oldest row shown if anyone ever needs the full ledger.
const LOOKBACK_BLOCKS = 200_000n;

export const backend: WalletBackend = {
  // Our own table is the idempotency, not a Privy query. Every caller already
  // guards on a row of its own (lib/oauth-callback.ts:91, lib/wallet-resolve.ts:58,
  // lib/user-agent.ts:34); this is the net under that, and it needs no lookup
  // endpoint we would have to trust.
  async getOrCreateWallet(namespace: string, key: string): Promise<ProviderWallet | null> {
    const existing = await getPrivyWallet(namespace, key);
    if (existing) return { address: existing.address, walletId: existing.wallet_id };

    const user = await privy().users().create({
      linked_accounts: [{ type: "custom_jwt", custom_user_id: `${namespace}:${key}` }],
      wallets: [{ chain_type: "ethereum", wallet_index: 0, additional_signers: [{ signer_id: quorumId() }] }],
    });
    const wallet = user.linked_accounts.find((a) => a.type === "wallet");
    if (!wallet) throw new Error("Privy createUser returned no wallet");

    await insertPrivyWallet({
      namespace,
      key,
      privy_user_id: user.id,
      wallet_id: wallet.id,
      address: wallet.address,
    });
    return { address: wallet.address, walletId: wallet.id };
  },

  transferUsdc(walletId, to, amountUsdc) {
    return send(
      walletId,
      ARC_TESTNET_USDC,
      encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        // Supabase returns numeric as a JS number, so stringify before parsing.
        args: [to as `0x${string}`, parseUnits(String(amountUsdc), 6)],
      }),
    );
  },

  executeContract: send,
```

- [ ] **Step 7c: Append `listTransactions` and close the object**

```ts
  // Read from the chain, not from a vendor indexer. Circle's listTransactions
  // has no Privy counterpart, and USDC Transfer logs are the same truth without
  // a second system to be stale — so this is the one method that gets simpler.
  async listTransactions(_walletId: string, address: string): Promise<WalletTx[]> {
    const self = address as `0x${string}`;
    const head = await publicClient.getBlockNumber();
    const fromBlock = head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n;
    const transfer = erc20Abi.find((e) => e.type === "event" && e.name === "Transfer");
    if (!transfer) throw new Error("viem's erc20Abi has no Transfer event");

    // Two calls because an OR across indexed topics is not expressible in one.
    const [out, incoming] = await Promise.all([
      publicClient.getLogs({ address: ARC_TESTNET_USDC, event: transfer, args: { from: self }, fromBlock, toBlock: head }),
      publicClient.getLogs({ address: ARC_TESTNET_USDC, event: transfer, args: { to: self }, fromBlock, toBlock: head }),
    ]);

    // Deduped by hash before mapping, so a self-transfer present in both results
    // is one row. logsToWalletTxs assumes it is handed each log once.
    const byHash = new Map<string, TransferLog>();
    for (const log of [...out, ...incoming]) {
      byHash.set(log.transactionHash, log as unknown as TransferLog);
    }
    return logsToWalletTxs([...byHash.values()], self);
  },
};
```

- [ ] **Step 8: Typecheck and run everything**

Run: `npm run build`
Expected: clean. If `sendTransaction`, `users().create()` or the `linked_accounts` shape does not typecheck, correct them against the calls Task 1 proved — that script is the authority, not this plan.

Run: `npm run test:wallet-provider`
Expected: PASS, 7/7 across both files.

- [ ] **Step 9: Smoke the Privy stack end to end**

Set `WALLET_PROVIDER=privy` in `.env.local`, run `npm run dev`, then:

1. Sign in with X. Expected: a new wallet address appears in the panel, and a `privy_wallets` row exists with `namespace='x'`.
2. Fund that address from `https://faucet.circle.com`, refresh the balance. Expected: the funded amount.
3. Send 0.01 USDC to any address from the Send tab. Expected: success, and the history tab lists it with a working `testnet.arcscan.app` link.

Then unset `WALLET_PROVIDER` and confirm the Circle stack still signs in and pays. Both stacks must work from this one working tree.

- [ ] **Step 10: Commit**

```bash
git add schema-privy-wallets.sql lib/privy-wallets-repo.ts lib/privy-wallet.ts lib/privy-wallet.test.ts
git commit -m "feat(privy): implement the Privy wallet backend on Arc"
```

---

### Task 4: Make the history read right on both stacks

`bill_debts.paid_tx_hash` holds a Circle transaction UUID on the Circle stack and
a real chain hash on the Privy stack. Three client paths currently assume the
former, so on Privy they show no explorer link for money that did move.

**Files:**
- Modify: `lib/arc-explorer.ts`
- Modify: `lib/wallet-provider.ts` (re-export instead of define)
- Create: `lib/arc-explorer.test.ts`
- Modify: `app/XHistoryPanel.tsx:86`
- Modify: `app/api/wallet/transactions/route.ts`
- Modify: `app/XAuthControl.tsx:321`
- Modify: `package.json`

**Interfaces:**
- Consumes: `listTransactions(walletId, address)` from Task 2; `looksLikeTxHash` moves here but keeps its `lib/wallet-provider.ts` export path, so Task 2's test is unaffected.
- Produces:
  ```ts
  // lib/arc-explorer.ts
  export function looksLikeTxHash(value: string | null): boolean;
  ```

- [ ] **Step 1: Write the failing test**

Create `lib/arc-explorer.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { looksLikeTxHash, waitForCircleTxUrl } from "./arc-explorer.ts";

test("a hash needs no polling — the link is already knowable", async () => {
  const hash = `0x${"a".repeat(64)}`;
  let fetched = false;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetched = true;
    throw new Error("must not be called");
  }) as typeof fetch;
  try {
    assert.equal(await waitForCircleTxUrl(hash), `https://testnet.arcscan.app/tx/${hash}`);
    assert.equal(fetched, false, "a hash must short-circuit before any network call");
  } finally {
    globalThis.fetch = original;
  }
});

test("only 0x + 64 hex is a hash; a Circle transaction id is not", () => {
  assert.equal(looksLikeTxHash(`0x${"a".repeat(64)}`), true);
  assert.equal(looksLikeTxHash("6f8a1d3e-1b2c-4d5e-8f90-1234567890ab"), false);
  assert.equal(looksLikeTxHash(null), false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test --experimental-strip-types lib/arc-explorer.test.ts`
Expected: FAIL — `looksLikeTxHash` is not exported from `./arc-explorer.ts`, and the first test times out on the un-short-circuited poll.

- [ ] **Step 3: Move the discriminator and short-circuit the poll**

In `lib/arc-explorer.ts`, add below `explorerTxUrl` (line 8):

```ts
/**
 * 0x + 64 hex.
 *
 * `paid_tx_hash` and the `txId` a send returns are a Circle transaction UUID on
 * the circle stack and a real chain hash on the privy one. Everything that turns
 * one into a link has to know which it was handed. Lives here rather than in
 * lib/wallet-provider.ts because browser components need it and this module has
 * no dependencies; wallet-provider re-exports it for server callers.
 */
export function looksLikeTxHash(value: string | null): boolean {
  return value !== null && /^0x[0-9a-fA-F]{64}$/.test(value);
}
```

Then add the short-circuit as the first statement of `waitForCircleTxUrl` (before the loop at line 21):

```ts
  // The privy backend answers with the hash itself, so there is nothing to wait
  // for. Polling anyway costs six getLogs round trips to learn what the argument
  // already said.
  if (looksLikeTxHash(txId)) return explorerTxUrl(txId);
```

- [ ] **Step 4: Re-export from the seam**

In `lib/wallet-provider.ts`, delete the local `looksLikeTxHash` definition and replace it with:

```ts
// Defined in arc-explorer.ts so browser components can import it too; re-exported
// here because this is the module server code imports.
export { looksLikeTxHash } from "./arc-explorer.ts";
```

- [ ] **Step 5: Run both test files to verify they pass**

Run: `node --test --experimental-strip-types lib/arc-explorer.test.ts lib/wallet-provider.test.ts`
Expected: PASS, 5/5. The Task 2 test still imports `looksLikeTxHash` from `wallet-provider.ts` and must still pass — that is what the re-export is for.

- [ ] **Step 6: Add the test file to the script**

In `package.json`, extend the Task 2 script:

```json
"test:wallet-provider": "node --test --experimental-strip-types lib/wallet-provider.test.ts lib/privy-wallet.test.ts lib/arc-explorer.test.ts",
```

- [ ] **Step 7: Fix the three client paths**

`app/XHistoryPanel.tsx:86` — a stored value that is already a hash needs no lookup:

```tsx
              const hash = looksLikeTxHash(d.paid_tx_hash)
                ? (d.paid_tx_hash as string)
                : d.paid_tx_hash
                  ? hashById[d.paid_tx_hash]
                  : undefined;
```

Add `import { looksLikeTxHash } from "@/lib/arc-explorer";` to that file.

`app/api/wallet/transactions/route.ts` — the Privy backend reads logs by address, so pass it. Circle ignores the second argument:

```ts
  const transactions = await listTransactions(user.circle_wallet_id, user.wallet_address ?? "");
```

Keep whatever guard the route already has for a missing `circle_wallet_id`; if `wallet_address` is null the Privy path cannot read logs, so return an empty list rather than calling with `""`.

`app/XAuthControl.tsx:321` — the copy names a vendor the Privy stack does not use. Make it stack-neutral rather than plumbing a provider flag to the client:

```tsx
                          A Splitsy wallet on <b>Arc Testnet</b>, tied to <OwnHandle me={me} />. Pay and get paid in
                          USDC — no crypto setup needed.
```

- [ ] **Step 8: Verify on both stacks**

Run: `npm run build` — expected clean.

With `WALLET_PROVIDER=privy`: send 0.01 USDC from the Send tab. Expected: the explorer link appears immediately, not after ~15s of polling. Pay one off-chain debt, then open the history tab. Expected: the paid row carries a working "View transaction" link.

With `WALLET_PROVIDER` unset: repeat both. Expected: unchanged from today — the link still appears after the poll, because a Circle id is not a hash.

- [ ] **Step 9: Commit**

```bash
git add lib/arc-explorer.ts lib/arc-explorer.test.ts lib/wallet-provider.ts app/XHistoryPanel.tsx app/XAuthControl.tsx app/api/wallet/transactions/route.ts package.json
git commit -m "fix(history): link transactions on both wallet stacks"
```

---

### Task 5: The agent wallet, and keeping the mandate path off the Privy stack

Task 2 already re-pointed `lib/user-agent.ts` at the seam, and the Privy backend
keys the agent wallet by `("agent", user.id)` — its own Privy user, so it gets a
distinct address and keeps the separate ERC-8004 identity that
`lib/user-agent.ts:146-158` insists on. What is left is the EOA/SCA gap and the
policy that makes the cap real.

**The gap:** Privy embedded wallets are EOAs. `encodeExecuteBatch`
(`app/api/agents/grants/route.ts:352`) sends `executeBatch` calldata *to the
wallet's own address* — an SCA-only trick. On the Privy stack that transaction
reverts. It is only reachable in `mandate` money mode, which the design doc
records as retired, so the fix is to make `funded` the Privy stack's default
rather than to emulate batching.

**Files:**
- Modify: `lib/autopay.ts` (add `defaultMoneyMode`)
- Modify: `lib/autopay.test.ts` (two tests)
- Modify: `app/api/agents/grants/route.ts:138,185,232`
- Modify: `lib/privy-wallet.ts` (attach the agent policy)
- Modify: `.env.local`

**Interfaces:**
- Consumes: `MoneyMode` from `lib/autopay.ts:26`, `walletProviderName()` from `lib/wallet-provider.ts` (Task 2).
- Produces:
  ```ts
  // lib/autopay.ts
  export function defaultMoneyMode(provider: "circle" | "privy"): MoneyMode;
  ```

- [ ] **Step 1: Create the agent policy and answer the spec's open question 1**

In the Privy dashboard, create a wallet policy that caps a single transaction's
USDC transfer to the contracts the agent calls. Record in `.env.local`:

```
# Privy policy attached to every agent wallet at creation. The enclave refuses a
# transaction over this cap, so lib/autopay.ts's decideAutopay is no longer the
# only thing between the agent and the money.
PRIVY_AGENT_POLICY_ID=
```

While there, check whether a policy can express a **rolling daily total** or only
per-transaction and per-destination limits. Record the answer as a comment above
`sumAutopaySpentTodayUsdc`'s call site in `app/api/agents/autopay/route.ts`. If it
cannot, that function stays authoritative for the daily cap and only the per-bill
cap moves into the enclave — which is still the larger of the two risks.

- [ ] **Step 2: Write the failing tests**

Append to `lib/autopay.test.ts`:

```ts
test("the privy stack defaults to funded, because its EOAs cannot batch", () => {
  assert.equal(defaultMoneyMode("privy"), "funded");
});

test("the circle stack still defaults to mandate, the mode the chain enforces", () => {
  assert.equal(defaultMoneyMode("circle"), "mandate");
});
```

Add `defaultMoneyMode` to that file's existing import from `./autopay.ts`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test:agents`
Expected: FAIL — `defaultMoneyMode is not a function`.

- [ ] **Step 4: Implement it**

Append to `lib/autopay.ts`, next to `buildGrant`:

```ts
// Which money mode a deployment falls back to when the user has no row yet.
//
// NOT a preference. The circle stack's DCWs are SCAs, so `mandate` works there
// and is the safer default: the contract reverts on its own numbers regardless
// of what this server believes. Privy embedded wallets are EOAs, and
// encodeExecuteBatch sends executeBatch calldata to the wallet's own address —
// which an EOA cannot execute. Defaulting a Privy deployment to `mandate` would
// arm nothing and silently disable autopay, so it defaults to `funded` and the
// enclave policy is what caps the spend instead of the contract.
export function defaultMoneyMode(provider: "circle" | "privy"): MoneyMode {
  return provider === "privy" ? "funded" : "mandate";
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:agents`
Expected: PASS, all suites green including the two new tests.

- [ ] **Step 6: Use it in the three places that hardcode the fallback**

In `app/api/agents/grants/route.ts`, import `defaultMoneyMode` from `@/lib/autopay` and `walletProviderName` from `@/lib/wallet-provider`, then:

Line 138: `const funded = (rules?.moneyMode ?? defaultMoneyMode(walletProviderName())) === "funded";`

Line 185: `moneyMode: rules?.moneyMode ?? defaultMoneyMode(walletProviderName()),`

Line 232 — the write path. The comment above it says a typo must never move someone into the mode where only this server says no. That reasoning is unchanged for Circle; for Privy the batching mode is not available at all, so:

```ts
  // Anything that is not exactly 'funded' reads as the stack's default — mandate
  // on circle, where the chain enforces the caps, and funded on privy, whose EOA
  // wallets cannot execute the approve+setMandate batch at all.
  const moneyMode = raw.moneyMode === "funded" ? "funded" : defaultMoneyMode(walletProviderName());
```

- [ ] **Step 7: Confirm nothing else reaches for SCA batching**

Run: `grep -rn "encodeExecuteBatch" app lib scripts --include=*.ts`
Expected: only `lib/registry-calldata.ts` (the definition) and `app/api/agents/grants/route.ts:352`. If any other call site appears, it needs the same treatment — report it rather than guessing.

- [ ] **Step 8: Attach the policy to agent wallets only**

In `lib/privy-wallet.ts`, replace the `wallets:` argument inside `getOrCreateWallet` with:

```ts
      wallets: [
        {
          chain_type: "ethereum",
          wallet_index: 0,
          additional_signers: [
            {
              signer_id: quorumId(),
              // The agent is the one wallet a server spends from with no user in
              // the loop, so it is the one that gets an enclave-enforced ceiling.
              // Pay wallets are only ever spent on a request the user made.
              ...(namespace === "agent" && process.env.PRIVY_AGENT_POLICY_ID
                ? { override_policy_ids: [process.env.PRIVY_AGENT_POLICY_ID] }
                : {}),
            },
          ],
        },
      ],
```

Note this only applies at creation. Agent wallets minted before the policy
existed keep no policy — on a fresh deployment there are none, which is why this
task does not carry a backfill.

- [ ] **Step 9: Verify the agent path on the Privy stack**

With `WALLET_PROVIDER=privy`, run `npm run dev`, sign in, open the Agents panel and save autopay settings.

Expected:
1. `GET /api/agents/grants` returns `moneyMode: "funded"` for a user with no row.
2. Saving returns `{ ok: true, txHash: null }` — `syncMandateOnchain` short-circuits at line 312 because `isMandateConfigured()` is false when the mandate address env var is unset. Confirm it *is* unset for this stack.
3. A `privy_wallets` row exists with `namespace='agent'`, and its address differs from the pay wallet's.
4. Fund the agent address, then let one autopay settlement run. Expected: it settles, and the decision log row is written.
5. Set a bill amount above the policy cap and run again. Expected: Privy refuses the transaction, the route reports the failure, and `settlementRowFor` writes a `skip` row — nothing was broadcast, so no money may be counted as spent.

Step 5 is the point of the whole task. If the policy does not refuse, the cap is still only `decideAutopay` and that must be reported.

- [ ] **Step 10: Commit**

```bash
git add lib/autopay.ts lib/autopay.test.ts app/api/agents/grants/route.ts lib/privy-wallet.ts
git commit -m "feat(agents): fund-mode default and an enclave-enforced cap on Privy"
```

---

### Task 6: Stand the Privy stack up beside the live one

Nothing here touches `splitsy.xyz`. The live deployment keeps every env var it
has, keeps its domain, and keeps serving the Circle stack — it is not
reconfigured, renamed or redeployed by this task.

The Privy stack goes up on **Vercel's Preview environment** for the
`privy-wallet-stack` branch, at a stable hostname of its own. Vercel scopes env
vars per environment (Production / Preview / Development), which is exactly the
axis needed here: Production has no `WALLET_PROVIDER`, so it stays on Circle by
the default in `walletProviderName()`; Preview sets it to `privy` and points at a
different database.

Renaming the live deployment to `testnet.splitsy.xyz` and handing `splitsy.xyz`
to the Privy stack is **Task 8**, deferred until it is chosen deliberately.

**Files:**
- Modify: `app/layout.tsx` (stack banner)
- Modify: `.env.local` (document the two new public vars)
- Create: `docs/deployments.md`

**Interfaces:**
- Consumes: `WALLET_PROVIDER` from Task 2.
- Produces: `NEXT_PUBLIC_STACK_LABEL` — when set, a banner names the stack. Unset in Production.

- [ ] **Step 1: Restore the Privy stack's database**

There is already a second Supabase project in the same org: **`splitsy-test`**
(ref `hdyioojrozodmutpldsu`), currently INACTIVE. Restore that one rather than
creating a new project, then run every schema file in this order (the later ones
alter tables the earlier ones create):

```
schema-users.sql
schema-users-pin.sql
schema-generic-identity.sql
schema-bills.sql
schema-pending-wallets.sql
schema-otp.sql
schema-circle-webhooks.sql
schema-x402-payments.sql
schema-agents.sql
schema-agent-economy.sql
schema-reputation.sql
schema-onchain-bill-preimages.sql
schema-privy-wallets.sql
```

Read each file before running it — if any contains a data migration rather than pure DDL, note it and skip that part on an empty database.

Never point the Preview environment at the live project's database.
`users.circle_wallet_id` holds an opaque provider id and one row cannot name a
wallet in both systems — and sharing it would put this stack's writes in front of
live users, which is the one outcome this whole task is arranged to prevent.

- [ ] **Step 2: Add the stack banner**

In `app/layout.tsx`, inside the body wrapper above the page content:

```tsx
        {process.env.NEXT_PUBLIC_STACK_LABEL ? (
          <div className="settle-label" role="status" data-tone="warn" style={{ textAlign: "center", padding: "0.4rem" }}>
            {process.env.NEXT_PUBLIC_STACK_LABEL}
          </div>
        ) : null}
```

Document it in `.env.local`:

```
# Banner text shown at the top of every page. Set in Vercel's PREVIEW
# environment ("Privy stack — Arc Testnet") and left UNSET in Production, so
# forgetting it can only ever under-warn a preview visitor, never mislabel the
# live site.
NEXT_PUBLIC_STACK_LABEL=
```

Read `node_modules/next/dist/docs/` on how `NEXT_PUBLIC_*` inlining works in this Next version before assuming a server component can read it at request time — if it is build-time only, each deployment gets its own build anyway, which is fine.

- [ ] **Step 3: Give the branch a stable preview hostname**

Vercel's per-deployment preview URLs carry a fresh hash on every push, which no
OAuth provider can be told about in advance. Assign a domain to the branch
instead — in the existing project, Domains → add `privy.splitsy.xyz` and assign it
to the `privy-wallet-stack` branch.

Adding a domain to a branch does not affect Production. `splitsy.xyz` keeps its
own assignment; confirm it is still listed as Production before moving on.

- [ ] **Step 4: Register the preview hostname with every provider**

Each provider validates the exact callback origin, so sign-in fails on the preview
host until it is registered. **Add**, never replace — the `splitsy.xyz` entries are
what keep the live site working:

- X developer portal (app settings → callback URI / redirect URL): add
  `https://privy.splitsy.xyz/api/auth/twitter/callback`
- Discord developer portal (OAuth2 → redirects): add
  `https://privy.splitsy.xyz/api/auth/discord/callback`
- Google Cloud console (credentials → authorised redirect URIs): add
  `https://privy.splitsy.xyz/api/auth/google/callback`
- Cloudflare Turnstile: the widget is domain-bound (`@marsidev/react-turnstile` is
  a dependency), so add `privy.splitsy.xyz` to its allowed hostnames or the
  challenge fails on the preview host only.

If any console has a redirect-URI limit you would have to free up by deleting an
entry, stop and report it — deleting a live entry is how this task would break
production.

- [ ] **Step 5: Configure the Preview environment**

In the existing Vercel project, set these on **Preview only** (Vercel's env-var
scope selector; do not tick Production):

```
WALLET_PROVIDER=privy
NEXT_PUBLIC_STACK_LABEL=Privy stack — Arc Testnet
```

- [ ] **Step 6: Point Preview at the Privy stack's own resources**

Still on **Preview only**, override these so the preview never reads or writes the
live project's data or Circle's wallets:

```
SUPABASE_URL / SUPABASE_*           # the splitsy-test project from Step 1
PRIVY_APP_ID / PRIVY_APP_SECRET / PRIVY_KEY_QUORUM_ID / PRIVY_AGENT_POLICY_ID
GOOGLE_OAUTH_REDIRECT_ORIGIN=https://privy.splitsy.xyz
SESSION_SECRET=                     # a NEW 32+ byte secret, not Production's
```

Leave **unset in Preview** (empty, not inherited): `CIRCLE_API_KEY`,
`CIRCLE_ENTITY_SECRET`, `CIRCLE_WALLET_SET_ID`, `CIRCLE_WEBHOOKS_ENABLED`, and the
autopay mandate address var.

The mandate one is load-bearing: `isMandateConfigured()` must be false so
`syncMandateOnchain` cannot reach `encodeExecuteBatch` on a Privy EOA. Check how
Vercel handles a Production var when Preview does not define it — if Preview
inherits rather than blanks it, set each of these to an empty string explicitly.

A distinct `SESSION_SECRET` is defence in depth rather than a live hole: the
session cookie is set without a `domain` attribute (`lib/oauth-callback.ts:116-122`),
so it is host-scoped and does not cross between hostnames on its own. The separate
secret means a leaked preview secret still cannot mint a live session even if that
ever changes.

- [ ] **Step 7: Write down which deployment is which**

Create `docs/deployments.md`:

```markdown
# Deployments

One repo, two wallet stacks. `WALLET_PROVIDER` is the only switch, and `circle` is
the default in `walletProviderName()` — so an environment that forgets the variable
falls back to the stack whose money is worthless, never the other way round.

| | splitsy.xyz (Production) | privy.splitsy.xyz (Preview) |
|---|---|---|
| Branch | `main` | `privy-wallet-stack` |
| `WALLET_PROVIDER` | unset → `circle` | `privy` |
| Wallets | Circle DCW, SCA | Privy embedded, EOA |
| Network | Arc Testnet (5042002) | Arc Testnet (5042002) |
| Database | `mhm233's Project` | `splitsy-test` |
| Autopay money mode | `mandate` | `funded` |
| Mandate address env | set | **must stay unset** |
| Circle env vars | set | absent |
| Banner | none | "Privy stack — Arc Testnet" |

Both stacks share the same deployed Arc Testnet contracts (BillSplitRegistry,
RecurringTabFactory, the ERC-8004 registrar). That is deliberate — no redeploy is
needed while both are on testnet — but it means preview activity lands on the same
contracts the live site reads. Live users never see it, because each stack reads by
its own wallet addresses out of its own database.

Arc mainnet is not live for either yet: see
`docs/superpowers/specs/2026-09-01-privy-wallet-stack-design.md` "Deliberately
deferred". Handing `splitsy.xyz` to the Privy stack is Task 8 of
`docs/superpowers/plans/2026-09-01-privy-wallet-stack.md` and has not happened.

Never point the two at one database: `users.circle_wallet_id` holds an opaque
provider id and one row cannot name a wallet in both systems.
```

- [ ] **Step 8: Verify the preview stack, then verify the live one is untouched**

Push the branch and wait for the preview deploy. Visit
`https://privy.splitsy.xyz`. Expected: the banner shows, all four sign-ins
complete, a Privy wallet address appears, and a `privy_wallets` row lands in
`splitsy-test`. Fund it and pay one debt end to end.

Then visit `https://splitsy.xyz`. Expected: **no banner**, and everything exactly as
before — this deployment still serves `main`, which has none of this code. If a
banner appears on `splitsy.xyz`, `NEXT_PUBLIC_STACK_LABEL` was scoped to
Production by mistake; fix it before doing anything else.

Last check, in the Vercel dashboard: confirm the Production deployment's commit is
still the one that was live before this task began.

- [ ] **Step 9: Commit**

```bash
git add app/layout.tsx docs/deployments.md
git commit -m "chore(deploy): stand the Privy stack up on a preview host"
```

---

### Task 7: Verify every seam caller on both stacks

Tasks 1–6 verified the paths they touched. This task walks the ones they did not,
because every route re-pointed in Task 2 is now running against a backend it was
never written for. Each row below exercises a different seam function.

**Files:** none planned. Fix whatever fails, in the file that fails, with a test
where the fix is not a one-liner.

**Interfaces:** consumes everything from Tasks 2–6.

- [ ] **Step 1: Run the whole automated suite on both stacks**

```bash
npm run build && npm run lint
npm run test:wallet-provider && npm run test:agents && npm run test:settle
npm run test:pay-link && npm run test:dashboard-create && npm run test:footer
npm run test:scout && npm run test:netting && npm run test:snapsplit
npm run test:iou && npm run test:treasury && npm run test:gateway
npm run test:wallet-chain && npm run test:landing && npm run test:dashboard
npm run test:docs-search
```

Expected: build clean, lint no new errors (the pre-existing
`react-hooks/set-state-in-effect` in `app/HomeClient.tsx` is carried), every suite
green. Unit tests are provider-agnostic, so this runs once.

- [ ] **Step 2: Walk the matrix on the Privy stack**

`WALLET_PROVIDER=privy`. Tick each only after seeing the on-chain result, not a
200 response.

| Flow | Seam function | Watch for |
|---|---|---|
| Sign in with X / Discord / Google / Email | `getOrCreateWallet` | one `privy_wallets` row per provider namespace |
| Tag an unregistered @handle on an on-chain bill | `getOrCreateWallet("prem", …)` | a `pending_wallets` row AND a `privy_wallets` row with `namespace='prem'` |
| That handle signs in for the first time | adoption at `lib/oauth-callback.ts:93-99` | they receive the **pre-minted** address, not a fresh one |
| Create an on-chain bill from the social wallet | `executeContract` | `BillCreated` on the explorer, billId read back |
| Pay an on-chain debt | `executeContract` | approve then payDebt both mine |
| Claim as the bill's creator | `executeContract` | only the splitter wallet can claim; confirm it still can |
| Refund | `executeContract` | funds return |
| Pay an off-chain (handle-tagged) debt | `transferUsdc` | `paid_tx_hash` is a real 0x hash now |
| Wallet panel send | `transferUsdc` | explorer link appears immediately |
| Wallet panel history | `listTransactions` | rows present, links work, no duplicate self-transfer |
| Recurring tab create → authorize → claim | `executeContract` | all three from the social wallet |
| Public `/pay/<token>` social route | `transferUsdc` | a stranger's first-press path |
| Public `/pay/<token>` gateway route | `transferUsdc` | x402 batching unaffected — the Settler EOA is untouched |
| Treasury net settlement | `executeContract` | transfers match the netting preview |
| Autopay settlement from the agent wallet | `executeContract` | Task 5 Step 9 covered it; re-confirm after Task 6's env |
| Reputation NFT on first payment | `executeContract` via `lib/erc8004.ts` | registrar mints, transfers to payer, no double mint |

- [ ] **Step 3: Check the one thing that has no Circle equivalent**

Circle DCWs are SCAs with lazy deployment; Privy wallets are EOAs that must hold
USDC to pay Arc's USDC-denominated gas. Confirm the failure mode is a readable
message and not a raw revert: with an unfunded wallet, attempt a pay. Expected:
`InsufficientFundsError` → HTTP 402 → the existing funding prompt. If the Privy
error string does not match the regex in `lib/privy-wallet.ts`'s `send`, widen it
and add the real message as a comment.

- [ ] **Step 4: Re-walk the top five rows on the Circle stack**

`WALLET_PROVIDER` unset. Sign in, create an on-chain bill, pay an off-chain debt,
send from the panel, read history. Expected: identical to before this plan
existed. Any difference is a regression in Task 2's refactor, not a Privy issue.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix(wallets): close the gaps the two-stack walkthrough found"
```

---

### Task 8: The domain flip — do not start until it is explicitly asked for

Everything before this leaves `splitsy.xyz` alone. This task is the only one that
changes what a live user gets, and it is split into two decisions that are
deliberately independent: **merging the code** and **flipping the domains**. Do the
first, live with it, then do the second.

**Files:** none. Git and dashboards only.

- [ ] **Step 1: Merge the branch**

```bash
git checkout main && git pull && git merge --no-ff privy-wallet-stack
git push origin main
```

This changes nothing for users. Production has no `WALLET_PROVIDER`, so
`walletProviderName()` returns `circle` and every route resolves to the same
Circle backend it used before. The refactor is the only thing that ships.

- [ ] **Step 2: Verify the live site after the merge — the real gate**

This is the moment Task 2's "the Circle stack cannot tell it happened" claim is
tested against production rather than a dev server. On `https://splitsy.xyz`, as a
real signed-in user: read a balance, pay one off-chain debt, send from the wallet
panel, open the history tab, create one on-chain bill.

Expected: no banner, no behaviour change, no new errors in the Vercel logs.

If anything is off, roll back immediately — Vercel's Deployments tab can promote
the previous production deployment in seconds, which is faster and safer than a
revert commit. Do that first, then diagnose.

Then leave it alone for a few days. The point of separating this from Step 3 is to
learn whether the refactor is quiet under real traffic before any domain moves.

- [ ] **Step 3: Create the second Vercel project**

Only once Step 2 has been quiet. New Vercel project, same repo, same `main`
branch, and copy the **Preview** env values from Task 6 into its **Production**
scope — `WALLET_PROVIDER=privy`, the `splitsy-test` Supabase vars, the four Privy
vars, a fresh `SESSION_SECRET`, no Circle vars, no mandate address.

Two projects now build on every push to `main`. That is the cost of the split.

- [ ] **Step 4: Register the testnet hostname before it exists**

Add `https://testnet.splitsy.xyz/api/auth/<provider>/callback` to the X, Discord
and Google consoles, and `testnet.splitsy.xyz` to Turnstile. Keep every existing
entry. Doing this first means the swap in Step 5 cannot strand sign-in.

- [ ] **Step 5: Swap the domains**

In the **new** project: add `splitsy.xyz`. In the **old** project: add
`testnet.splitsy.xyz`, set `NEXT_PUBLIC_STACK_LABEL=Arc Testnet — play money`, and
set `GOOGLE_OAUTH_REDIRECT_ORIGIN=https://testnet.splitsy.xyz`. Then move
`splitsy.xyz` off the old project.

Vercel will not let one domain sit on two projects, so the order is: prepare the
new project fully, then release the domain from the old one and claim it. Expect a
brief window where `splitsy.xyz` does not resolve. Do this at a quiet hour.

- [ ] **Step 6: Verify both, and know the way back**

`splitsy.xyz` → Privy stack, no banner, sign-in works, a wallet appears, one debt
pays. `testnet.splitsy.xyz` → Circle stack, banner shows, same five flows.

Rollback is a domain move, not a deploy: put `splitsy.xyz` back on the old
project. The old project still has its database, its Circle env and its users
untouched, which is why nothing in Tasks 1–7 was allowed to modify it.

Update `docs/deployments.md` to match reality once this is done — its table still
describes the preview arrangement.

---

## Self-Review

Checked against the spec:

- **Spec coverage.** Circle-mainnet blocker → Task 6 keeps both on testnet and
  `docs/deployments.md` records why. DCW custody → Tasks 2+3. Agent-wallet float →
  Task 5. Two stacks, one branch → Tasks 2 and 6. Privy-as-wallets-only → Task 3
  touches no OAuth module. Server SDK only → Global Constraints forbid the client
  SDK and `proxy.ts` is on the do-not-touch list. Agent wallet keeps its own
  address → Task 3's `("agent", user.id)` key. Separate databases → Task 6 Step 1.
  PIN deferred → `lib/pin.ts` and the PIN routes are on the do-not-touch list.
  Arc mainnet deferred → not in any task. Open question 1 → Task 5 Step 1. Open
  question 2 → Task 1 Step 3.
- **The live site is protected structurally, not by care.** Three independent
  mechanisms, and any one of them alone would be enough: the work lives on
  `privy-wallet-stack` while Production serves `main`; `walletProviderName()`
  defaults to `circle`, so an environment that forgets the variable falls back to
  the harmless stack; and the Privy env is scoped to Vercel's Preview environment,
  pointing at a different database. Tasks 1–7 change no Production setting at all.
  Task 8 is where a live user first sees a difference, and it exists as a separate
  task so that it cannot happen by momentum.
- **One design choice worth re-reading before you start.** The agent wallet gets
  its own Privy user keyed `agent:<userId>` rather than a second `wallet_index` on
  the user's own Privy user, because the pay wallet's key is
  `<provider>:<providerUserId>` (per-identity) while the agent's is per-account —
  they cannot share a `custom_jwt` id without a second mapping table. Same
  outcome: a distinct address, its own ERC-8004 identity, its own policy. Cost:
  when client-side Privy auth eventually lands, exporting both wallets is two
  flows rather than one. The spec records this decision; no deviation remains.
- **Type consistency.** `ProviderWallet` / `TxResult` / `WalletTx` /
  `WalletBackend` are declared once in Task 2 and only imported afterwards.
  `looksLikeTxHash` moves in Task 4 but keeps its Task 2 export path via
  re-export, so the Task 2 test is untouched. Circle's state strings
  (`COMPLETE`/`FAILED`) are what `receiptToState` produces, which is what the
  existing route guards compare against.
- **Known thin spot.** Task 3's `privy().wallets().ethereum().sendTransaction()`
  and `privy().users().create()` are written from documentation, not from a
  running SDK. Task 1 exists to pin them down first, and Tasks 3 and 5 both say
  the spike script is the authority over this plan. If Task 1 finds different
  names, correct them there and the later tasks inherit the fix.

# Arc Chain Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Arc chain value in the app come from one module, so the same
build runs on Arc mainnet or Arc testnet by one variable, and can never silently
mix the two.

**Architecture:** A new `lib/arc-chain.ts` holds two profiles (mainnet, testnet)
and picks one from `NEXT_PUBLIC_ARC_NETWORK`. Every other module imports `ARC`
from it instead of reading `ARC_TESTNET_*` with a testnet fallback. The switch
itself defaults to testnet; nothing derived from it has a default at all.

**Tech Stack:** TypeScript, Next.js 16, viem 2.52.2, `node:test` with
`--experimental-strip-types`.

**Spec:** `docs/superpowers/specs/2026-09-16-arc-mainnet-migration-design.md`

## Global Constraints

- **No dependency changes.** viem stays at 2.52.2. viem's `arc` export is an
  empty stub in every published version including latest; Arc mainnet is defined
  locally with `defineChain`.
- **The switch is `NEXT_PUBLIC_ARC_NETWORK`**, not `ARC_NETWORK`. Client modules
  (`lib/wagmi.ts`, `app/PrivyShell.tsx`, `lib/appkit-bridge.ts`) read it, and only
  `NEXT_PUBLIC_*` variables exist in the browser bundle.
- **`process.env.NEXT_PUBLIC_*` must be referenced as a literal**, never as
  `env[key]` or destructured. Next replaces these textually at build time; a
  dynamic read is not inlined and is `undefined` in the browser.
- **Exact match, failing toward testnet.** Only the exact string `"mainnet"`
  selects mainnet. Anything else — unset, `"Mainnet"`, `"MAINNET"`, a typo —
  selects testnet. Same rule as `walletProviderName()` (`lib/wallet-provider.ts:52`).
- **No per-value fallbacks.** Once a network is chosen, every value it implies
  comes from the profile. No call site may keep a `?? "https://rpc.testnet…"` or
  a `?? "0x3600…"`.
- **Arc mainnet values**, verified on chain 2026-09-16 against
  `https://rpc.mainnet.arc.io`:
  - chain id `5042`, RPC `https://rpc.mainnet.arc.io`, explorer `https://explorer.arc.io`
  - USDC `0x3600000000000000000000000000000000000000` (same as testnet)
  - GatewayWallet `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE` (**differs from testnet**)
  - GatewayMinter `0x2222222d7164433c4C09B0b0D809a9b52C04C205` (**differs from testnet**)
  - Gateway API `https://gateway-api.circle.com/v1`, Arc is domain `26`
  - Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11`
- **Test command:** `node --test --experimental-strip-types <files>`. Tests live
  beside their module as `<module>.test.ts` and use `node:test` +
  `node:assert/strict`.
- **Test names are sentences** describing the behaviour, matching
  `lib/site-contracts.test.ts`. Comment *why* a test exists when it guards a
  specific past failure.
- **Commit after every task.** Conventional commits, lowercase scope.

---

### Task 1: The chain module

**Files:**
- Create: `lib/arc-chain.ts`
- Create: `lib/arc-chain.test.ts`
- Modify: `package.json` (add a `test:arc-chain` script)

**Interfaces:**
- Consumes: nothing. This task has no dependencies.
- Produces:
  - `type ArcNetwork = "mainnet" | "testnet"`
  - `type ArcProfile = { network: ArcNetwork; chain: Chain; chainId: number; rpcUrl: string; explorerUrl: string; usdcAddress: \`0x${string}\`; gatewayWallet: \`0x${string}\`; gatewayMinter: \`0x${string}\`; gatewayApiUrl: string; caip2: string }`
  - `const arcMainnet: Chain`
  - `const ARC_PROFILES: Record<ArcNetwork, ArcProfile>`
  - `function resolveArcProfile(network: string | undefined, rpcOverride?: string): ArcProfile`
  - `const ARC: ArcProfile` — the resolved profile every other module imports

- [ ] **Step 1: Write the failing test**

Create `lib/arc-chain.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { ARC_PROFILES, resolveArcProfile } from "./arc-chain.ts";

// The whole point of the module. Every one of these used to be a separate
// `process.env.ARC_TESTNET_* ?? "<a testnet value>"` at 24 call sites, so a
// mainnet deployment that missed one variable read testnet and rendered it as
// real money.
test("an unset network is testnet, never mainnet", () => {
  assert.equal(resolveArcProfile(undefined).network, "testnet");
  assert.equal(resolveArcProfile("").network, "testnet");
});

// Exact match, failing toward testnet — the same rule as walletProviderName().
// A capitalised or misspelled value in a new environment must land on the chain
// where being wrong is free.
test("only the exact string mainnet selects mainnet", () => {
  assert.equal(resolveArcProfile("mainnet").network, "mainnet");
  assert.equal(resolveArcProfile("Mainnet").network, "testnet");
  assert.equal(resolveArcProfile("MAINNET").network, "testnet");
  assert.equal(resolveArcProfile("mainet").network, "testnet");
  assert.equal(resolveArcProfile("main").network, "testnet");
});

test("each profile carries the chain id its name implies", () => {
  assert.equal(resolveArcProfile("mainnet").chainId, 5042);
  assert.equal(resolveArcProfile("testnet").chainId, 5042002);
  assert.equal(resolveArcProfile("mainnet").chain.id, 5042);
  assert.equal(resolveArcProfile("testnet").chain.id, 5042002);
});

// The CAIP-2 string is handed to Privy and to x402, which both reject a
// transaction whose chain does not match. Deriving it by hand at a call site is
// how it drifts from the chain it claims to name.
test("the CAIP-2 string always agrees with the chain id", () => {
  for (const profile of Object.values(ARC_PROFILES)) {
    assert.equal(profile.caip2, `eip155:${profile.chainId}`);
  }
});

// The trap this module exists to close. USDC happens to share an address across
// both networks, so a migration that checks only USDC concludes "Arc addresses
// are the same everywhere" and is then wrong about Gateway — which moves money.
test("USDC shares an address across networks but Gateway does not", () => {
  assert.equal(ARC_PROFILES.mainnet.usdcAddress, ARC_PROFILES.testnet.usdcAddress);
  assert.notEqual(ARC_PROFILES.mainnet.gatewayWallet, ARC_PROFILES.testnet.gatewayWallet);
  assert.notEqual(ARC_PROFILES.mainnet.gatewayMinter, ARC_PROFILES.testnet.gatewayMinter);
  assert.notEqual(ARC_PROFILES.mainnet.gatewayApiUrl, ARC_PROFILES.testnet.gatewayApiUrl);
});

test("mainnet carries the addresses verified on chain 2026-09-16", () => {
  const mainnet = ARC_PROFILES.mainnet;
  assert.equal(mainnet.rpcUrl, "https://rpc.mainnet.arc.io");
  assert.equal(mainnet.explorerUrl, "https://explorer.arc.io");
  assert.equal(mainnet.usdcAddress, "0x3600000000000000000000000000000000000000");
  assert.equal(mainnet.gatewayWallet, "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE");
  assert.equal(mainnet.gatewayMinter, "0x2222222d7164433c4C09B0b0D809a9b52C04C205");
  assert.equal(mainnet.gatewayApiUrl, "https://gateway-api.circle.com/v1");
});

// The public endpoints rate-limit: -32011 'request limit reached' surfaces as a
// failed contract READ, so it reads as a broken call rather than a quota
// (lib/x402/constants.ts:16-21). A keyed URL is per-deployment, so it overrides
// the RPC and nothing else.
test("an RPC override replaces the endpoint and leaves every other value alone", () => {
  const overridden = resolveArcProfile("mainnet", "https://arc-mainnet.g.alchemy.com/v2/key");
  const base = ARC_PROFILES.mainnet;

  assert.equal(overridden.rpcUrl, "https://arc-mainnet.g.alchemy.com/v2/key");
  assert.equal(overridden.chainId, base.chainId);
  assert.equal(overridden.explorerUrl, base.explorerUrl);
  assert.equal(overridden.gatewayWallet, base.gatewayWallet);
});

test("an empty override is ignored rather than blanking the endpoint", () => {
  assert.equal(resolveArcProfile("mainnet", "").rpcUrl, ARC_PROFILES.mainnet.rpcUrl);
  assert.equal(resolveArcProfile("mainnet", undefined).rpcUrl, ARC_PROFILES.mainnet.rpcUrl);
});

// Mutating a returned profile must not poison the next caller — these are
// module-level singletons read by ~20 modules.
test("a returned profile does not alias the shared table", () => {
  const first = resolveArcProfile("mainnet", "https://one.example");
  const second = resolveArcProfile("mainnet");

  assert.equal(second.rpcUrl, ARC_PROFILES.mainnet.rpcUrl);
  assert.notEqual(first.rpcUrl, second.rpcUrl);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
node --test --experimental-strip-types lib/arc-chain.test.ts
```

Expected: FAIL — `Cannot find module './arc-chain.ts'`.

- [ ] **Step 3: Write the module**

Create `lib/arc-chain.ts`:

```ts
// The one place that knows which Arc network this deployment is on.
//
// Before this module, 24 call sites across 20 files each decided for themselves,
// and every one of them read an `ARC_TESTNET_*` variable with a TESTNET value as
// its fallback. That is the wrong direction: a mainnet deployment missing one
// variable did not fail, it read testnet state and rendered it as real money.
//
// So the rule here is two-level, and the levels are what make it safe:
//   - the SWITCH has a default (absent means testnet, never mainnet);
//   - nothing DERIVED from the switch has a default at all.
// A deployment can still be wrong about which network it is, which is loud and
// harmless. It can no longer be wrong about one address inside a network, which
// was quiet and expensive.
import { defineChain, type Chain } from "viem";
import { arcTestnet } from "viem/chains";

// viem exports `arc`, but it is an empty stub — no RPC urls, no block explorer,
// no multicall3 — in 2.52.2 and in every later version including latest, so
// `createPublicClient({ chain: arc })` throws. Arc's docs say both chains are
// "bundled with viem"; the export exists but is not usable. Hence this.
//
// Values verified on chain 2026-09-16 against https://rpc.mainnet.arc.io.
// nativeCurrency mirrors viem's own arcTestnet: gas is USDC at 18 decimals of
// precision, while the ERC-20 interface at usdcAddress reports 6. Mixing the two
// breaks balance maths — read the ERC-20 for balances, never the native unit.
export const arcMainnet = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.arc.io"] } },
  blockExplorers: {
    default: { name: "Arc Explorer", url: "https://explorer.arc.io" },
  },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

export type ArcNetwork = "mainnet" | "testnet";

export type ArcProfile = {
  network: ArcNetwork;
  chain: Chain;
  chainId: number;
  rpcUrl: string;
  explorerUrl: string;
  usdcAddress: `0x${string}`;
  gatewayWallet: `0x${string}`;
  gatewayMinter: `0x${string}`;
  gatewayApiUrl: string;
  /** eip155:<chainId>, the form Privy and x402 both want. */
  caip2: string;
};

export const ARC_PROFILES: Record<ArcNetwork, ArcProfile> = {
  mainnet: {
    network: "mainnet",
    chain: arcMainnet,
    chainId: 5042,
    rpcUrl: "https://rpc.mainnet.arc.io",
    explorerUrl: "https://explorer.arc.io",
    usdcAddress: "0x3600000000000000000000000000000000000000",
    // Note these differ from testnet's. USDC does not, which is exactly what
    // makes assuming "Arc addresses are the same on both" so easy and so wrong.
    gatewayWallet: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE",
    gatewayMinter: "0x2222222d7164433c4C09B0b0D809a9b52C04C205",
    gatewayApiUrl: "https://gateway-api.circle.com/v1",
    caip2: "eip155:5042",
  },
  testnet: {
    network: "testnet",
    chain: arcTestnet,
    chainId: 5042002,
    rpcUrl: "https://rpc.testnet.arc.network",
    explorerUrl: "https://testnet.arcscan.app",
    usdcAddress: "0x3600000000000000000000000000000000000000",
    gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    gatewayMinter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
    gatewayApiUrl: "https://gateway-api-testnet.circle.com/v1",
    caip2: "eip155:5042002",
  },
};

/**
 * Pick a profile, with an optional RPC override.
 *
 * Exported separately from `ARC` so it is testable without touching the process
 * environment — the same shape as `siteContracts(env)` in lib/site-contracts.ts.
 *
 * The match is EXACT and fails toward testnet. A capitalised value, a typo or an
 * unset variable in a new environment all land on the chain where being wrong
 * costs nothing, which is the same rule `walletProviderName()` uses.
 */
export function resolveArcProfile(network: string | undefined, rpcOverride?: string): ArcProfile {
  const base = ARC_PROFILES[network === "mainnet" ? "mainnet" : "testnet"];
  // Spread rather than return `base` directly: callers must not be able to
  // mutate the shared table out from under twenty other modules.
  return { ...base, rpcUrl: rpcOverride || base.rpcUrl };
}

// Both reads are written as literals on purpose. Next replaces
// `process.env.NEXT_PUBLIC_*` textually at BUILD time, so a dynamic read —
// `env[key]`, a destructure — is never inlined and is undefined in the browser.
// ARC_RPC_URL is server-only and wins where it exists, so a keyed endpoint need
// not be published into the client bundle; in the browser it is simply
// undefined and the public one applies.
export const ARC = resolveArcProfile(
  process.env.NEXT_PUBLIC_ARC_NETWORK,
  process.env.ARC_RPC_URL || process.env.NEXT_PUBLIC_ARC_RPC_URL,
);
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
node --test --experimental-strip-types lib/arc-chain.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Add the test script**

In `package.json`, add beside the other `test:*` scripts:

```json
"test:arc-chain": "node --test --experimental-strip-types lib/arc-chain.test.ts",
```

- [ ] **Step 6: Commit**

```bash
git add lib/arc-chain.ts lib/arc-chain.test.ts package.json
git commit -m "feat(arc): one module decides which Arc network this deployment is"
```

---

### Task 2: The explorer

**Files:**
- Modify: `lib/arc-explorer.ts:1-6`
- Modify: `lib/arc-explorer.test.ts:13`
- Modify: `app/DashboardPanel.tsx:63`, `app/JobTrail.tsx:21`, `app/XHistoryPanel.tsx:47`
- Modify: `app/HomeClient.tsx:2870`, `:3784`, `:3798`
- Modify: `components/landing/demo/AgentStage.tsx:335`
- Modify: `app/api/wallet/transactions/route.ts:15`

**Interfaces:**
- Consumes: `ARC` from `lib/arc-chain.ts` (Task 1).
- Produces: `ARC_EXPLORER` keeps its name and export, so no consumer signature
  changes — only its value becomes network-aware.

- [ ] **Step 1: Update the test to assert the behaviour, not the constant**

In `lib/arc-explorer.test.ts:13`, replace the hardcoded host:

```ts
    assert.equal(await waitForCircleTxUrl(hash), `https://testnet.arcscan.app/tx/${hash}`);
```

with a reference to the configured one, and add an import at the top:

```ts
import { ARC } from "./arc-chain.ts";
```

```ts
    assert.equal(await waitForCircleTxUrl(hash), `${ARC.explorerUrl}/tx/${hash}`);
```

Then add a test that the constant tracks the profile:

```ts
// The footer, the dashboard and every receipt link read this. Pinned to a
// literal it silently pointed a mainnet receipt at a testnet explorer, where the
// transaction does not exist — which reads to a user as "my payment vanished".
test("the explorer host is whichever network this deployment is on", () => {
  assert.equal(ARC_EXPLORER, ARC.explorerUrl);
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
node --test --experimental-strip-types lib/arc-explorer.test.ts
```

Expected: FAIL — `ARC_EXPLORER` is not exported into the test yet / is not equal.

Add `ARC_EXPLORER` to the existing import from `./arc-explorer.ts` if it is not
already there.

- [ ] **Step 3: Make the constant network-aware**

In `lib/arc-explorer.ts`, replace lines 1-6:

```ts
// Arc Testnet block explorer links, client-side.
//
// lib/circle-dcw.ts owns the same knowledge server-side but is server-only (it
// pulls the Circle SDK and node:crypto), so a browser component can't import it.

export const ARC_EXPLORER = "https://testnet.arcscan.app";
```

with:

```ts
// Arc block explorer links, client-side.
//
// lib/circle-dcw.ts owns the same knowledge server-side but is server-only (it
// pulls the Circle SDK and node:crypto), so a browser component can't import it.
import { ARC } from "./arc-chain.ts";

export const ARC_EXPLORER = ARC.explorerUrl;
```

- [ ] **Step 4: Replace every hardcoded explorer host**

In each file below, replace the literal `"https://testnet.arcscan.app"` (or the
inline `https://testnet.arcscan.app` inside a template string) with `ARC_EXPLORER`
imported from `@/lib/arc-explorer`, deleting the now-dead local const:

- `app/DashboardPanel.tsx:63` — delete `const EXPLORER = "https://testnet.arcscan.app";`, import `ARC_EXPLORER` and rename uses.
- `app/JobTrail.tsx:21` — same.
- `app/XHistoryPanel.tsx:47` — `useState("https://testnet.arcscan.app")` becomes `useState(ARC_EXPLORER)`.
- `app/HomeClient.tsx:2870`, `:3784`, `:3798` — three template strings; replace the host portion with `${ARC_EXPLORER}`.
- `components/landing/demo/AgentStage.tsx:335` — one template string.
- `app/api/wallet/transactions/route.ts:15` — replace
  `process.env.ARC_TESTNET_EXPLORER_URL ?? "https://testnet.arcscan.app"` with
  `ARC.explorerUrl`, importing `ARC` from `@/lib/arc-chain`.

- [ ] **Step 5: Confirm no explorer literal survives outside the profile table**

```bash
grep -rn "testnet.arcscan.app" --include="*.ts" --include="*.tsx" app lib components | grep -v "arc-chain.ts"
```

Expected: no output.

- [ ] **Step 6: Run the tests**

```bash
node --test --experimental-strip-types lib/arc-chain.test.ts lib/arc-explorer.test.ts lib/site-contracts.test.ts
```

Expected: PASS. `site-contracts.test.ts` is included because `siteContracts()`
builds its URLs from `ARC_EXPLORER`; its assertion at line 15 still expects the
testnet host, which is correct while `NEXT_PUBLIC_ARC_NETWORK` is unset.

- [ ] **Step 7: Commit**

```bash
git add lib/arc-explorer.ts lib/arc-explorer.test.ts app components
git commit -m "fix(arc): link receipts to the explorer for the network they were mined on"
```

---

### Task 3: The read clients

**Files:**
- Modify: `lib/arc-read.ts:114`, `:253`, `:289`, `:455`
- Modify: `lib/recurring-read.ts:107`
- Modify: `lib/recurring-contracts.ts:22`, `:222`

**Interfaces:**
- Consumes: `ARC` from `lib/arc-chain.ts` (Task 1).
- Produces: no signature changes. `ARC_USDC_ADDRESS` keeps its name and type in
  `lib/recurring-contracts.ts`.

- [ ] **Step 1: Replace the RPC reads**

In `lib/arc-read.ts:114` and `lib/recurring-read.ts:107`, both currently:

```ts
  transport: http(process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network", {
    batch: { batchSize: 3 },
  }),
```

becomes:

```ts
  transport: http(ARC.rpcUrl, {
    batch: { batchSize: 3 },
  }),
```

Keep the surrounding comments about `batchSize: 3` — they record why drpc's free
plan rejects batches over 3, which is still true.

In `lib/recurring-contracts.ts:222`:

```ts
  transport: http(process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network"),
```

becomes:

```ts
  transport: http(ARC.rpcUrl),
```

Add `import { ARC } from "./arc-chain.ts";` to each file.

- [ ] **Step 2: Replace the chain objects**

Anywhere these three files pass `chain: arcTestnet`, pass `chain: ARC.chain` and
drop the now-unused `arcTestnet` import.

- [ ] **Step 3: Replace the USDC reads**

`lib/arc-read.ts:253` and `:289`:

```ts
    address: (process.env.ARC_TESTNET_USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000") as `0x${string}`,
```

becomes:

```ts
    address: ARC.usdcAddress,
```

`lib/arc-read.ts:455`:

```ts
const ARC_USDC_ADDRESS = (process.env.ARC_TESTNET_USDC_ADDRESS ??
```

becomes a single line:

```ts
const ARC_USDC_ADDRESS = ARC.usdcAddress;
```

`lib/recurring-contracts.ts:21-24`:

```ts
export const ARC_USDC_ADDRESS = (
  process.env.NEXT_PUBLIC_ARC_TESTNET_USDC_ADDRESS ??
  "0x3600000000000000000000000000000000000000"
) as `0x${string}`;
```

becomes:

```ts
export const ARC_USDC_ADDRESS = ARC.usdcAddress;
```

- [ ] **Step 4: Run the read-path tests**

```bash
npm run test:settle && npm run test:dashboard
```

Expected: PASS. These cover `lib/arc-read.ts` and the settle path.

- [ ] **Step 5: Commit**

```bash
git add lib/arc-read.ts lib/recurring-read.ts lib/recurring-contracts.ts
git commit -m "fix(arc): read chain state from the configured network, not a testnet default"
```

---

### Task 4: The browser chain

**Files:**
- Modify: `lib/wagmi.ts:5-34`, `:50-52`
- Modify: `lib/wagmi.test.ts:55`
- Modify: `app/PrivyShell.tsx:18`
- Modify: `lib/appkit-bridge.ts:51`, `:72`

**Interfaces:**
- Consumes: `ARC` from `lib/arc-chain.ts` (Task 1).
- Produces: `arcWalletClient()` keeps its signature — `() => Promise<WalletClient>`.

**Note:** `lib/wagmi.test.ts` is a *source-level* invariant test. It greps every
file under `app/`, `lib/` and `components/` for `getWalletClient` calls that name
Arc's chain id directly. Its regex must learn the new spelling or it stops
guarding anything.

- [ ] **Step 1: Update the invariant test's regex**

In `lib/wagmi.test.ts:55`:

```ts
  const pattern = /getWalletClient\s*\([^)]*chainId\s*:\s*(arcTestnet\.id|5042002)/s;
```

becomes:

```ts
  const pattern = /getWalletClient\s*\([^)]*chainId\s*:\s*(arcTestnet\.id|ARC\.chainId|5042002|5042)/s;
```

Update the comment above it to name `ARC.chainId` as the current spelling.

- [ ] **Step 2: Run it and confirm it still passes**

```bash
npm run test:wallet-chain
```

Expected: PASS — the regex is widened, nothing has moved yet.

- [ ] **Step 3: Point wagmi at the configured chain**

In `lib/wagmi.ts`, replace the `arcTestnet` import with `ARC`:

```ts
import { ARC } from "./arc-chain";
```

Remove `arcTestnet` from the `viem/chains` import list. The bridge source chains
(`baseSepolia`, `sepolia`, …) stay exactly as they are — they are testnet
bridging sources and are out of scope for this task; see "Deliberately deferred"
in the spec.

Then, in `getDefaultConfig`:

```ts
  chains: [ARC.chain, baseSepolia, sepolia, arbitrumSepolia, optimismSepolia, avalancheFuji, polygonAmoy],
  transports: {
    [ARC.chainId]: http(ARC.rpcUrl),
```

and in `arcWalletClient()`:

```ts
export async function arcWalletClient() {
  await switchChain(wagmiConfig, { chainId: ARC.chainId });
  return getWalletClient(wagmiConfig, { chainId: ARC.chainId });
}
```

Keep the long comment above `arcWalletClient` intact — it records the exact user-
facing bug the switch-before-read order prevents.

- [ ] **Step 4: Point PrivyShell at the configured chain**

In `app/PrivyShell.tsx:18`, replace:

```ts
import { arcTestnet } from "viem/chains";
```

with:

```ts
import { ARC } from "@/lib/arc-chain";
```

and replace every `arcTestnet` use in the file with `ARC.chain`.

- [ ] **Step 5: Point the bridge adapter at the configured chain**

In `lib/appkit-bridge.ts:51`:

```ts
const ARC_TESTNET_CHAIN_ID = 5042002;
```

becomes:

```ts
const ARC_CHAIN_ID = ARC.chainId;
```

Rename its uses in the file. At `:72`:

```ts
const arcRpcUrl = process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network";
```

becomes:

```ts
const arcRpcUrl = ARC.rpcUrl;
```

Add `import { ARC } from "./arc-chain.ts";`.

- [ ] **Step 6: Run the wallet tests**

```bash
npm run test:wallet-chain && npm run test:wallet-provider
```

Expected: PASS.

- [ ] **Step 7: Confirm it compiles**

```bash
npx tsc --noEmit
```

Expected: no errors. This is the first task touching `.tsx` files, so a type
error here is more likely than in Tasks 1-3.

- [ ] **Step 8: Commit**

```bash
git add lib/wagmi.ts lib/wagmi.test.ts app/PrivyShell.tsx lib/appkit-bridge.ts
git commit -m "fix(arc): put the browser wallet on the network this deployment runs"
```

---

### Task 5: Gateway and the server-side USDC constants

**Files:**
- Modify: `lib/gateway-contracts.ts:1-33`
- Modify: `lib/gateway-pay.ts:33-35`
- Modify: `lib/circle-dcw.ts:34`
- Modify: `lib/user-agent.ts:23-24`

**Interfaces:**
- Consumes: `ARC` from `lib/arc-chain.ts` (Task 1).
- Produces: `arcContracts: ChainConfig` gains a populated `mainnet` half. Its
  existing `NetworkConfig` and `ChainConfig` types are unchanged.

**Note:** `lib/gateway-contracts.ts` already has the right shape — `ChainConfig`
declares optional `mainnet?` and `testnet?` halves, and `GATEWAY_CONFIG` already
declares `MAINNET_URL`. Only Arc's `mainnet` half is missing. Do not restructure
the file. Add the missing half, exactly as below.

- [ ] **Step 1: Fill in Arc's mainnet half**

In `lib/gateway-contracts.ts`, `arcContracts` currently declares `testnet` only.
Add the mainnet half using the verified addresses:

```ts
export const arcContracts: ChainConfig = {
  domain: 26,
  mainnet: {
    RPC: ARC_PROFILES.mainnet.rpcUrl,
    GatewayWallet: ARC_PROFILES.mainnet.gatewayWallet,
    GatewayMinter: ARC_PROFILES.mainnet.gatewayMinter,
    USDCAddress: ARC_PROFILES.mainnet.usdcAddress,
    ViemChain: ARC_PROFILES.mainnet.chain,
  },
  testnet: {
    RPC: ARC_PROFILES.testnet.rpcUrl,
    GatewayWallet: ARC_PROFILES.testnet.gatewayWallet,
    GatewayMinter: ARC_PROFILES.testnet.gatewayMinter,
    USDCAddress: ARC_PROFILES.testnet.usdcAddress,
    ViemChain: ARC_PROFILES.testnet.chain,
  },
};
```

Import `ARC_PROFILES` from `./arc-chain.ts`, and drop `arcTestnet` from the
`viem/chains` import if it becomes unused.

**Read the values from the profile table, do not retype them.** These four
addresses are the ones that move money, and two of them differ between networks
in a way that is easy to get backwards. One source of truth means a wrong address
is wrong in one place and caught by Task 1's tests, rather than wrong in one of
two places and caught by nobody.

`domain: 26` stays declared here: `gateway-contracts.ts` already carries a
`domain` for every chain uniformly, and Circle's Gateway domain is not the chain
id — Arc is 26 on both networks. Duplicating it into the profile would create the
second source this step exists to avoid.

Leave the other chains (`avalancheContracts`, `baseContracts`,
`ethereumContracts`, …) untouched — they are bridge *sources* and stay on
testnet, per the spec's deferred list.

- [ ] **Step 2: Replace the server-side USDC constants**

`lib/gateway-pay.ts:33-35`, `lib/circle-dcw.ts:34` and `lib/user-agent.ts:23-24`
each declare a local `ARC_USDC_ADDRESS` with a testnet default. All three become:

```ts
const ARC_USDC_ADDRESS = ARC.usdcAddress;
```

with `import { ARC } from "./arc-chain.ts";` added.

- [ ] **Step 3: Run the gateway tests**

```bash
npm run test:gateway
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/gateway-contracts.ts lib/gateway-pay.ts lib/circle-dcw.ts lib/user-agent.ts
git commit -m "feat(arc): teach Gateway the mainnet addresses, which are not the testnet ones"
```

---

### Task 6: ERC-8004 stops pretending it is configured

**Files:**
- Modify: `lib/erc8004.ts:51-55`, `:175-177`, `:578`
- Create: `lib/erc8004-config.test.ts`
- Modify: `package.json` (extend `test:agents`)

**Interfaces:**
- Consumes: `ARC` from `lib/arc-chain.ts` (Task 1).
- Produces:
  - `function isReputationConfigured(): boolean`
  - `IDENTITY_REGISTRY` and `REPUTATION_REGISTRY` keep their names and
    `` `0x${string}` `` type, but default to the zero address rather than to a
    testnet address.

**Why this task is not cosmetic.** `lib/erc8004.ts:52` currently defaults to the
Arc *testnet* registry address. On mainnet nothing is deployed there, so "unset"
does not mean "off" — it means "call an address with no code", which fails in a
way that looks like a bug. `lib/erc8183.ts:18-25` already does this correctly for
AgenticCommerce and is the pattern to copy, comment and all.

- [ ] **Step 1: Write the failing test**

Create `lib/erc8004-config.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { IDENTITY_REGISTRY, REPUTATION_REGISTRY, isReputationConfigured } from "./erc8004.ts";

const ZERO = "0x0000000000000000000000000000000000000000";

// Circle has not deployed ERC-8004 to Arc mainnet and intends to. So unset must
// mean OFF and stay off until an address is entered — never "call the testnet
// registry", which on mainnet is an address with no code. A call to it fails in
// a way that reads as a bug rather than as missing configuration.
//
// Same rule, and the same shape, as isJobsConfigured() in lib/erc8183.ts:24.
test("an unset registry is the zero address, not a testnet address", () => {
  assert.equal(IDENTITY_REGISTRY, ZERO);
  assert.equal(REPUTATION_REGISTRY, ZERO);
});

test("reputation reports itself unconfigured when the registries are unset", () => {
  assert.equal(isReputationConfigured(), false);
});
```

This test is written to run with `ERC8004_IDENTITY_REGISTRY` and
`ERC8004_REPUTATION_REGISTRY` absent from the environment, which is their state
in a clean checkout.

- [ ] **Step 2: Run it and confirm it fails**

```bash
node --test --experimental-strip-types lib/erc8004-config.test.ts
```

Expected: FAIL — `IDENTITY_REGISTRY` is `0x8004A818BFB912233c491871b3d84c89A494BD9e`,
and `isReputationConfigured` is not a function.

- [ ] **Step 3: Change the defaults and add the gate**

In `lib/erc8004.ts`, replace lines 51-55:

```ts
// Arc Testnet ERC-8004 registries (docs.arc.io); env-overridable for redeploys.
export const IDENTITY_REGISTRY = (process.env.ERC8004_IDENTITY_REGISTRY ??
  "0x8004A818BFB912233c491871b3d84c89A494BD9e") as `0x${string}`;
export const REPUTATION_REGISTRY = (process.env.ERC8004_REPUTATION_REGISTRY ??
  "0x8004B663056A597Dffe9eCcC1965A193B7388713") as `0x${string}`;
```

with:

```ts
// ERC-8004 registries. Unset means "no reputation configured", which reads as
// reputation OFF — never as "use some other network's registry".
//
// These used to default to Arc TESTNET's predeploys. On mainnet those addresses
// hold no code, so an unconfigured mainnet deployment did not skip reputation,
// it called nothing and failed in a way that looked like a bug. Circle has not
// deployed ERC-8004 to Arc mainnet yet and intends to; when they do, setting
// these two variables turns the feature on with no code change.
//
// Same rule as AGENTIC_COMMERCE_ADDRESS in lib/erc8183.ts:21.
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const IDENTITY_REGISTRY = (process.env.ERC8004_IDENTITY_REGISTRY ??
  ZERO_ADDRESS) as `0x${string}`;
export const REPUTATION_REGISTRY = (process.env.ERC8004_REPUTATION_REGISTRY ??
  ZERO_ADDRESS) as `0x${string}`;

export function isReputationConfigured() {
  return IDENTITY_REGISTRY !== ZERO_ADDRESS && REPUTATION_REGISTRY !== ZERO_ADDRESS;
}
```

- [ ] **Step 4: Point the module's RPC and explorer at the profile**

At `lib/erc8004.ts:175-177`:

```ts
const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network"),
});
```

becomes:

```ts
const publicClient = createPublicClient({
  chain: ARC.chain,
  transport: http(ARC.rpcUrl),
});
```

At `:578`:

```ts
const EXPLORER_URL = process.env.ARC_TESTNET_EXPLORER_URL ?? "https://testnet.arcscan.app";
```

becomes:

```ts
const EXPLORER_URL = ARC.explorerUrl;
```

Add `import { ARC } from "./arc-chain.ts";` and drop the `arcTestnet` import if it
becomes unused.

- [ ] **Step 5: Guard the entry points**

Find every exported function in `lib/erc8004.ts` that reads or writes a registry:

```bash
grep -n "IDENTITY_REGISTRY\|REPUTATION_REGISTRY" lib/erc8004.ts
```

For each *exported* function containing one, add an early return at the top,
matching how `lib/erc8183.ts:281` and `:313` already do it — return `[]` for a
list, `null` for a lookup, and for a write, return without sending:

```ts
  if (!isReputationConfigured()) return null;
```

Choose the empty value that matches the declared return type. Do not throw: an
unconfigured feature is a feature that is off, not an error.

- [ ] **Step 6: Run the test and confirm it passes**

```bash
node --test --experimental-strip-types lib/erc8004-config.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 7: Extend the agents test script**

In `package.json`, add `lib/erc8004-config.test.ts` to the end of the
`test:agents` file list, then run it:

```bash
npm run test:agents
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/erc8004.ts lib/erc8004-config.test.ts package.json
git commit -m "fix(erc8004): unset registries mean reputation is off, not pointed at another chain"
```

---

### Task 7: The signature domain and the x402 network string

**Files:**
- Modify: `lib/escrow-release.ts:42-44`, `:104`
- Modify: `lib/x402/constants.ts:1`, `:16-21`, `:31`
- Modify: `app/JobTrail.tsx:236`, `app/api/agents/catalog/route.ts:233`

**Interfaces:**
- Consumes: `ARC` from `lib/arc-chain.ts` (Task 1).
- Produces: `ARC_NETWORK` replaces `ARC_TESTNET_NETWORK` as the exported CAIP-2
  string; `ARC_USDC` and `ARC_RPC` keep their names.

**Why this one deserves care.** The chain id at `lib/escrow-release.ts:44` feeds
`releaseDomain()`, which is the EIP-712 domain separator the deployed
`HandleEscrow` checks. A signature made with the wrong chain id is rejected by
the contract — it does not misbehave, it fails closed. That is the correct
behaviour and the reason the chain id must follow the deployment rather than be
pinned. Existing testnet deposits are unaffected: they are held by a different
contract at a different address, and the address is part of the domain too.

- [ ] **Step 1: Make the escrow domain follow the network**

In `lib/escrow-release.ts`, replace lines 42-44:

```ts
// Arc Testnet. Also what releaseDomain binds the signature to, so a signature
// made for this deployment cannot be replayed against another chain.
const ARC_TESTNET_CHAIN_ID = 5042002;
```

with:

```ts
// Whichever Arc this deployment is on. Also what releaseDomain binds the
// signature to, so a signature made for this deployment cannot be replayed
// against another chain — which now includes the other Arc. A release signed on
// testnet is rejected by a mainnet escrow and vice versa, by the contract, not
// by us.
const ARC_CHAIN_ID = ARC.chainId;
```

Update the use at `:104` from `ARC_TESTNET_CHAIN_ID` to `ARC_CHAIN_ID`, and add
`import { ARC } from "./arc-chain.ts";`.

- [ ] **Step 2: Run the escrow tests**

```bash
npm run test:escrow
```

Expected: PASS. `lib/handle-escrow.test.ts` passes chain ids explicitly to
`releaseDomain()` (`:32`, `:37`, `:71`, `:78`), so it is unaffected by this change
— which is what makes it a useful check that the domain maths did not move.

- [ ] **Step 3: Make the x402 constants network-aware**

In `lib/x402/constants.ts`, replace line 1:

```ts
export const ARC_TESTNET_NETWORK = "eip155:5042002" as const;
export const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000" as const;
export const ARC_TESTNET_GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" as const;
```

with:

```ts
import { ARC } from "../arc-chain.ts";

export const ARC_NETWORK = ARC.caip2;
export const ARC_USDC = ARC.usdcAddress;
export const ARC_GATEWAY_WALLET = ARC.gatewayWallet;
```

Replace the `ARC_TESTNET_RPC` block at `:16-21` with:

```ts
export const ARC_RPC = ARC.rpcUrl;
```

Keep the long comment above it — it explains the rate-limit failure mode and is
still true.

Replace `GATEWAY_TRANSFER_URL` at `:31`:

```ts
export const GATEWAY_TRANSFER_URL = `${ARC.gatewayApiUrl}/x402/transfers/` as const;
```

Keep the comment about the `/x402/` segment — the warning that the plain
`/v1/transfers/` namespace 404s on these ids, and so reads as "this payment never
happened", applies on both hosts.

- [ ] **Step 4: Update every importer of the renamed constants**

```bash
grep -rn "ARC_TESTNET_NETWORK\|ARC_TESTNET_USDC\b\|ARC_TESTNET_GATEWAY_WALLET\|ARC_TESTNET_RPC" --include="*.ts" app lib scripts
```

Rename each to `ARC_NETWORK`, `ARC_USDC`, `ARC_GATEWAY_WALLET`, `ARC_RPC`. The
`scripts/` files are included here because they import from this module directly
and will not compile otherwise.

- [ ] **Step 5: Replace the two hardcoded Gateway hosts**

`app/JobTrail.tsx:236` and `app/api/agents/catalog/route.ts:233` both hardcode
`https://gateway-api-testnet.circle.com`. Replace with `ARC.gatewayApiUrl`
(strip the trailing `/v1` where the call site adds its own path segment — check
each one rather than assuming).

- [ ] **Step 6: Run the scout and agent tests**

```bash
npm run test:scout && npm run test:agents
```

Expected: PASS.

- [ ] **Step 7: Confirm it compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add lib/escrow-release.ts lib/x402 app/JobTrail.tsx app/api/agents/catalog/route.ts scripts
git commit -m "fix(arc): bind escrow signatures and x402 receipts to the running network"
```

---

### Task 8: The API routes

**Files:**
- Modify: `app/api/recurring/settle/route.ts:18`
- Modify: `app/api/treasury/settle/route.ts:42`
- Modify: `app/api/onchain-bills/preimage/route.ts:38`
- Modify: `app/api/onchain-bills/[billId]/pay/route.ts:20`
- Modify: `app/api/escrow/deposit/route.ts:27`
- Modify: `app/api/agents/grants/route.ts:41`
- Modify: `app/api/pay/[token]/social/route.ts:32`
- Modify: `app/api/recurring/[tabAddress]/authorize/route.ts:12`

**Interfaces:**
- Consumes: `ARC` from `lib/arc-chain.ts` (Task 1).
- Produces: nothing. These are leaf consumers.

The change is uniform. In each file:

- [ ] **Step 1: Replace the USDC constants**

Every `const ARC_USDC_ADDRESS = (process.env.ARC_TESTNET_USDC_ADDRESS ?? "0x3600…")`
— possibly split across two lines — becomes:

```ts
const ARC_USDC_ADDRESS = ARC.usdcAddress;
```

- [ ] **Step 2: Replace the RPC constants**

`app/api/recurring/settle/route.ts:18`:

```ts
const rpcUrl = process.env.ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network";
```

becomes:

```ts
const rpcUrl = ARC.rpcUrl;
```

`app/api/onchain-bills/preimage/route.ts:38`:

```ts
  transport: http(process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network"),
```

becomes:

```ts
  transport: http(ARC.rpcUrl),
```

- [ ] **Step 3: Replace the chain objects**

`app/api/recurring/settle/route.ts:81` and `:86` pass `chain: arcTestnet`. Both
become `chain: ARC.chain`. Drop the `arcTestnet` import from `viem/chains`.

Add `import { ARC } from "@/lib/arc-chain";` to each of the eight files.

- [ ] **Step 4: Confirm nothing falls back to testnet any more**

```bash
grep -rnE '\?\? *"https://rpc\.testnet|\?\? *"https://testnet\.arcscan|ARC_TESTNET_USDC_ADDRESS *\?\?|\?\? *"0x8004' --include="*.ts" --include="*.tsx" app lib
```

Expected: **no output.** This is the acceptance check for the whole plan — it is
the exact grep that found the 24 sites in the first place.

- [ ] **Step 5: Confirm it compiles and the suite is green**

```bash
npx tsc --noEmit && npm run lint
```

Then the full set of affected suites:

```bash
npm run test:arc-chain && npm run test:settle && npm run test:escrow \
  && npm run test:gateway && npm run test:agents && npm run test:scout \
  && npm run test:wallet-chain && npm run test:wallet-provider \
  && npm run test:footer && npm run test:dashboard
```

Expected: PASS throughout.

- [ ] **Step 6: Commit**

```bash
git add app/api
git commit -m "fix(arc): route handlers spend on the configured network only"
```

---

### Task 9: Configuration and documentation

**Files:**
- Modify: `.env.example`
- Modify: `docs/deployments.md`
- Modify: `hardhat.config.ts:35-56`
- Modify: `package.json` (mainnet deploy scripts)

**Interfaces:**
- Consumes: everything above.
- Produces: no code interfaces. This task makes the switch discoverable.

- [ ] **Step 1: Document the switch in `.env.example`**

Replace the `ARC_TESTNET_CHAIN_ID` / `ARC_TESTNET_EXPLORER_URL` /
`ARC_TESTNET_USDC_ADDRESS` block with:

```bash
# ── Which Arc network this deployment is on ──────────────────────────────────
# The ONLY switch. `mainnet` selects Arc mainnet (5042); anything else — unset,
# misspelled, capitalised — selects Arc Testnet (5042002), so a new environment
# can never silently spend real money it was not configured for. Same exact-match
# rule and same fail-toward-safety default as WALLET_PROVIDER.
#
# NEXT_PUBLIC_ because the browser needs it too (lib/wagmi.ts, app/PrivyShell.tsx),
# and NEXT_PUBLIC_* is inlined at BUILD time — changing it needs a redeploy, not
# just a saved variable.
#
# Chain id, RPC, explorer, USDC and the Gateway addresses all follow from this one
# value. They are no longer settable one by one, which is what stopped a mainnet
# deployment reading testnet state when a single variable went missing.
NEXT_PUBLIC_ARC_NETWORK=

# Optional RPC override. The public endpoints rate-limit, and -32011 'request
# limit reached' surfaces as a failed contract READ — it looks like a broken call
# rather than a quota. The server-only variable wins, so a keyed URL need not be
# published into the browser bundle.
ARC_RPC_URL=
NEXT_PUBLIC_ARC_RPC_URL=
```

Delete `ARC_TESTNET_CHAIN_ID`, `ARC_TESTNET_EXPLORER_URL` and
`ARC_TESTNET_USDC_ADDRESS`. Rename `ARC_TESTNET_RPC_URL` to `ARC_RPC_URL`.

- [ ] **Step 2: Note that ERC-8004 and AgenticCommerce are off until set**

In `.env.example`, under the ERC-8004 block, replace the "Optional: Override Arc
Testnet's pre-deployed ERC-8004 registries" comment with:

```bash
# ERC-8004 registries. UNSET MEANS REPUTATION IS OFF — it no longer falls back to
# Arc Testnet's predeploys, which on mainnet are addresses with no code. Circle
# has not deployed these to Arc mainnet yet; when they do, set both and the
# feature turns on with no code change (isReputationConfigured(), lib/erc8004.ts).
ERC8004_IDENTITY_REGISTRY=
ERC8004_REPUTATION_REGISTRY=

# The ERC-8183 job market, same rule (isJobsConfigured(), lib/erc8183.ts:24).
# Unset means autopay runs with no job market — never "settle without the job".
# NEXT_PUBLIC_, so setting it needs a redeploy.
NEXT_PUBLIC_AGENTIC_COMMERCE_ADDRESS=
```

- [ ] **Step 3: Add the mainnet network to hardhat**

In `hardhat.config.ts`, add beside `arcTestnet`:

```ts
    arcMainnet: {
      type: "http",
      chainType: "l1",
      url: configVariable("ARC_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
```

and add a mainnet entry to `chainDescriptors`:

```ts
    5042: {
      name: "Arc",
      blockExplorers: {
        blockscout: {
          name: "Arc Explorer",
          url: "https://explorer.arc.io",
          apiUrl: "https://explorer.arc.io/api",
        },
      },
    },
```

**Flag for the reviewer, do not silently assume:** `explorer.arc.io` answers 200
but sits behind a Cloudflare bot challenge, so its API could not be confirmed as
Blockscout from a server. If `hardhat verify` fails against it, that is open
question 3 in the spec, not a mistake in this task.

- [ ] **Step 4: Add mainnet deploy scripts**

In `package.json`, beside each `deploy:arc:*` script, add a mainnet twin that
differs only in `--network arcMainnet`:

```json
"deploy:arc-mainnet:bill-registry": "node --env-file=.env.local ./node_modules/hardhat/dist/src/cli.js run --network arcMainnet scripts/deploy-bill-split-registry.ts",
"deploy:arc-mainnet:factory": "node --env-file=.env.local ./node_modules/hardhat/dist/src/cli.js run --network arcMainnet scripts/deploy-recurring-tab-factory.ts",
"deploy:arc-mainnet:autopay-mandate": "node --env-file=.env.local ./node_modules/hardhat/dist/src/cli.js run --network arcMainnet scripts/deploy-autopay-mandate.ts",
"deploy:arc-mainnet:handle-escrow": "node --env-file=.env.local ./node_modules/hardhat/dist/src/cli.js run --network arcMainnet scripts/deploy-handle-escrow.ts"
```

The four `scripts/deploy-*.ts` files read `ARC_TESTNET_USDC_ADDRESS` and pin
`network: "arcTestnet"` internally. Update each to read `ARC_USDC_ADDRESS` and to
take its network from the Hardhat runtime rather than a literal.

- [ ] **Step 5: Update the deployments doc**

In `docs/deployments.md`, replace the two-column "Which is which" table with three
columns — `splitsy.xyz (Production, mainnet)`, `testnet.splitsy.xyz (Preview,
testnet)`, and a row for `NEXT_PUBLIC_ARC_NETWORK`. Record:

- the branch domain arrangement and the `git push origin main:testnet` sync
- that Vercel crons run on Production only, so the testnet host never fires
  `/api/recurring/settle` or `/api/agents/dunning`
- that Deployment Protection must be off for the branch domain
- that `privy.splitsy.xyz` is retired

Keep the existing warning about Supabase variables being scoped to Preview
verbatim — it is still the sharpest failure in the document.

- [ ] **Step 6: Verify the testnet default is genuinely unchanged**

With no `NEXT_PUBLIC_ARC_NETWORK` set anywhere:

```bash
npm run build
```

Expected: a clean build that is byte-for-byte a testnet deployment. This is the
proof that Step 2 of the migration can ship to `testnet.splitsy.xyz` and change
nothing observable.

- [ ] **Step 7: Commit**

```bash
git add .env.example docs/deployments.md hardhat.config.ts package.json scripts
git commit -m "docs(arc): one switch, two networks, and the console half of both"
```

---

## Acceptance

The plan is done when all of these hold:

1. This grep returns nothing:

```bash
grep -rnE '\?\? *"https://rpc\.testnet|\?\? *"https://testnet\.arcscan|ARC_TESTNET_USDC_ADDRESS *\?\?|\?\? *"0x8004' --include="*.ts" --include="*.tsx" app lib
```

2. `npx tsc --noEmit` and `npm run lint` are clean.
3. Every `test:*` script passes.
4. `npm run build` with no `NEXT_PUBLIC_ARC_NETWORK` produces a testnet build.
5. Deployed to `testnet.splitsy.xyz`, the app behaves exactly as it did before
   this work — same wallets, same balances, same explorer links.

Point 5 is the one that matters. This plan's entire purpose is to be a change
that does nothing visible on testnet and makes mainnet possible.

## Out of scope

Named here so nobody adds them mid-task:

- Bridge **source** chains stay on testnet (`baseSepolia`, `sepolia`,
  `arbitrumSepolia`, `optimismSepolia`, `avalancheFuji`, `polygonAmoy` in
  `lib/wagmi.ts` and `lib/gateway-contracts.ts`). Mainnet bridge sources are their
  own change.
- Renaming `ARC_TESTNET_*` inside `scripts/` beyond what Task 7 Step 4 requires to
  compile. 13 of 19 script files carry the identifiers; they run by hand against
  an explicit `--env-file` and are not a deployment hazard.
- Deploying contracts to mainnet, the new Supabase project, the Privy mainnet
  policy, and the apex env flip. Those are steps 3 and 4 of the spec.
- `X-Robots-Tag: noindex` on non-canonical hosts — folded into step 1 of the
  migration, not this plan.

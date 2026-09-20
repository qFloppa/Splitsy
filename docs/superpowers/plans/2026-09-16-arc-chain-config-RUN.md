# Run prompt — Arc chain config

Paste the block below into a fresh chat in this repo.

---

Implement the Arc chain config plan in this repo.

Plan: docs/superpowers/plans/2026-09-16-arc-chain-config.md
Spec: docs/superpowers/specs/2026-09-16-arc-mainnet-migration-design.md

Read AGENTS.md first — this is not the Next.js you know, so check
node_modules/next/dist/docs/ before writing any Next code.

Use the superpowers:subagent-driven-development skill to work through the
plan task by task. Nine tasks, in order — Task 1 creates the module every
later task imports.

What this change is: every Arc chain value — chain id, RPC, explorer, USDC,
Gateway addresses — currently comes from 24 call sites that each read an
`ARC_TESTNET_*` variable and fall back to a testnet value. A mainnet
deployment missing one variable therefore does not crash; it reads testnet
state and renders it as real money. This collapses all of it into
`lib/arc-chain.ts` behind one switch, `NEXT_PUBLIC_ARC_NETWORK`.

Things the plan says that are easy to get wrong, so hold onto them:

- **With `NEXT_PUBLIC_ARC_NETWORK` unset, this change must do NOTHING
  observable.** Same wallets, same balances, same explorer links. It ships to
  testnet.splitsy.xyz first precisely to prove that. If a task starts changing
  testnet behaviour, stop and say so rather than working around it.
- `lib/wagmi.test.ts` is a SOURCE-level test — it greps every file for
  `getWalletClient` calls naming Arc's chain id. Widen its regex in Task 4
  Step 1 before renaming anything, or it silently stops guarding the bug it
  exists for.
- Task 7 changes an EIP-712 domain the deployed HandleEscrow checks. That is
  correct and intended — a mainnet release must be signed with chain id 5042 —
  but read the task note before touching it.
- Task 6 changes behaviour, not just wiring: unset ERC-8004 registries stop
  meaning "use the testnet ones" and start meaning "reputation is off". Copy
  the shape of `isJobsConfigured()` in lib/erc8183.ts:24, which already does
  this correctly for AgenticCommerce.
- Read the four Gateway addresses from `ARC_PROFILES`, never retype them.
  Two of them differ between networks and they are the ones that move money.
- `NEXT_PUBLIC_*` must be referenced as a literal `process.env.NEXT_PUBLIC_X`,
  never `env[key]`. Next inlines these textually at build time; a dynamic read
  is `undefined` in the browser.

Acceptance: `npx tsc --noEmit` clean, `npm run lint` clean, every `test:*`
script passing, a clean `npm run build` with the switch unset, and this grep —
the one that found the 24 sites — returning nothing:

    grep -rnE '\?\? *"https://rpc\.testnet|\?\? *"https://testnet\.arcscan|ARC_TESTNET_USDC_ADDRESS *\?\?|\?\? *"0x8004' --include="*.ts" --include="*.tsx" app lib

Out of scope, do not drift into it: bridge source chains stay on testnet; no
contract deploys; no new Supabase project; no Privy policy changes; no apex
env flip. Those are steps 3 and 4 of the spec, not this plan.

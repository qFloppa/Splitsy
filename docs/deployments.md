# Deployments

One repo, two wallet stacks. `WALLET_PROVIDER` is the only switch, and `circle`
is the default in `walletProviderName()` (`lib/wallet-provider.ts:52`) — the match
is exact, so a typo, a capitalised value or an unset variable in a new
environment all land on the Circle stack rather than the newer one.

`WALLET_UI` is a **second, independent** switch with the same exact-match rule and
the same OFF default (`walletUiName()`). `WALLET_PROVIDER` decides who holds the
wallet; `WALLET_UI` decides who asks the user to approve a payment. Set to
`privy`, Privy's own modal is the login door and its confirmation prompt stands in
front of every transaction, spending from a Privy **embedded** wallet the user
owns from creation. It only makes sense on top of `WALLET_PROVIDER=privy` — an
embedded wallet is a Privy wallet — and the two are kept apart so the popup can be
compared against the app's own screens and turned off again without touching
anybody's custody.

The Preview column below describes the arrangement this branch is meant to run
under. The console half of it — the branch domain, the four OAuth/Turnstile
callback registrations and the environment variables — is done by hand; nothing in
this repo asserts it is in place.

---

## Which is which

| | splitsy.xyz (Production) | privy.splitsy.xyz (Preview) |
|---|---|---|
| Branch | `main` | `privy-wallet-stack` |
| `WALLET_PROVIDER` | unset → `circle` | `privy` |
| `WALLET_UI` | unset → the app's own screens | `privy` (opt in per deploy) |
| `WALLET_CLAIM_ENABLED` | unset → off | unset → off (opt in per deploy) |
| Wallets | Circle DCW, SCA | Privy embedded, EOA |
| Network | Arc Testnet (5042002) | Arc Testnet (5042002) |
| Database | `mhm233's Project` | `splitsy-test` (`hdyioojrozodmutpldsu`) |
| Autopay money-mode default | `mandate` | `funded` |
| Agent spend cap | `decideAutopay` only | `decideAutopay` + a Privy enclave policy |
| Settle net | works | **refused, 503** |
| Arming an on-chain mandate | works | **throws** |
| Mandate address env | whatever Production holds | **must not inherit it** |
| Circle env vars | set | absent |
| Banner | none | "Privy stack — Arc Testnet" |

That money-mode row is the server's answer for a save that does not name a mode
(`defaultMoneyMode()`, `lib/autopay.ts:175`), not what accounts are on. The
settings panel sends `funded` on every save on both stacks
(`app/SettlementAgentsPanel.tsx:418`) because it is the only mode it knows how to
describe, and the PUT keeps `funded` when asked for it and falls back to the
default otherwise (`app/api/agents/grants/route.ts:232`). `splitsy-test`'s column
default is `'funded'` and no row in it is on `'mandate'`.

`CIRCLE_WEBHOOKS_ENABLED` is one of the Circle variables that must stay absent on
Preview, and it is absent for a reason of its own rather than as tidiness. Unset,
`app/api/debts/[id]/pay/route.ts:132` marks a debt paid on the spot, and on this
stack the id it stores IS the chain hash (`lib/privy-wallet.ts:105`), so
`paid_tx_hash` holds something an explorer resolves. Set it, and — with no Circle
webhook coming to confirm a Privy transfer — nothing would report a debt paid at
the moment it settles: the row would sit in `settling` until the debtor pressed Pay
again, which is when that route re-reads the stored hash and finishes the job
(`:42-69`). A self-heal on the next press is not a confirmation, so leave it unset.

---

## What `WALLET_UI=privy` changes

Set it and the login door, the pay wallet and the confirmation all move to Privy.
Nine things follow, and none of them are reversible for a user who has already
signed in through it — they will have a **new wallet at a new address**.

**Privy owns login.** The header's four OAuth links collapse into one button that
opens Privy's modal (`app/SignInMenu.tsx`), configured with exactly X, Discord,
Google and email. `POST /api/auth/privy` verifies the access token server-side,
maps the Privy user onto the `users` row that person already has, and sets the
ordinary Splitsy session cookie — so the ~40 route handlers calling
`getSessionUser()` are untouched, and so are logout, the PIN unlock and the
wallet-proof cookie. The app's own OAuth routes still work and are still what the
Circle stack uses; nothing was deleted.

**The mapping is per provider, and getting it wrong forks an account silently.**
`lib/privy-identity.ts` keys X and Discord on Privy's `subject`, and Google *and*
email-OTP both on the lowercased email address — which is what makes "sign in with
Google" and "email me a code" one account, exactly as
`app/api/auth/google/callback/route.ts:138` already does. It looks the row up by
provider id first and by **handle** second, so a Privy `subject` that turns out not
to be the id X's own API returned still lands on the existing row rather than
creating a second one. That second lookup is why no manual id comparison is needed
before turning this on.

**Existing accounts keep everything except their wallet address.** The row, the
handle, the debts, the bills and the reputation all stay; the pay wallet becomes a
fresh Privy embedded one at a new address. The old wallet is **abandoned — not
swept and not imported**, because a claimed wallet's key is one Splitsy cannot
export by design. Anything already on chain against the old address stays pointed
at it. Acceptable on testnet and **not** acceptable on mainnet.

**Every payment shows a prompt.** `walletPost` (`app/signed-send.ts`) takes a third
branch: the server prepares the transaction exactly as it already did, Privy's
modal asks the user, and the server broadcasts what comes back. A bill payment is
approve-then-pay, so it shows **two** prompts — two transactions really are being
signed.

**The server verifies the bytes, not just the signer.** On this path the client
produces the signed transaction, so `lib/privy-wallet.ts:matchesPrepared` compares
it against the ticket's transaction before broadcasting. Without that, a user
could sign anything at all from their own wallet and have a route mark a debt paid.

**Pregenerated wallets replace the holding-wallet sweep.** Tagging a handle that
has never signed in creates a Privy user keyed `custom_auth: "x:alice"` with an
embedded wallet inside it (`lib/wallet-resolve.ts`). That wallet does **not**
join Alice's account when she signs in: Privy does not merge a `custom_auth`
account with a later email or social login, and the SDK has no link method — see
"The handle escrow" below, and `lib/privy-wallet.ts` `pregenerateWallet` for the
measurement. The settle rail escrows against the handle instead, so a stranger's
IOU no longer lands in one of these; the bill rails still mint them. Privy caps
user creation at **240/minute**.

**The setup ceremony and the export tab disappear.** Both are Splitsy's own
machinery for a wallet Splitsy minted, and there is no such wallet here. The
password/passkey route still exists and still works with `WALLET_UI` unset.

**The CSP had to change.** `frame-src` now allows `https://auth.privy.io` — the
embedded wallet lives in a cross-origin iframe this page cannot read, which is the
point of it — and `PrivyProvider` is handed the same per-request nonce the inline
theme script uses (`proxy.ts`, `app/PrivyShell.tsx`). Without either, login stalls
with nothing on screen to say why.

**Privy's SDK is only fetched where it is used.** `app/PrivyShell.tsx` is a
`next/dynamic` leaf beside the app rather than a provider around it, which works
because signing, login and logout all travel through the module-scoped spot in
`app/privy-signer.ts`. On the Circle stack the chunk is never requested.

---

## The banner

`NEXT_PUBLIC_STACK_LABEL` is the whole mechanism (`app/layout.tsx`): a non-empty
value renders a row naming the stack, anything else renders nothing. Production
leaves it unset, so forgetting it produces an unlabelled preview rather than a
mislabelled live site.

What `NEXT_PUBLIC_*` inlining actually does here, measured against a build rather
than assumed. The bundled guide
(`node_modules/next/dist/docs/01-app/02-guides/environment-variables.md`) says
these are inlined at build time, "replacing all references to
`process.env.[variable]` with a hard-coded value", and frozen thereafter. That is
what happens when the variable **is** set at build time: the compiled server
chunk for `lib/supabase.ts` carries its Supabase URL as a literal and no longer
mentions `NEXT_PUBLIC_SUPABASE_URL` at all. When it is **not** set, the reference
survives verbatim — the root layout's SSR chunk still contains
`process.env.NEXT_PUBLIC_STACK_LABEL ? … : null` and evaluates it per request,
which it can because the layout renders dynamically.

Two consequences worth stating separately, because conflating them invents a
safety property that does not exist. A **set** value is frozen into the build that
saw it, so changing one needs a redeploy. An **unset** one leaves a live
`process.env` read behind, so the age of a build is **not** what keeps a banner
off — only the variable's absence from that environment is. "We never rebuilt
Production" is not a defence against a mis-scoped label.

---

## The Privy stack is not the Circle stack minus Circle

Four differences no variable papers over. Three of them are one fact: a Privy
wallet is an **EOA** where a Circle DCW is a smart contract account.

**Settle net is unavailable.** `app/api/treasury/settle/route.ts:63` refuses with
503 when `WALLET_PROVIDER=privy`. The route is one `executeBatch` sent to the
wallet's own address, which only an SCA can execute — and an EOA does not revert
on calldata it cannot run, it **succeeds and does nothing**. Measured, not
reasoned: tx `0x5870092926417f148363962be768594b7e555bfd7d7f6e8d82f1547b00dadf95`
(block 60147923) carried 324 bytes of `executeBatch` calldata to a Privy wallet's
own address and came back `status: 0x1`, `gasUsed: 25290` — base cost plus
calldata, zero execution — `logs: []`, with `eth_getCode` on the target `0x`.
Before the refusal the route answered `{ok: true, paid: […]}` naming every leg as
settled and queued ERC-8004 payment feedback for debts nobody paid.

**Arming an on-chain mandate throws.** `app/api/agents/grants/route.ts:363`, for
the same reason — `approve` + `setMandate` are sent as one `executeBatch`.
Revoking still works, because revoking is a single call. It is unreachable twice
over today: `NEXT_PUBLIC_AUTOPAY_MANDATE_ADDRESS` is unset, so
`isMandateConfigured()` is false and `:312` returns first, and the mode is always
`funded` here, so the PUT hands the sync `enabled: false` and the revoke branch
returns before the throw. The throw is there for the deployment that changes one
of those.

**The agent wallet's cap is enforced inside Privy's enclave, per transaction.**
The policy in `PRIVY_AGENT_POLICY_ID` is attached to the signer at wallet
**creation** (`lib/privy-wallet.ts:565`), so it applies from the agent's first
signature and cannot be argued with by a bug in `decideAutopay`. It caps a
**single transaction** only. A rolling daily total is expressible in Privy's API —
an Aggregation over a rolling window, 1-72 hours, function `sum` — but
`@privy-io/node@0.34.0` ships `Aggregations` as an empty class
(`resources/aggregations.d.mts:4`), so there is no method to create one. The daily
cap therefore remains `sumAutopaySpentTodayUsdc` (`lib/agents-repo.ts:343`) on
both stacks, enforced off chain.

**`privy_wallets` exists only in `splitsy-test`.** The Circle stack never reads
it: `lib/privy-wallet.ts` is the only importer of `lib/privy-wallets-repo.ts`, and
it is lazy-imported by `backend()` (`lib/wallet-provider.ts:65`) only when the
provider is `privy`.

---

## Before the first sign-in on Preview

**The three Supabase variables must be SCOPED to Preview and point at
`hdyioojrozodmutpldsu`.** A variable set for All Environments is inherited by
Preview, so leaving `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
and `SUPABASE_SERVICE_ROLE_KEY` unscoped points this stack at the live project —
what "Never point the two at one database" below forbids — and nothing in the
code detects it. Check the values, not their presence.

Neither half of that failure announces itself. `lib/oauth-callback.ts:91`
provisions only when `wallet_address` is null, so a live user signing in here is
shown the **Circle** wallet their row already holds and no Privy wallet is ever
minted; and `privy_wallets` exists only where Task 6 Step 1's schema files were
run, so on any other project `getPrivyWallet` throws
(`lib/privy-wallets-repo.ts:25`) into the best-effort catch at `:103` and the
login completes with no wallet at all. One is silent, the other is a log line
nobody is reading.

`NEXT_PUBLIC_SUPABASE_URL` is inlined at build time (see "The banner" above), so
correcting it needs a **redeploy**, not just a saved variable.

**`WALLET_CLAIM_ENABLED=true` hands pay wallets to their users, and it cannot be
taken back.** Unset is OFF, and only the exact string `true` turns it on
(`claimEnabled()`, `lib/wallet-gate.ts:38`). It is **irrelevant when
`WALLET_UI=privy`** — an embedded wallet is already the user's and has nothing to
claim — so what follows is about the app's own wallets. A claim moves ownership to
the user's password-derived key and
revokes our `additional_signer` in one `wallets().update()`, after which Privy
answers 401 to anything Splitsy sends — measured in
`scripts/privy-claim-probe.ts`: 401 on `signTransaction`, 401 on `_export`, 0
signers left. There is no recovery path for anyone, including Privy, and a user
who forgets the password loses the wallet.

**Off by default, and it must stay off until the routes are migrated.** A claimed
wallet can send from the wallet panel (`app/api/wallet/send` signs in the browser)
and little else: `debts/[id]/pay`, the `onchain-bills/*` paths, `recurring/*` and
`treasury/settle` all still ask the server to sign and now get a refusal they
cannot recover from. They fail cleanly — `NotOurWalletError`, nothing moves — but
they fail. Turning this on before that work lands gives users a wallet that does
less than the one they started with, permanently.

The agent wallet is deliberately unaffected: it keeps our quorum as owner and
signer, which is what lets autopay run while the user is away, and it is the one
wallet this feature does not touch.

**`PRIVY_AGENT_POLICY_ID` must be set in Preview before any user signs in.** The
policy attaches at wallet creation and nowhere else; the adopt path reads an
existing wallet's signers only to confirm our key quorum can sign, never to see
what policies that signer carries, and no code detects a wallet that lacks one.
An agent wallet minted before the variable is set is uncapped **forever** —
bounded only by `decideAutopay`, which is our own code — and nothing surfaces it.
The id is produced by `npm run privy:policy -- <per-transaction cap in USDC>`,
which prints it; each run creates a new policy and edits nothing.

**Rotating `PRIVY_KEY_QUORUM_ID` is a per-wallet migration, not a variable
change — and for any wallet with export enabled it is impossible.** Nothing in
the code detects a rotation, and it breaks two things independently:

- **Signing, for every existing wallet.** The quorum is written into
  `additional_signers` at creation (`lib/privy-wallet.ts:583`), so a new quorum is
  not a signer on any wallet already minted. The break lands the moment
  `PRIVY_AUTHORIZATION_PRIVATE_KEY` moves to the new quorum's key — that key
  authorizes nothing on an existing wallet, and every send, pay-link claim and
  autopay run fails at `signTransaction`. This is the larger half and has nothing
  to do with export.
- **Export state.** `resolveState` (`app/api/wallet/export/route.ts:169`) compares
  Privy's `owner_id` against the environment value, so a rotated value makes
  every not-yet-enabled wallet read as `needs_restore`. Nothing false is
  recorded — restore proves an export before it writes the key (`76b912a`) — but
  each user is offered a restore they can never complete.

What is repairable splits on who owns the wallet. While **we** are still the
owner, `wallets().update()` accepts `additional_signers` and `policy_ids`
(`node_modules/@privy-io/node/resources/wallets/wallets.d.ts:4869`), so a
re-signer pass is at least expressible — one call per wallet, **unmeasured, and
worth a throwaway probe before anyone plans a rotation around it.** Once a user
has taken ownership (`privy_wallets.export_owner_key` non-null) that door is
shut: `update()` is owner-gated, and the spike measured exactly this as a 401
when our quorum was only an additional signer (design doc §"Spike results"). Those
wallets are pinned to the retired quorum **permanently**.

So: **keep a retired quorum's authorization key for as long as any wallet
references it.** Deleting it ends server-side spending for every wallet whose
owner is now a user, with no recovery. No allowlist of previously-held quorum ids
is built — it would paper over the export half and do nothing for the signing
half, which is the one that takes the product down.

The same SDK fact puts a question mark on "uncapped **forever**" above: if
`additional_signers` is genuinely updatable for a wallet we own, an agent wallet
minted before `PRIVY_AGENT_POLICY_ID` was set may be fixable after all. Also
unmeasured. Both claims need one probe wallet, not a design.

**Set the cap above the largest per-bill cap a user can save.** The enclave
refuses at step 4 of the six-step settlement ceremony, *after* the job fee is
escrowed at step 3, so a cap set too low burns 0.01 USDC plus gas on every bill
the user's own rules allow, on a job that then sits until its one-hour TTL
expires.

---

## Shared contracts

Both stacks read and write the same deployed Arc Testnet contracts —
BillSplitRegistry, RecurringTabFactory and the ERC-8004 registries. That is
deliberate: no redeploy is needed while both are on testnet. It does mean preview
activity lands on the contracts the live site reads. Live users never see it,
because each stack resolves bills by its own wallet addresses out of its own
database.

Arc mainnet is not live for either stack: see
`docs/superpowers/specs/2026-09-01-privy-wallet-stack-design.md` "Deliberately
deferred". Handing `splitsy.xyz` to the Privy stack is Task 8 of
`docs/superpowers/plans/2026-09-01-privy-wallet-stack.md` and has not happened.

---

## The handle escrow

`HandleEscrow` is another shared contract, deployed by
`npm run deploy:arc:handle-escrow`. It holds USDC for someone who has no wallet
yet. Both settle rails deposit into it when the recipient has never signed in,
and the first sign-in as that handle releases the money to the wallet they
actually sign in with. The design, including what it deliberately does not fix,
is `docs/superpowers/specs/2026-09-13-handle-escrow-design.md`.

**Deployed on Arc Testnet, 2026-09-14:**

```
HandleEscrow  0x9820f2889710a2a5190187993c31ff1d4f15efa5
attester      0xEE42a492B183CdFf04439F2Cb6A9c49F857F70AC   immutable
usdc          0x3600000000000000000000000000000000000000   immutable
```

**Source verified on Arcscan, 2026-09-15** —
https://testnet.arcscan.app/address/0x9820f2889710a2a5190187993c31ff1d4f15efa5
— a full match against `v0.8.36+commit.8a079791`, `cancun`, optimizer **off**,
which is the `default` solidity profile in `hardhat.config.ts` rather than
`production`. That is what `npm run deploy:arc:handle-escrow` uses, since it
passes no `--build-profile`; verifying against `production` would not have
matched. Arcscan is Blockscout and wants no API key, but Arc is not in
hardhat-verify's built-in chain list, so the explorer is named by the
`chainDescriptors` entry for 5042002 in `hardhat.config.ts`. Re-run for any
contract with:

```bash
node --env-file=.env.local ./node_modules/hardhat/dist/src/cli.js verify \
  --network arcTestnet <address> <constructor args…>
```

Verification fell back to the **full solc input** — the minimal one was
rejected — so the explorer also lists the test and mock contracts from the same
compilation unit (`HandleEscrow.t.sol`, `MockUSDC.sol`, `Test.sol`). Cosmetic;
the match is still full, and the constructor arguments read back as the usdc and
attester addresses above, in that order.

Verified at deploy time: both EIP-712 hashes recomputed from
`lib/handle-escrow.ts` match the contract (`RELEASE_TYPEHASH` `0xf49662…71a5c`,
`DOMAIN_SEPARATOR` `0x307213…4e135`), and a deposit→release and a
deposit→reclaim both settled on chain. **Deposit ids 1 and 2 belong to that
smoke test**, and **ids 3 and 4 to the relay probe** of 2026-09-15 that ran a
real release through `releaseEscrowForHandle` on each stack. None of the four
has an `escrow_deposits` row, which is correct — nothing indexed them.
`nextDepositId` is 5.

On this deployment the attester key is also the deployer key. That is against
the plan's advice (it should be a fresh key holding nothing) and was a deliberate
call for a testnet run: if the key leaks, the deployer's balance goes with it.
Changing the attester means redeploying — there is no setter.

**Three variables, and only one of them is a client value.**
`NEXT_PUBLIC_HANDLE_ESCROW_ADDRESS` is the deployed escrow both settle rails
name: the server rail, which spends the signed-in user's USDC and writes its own
index row (`app/api/escrow/deposit`, singular), and the browser-wallet rail,
which deposits without the server's help and then asks
`app/api/escrow/deposits` (plural) to record it. Unset means
REFUSE, never "escrow somewhere else": `isHandleEscrowConfigured()`
(`lib/arc-read.ts:496` server-side, `lib/bill-split-contracts.ts:990` in the
browser) is checked before either rail spends anything.
`ESCROW_ATTESTER_ADDRESS` is read only by the deploy script
(`scripts/deploy-handle-escrow.ts:4`), which refuses to deploy without it — the
attester cannot be corrected later, so a wrong one here is a contract that can
never release anything. The script prints the address to copy into
`NEXT_PUBLIC_HANDLE_ESCROW_ADDRESS`.
`ESCROW_ATTESTER_PRIVATE_KEY` is used in process by `lib/escrow-release.ts:88`
to sign an EIP-712 `Release(id, to, deadline)` and is then dropped — it never
has to be a transaction sender, which is the point of the permissionless
`release` entry point.

**The attester is immutable in the deployed contract.** There is no setter and
no owner (`contracts/HandleEscrow.sol:88-90`). Rotating the key is not a
variable change: it needs a redeploy, and until then any deposit already held
is releasable only by the old key. If the key is compromised, the recovery path
is that depositors take their money back with `reclaim` — unconditional,
available any time before a release, callable only by the depositor — and the
contract is redeployed under a new attester. That only works because reclaim is
unconditional; the two decisions hold each other up.

**The releaser wallet needs USDC, and not for the amount being released.**
Releases are relayed by `getOrCreateWallet("splitsy", "escrow-releaser")`
(`lib/escrow-release.ts`), and Arc charges gas in USDC. If it runs dry,
releases stall **silently**: deposits stay safe and reclaimable, the login still
succeeds, and money simply stops arriving — nothing surfaces an error to the
user.

**Each stack has its OWN releaser** — same namespace and key, different backend,
different address. Funding the wrong one is indistinguishable from funding none,
so both were funded with 5 USDC on 2026-09-15, from the deployer rather than the
faucet:

```
privy    0xc910B8E376d19e653e7096913c1EBbe238086191   5 USDC   walletId k88pecv1wzywd2l9waxjolpp
circle   0xdbcd0e96649257eb224bcd6954d49069624f70ac   5 USDC
```

**How much a release actually costs, measured on 2026-09-15 rather than
assumed.** One real release through `releaseEscrowForHandle` on each stack: the
Privy releaser went 5000000 → 4998596 units (**0.001404 USDC**), and the Circle
releaser went 5000000 → 5000000 (**nothing**). A Privy wallet is an EOA and pays
its own gas; Circle's gas station covers the SCA's. So at this rate 5 USDC is on
the order of three thousand releases on Privy and does not deplete at all on
Circle — but that is one transaction, not a guarantee, and no code detects the
difference, so keep both funded. The failure it would otherwise cause is the
silent one described above.

To look one up later:

- **Privy stack** — its address is a row in `privy_wallets` (`namespace =
  'splitsy'`, `key = 'escrow-releaser'`).
- **Circle stack** — keyed by `refId = "splitsy:escrow-releaser"`
  (`lib/circle-dcw.ts:208`).

Top it up the way the other server wallets are funded — an ERC-20 `transfer`
from the deployer, or https://faucet.circle.com. Two log lines mean "the money
did not move, and the login still succeeded" — both are non-fatal by design,
because a release runs inside a login and must cost the user nothing:

```
Escrow release for <provider>:<handle> failed for deposit <id> (login continues):
Escrow release pass for <provider>:<handle> failed (login continues, user <id>):
```

**A reclaimed deposit's index row stays `status = 'open'` forever.** The table's
check constraint has only `open` and `released` (`schema-escrow-deposits.sql:24`)
and nothing watches for `Reclaimed`, so a deposit its sender has taken back
still looks open to `getOpenDeposits` and every later sign-in retries it. The
retry costs a chain read and no gas: the relay asks the escrow what it holds
before it submits anything (`lib/escrow-release.ts`), and a deposit that reads
zero is refused there rather than sent to revert on chain — Arc charges gas in
USDC for a revert, so the releaser would otherwise pay for that same refusal at
every sign-in of that handle, forever. The refusal lands as the first log line
above. That is the design working, not breakage: the row is an index of what is
worth trying, never an authority on whether money may move, and the contract is
the authority. Do not read the table as tracking reclaims — it does not.

**`NEXT_PUBLIC_HANDLE_ESCROW_ADDRESS` is inlined at build time, and the two rails
must agree on it.** As with the banner above, a value present at build is
hard-coded into both the browser bundle and the server chunk, so within one build
they cannot disagree — and a saved variable with no rebuild changes **neither**
side. Two ways the disagreement the recording route guards against still happens:

- **A client running an older build.** A tab left open across a redeploy, or a
  cached chunk, still names the escrow its own build saw. The deposit lands
  there, and the current server records only its own escrow and answers
  `{ "error": "That isn't this deployment's escrow." }`
  (`app/api/escrow/deposits/route.ts:54`), so the money sits on chain with no
  index row — reclaimable by its sender and by nobody else.
- **The variable unset at build time.** Then the reference survives in the server
  chunk as a live read while the browser is frozen on the zero address, so the
  browser rail refuses every escrow (`isHandleEscrowConfigured()` is false there)
  while the server considers itself configured. Setting the variable afterwards
  does nothing in the browser, so the rails stay split until a rebuild.

**Set it before the build and redeploy to change it.** Same rule, same reason, as
the banner section above.

**What is still broken after this plan.** Bills and recurring tabs still bind a
stranger's share to a pre-minted address (`pregenerateWallet`,
`defaultMintPending`, `pending_wallets`), so when that person signs in with a
different wallet the chain still reads them as not a participant — the answer is
literally "You're not a participant on this bill."
(`app/api/onchain-bills/[billId]/pay/route.ts:54`). No money is stranded there,
and it is not repairable after creation: participants are set only in
`createBill`, and `participantList` is written once and never edited
(`contracts/BillSplitRegistry.sol:340`, read back at `:666`). Fixing it is §3 of
the design doc, and §3 is blocked on an unanswered product decision — whether an
on-chain bill's `totalOwed` excludes the stranger's share, or on-chain creation
waits until every participant has a wallet. Until that is answered, the bill rail
behaves exactly as it did before this plan.

**The 3.11 USDC already stranded is unrecoverable.** It sits in three
user-owned wallets the server gets 401 on for every signing path, and the Privy
Node SDK has no method to link them to the accounts their owners actually sign in
with. Testnet; re-send after the fix.

---

## Never point the two at one database

`users.circle_wallet_id` holds an opaque provider id and one row cannot name a
wallet in both systems. Sharing the database would also put this stack's writes
in front of live users, which is the one outcome the whole arrangement exists to
prevent.

---

## Open question: Settle net on an EOA

Making net settlement work on the Privy stack needs a decision nobody has taken.
Two candidates, neither costless:

- **Two sequential transactions** — `approve`, then `settle`. Atomicity is what
  the feature is for (`docs/treasury.md`), and this gives it up: a failure
  between the two leaves an approval standing with nothing settled.
- **An `approve` + `settle` entry point on the registry** — atomic again, but it
  is a contract change and a redeploy, and both stacks go on reading the current
  registry until each is pointed at the new one.

Until one is chosen, the 503 is the answer, and it is the honest one: the
alternative was a success response for money that never moved.

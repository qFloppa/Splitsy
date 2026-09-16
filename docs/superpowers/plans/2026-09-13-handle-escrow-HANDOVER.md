# HandleEscrow — the step that needs you

Everything else is built, reviewed and green. **Only Step 4 is left, and it is
the browser one.** Steps 1, 2, 3 and 5 are done and measured.

**Status (2026-09-15, 08:10 UTC):**

- Branch `privy-wallet-stack`, clean. Nothing merged, nothing pushed.
- `escrow_deposits` **exists** in `splitsy-test` (`hdyioojrozodmutpldsu`) —
  eleven columns, RLS on, both indexes. **Step 1 done.**
- **The contract is deployed and proven on chain. Step 2 done.**
- **Both releasers hold 5 USDC. Step 3 done.**
- **The app's own release path has now relayed real money on both stacks.**
  See "What the release path has actually run" below.

```
HandleEscrow  0x9820f2889710a2a5190187993c31ff1d4f15efa5   (Arc Testnet, 5042002)
attester      0xEE42a492B183CdFf04439F2Cb6A9c49F857F70AC   IMMUTABLE
usdc          0x3600000000000000000000000000000000000000   IMMUTABLE
```

What was verified, beyond reading the two values back: both EIP-712 hashes were
recomputed from `lib/handle-escrow.ts` and matched the deployed contract exactly
(`RELEASE_TYPEHASH` `0xf49662…71a5c`, `DOMAIN_SEPARATOR` `0x307213…4e135`), and a
real attester signature recovered to the attester address. Then a 0.01 USDC smoke
test on the live contract: deposit → release worked, deposit → reclaim worked,
a replayed release reverted. Money ended where it started; the cost was gas.

**Ids 1 to 4 are consumed.** 1 and 2 by the deploy-time smoke test, 3 and 4 by
the relay probe below. `nextDepositId` is **5**, so your first Preview deposit
will be id 5. None of the four has an `escrow_deposits` row, which is correct —
nothing indexed them, and nothing should.

**One decision on record:** the attester key is also the deployer key, against
the plan's instruction to use a fresh one. That account holds ~98 USDC, so if
the key leaks, that money goes too — not just the ability to misdirect deposits.
Changing it means redeploying; there is no setter.

---

## What the release path has actually run

The deploy-time smoke test proved the **contract**. It did not prove the app's
release code, because the releaser wallet held no gas until it was funded. That
gap is now closed on both stacks — 2026-09-15, 0.05 USDC per stack, deployer to
escrow and back to deployer:

| | deposit id | release tx | releaser gas |
|---|---|---|---|
| privy | 3 | `0x68bb9ae9…2cc2a8` | **0.001404 USDC** |
| circle | 4 | `0x783496b6…5b608d` | **0 USDC** |

What was real in that run: `releaseEscrowForHandle` itself (its sequencing,
deadline and error containment), `wallet-provider.executeContract`,
`arc-read.getEscrowDepositOnchain`, `handle-escrow.encodeRelease`, the live
contract, and an attester signature the contract accepted. Only the two Supabase
calls — `getOpenDeposits` and `markReleased` — were stubbed, because
`escrow-deposits-repo.ts` imports through `@/lib/…` aliases that resolve only
under Next's bundler. So what Step 4 still tests is the **web** half: the
composer, the deposit routes, the index row and the login tail. The signing and
relaying underneath it have now moved real money.

**The Circle releaser spent nothing.** Measured at raw precision, not rounded:
it held 5000000 units before the release and 5000000 after, while the Privy
releaser went 5000000 → 4998596. Circle's gas station covers the transaction; a
Privy EOA pays its own way. That is one release, not a guarantee — keep the
Circle releaser funded anyway, because nothing in our code detects the
difference and the failure it would cause is the silent one.

---

## ~~Step 1 — the table~~ DONE

## ~~Step 2 — deploy~~ DONE

Kept for the record: the script demands `ESCROW_ATTESTER_ADDRESS` rather than
deriving it from the key, because the attester is immutable once deployed and an
unstated value must not become permanent. Redeploying (new attester, new token,
or a contract change) is `npm run deploy:arc:handle-escrow` with `.env.local`
holding `DEPLOYER_PRIVATE_KEY`, `ARC_TESTNET_RPC_URL`, `ARC_TESTNET_USDC_ADDRESS`,
`ESCROW_ATTESTER_ADDRESS` and `ESCROW_ATTESTER_PRIVATE_KEY`. A redeploy restarts
deposit ids at 1, which is why `escrow_deposits` is keyed by
`(escrow_address, deposit_id)` — old rows stay readable rather than colliding.

---

## ~~Step 3 — Fund the releaser~~ DONE

**This was the step that decided whether the run works.** Arc charges gas in
USDC, so an unfunded releaser fails every release silently: the login still
succeeds, the deposit stays safe and reclaimable, and money simply never
arrives. It looks exactly like "the escrow is broken".

The releaser wallet is `namespace = "splitsy"`, `key = "escrow-releaser"`, and
it is created lazily at the first relay.

**Both stacks' releasers now hold 5 USDC**, sent from the deployer on
2026-09-15 rather than from the faucet, because the deployer key in `.env.local`
already held the money. They are DIFFERENT wallets — same namespace and key,
different backend:

```
privy    0xc910B8E376d19e653e7096913c1EBbe238086191   walletId k88pecv1wzywd2l9waxjolpp
         funded by 0x74075dff8b87b709157fa5f3eb27d766e838aa2442af7e1e80a8120df1ff219a
circle   0xdbcd0e96649257eb224bcd6954d49069624f70ac
         funded by 0x2c9ac28d0f4bec3bb2b4ebaa4a543ac187cffe4942ff139b2ed8ccb9107b7642
```

Both were funded deliberately, rather than only the stack under test, because
funding the wrong one is indistinguishable from funding none. At the measured
burn rate — 0.001404 USDC per release on Privy, 0 on Circle — 5 USDC is on the
order of three thousand releases, so this is not a step anyone should have to
repeat during testing. **Top it up the same way if it ever runs dry:** an ERC-20
`transfer` from the deployer, or https://faucet.circle.com.

Ways to look them up later:

- **Privy stack** — `select address, wallet_id from privy_wallets
   where namespace = 'splitsy' and key = 'escrow-releaser';`
- **Circle stack** — keyed by `refId = "splitsy:escrow-releaser"`
  (`lib/circle-dcw.ts:208`), listable in the Circle console.

Or ask the provider directly — this is the command that produced both addresses,
it creates the wallet if absent, and it answers for whichever stack the
environment selects:

```bash
WALLET_PROVIDER=privy node --experimental-strip-types --env-file=.env.local -e "
import('./lib/wallet-provider.ts').then(async (m) => {
  console.log('stack:', m.walletProviderName());
  console.log(await m.getOrCreateWallet('splitsy', 'escrow-releaser'));
})"
```

Check a balance any time:

```bash
node -e "
const {createPublicClient,http,formatUnits}=require('viem');const {arcTestnet}=require('viem/chains');
const c=createPublicClient({chain:arcTestnet,transport:http('https://rpc.testnet.arc.network')});
const abi=[{name:'balanceOf',type:'function',stateMutability:'view',inputs:[{type:'address'}],outputs:[{type:'uint256'}]}];
const a=process.argv[1];
(async()=>console.log(a, formatUnits(await c.readContract({address:'0x3600000000000000000000000000000000000000',abi,functionName:'balanceOf',args:[a]}),6),'USDC'))()
" 0xc910B8E376d19e653e7096913c1EBbe238086191
```

---

## Step 4 — The end-to-end run on Preview

Everything below is the part no terminal can do: it needs a browser, a login and
the app's own routes. The contract underneath it is already proven (see the
status block at the top) — what this tests is the app path.

### Which stack, and what changes with it

Set these in Preview's environment, then **rebuild** —
`NEXT_PUBLIC_HANDLE_ESCROW_ADDRESS` is inlined into the browser bundle at build
time, so saving a variable without rebuilding changes neither side.

```
NEXT_PUBLIC_HANDLE_ESCROW_ADDRESS=0x9820f2889710a2a5190187993c31ff1d4f15efa5
ESCROW_ATTESTER_ADDRESS=0xEE42a492B183CdFf04439F2Cb6A9c49F857F70AC
ESCROW_ATTESTER_PRIVATE_KEY=0x...          # server-side only, never NEXT_PUBLIC
WALLET_PROVIDER=privy                      # or leave unset for Circle
WALLET_UI=privy                            # only meaningful with the line above
```

Three things differ between the stacks, and all three have caught someone out:

| | Circle | Privy |
|---|---|---|
| Releaser (both funded) | `0xdbcd0e…70ac` | `0xc910B8…6191` |
| Prompts per deposit | none (server signs) | **two** Privy modals — approve, then deposit |
| First-ever login | releases **one sign-in late** | releases on the **first** sign-in |

The Circle delay is not a bug: the release runs before Circle provisioning, so a
brand-new user has no wallet address yet and the pass no-ops. The row stays
`open` and the next sign-in pays it. Privy links the wallet before calling the
login tail, so it lands first time.

**On the Privy stack, unlock the wallet first.** `/api/escrow/deposit` requires
the wallet-unlock cookie (`app/api/escrow/deposit/route.ts:62`), the same gate
`/api/wallet/send` has. The composer checks it before animating and refuses with
*"Unlock your wallet first — the wallet button, bottom right."* Set a PIN if the
account has none, unlock, then settle. **The window is 5 minutes** — dawdle and
you get a 403 `locked`, with nothing spent.

The test account also needs USDC beyond the IOU amount: Arc charges gas in USDC,
and on the Privy stack the user's own wallet pays for both legs.

### The run

**4a. Send an IOU to a handle nobody has ever used.** Type "I owe
@somebody-new $1" and settle. The row should read **waiting for @somebody-new**.

If it instead reads *in escrow, not recorded — don't resend*, the money moved and
the index row did not. The sentence above the composer carries the deposit id and
the transaction hash. Keep them; do not send it again.

**4b. Confirm the deposit on chain and in the table.** Your first deposit is
**id 5** — ids 1 to 4 were consumed by the smoke test and the relay probe, and
are deliberately not in the table:

```bash
node -e "
const {createPublicClient,http}=require('viem');const {arcTestnet}=require('viem/chains');
const c=createPublicClient({chain:arcTestnet,transport:http('https://rpc.testnet.arc.network')});
const abi=[{name:'deposits',type:'function',stateMutability:'view',inputs:[{type:'uint256'}],
            outputs:[{type:'address'},{type:'bytes32'},{type:'uint256'}]}];
(async()=>console.log(await c.readContract({address:'0x9820f2889710a2a5190187993c31ff1d4f15efa5',abi,functionName:'deposits',args:[5n]})))()"
```

```sql
select escrow_address, deposit_id, provider, handle, amount_usdc, status
  from escrow_deposits;
```

Expected: one row, `status = 'open'`, the amount matching the IOU, and the
escrow's USDC balance equal to it.

**4c. Sign in as that handle** (the same provider — an `email:` deposit is
released by an email or a Google login, because both land on provider `email`).

**4d. Confirm the money arrived:**

```sql
select deposit_id, status, release_tx_hash from escrow_deposits;
```

Expected: `status = 'released'`, a non-null `release_tx_hash`, and the new
wallet holding the amount. On Circle, if the row is still `open` after a
brand-new user's first sign-in, sign in again — that is the one-login delay in
the table above, not a failure.

### If the money does not move

Grep the login logs for these two lines. Both mean the login succeeded and the
money did not move:

```
Escrow release for <provider>:<handle> failed for deposit <id> (login continues):
Escrow release pass for <provider>:<handle> failed (login continues, user <id>):
```

Most likely causes, in order. **The first two are now much less likely than they
were** — both releasers are funded and the relay path has run on both stacks —
so work down the list rather than assuming the usual suspect:

1. **The releaser has run dry.** It was the most common cause by far before
   Step 3; 5 USDC is thousands of releases, so check the balance rather than
   assume it. The other half of this — funding the wrong stack's releaser — no
   longer applies, because both are funded.
2. `Missing or malformed ESCROW_ATTESTER_PRIVATE_KEY` — the key is unset or
   truncated **in the Preview environment**. The local `.env.local` being right
   says nothing about Preview; it is read server-side at signing time, so it
   fails per-release rather than at boot.
3. `Deposit <id> is no longer held by <escrow> — nothing to release` — the
   deposit already left, by release or reclaim. This is the design working, not a
   fault, and it costs a chain read rather than gas.
4. A `BadSignature` revert would mean the attester in the deployed contract is not
   the key signing releases. It is not, for this deployment — that pairing has now
   been proven twice, at deploy time and by the relay probe — so it would mean the
   Preview environment holds a different `ESCROW_ATTESTER_PRIVATE_KEY` than the
   one the contract was deployed against.

---

## Step 5 — Reclaim, from the sender's side

Already proven on the deployed contract (deposit id 2 in the smoke test: the
depositor called `reclaim` and the USDC came back). **There is no UI for it** —
the plan's scope was the deposit and the release — so if you want it demonstrated
from a real sender's wallet rather than a script, it is a direct `reclaim(id)`
call from the address that deposited.

---

## What is still broken after all of this

Bills and recurring tabs still bind a stranger's share to a pre-minted address
that person cannot reach, so they still read as "not a participant" when they
sign in. That is spec §3, blocked on a product decision, and deliberately not in
this plan. The settle rail — the one that moves money — no longer strands it.

The 3.11 USDC already stranded is unrecoverable: user-owned wallets, 401 on
every signing path, and the Privy SDK has no method to link a pregenerated
account to a later login.

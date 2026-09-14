# HandleEscrow — the three steps that need you

Everything else is built, reviewed and green. This file is the whole remaining
list, in order. Nothing here can be done from a terminal that has no deployer
key and no browser, which is why it stopped here.

**Status when this was written (2026-09-14):**

- Branch `privy-wallet-stack`, clean at `2327dde`. Nothing merged, nothing pushed.
- `escrow_deposits` **already exists** in `splitsy-test`
  (`hdyioojrozodmutpldsu`) — eleven columns, RLS on, both indexes. Step 2 of the
  plan's Task 4 is DONE. You do not need to run the SQL.
- The contract is **not deployed**. Nothing on the escrow rail can run until it
  is: both rails check `isHandleEscrowConfigured()` and refuse rather than
  falling back to a transfer.

---

## Step 1 — Generate the attester key and deploy

`.env.local` currently has no Arc deployer key and no USDC address. Both are
needed before the deploy script will run.

**1a. Add the deployer variables** to `.env.local`:

```
ARC_TESTNET_PRIVATE_KEY=0x...      # a funded Arc Testnet deployer
ARC_TESTNET_USDC_ADDRESS=0x...     # Arc Testnet USDC
```

**1b. Generate a fresh attester key.** Do not reuse the deployer, and do not
reuse any wallet that holds money:

```bash
node -e "const {generatePrivateKey,privateKeyToAccount}=require('viem/accounts');const k=generatePrivateKey();console.log('ESCROW_ATTESTER_PRIVATE_KEY='+k);console.log('ESCROW_ATTESTER_ADDRESS='+privateKeyToAccount(k).address)"
```

Put both lines in `.env.local`.

> **THE ATTESTER IS IMMUTABLE IN THE DEPLOYED CONTRACT.** There is no setter and
> no owner. A wrong address here is not a setting you correct later — it is a
> contract that can never release anything, and the only exit is every depositor
> reclaiming. Check the address you paste matches the key you paste.
>
> Treat the private key as money. A stolen attester key can misdirect every
> deposit the escrow holds, one signature per id. It cannot take anything the
> escrow was never given, and it cannot stop a depositor reclaiming first.

**1c. Deploy:**

```bash
npm run deploy:arc:handle-escrow
```

The script refuses to start if either variable is missing or malformed — that
check is deliberate, because this is the irreversible step.

**1d. Copy the printed address** into `.env.local`:

```
NEXT_PUBLIC_HANDLE_ESCROW_ADDRESS=0x...
```

**1e. Confirm the deployment answers** (attester matches, ids start at 1):

```bash
node -e "
const {createPublicClient,http}=require('viem');const {arcTestnet}=require('viem/chains');
const c=createPublicClient({chain:arcTestnet,transport:http('https://rpc.testnet.arc.network')});
const abi=[{name:'attester',type:'function',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},
           {name:'nextDepositId',type:'function',stateMutability:'view',inputs:[],outputs:[{type:'uint256'}]}];
(async()=>{
  const a='$NEXT_PUBLIC_HANDLE_ESCROW_ADDRESS';
  console.log('attester', await c.readContract({address:a,abi,functionName:'attester'}));
  console.log('nextDepositId', await c.readContract({address:a,abi,functionName:'nextDepositId'}));
})()"
```

Expected: the attester equals `ESCROW_ATTESTER_ADDRESS`, and `nextDepositId` is
`1`. If the attester does not match, stop — redeploy rather than continue.

---

## Step 2 — Fund the releaser

**This is the step that decides whether the run works.** Arc charges gas in
USDC, so an unfunded releaser fails every release silently: the login still
succeeds, the deposit stays safe and reclaimable, and money simply never
arrives. It looks exactly like "the escrow is broken".

The releaser wallet is `namespace = "splitsy"`, `key = "escrow-releaser"`, and
it is created lazily at the first relay — so it normally has no address until
one release has been attempted.

**On the Circle stack it already exists, and it is empty.** Measured
2026-09-14 against the `.env.local` in this repo (`WALLET_PROVIDER` unset, so
Circle is the stack):

```
address:  0xdbcd0e96649257eb224bcd6954d49069624f70ac
walletId: 34104bdd-b922-5f7b-ac80-5c47ffcb2f44
balance:  0 USDC
```

**Send that address a few USDC on Arc Testnet** (https://faucet.circle.com).
Until you do, every release fails silently.

> The Privy stack has a DIFFERENT releaser — same namespace and key, different
> backend. If you run Preview with `WALLET_PROVIDER=privy`, fund that one
> instead; the address above is worthless there.

Ways to find it on either stack:

- **Privy stack** — after the first attempt:
  ```sql
  select address, wallet_id from privy_wallets
   where namespace = 'splitsy' and key = 'escrow-releaser';
  ```
- **Circle stack** — keyed by `refId = "splitsy:escrow-releaser"`
  (`lib/circle-dcw.ts:208`), listable in the Circle console.

Or ask the wallet provider directly, which creates it if it does not exist yet
(this is the command that produced the address above — it is safe to re-run, and
it answers for whichever stack `.env.local` selects):

```bash
node --experimental-strip-types --env-file=.env.local -e "
import('./lib/wallet-provider.ts').then(async (m) => {
  const w = await m.getOrCreateWallet('splitsy', 'escrow-releaser');
  console.log(w);
})"
```

Check its balance any time:

```bash
node -e "
const {createPublicClient,http,formatUnits}=require('viem');const {arcTestnet}=require('viem/chains');
const c=createPublicClient({chain:arcTestnet,transport:http('https://rpc.testnet.arc.network')});
const abi=[{name:'balanceOf',type:'function',stateMutability:'view',inputs:[{type:'address'}],outputs:[{type:'uint256'}]}];
(async()=>console.log('releaser USDC:', formatUnits(await c.readContract({address:'0x3600000000000000000000000000000000000000',abi,functionName:'balanceOf',args:['0xdbcd0e96649257eb224bcd6954d49069624f70ac']}),6)))()"
```

---

## Step 3 — The end-to-end run on Preview

With `NEXT_PUBLIC_HANDLE_ESCROW_ADDRESS` set **at build time** (it is inlined
into the browser bundle — a saved variable with no rebuild changes neither
side), on Preview:

**3a. Send an IOU to a handle nobody has ever used.** Type "I owe
@somebody-new $1" and settle. The row should read **waiting for @somebody-new**.

If it instead reads *in escrow, not recorded — don't resend*, the money moved
and the index row did not. The sentence above the composer carries the deposit
id and the transaction hash. Keep them; do not send it again.

**3b. Confirm the deposit on chain and in the table:**

```bash
node -e "
const {createPublicClient,http}=require('viem');const {arcTestnet}=require('viem/chains');
const c=createPublicClient({chain:arcTestnet,transport:http('https://rpc.testnet.arc.network')});
const abi=[{name:'deposits',type:'function',stateMutability:'view',inputs:[{type:'uint256'}],
            outputs:[{type:'address'},{type:'bytes32'},{type:'uint256'}]}];
(async()=>console.log(await c.readContract({address:'$NEXT_PUBLIC_HANDLE_ESCROW_ADDRESS',abi,functionName:'deposits',args:[1n]})))()"
```

```sql
select escrow_address, deposit_id, provider, handle, amount_usdc, status
  from escrow_deposits;
```

Expected: one row, `status = 'open'`, the amount matching the IOU, and the
escrow's USDC balance equal to it.

**3c. Sign in as that handle** (the same provider — an `email:` deposit is
released by an email or Google login, both of which land on provider `email`).

**3d. Confirm the money arrived:**

```sql
select deposit_id, status, release_tx_hash from escrow_deposits;
```

Expected: `status = 'released'`, a non-null `release_tx_hash`, and the new
wallet holding the amount.

**On the Circle stack a brand-new user gets their release one sign-in late.**
The release runs before Circle provisioning, so the first login has no wallet
address yet and the pass no-ops. Sign in a second time. This is known and
harmless — the row stays `open` and the money stays put.

### If the money does not move

Grep the login logs for these two lines. Both mean the login succeeded and the
money did not move:

```
Escrow release for <provider>:<handle> failed for deposit <id> (login continues):
Escrow release pass for <provider>:<handle> failed (login continues, user <id>):
```

Most likely causes, in order:

1. **The releaser has no USDC** (Step 2). The most common one by far.
2. `Missing or malformed ESCROW_ATTESTER_PRIVATE_KEY` — the key is unset or
   truncated in the Preview environment.
3. `Deposit <id> is no longer held by <escrow> — nothing to release` — the
   deposit already left, by release or reclaim. This is the design working, not
   a fault.
4. A `BadSignature` revert would mean the attester in the deployed contract is
   not the key signing releases. That is Step 1d gone wrong, and it needs a
   redeploy.

---

## Step 4 — Reclaim, the last line of the Definition of done

The sender can take back a deposit that has not been released. There is **no UI
for this** — it is a direct contract call, by design (the plan's scope was the
deposit and the release). To prove it, call `reclaim(id)` from the depositor's
wallet and confirm the USDC comes back.

---

## What is still broken after all of this

Bills and recurring tabs still bind a stranger's share to a pre-minted address
that person cannot reach, so they still read as "not a participant" when they
sign in. That is spec §3, blocked on a product decision, and deliberately not in
this plan. The settle rail — the one that moves money — no longer strands it.

The 3.11 USDC already stranded is unrecoverable: user-owned wallets, 401 on
every signing path, and the Privy SDK has no method to link a pregenerated
account to a later login.

// Privy implementation of WalletBackend — the splitsy.xyz stack's wallets.
//
// Wallets are app-created with our key quorum attached as an additional signer
// AT CREATION, so the server transacts without the user present, exactly as the
// Circle stack does. Two differences are the point of the change: the user can
// export the wallet, and a Privy policy can refuse a transaction our own code
// would have allowed. See
// docs/superpowers/specs/2026-09-01-privy-wallet-stack-design.md
//
// PRIVY SIGNS, WE BROADCAST. sendTransaction is not available here: it asks Privy
// to submit the transaction, Privy has no Arc RPC, and it answers 401 "App is not
// authorized to transact on chain eip155:5042002". eth_signTransaction carries no
// caip2 at all — the chain id rides inside the transaction — so it sits outside
// that check. scripts/privy-setup.ts proved the path on chain and every Privy
// call shape below is copied from it.
import { NotFoundError, PrivyClient, isEmbeddedWalletLinkedAccount, type User } from "@privy-io/node";
import {
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAbiItem,
  getAddress,
  http,
  numberToHex,
  parseUnits,
  recoverTransactionAddress,
} from "viem";
import { arcTestnet } from "viem/chains";
import { getPrivyWallet, insertPrivyWallet } from "./privy-wallets-repo.ts";
import {
  InsufficientFundsError,
  type ProviderWallet,
  type TxResult,
  type WalletBackend,
  type WalletTx,
} from "./wallet-provider.ts";
import { ARC_TESTNET_RPC, ARC_TESTNET_USDC } from "./x402/constants.ts";

let cached: PrivyClient | null = null;
function privy(): PrivyClient {
  const appId = process.env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) throw new Error("Privy is not configured (PRIVY_APP_ID / PRIVY_APP_SECRET)");
  cached ??= new PrivyClient({ appId, appSecret });
  return cached;
}

// The signer attached to every wallet at creation. Without it the server cannot
// transact at all, so an unset value is a hard error rather than a degraded mode.
function quorumId(): string {
  const id = process.env.PRIVY_KEY_QUORUM_ID;
  if (!id) throw new Error("PRIVY_KEY_QUORUM_ID is not set — the server cannot sign");
  return id;
}

// One of the quorum's authorization keys has to sign every wallet RPC, and in
// this SDK that is a PER-REQUEST field rather than a client option. It is
// optional in the type and optional at runtime too — an unset key still creates
// wallets and only fails at the first signature — so it is demanded here, on the
// path that needs it. Paste the dashboard value verbatim; the SDK strips the
// `wallet-auth:` prefix itself.
function authorizationContext(): { authorization_private_keys: string[] } {
  const key = process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY;
  if (!key) throw new Error("PRIVY_AUTHORIZATION_PRIVATE_KEY is not set — the server cannot sign");
  return { authorization_private_keys: [key] };
}

const publicClient = createPublicClient({ chain: arcTestnet, transport: http(ARC_TESTNET_RPC) });

export function receiptToState(status: "success" | "reverted"): "COMPLETE" | "FAILED" {
  return status === "success" ? "COMPLETE" : "FAILED";
}

export type TransferLog = {
  transactionHash: string;
  blockNumber: bigint;
  args: { from: string; to: string; value: bigint };
};

// USDC Transfer logs → the history rows the wallet panel renders.
//
// ONE ROW PER TRANSACTION, never one per direction: listTransactions asks the node
// twice, once for `from` and once for `to`, so a self-transfer arrives HERE TWICE.
// Deduping inside means the mapper has no precondition its caller has to remember,
// and the panel never sees two rows keyed on the same id (app/XAuthControl.tsx:752).
// `from === self` decides direction, so a self-transfer reads as outgoing, which is
// what the wallet actually did.
//
// ponytail: the key is the transaction hash, so a transaction carrying several USDC
// transfers for this wallet shows one of them rather than the net. Batched
// settlement is the only caller that does that, and Task 5 keeps it off this stack.
//
// ponytail: no block timestamps — that is one eth_getBlockByNumber per row, and
// the panel already renders a row without a date (app/XAuthControl.tsx:738).
// Fetch them if the history ever needs to be sorted by time rather than height.
export function logsToWalletTxs(logs: TransferLog[], self: string): WalletTx[] {
  const me = self.toLowerCase();
  return [...new Map(logs.map((log) => [log.transactionHash, log])).values()]
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

// WHAT ARC ACTUALLY DOES WITH A NONCE, measured against
// https://rpc.testnet.arc.network rather than read off a geth changelog:
//
//   nonce already mined        -> rejected, "nonce too low: next nonce 5, tx nonce 0"
//   two txs at the same nonce  -> BOTH accepted, first one mines, second is
//                                 silently dropped from the pool
//   nonce with a gap ahead     -> accepted, then dropped
//   byte-identical resubmit    -> not an error, the original hash comes back
//
// So only the first shape is an error to retry, and it is the one a STALE read
// produces: our pending-nonce read raced a send that had already mined.
// "replacement transaction underpriced" is matched too because it is what the
// geth family answers to the same mistake and a keyed endpoint may front such a
// node — but it was NOT observed on Arc, whose racing loser is dropped rather
// than refused. send() handles that second shape, because there is no error here
// to hang it on.
const NONCE_COLLISION = /nonce too low|replacement transaction underpriced/i;
export const isNonceCollision = (e: unknown): boolean =>
  NONCE_COLLISION.test(e instanceof Error ? e.message : String(e));

const SEND_ATTEMPTS = 3;

// Sign with Privy, broadcast ourselves, and re-read the nonce if the last read
// was stale.
//
// Broadcasting means WE own the nonce, which Privy owned in the sendTransaction
// design. Two sends from one wallet can read the same pending nonce, and one of
// them loses. Re-reading is what fixes the shape Arc reports — "nonce too low",
// i.e. our read had already been overtaken — because by the time we look again
// the winner is counted, so the next read returns the next nonce. Everything
// re-runs per attempt, prepareTransactionRequest included, which is what makes
// the retry self-correcting rather than a resubmission of the same bytes.
//
// Deliberately NOT a nonce tracked in Supabase — one send that dies after the row
// increments leaves the wallet permanently ahead of the chain, and Arc ACCEPTS a
// gapped nonce silently rather than rejecting it, so every later send would sit
// unmined behind the hole until someone filled it by hand. And deliberately not
// an in-process lock: two concurrent requests on Vercel land in separate
// instances that share no memory, so it would guard nothing.
//
// ponytail: two concurrent sends whose transactions come out BYTE-IDENTICAL —
// same nonce, same recipient, same amount — sign to the same RLP, so both callers
// wait on ONE transaction and both are handed `COMPLETE` with THE SAME HASH. Right
// for a double-submitted payment. Wrong for two equal debts to the same creditor,
// which app/api/debts/[id]/pay/route.ts pays as a bare transfer: both rows get
// marked paid, each carrying a hash that resolves on the explorer, so the ledger
// looks right and one transfer is missing. Whoever reconciles is looking for two
// paid rows sharing one paid_tx_hash, not for a failure. Registry writes carry the
// bill id, so they differ and one side drops instead. Route a settlement through
// the registry, or give the caller a per-payment marker, if bare transfers ever
// have to be told apart.
async function signAndBroadcast(
  walletId: string,
  to: `0x${string}`,
  data: `0x${string}`,
): Promise<{ hash: `0x${string}`; from: `0x${string}`; nonce: number }> {
  const authorization_context = authorizationContext();
  // Privy signs by wallet id, but reading a nonce and estimating gas need the
  // address, and the seam hands down only the id.
  const from = getAddress((await privy().wallets().get(walletId)).address);

  for (let attempt = 1; ; attempt++) {
    try {
      // Privy fills in NOTHING — it has no Arc RPC and signs exactly what it is
      // handed — so the nonce, the gas limit and the EIP-1559 fees are all read
      // here, and prepareTransactionRequest is viem's one call for all three.
      const tx = await publicClient.prepareTransactionRequest({ account: from, to, data, type: "eip1559" });
      const { signed_transaction } = await privy()
        .wallets()
        .ethereum()
        .signTransaction(walletId, {
          params: {
            transaction: {
              to,
              data,
              nonce: numberToHex(tx.nonce),
              chain_id: arcTestnet.id,
              type: 2,
              gas_limit: numberToHex(tx.gas),
              max_fee_per_gas: numberToHex(tx.maxFeePerGas),
              max_priority_fee_per_gas: numberToHex(tx.maxPriorityFeePerGas),
            },
          },
          authorization_context,
        });

      // Recover the signer from the RLP Privy handed back and refuse to broadcast
      // unless it is this wallet. A signature over the wrong payload, or one
      // carrying the wrong recovery parity, resolves to a DIFFERENT address —
      // which either burns gas on a revert or spends from an account we did not
      // mean to touch. The prefix check is what makes the cast below honest
      // rather than assumed: we asked for a type-2 transaction, so confirm it is.
      if (!signed_transaction.startsWith("0x02")) {
        throw new Error(`Expected an EIP-1559 (type 2) signed transaction, got ${signed_transaction.slice(0, 4)}`);
      }
      const serializedTransaction = signed_transaction as `0x02${string}`;
      const signer = await recoverTransactionAddress({ serializedTransaction });
      if (signer !== from) {
        throw new Error(`Signature recovers to ${signer}, not ${from} — refusing to broadcast`);
      }

      return { hash: await publicClient.sendRawTransaction({ serializedTransaction }), from, nonce: tx.nonce };
    } catch (e) {
      if (attempt >= SEND_ATTEMPTS || !isNonceCollision(e)) throw e;
    }
  }
}

// What a receipt wait that produced no receipt is allowed to tell a caller.
//
// "dropped" is the only UNTAGGED answer and the only one that can be wrong in the
// unrecoverable direction. lib/autopay.ts:250 turns an untagged throw into
// `decision: "skip", amountUsdc: 0` — handing back a daily cap that was really
// spent, so two 8 USDC bills both pay against a 10 USDC cap — and
// app/api/debts/[id]/pay/route.ts:47-58 answers 502 and leaves the debt pending, so
// the user presses Pay again and a bare transfer executes twice. So it demands
// PROOF, never absence:
//
//   mined         a receipt turned up after all. Beats every other signal — the
//                 nonce being consumed by OUR OWN transaction must never read as
//                 someone else consuming it.
//   dropped       the wait genuinely ran out AND the nonce is consumed with no
//                 receipt of ours, so the slot went to different bytes and this
//                 transaction can never mine.
//   indeterminate everything else, including any error that is not the timeout.
//                 viem rejects the wait immediately on any non-not-found error from
//                 the polled call (waitForTransactionReceipt.js:195-197) and does
//                 not retry Arc's -32011 "request limit reached" (lib/x402/constants.ts:6),
//                 so that path can fire a second after the broadcast — when unmined
//                 is simply the normal state of a perfectly live transaction.
export function verdictAfterWait(
  err: unknown,
  nonceConsumed: boolean,
  mined: boolean,
): "mined" | "dropped" | "indeterminate" {
  if (mined) return "mined";
  if (!(err instanceof WaitForTransactionReceiptTimeoutError)) return "indeterminate";
  return nonceConsumed ? "dropped" : "indeterminate";
}

// One contract write, waited to a receipt.
//
// A THROW AFTER THE BROADCAST IS INDETERMINATE, NOT "DIDN'T HAPPEN" — but on Arc a
// hash alone does not prove the transaction will mine, which is the one place this
// cannot copy lib/circle-dcw.ts. eth_sendRawTransaction answers with a hash for
// transactions Arc then DISCARDS: the loser of a same-nonce race and a gapped nonce
// both come back accepted and then vanish. So a wait that produced no receipt asks
// the chain which of those happened, and verdictAfterWait decides what it means.
//
// The two reads are ordered NONCE FIRST, RECEIPT SECOND, and that order is the whole
// guarantee. A nonce already consumed at the earlier read, with still no receipt at
// the later one, cannot have been consumed by us — a receipt never disappears — so
// it was different bytes. The other order leaves a window in which our own
// transaction mines between the two reads and gets called dead.
//
// pollMs defaults to 8s rather than the 60s the Circle backend uses: Arc confirms in
// ~1.2s (measured), and the routes on this path export no maxDuration, so Vercel's
// ~10s default kills the request long before a 60s wait ends — and a killed request
// writes no row saying what it did. Callers with a bigger budget pass their own
// (app/api/agents/autopay/route.ts passes 25s inside maxDuration = 300).
async function send(
  walletId: string,
  to: `0x${string}`,
  data: `0x${string}`,
  pollMs = 8_000,
): Promise<TxResult> {
  let sent: { hash: `0x${string}`; from: `0x${string}`; nonce: number };
  try {
    sent = await signAndBroadcast(walletId, to, data);
  } catch (e) {
    // Arc charges gas in USDC, so "not enough USDC" covers the amount and the gas
    // both, and the shortfall surfaces from the gas estimate as readily as from
    // the broadcast. Same detection the Circle backend does at lib/circle-dcw.ts:75.
    const raw = e instanceof Error ? e.message : JSON.stringify(e);
    if (/insufficient|not enough|balance|exceeds/i.test(raw)) throw new InsufficientFundsError();
    // Matched on the full text above, reported without it: viem inlines the RPC URL,
    // and getUrl only strips basic-auth credentials, not a key in the path or query.
    // ARC_TESTNET_RPC is env-driven precisely so it can be a keyed endpoint, and
    // app/api/debts/[id]/pay/route.ts:53-57 hands this message to the caller.
    throw new Error(`Privy send failed: ${raw.replace(/\nURL: \S+/g, "")}`);
  }

  const { hash } = sent;
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: pollMs });
    return { id: hash, state: receiptToState(receipt.status), txHash: hash };
  } catch (err) {
    // Only asked when the wait actually ran out; for any other error the answer is
    // fixed, and two more RPC calls on an RPC that just failed would decide nothing.
    // An unreadable chain also decides nothing: anything thrown in here leaves the
    // verdict indeterminate rather than letting a network blip declare money gone.
    let nonceConsumed = false;
    let receipt: Awaited<ReturnType<typeof publicClient.getTransactionReceipt>> | null = null;
    if (err instanceof WaitForTransactionReceiptTimeoutError) {
      try {
        nonceConsumed = (await publicClient.getTransactionCount({ address: sent.from, blockTag: "latest" })) > sent.nonce;
        receipt = await publicClient.getTransactionReceipt({ hash }).catch((e) => {
          if (e instanceof TransactionReceiptNotFoundError) return null;
          throw e;
        });
      } catch {
        nonceConsumed = false;
      }
    }

    const verdict = verdictAfterWait(err, nonceConsumed, receipt !== null);
    if (verdict === "mined" && receipt) return { id: hash, state: receiptToState(receipt.status), txHash: hash };
    if (verdict === "dropped") {
      throw new Error(
        `Privy tx ${hash} was dropped before it mined — nonce ${sent.nonce} went to another transaction, nothing moved`,
        { cause: err },
      );
    }
    throw Object.assign(new Error(`Privy tx indeterminate — broadcast but unconfirmed: ${hash}`, { cause: err }), {
      broadcast: true as const,
      txHash: hash,
    });
  }
}

// Every wallet is created with the key quorum as an additional signer; that is
// what lets the server transact later with no user present. A function, not a
// const, so a missing quorum id fails the call that needed it rather than the
// import — this module is loaded lazily by the seam and must not throw on load.
const walletSpec = () => [{ chain_type: "ethereum" as const, additional_signers: [{ signer_id: quorumId() }] }];

// A linked account can be an external wallet, or an embedded Solana, Bitcoin or
// curve-signing one. This picks the Privy-held ETHEREUM wallet, the only kind the
// send path can use.
const ethereumWallet = (u: User) =>
  u.linked_accounts.filter(isEmbeddedWalletLinkedAccount).find((a) => a.chain_type === "ethereum");

// Whether OUR key quorum can sign for this wallet. The linked-account record cannot
// answer that — it carries id, address, delegated and user_can_sign and nothing about
// quorums (resources/users/users.d.ts, LinkedAccountEthereumEmbeddedWallet) — so the
// wallet object is fetched and its signers read. Confirmed against a wallet this code
// created: the quorum arrives in `additional_signers`, while `owner_id` is a different
// quorum Privy assigns, so both are accepted.
//
// This matters only on the adopt path. A wallet held by an app we do not share a
// quorum with looks perfectly fine until the first signature answers 401 — by which
// time somebody may have funded it.
async function serverCanSign(walletId: string): Promise<boolean> {
  const quorum = quorumId();
  const wallet = await privy().wallets().get(walletId);
  return wallet.owner_id === quorum || (wallet.additional_signers ?? []).some((s) => s.signer_id === quorum);
}

// Arc's public RPC refuses an eth_getLogs range wider than ~25k blocks (-32012
// "requested range too large") and caps one response at 20k logs, so a wallet's
// history is a walk backwards in chunks and not a single call. Both limits
// measured against https://rpc.testnet.arc.network; a keyed endpoint may be
// looser, which is why ARC_TESTNET_RPC is read from the environment.
// ponytail: 200k blocks is ~1.5 days of Arc, i.e. "recent activity" rather than a
// ledger, at 10 chunks x 2 calls per history load. Page further back from the
// oldest row shown, or record our own sends, if the full history is ever needed.
const LOG_CHUNK = 20_000n;
const LOOKBACK_BLOCKS = 200_000n;
const TRANSFER = getAbiItem({ abi: erc20Abi, name: "Transfer" });

export const backend: WalletBackend = {
  // Our own table is the idempotency, not a Privy query. Every caller already
  // guards on a row of its own (lib/oauth-callback.ts:91, lib/wallet-resolve.ts:58,
  // lib/user-agent.ts:34); this is the net under that, and it needs no lookup
  // endpoint we would have to trust.
  async getOrCreateWallet(namespace: string, key: string): Promise<ProviderWallet | null> {
    const existing = await getPrivyWallet(namespace, key);
    if (existing) return { address: existing.address, walletId: existing.wallet_id };

    // create() is not idempotent, so the LOOKUP comes first: a key whose row
    // never landed must adopt the wallet Privy already holds rather than mint a
    // second one and orphan whatever the first was funded with. A miss THROWS
    // NotFoundError, and the catch is scoped to exactly that class so a 401 or a
    // dropped connection can never masquerade as "no such user".
    const custom_user_id = `${namespace}:${key}`;
    let user: User;
    try {
      user = await privy().users().getByCustomAuthID({ custom_user_id });
    } catch (caught) {
      if (!(caught instanceof NotFoundError)) throw caught;
      user = await privy()
        .users()
        .create({ linked_accounts: [{ type: "custom_auth", custom_user_id }], wallets: walletSpec() });
    }

    // The identity can outlive a call whose wallet creation failed (a bad quorum
    // id, say). Without this, that key is a dead end no retry gets past.
    const wallet =
      ethereumWallet(user) ??
      ethereumWallet(await privy().users().pregenerateWallets(user.id, { wallets: walletSpec() }));
    if (!wallet) throw new Error("Privy returned no Ethereum wallet");
    // Without a wallet id the server cannot sign, so stop here rather than after
    // somebody has funded an address that can never spend.
    if (!wallet.id) {
      throw new Error(
        `Privy wallet ${wallet.address} has no server wallet id, so the server cannot sign for it — check ` +
          "PRIVY_KEY_QUORUM_ID, and that this PRIVY_APP_ID owns the wallet.",
      );
    }
    // And a non-null id is not the same as a wallet WE can sign for — an adopted
    // wallet may carry someone else's quorum, which fails as a Privy 401 at the first
    // signature rather than here. Checked before the row lands, so a key that resolves
    // is a key that can spend.
    if (!(await serverCanSign(wallet.id))) {
      throw new Error(
        `Privy wallet ${wallet.address} is not signable by PRIVY_KEY_QUORUM_ID — it carries a different ` +
          "key quorum, so the server could create it but never transact with it.",
      );
    }

    await insertPrivyWallet({
      namespace,
      key,
      privy_user_id: user.id,
      wallet_id: wallet.id,
      address: wallet.address,
    });
    // Re-read rather than returning what WE got from Privy. Two concurrent first-time
    // resolutions of one key both miss the row and both create, and ignoreDuplicates
    // makes the loser's write a silent no-op — so the loser would otherwise hand its
    // own wallet to lib/oauth-callback.ts:94 to persist and display while the table
    // holds the winner's, and money sent to it would be invisible to every later
    // lookup. Whoever the row says won, both callers return.
    const row = await getPrivyWallet(namespace, key);
    return row
      ? { address: row.address, walletId: row.wallet_id }
      : { address: wallet.address, walletId: wallet.id };
  },

  transferUsdc(walletId, to, amountUsdc) {
    return send(
      walletId,
      ARC_TESTNET_USDC,
      encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        // Supabase returns numeric as a JS number, so stringify before parsing.
        args: [getAddress(to), parseUnits(String(amountUsdc), 6)],
      }),
    );
  },

  executeContract: send,

  // Read from the chain, not from a vendor indexer. Circle's listTransactions has
  // no Privy counterpart, and USDC Transfer logs are the same truth without a
  // second system to be stale.
  async listTransactions(_walletId: string, address: string): Promise<WalletTx[]> {
    const self = getAddress(address);
    const head = await publicClient.getBlockNumber();
    const oldest = head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n;
    const logs: TransferLog[] = [];

    // Two calls per chunk, because an OR across two indexed topic POSITIONS is not
    // expressible in one filter. The pair runs in parallel and the chunks run in
    // sequence: the endpoint rate-limits a burst, and while viem retries -32005 on
    // its own, not provoking it is cheaper.
    for (let toBlock = head; toBlock > oldest; ) {
      const fromBlock = toBlock - LOG_CHUNK > oldest ? toBlock - LOG_CHUNK : oldest;
      const window = { address: ARC_TESTNET_USDC, event: TRANSFER, fromBlock, toBlock, strict: true } as const;
      const [out, incoming] = await Promise.all([
        publicClient.getLogs({ ...window, args: { from: self } }),
        publicClient.getLogs({ ...window, args: { to: self } }),
      ]);
      logs.push(...out, ...incoming);
      toBlock = fromBlock - 1n;
    }

    // One row per TRANSACTION: logsToWalletTxs dedupes on the hash, which is what a
    // self-transfer needs — it comes back in both result sets above.
    return logsToWalletTxs(logs, self);
  },
};

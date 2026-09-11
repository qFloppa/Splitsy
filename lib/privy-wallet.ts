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
import { AuthenticationError, PrivyClient } from "@privy-io/node";
import {
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAbiItem,
  getAddress,
  http,
  keccak256,
  numberToHex,
  parseTransaction,
  parseUnits,
  recoverTransactionAddress,
} from "viem";
import { arcTestnet } from "viem/chains";
import { getPrivyWallet, insertPrivyWallet } from "./privy-wallets-repo.ts";
import {
  InsufficientFundsError,
  NotOurWalletError,
  type ProviderWallet,
  type TxFate,
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
// Trimmed to match resolveState (app/api/wallet/export/route.ts), which compares
// this id against the owner Privy reports — a padded value here would mint
// wallets whose ownership never matches and read as "someone else owns this".
function quorumId(): string {
  const id = process.env.PRIVY_KEY_QUORUM_ID?.trim();
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

// A MINED RECEIPT IS NOT A SUCCESS. Every return path out of send() goes through
// here, which is the point: the Circle backend THROWS on a failed execution
// (lib/circle-dcw.ts:158-162) and its callers are written against that throw. Only
// three of them read `state` at all — app/api/wallet/send, app/api/debts/[id]/pay
// and lib/user-agent.ts:143, the last being the one that says so out loud. EIGHT
// answered `{ok: true, txHash}` for a transaction that reverted, and
// app/api/onchain-bills/[billId]/pay/route.ts also queued an ERC-8004
// `paid_in_full` score, which resolveScoringContext (lib/erc8004.ts:635) commits on
// chain reading the receipt for its block timestamp and never for its status.
// Reachable with nothing exotic: Arc charges gas in USDC, so a wallet funded to
// exactly its share pays the separate approve and then reverts on payDebt.
//
// UNTAGGED, exactly as Circle leaves a FAILED. A revert burned gas and moved no
// USDC, so `broadcast` — "this may yet settle, count it as spent" — would be a lie:
// app/api/agents/autopay/route.ts:645-651 names this case as the one that must not
// charge the daily cap, and app/api/debts/[id]/pay/route.ts must let the user try
// again rather than park the debt in `settling`.
//
// receiptToState is left exactly as it was and stays the mapper for a SUCCESS
// (lib/privy-wallet.test.ts:14): the throw belongs to the send, not to the mapping.
export function settledOrThrow(hash: `0x${string}`, status: "success" | "reverted"): TxResult {
  if (status === "reverted") {
    throw new Error(`Privy tx ${hash} reverted on chain — it burned gas and moved no USDC`);
  }
  return { id: hash, state: receiptToState(status), txHash: hash };
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
  // address, and the seam hands down only the id. Hoisted out of the loop below:
  // the address cannot change between attempts, and every retry was re-asking.
  const from = getAddress((await privy().wallets().get(walletId)).address);

  for (let attempt = 1; ; attempt++) {
    try {
      const { transaction } = await prepareTransfer(from, to, data);
      const { signed_transaction } = await privy()
        .wallets()
        .ethereum()
        .signTransaction(walletId, {
          params: { transaction: transaction as never },
          authorization_context,
        });
      return await broadcastSigned(signed_transaction, from);
    } catch (e) {
      if (attempt >= SEND_ATTEMPTS || !isNonceCollision(e)) throw e;
    }
  }
}

// Nonce, gas limit and EIP-1559 fees — everything Privy fills in NOTHING of,
// because it has no Arc RPC and signs exactly what it is handed. One call, because
// prepareTransactionRequest is viem's ask for all three at once.
//
// SEPARATE FROM THE SIGNING because the user-signed path needs these bytes WITHOUT
// any Privy signature: the server prepares, the browser authorizes, and the server
// relays. It is also the half that must be re-run on a nonce collision — the retry
// is self-correcting precisely because this reads the chain again rather than
// resubmitting bytes.
async function prepareTransfer(from: `0x${string}`, to: `0x${string}`, data: `0x${string}`): Promise<Prepared> {
  const tx = await publicClient.prepareTransactionRequest({ account: from, to, data, type: "eip1559" });
  return {
    from,
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
  };
}

// RLP in, hash on the wire out — everything between the signature and the receipt
// wait, for BOTH signers. Shared rather than duplicated because the three checks
// below are the only thing standing between a signature and money moving, and a
// second copy is a second place for one of them to go missing.
//
// THE RECOVERY CHECK IS WHAT MAKES THE RELAY SAFE. On the user-signed path these
// bytes were produced by Privy on a request the USER authorized, and the server
// cannot verify that authorization itself — it has no owner key. What it CAN do is
// refuse to broadcast anything that does not recover to this wallet, which is what
// stops a substituted or mis-signed payload from spending.
async function broadcastSigned(signed_transaction: string, from: `0x${string}`): Promise<Sent> {
  // The prefix check is what makes the cast below honest rather than assumed: we
  // asked for a type-2 transaction, so confirm it is one before viem parses it.
  if (!signed_transaction.startsWith("0x02")) {
    throw new Error(`Expected an EIP-1559 (type 2) signed transaction, got ${signed_transaction.slice(0, 4)}`);
  }
  const serializedTransaction = signed_transaction as `0x02${string}`;
  const signer = await recoverTransactionAddress({ serializedTransaction });
  if (signer !== from) {
    throw new Error(`Signature recovers to ${signer}, not ${from} — refusing to broadcast`);
  }

  // The nonce is read back OUT OF THE SIGNED BYTES, not carried over from the
  // request. The recovery check above cannot notice a substituted nonce — it
  // proves only who signed — and the dropped verdict in send() is an argument
  // about which nonce this transaction occupies, so it has to be the nonce the
  // chain will see. Costs no RPC call. An unparseable nonce fails here, before
  // the broadcast, rather than turning into a proof about the wrong slot.
  const nonce = parseTransaction(serializedTransaction).nonce;
  if (nonce === undefined) {
    throw new Error("Privy returned a signed transaction with no nonce — refusing to broadcast");
  }

  // THE BROADCAST IS THE ONLY CALL HERE WHOSE FAILURE IS AMBIGUOUS, so it is
  // the only one that hands the caller something to probe with. Everything
  // above it — the gas estimate, Privy's signature, the recovery check, the
  // nonce parse — fails with no bytes on the wire, and letting one of those
  // read as "this may have moved money" would park a payment as in-flight for
  // a send that never left. keccak256 of the signed bytes IS the transaction
  // hash, so naming it needs no answer from the node.
  try {
    return { hash: await publicClient.sendRawTransaction({ serializedTransaction }), from, nonce };
  } catch (e) {
    throw Object.assign(e as Error, {
      sent: { hash: keccak256(serializedTransaction), from, nonce } satisfies Sent,
    });
  }
}

// What a receipt wait that produced no receipt is allowed to tell a caller.
//
// "dropped" is the only UNTAGGED answer and the only one that can be wrong in the
// unrecoverable direction. lib/autopay.ts:250 turns an untagged throw into
// `decision: "skip", amountUsdc: 0` — handing back a daily cap that was really
// spent, so two 8 USDC bills both pay against a 10 USDC cap — and
// app/api/debts/[id]/pay/route.ts:114-117 answers 502 and leaves the debt pending, so
// the user presses Pay again and a bare transfer executes twice. (Its TAGGED sibling
// no longer does that: :98-113 parks the debt as `settling` instead. Which is exactly
// why the untagged answer has to be earned.) So it demands PROOF, never absence:
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

type Sent = { hash: `0x${string}`; from: `0x${string}`; nonce: number };

// The unsigned transaction Privy will sign, in the shape its `transaction` param
// takes. Opaque to the browser by design — see lib/export-crypto.ts:rpcRequestInput.
export type PreparedTransaction = Record<string, unknown>;
export type Prepared = { transaction: PreparedTransaction; from: `0x${string}` };
type Receipt = Awaited<ReturnType<typeof publicClient.getTransactionReceipt>>;
type Outcome = { verdict: "mined" | "dropped" | "indeterminate"; receipt: Receipt | null };
const INDETERMINATE: Outcome = { verdict: "indeterminate", receipt: null };

// The probe's own budget. Its reads normally answer in tens of milliseconds, and
// ~0.6s of setup plus pollMs plus this has to fit inside Vercel's ~10s default.
const PROBE_MS = 1_500;
const rejectAfter = (ms: number) =>
  new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`chain probe gave up after ${ms}ms`)), ms);
  });

// Everything the chain has to say about a wait that ran out, on one budget.
//
// NONCE FIRST, RECEIPT SECOND, and that order is the whole guarantee: a slot already
// consumed at the earlier read, with still no receipt at the later one, cannot have
// been consumed by us — a receipt never disappears — so it was different bytes. The
// other order leaves a window in which our own transaction mines between the two
// reads and gets called dead.
async function probeChain(sent: Sent, err: unknown): Promise<Outcome> {
  const nonceConsumed = (await publicClient.getTransactionCount({ address: sent.from, blockTag: "latest" })) > sent.nonce;
  const read = () =>
    publicClient.getTransactionReceipt({ hash: sent.hash }).catch((e) => {
      if (e instanceof TransactionReceiptNotFoundError) return null;
      throw e;
    });

  let receipt = await read();
  const verdict = verdictAfterWait(err, nonceConsumed, receipt !== null);
  if (verdict !== "dropped") return { verdict, receipt };

  // "dropped" is the only untagged answer, so it gets ONE MORE, FRESH receipt read
  // before anyone acts on it. The read above can be served by the dedupe entry of a
  // request the WAIT issued — viem keys one in-flight promise per method+params and
  // holds it across the retry sequence (buildRequest.js:25-28, withDedupe.js) — which
  // is an OLDER view than the nonce read, which is not deduped. A load-balanced
  // endpoint answering the two from different nodes does the same thing. By now that
  // entry has settled and been evicted, so this is genuinely new, and a receipt here
  // wins: better a settlement counted twice than a debt paid twice.
  receipt = await read();
  return receipt ? { verdict: "mined", receipt } : { verdict: "dropped", receipt: null };
}

// The same question probeChain asks, for a caller that was never inside a wait:
// given a hash, did this mine, revert, or die?
//
// PURE, like verdictAfterWait, and on the same doctrine. A receipt is proof. A
// consumed nonce with no receipt of ours is proof that the slot went to different
// bytes, so this transaction can never mine. NOTHING ELSE IS PROOF OF ANYTHING, and
// "unknown" is what that honestly reads as — not a failure. The receipt is read
// AFTER the nonce (see readFate), which is what lets it beat it: a receipt never
// disappears, so one that mined between the two reads reads as mined, never as dead.
export function fateFromReads(receipt: "success" | "reverted" | null, nonceConsumed: boolean): TxFate {
  if (receipt) return receipt;
  return nonceConsumed ? "dropped" : "unknown";
}

// The reads behind that answer, on one budget, for the two callers holding a hash
// and no receipt: app/api/debts/[id]/pay/route.ts re-reading the transfer it parked
// in `settling` (through the seam, which is what keeps the circle stack out of
// here), and send() below after a broadcast whose ANSWER was lost.
//
// NEVER THROWS. Both callers are deciding what to do about money, and an unreadable
// chain is not evidence: every failure — an RPC error, reads that outrun PROBE_MS —
// comes back "unknown", which is the answer that changes nothing.
//
// `known` is the (from, nonce) the caller signed, which only send() has. Without it
// the nonce comes from the transaction itself: a node still holding it, mined or
// pending, reports both fields, and a node that never heard of it leaves nothing to
// argue from — which is "unknown", not "dead".
//
// Deliberately not probeChain rebuilt. That one knows its own wait's error and needs
// the timeout distinction; this one has no wait. What they share is the rule above
// and the second fresh read below.
export async function fateOfTx(hash: `0x${string}`, known?: Sent): Promise<TxFate> {
  return Promise.race([readFate(hash, known), rejectAfter(PROBE_MS)]).catch(() => "unknown" as const);
}

const receiptStatus = (hash: `0x${string}`) =>
  publicClient.getTransactionReceipt({ hash }).then(
    (receipt) => receipt.status,
    (e) => {
      if (e instanceof TransactionReceiptNotFoundError) return null;
      throw e;
    },
  );

// from + nonce out of the transaction itself. Not-found is an ANSWER rather than an
// error — the node has no record of these bytes — but it proves nothing on its own,
// since another node's pool may still hold them, so it leaves the fate unknown.
const txClaim = (hash: `0x${string}`): Promise<Sent | null> =>
  publicClient.getTransaction({ hash }).then(
    (tx) => ({ hash, from: tx.from, nonce: tx.nonce }),
    (e) => {
      if (e instanceof TransactionNotFoundError) return null;
      throw e;
    },
  );

async function readFate(hash: `0x${string}`, known?: Sent): Promise<TxFate> {
  const claim = known ?? (await txClaim(hash));
  // NONCE FIRST, RECEIPT SECOND — probeChain's ordering, for probeChain's reason.
  const nonceConsumed =
    claim !== null &&
    (await publicClient.getTransactionCount({ address: claim.from, blockTag: "latest" })) > claim.nonce;

  const fate = fateFromReads(await receiptStatus(hash), nonceConsumed);
  if (fate !== "dropped") return fate;
  // "dropped" is the one answer that lets a caller pay again, so it gets ONE MORE,
  // FRESH receipt read before anybody acts on it: a load-balanced endpoint can serve
  // the nonce and the receipt from two different nodes, and a receipt turning up
  // here wins — better a settlement counted twice than a debt paid twice.
  return fateFromReads(await receiptStatus(hash), true);
}

// The tagged throw for "broadcast, and nothing proves what happened next". Read
// through isBroadcast and broadcastTxHash (lib/wallet-provider.ts), which is how
// app/api/debts/[id]/pay/route.ts parks the debt instead of offering a second Pay.
const indeterminate = (hash: `0x${string}`, cause: unknown) =>
  Object.assign(new Error(`Privy tx indeterminate — broadcast but unconfirmed: ${hash}`, { cause }), {
    broadcast: true as const,
    txHash: hash,
  });

// One contract write, waited to a receipt.
//
// A THROW AFTER THE BROADCAST IS INDETERMINATE, NOT "DIDN'T HAPPEN" — but on Arc a
// hash alone does not prove the transaction will mine, which is the one place this
// cannot copy lib/circle-dcw.ts. eth_sendRawTransaction answers with a hash for
// transactions Arc then DISCARDS: the loser of a same-nonce race and a gapped nonce
// both come back accepted and then vanish. So a wait that ran out asks the chain
// which of those happened, and probeChain decides what it means.
//
// THE BROADCAST ITSELF FAILING IS THE SAME PROBLEM ONE LAYER UP, and gets the same
// treatment: eth_sendRawTransaction can take the bytes and lose the answer, so a
// throw from there is probed (fateOfTx) rather than reported as a send that never
// happened. Only the reads decide — nothing here reasons from the error's text.
//
// A MINED RECEIPT IS STILL NOT A SUCCESS: every return goes through settledOrThrow,
// so a revert leaves here as a throw exactly as it does on the Circle backend.
//
// checkReplacement is OFF, against viem's default. With it on, once the wait has
// resolved our hash — and Arc serves an unmined transaction by hash for ~1.2s, so it
// will — any transaction it later finds sharing our (from, nonce) is treated as our
// replacement and ITS receipt resolves the wait (waitForTransactionReceipt.js:158-186).
// This would then return success carrying OUR hash and a STRANGER'S status, and a debt
// would be marked paid, with a hash that resolves on the explorer, off money that went
// somewhere else. Nothing here ever replaces a transaction on purpose: the retry fires
// only on "nonce too low", which means that slot is already gone, so the re-read
// returns a higher nonce. Replacement detection has nothing to detect and one way to
// be wrong.
//
// pollingInterval is named because arcTestnet declares no blockTime, so viem falls
// back to 4s (createClient.js:9-11) — two receipt checks inside the whole wait, at ~0s
// and ~4s, on a chain that mines every 0.56s. 1s keeps the ordinary slow-ish send on
// the wait's own path instead of leaning on the probe.
//
// pollMs defaults to 6s, not the Circle backend's 60s: Arc confirms in ~1.2s
// (measured) with ~0.6s of work ahead of it, and the routes on this path export no
// maxDuration, so Vercel's ~10s default kills the request long before a 60s wait ends
// — and a killed request writes no row saying what it did. 6s rather than 8s because
// at a 1s poll it still gets six checks, and the 2s it gives back is what the probe
// spends. Callers with a bigger budget pass their own (app/api/agents/autopay 25s,
// app/api/pay/[token]/social 60s).
async function send(
  walletId: string,
  to: `0x${string}`,
  data: `0x${string}`,
  pollMs = 6_000,
): Promise<TxResult> {
  let sent: Sent;
  try {
    sent = await signAndBroadcast(walletId, to, data);
  } catch (e) {
    return orThrow(await classifySendFailure(e));
  }
  return awaitSettlement(sent, pollMs);
}

// Sign with the OWNER'S key instead of ours, then relay their bytes.
//
// The signature was produced in the user's tab over a payload we built, and the
// server cannot verify that authorization for itself — it holds no owner key. What
// it CAN do is refuse to broadcast anything that does not recover to this wallet
// (broadcastSigned), which is the check that keeps a relay from becoming a blank
// cheque. Everything after the relay is the same money-safety machinery the
// quorum-signed path uses, deliberately not a second copy of it.
//
// NO NONCE-COLLISION RETRY HERE, unlike signAndBroadcast. Retrying means signing
// again, which on this path is another browser round trip — and the concurrent
// same-wallet sends that motivated the loop are server-side, where the user is not
// present to be asked. A collision surfaces as a retryable error instead.
// ponytail: if a user ever races themselves across two tabs, the loop belongs in
// the browser, around the prepare/sign/relay cycle, not in here.
export async function sendUserSigned(
  walletId: string,
  transaction: PreparedTransaction,
  authorizationSignature: string,
  pollMs = 6_000,
): Promise<TxResult> {
  const from = getAddress((await privy().wallets().get(walletId)).address);

  let response: { data?: { signed_transaction?: string } };
  try {
    response = (await privy().wallets()._rpc(walletId, {
      method: "eth_signTransaction",
      params: { transaction },
      // The RAW header rather than authorization_context, and that is not a style
      // choice: the SDK's signTransaction() input type replaces this header with
      // `authorization_context`, which takes PRIVATE KEYS. A browser must never hand
      // its key over, so the generated _rpc is the only door that fits — the same
      // reason the export path calls _export rather than exportPrivateKey().
      "privy-authorization-signature": authorizationSignature,
    } as never)) as { data?: { signed_transaction?: string } };
  } catch (e) {
    // No fate-probing here, unlike the quorum path's catch. The bytes on this route
    // are signed by Privy only AFTER the user's authorization verifies, so a failure
    // this early means nothing was signed and nothing reached the chain — which is
    // indistinguishable from what the user sees either way, so it does not need the
    // narrower story. Insufficient funds still has to be told apart: it is a 402.
    if (/insufficient|not enough|balance|exceeds/i.test(e instanceof Error ? e.message : String(e))) {
      throw new InsufficientFundsError();
    }
    throw e;
  }

  const signed = response.data?.signed_transaction;
  // An SDK change that renames this field would otherwise read as "the relay
  // succeeded", and the next thing broadcastSigned does is throw on `undefined`.
  // Named here so the failure says what actually broke.
  if (typeof signed !== "string") {
    throw new Error("Privy returned no signed transaction for an authorized user signature");
  }

  try {
    return awaitSettlement(await broadcastSigned(signed, from), pollMs);
  } catch (e) {
    // A relay that reached the node and lost its answer is the same problem as on
    // the quorum path, and gets the same treatment: only a PROVEN fate changes the
    // story, so a broadcast that may have landed is never reported as one that did
    // not. Insufficient funds is checked first — it arrives from the gas estimate
    // and would otherwise be swallowed by the indeterminate branch below.
    return orThrow(await classifySendFailure(e));
  }
}

// What a throw out of the signing or broadcast half MEANS, for both paths.
//
// Returns rather than throws, because one of the three answers is not an error at
// all: a broadcast that was lost in transit but turns out to have MINED resolves
// to a TxResult, and a helper that could only throw would have to report that as
// a failure — the exact mistake this classification exists to prevent. Callers
// narrow on `tx` and must not proceed otherwise.
//
// `error` is the failure to rethrow. A caller that ever returns it instead will
// look like a successful send, which is why the two call sites both read the same
// three lines and why SendFailure is a union rather than `TxResult | Error`.
type SendFailure = { tx: TxResult; error?: never } | { tx?: never; error: unknown };

async function classifySendFailure(e: unknown): Promise<SendFailure> {
  // Arc charges gas in USDC, so "not enough USDC" covers the amount and the gas
  // both, and the shortfall surfaces from the gas estimate as readily as from
  // the broadcast. Same detection the Circle backend does at lib/circle-dcw.ts:75.
  const raw = e instanceof Error ? e.message : JSON.stringify(e);
  if (/insufficient|not enough|balance|exceeds/i.test(raw)) return { error: new InsufficientFundsError() };

  // A CLAIMED WALLET REFUSING OUR SIGNATURE IS NOT A FAULT — it is the guarantee
  // working. Privy answers 401 because we revoked our own signer, and without this
  // the caller reports "Privy send failed: …401…", which reads as an outage and
  // sends someone hunting a credential bug that does not exist.
  //
  // Matched on the error rather than looked up in the row on purpose: every send
  // path reaches here, so one check covers all of them with no extra query, and it
  // stays correct for a wallet claimed a moment ago in another tab. It FAILS
  // CLOSED either way — the send already did not happen — so this only changes
  // what the failure says, never whether money moved.
  if (e instanceof AuthenticationError || /\b401\b|No valid authorization keys/i.test(raw)) {
    return {
      error: new NotOurWalletError(),
    };
  }

  // A BROADCAST THAT DID NOT ANSWER IS NOT A BROADCAST THAT DID NOT HAPPEN. The
  // bytes can be in the pool already — a lost response, a proxy 502, a rate
  // limiter that fired after the node took them — and the throw below reads to
  // every caller as "nothing moved", which is the mistake the verdict logic
  // fixed one layer down. So the chain is asked, by the same helper, and only a
  // PROVEN answer changes the story.
  const attempted = (e as { sent?: Sent }).sent;
  if (attempted) {
    const fate = await fateOfTx(attempted.hash, attempted);
    // The node had it all along: the receipt decides, exactly as on the ordinary
    // path above.
    if (fate === "success" || fate === "reverted") return { tx: settledOrThrow(attempted.hash, fate) };
    // "dropped" is not here on purpose — it proves the nonce went to different
    // bytes, so these can never mine, and the plain failure below is the truth.
    if (fate === "unknown") return { error: indeterminate(attempted.hash, e) };
  }

  // Matched on the full text above, reported without it: viem inlines the RPC URL,
  // and getUrl only strips basic-auth credentials, not a key in the path or query.
  // ARC_TESTNET_RPC is env-driven precisely so it can be a keyed endpoint, and
  // app/api/debts/[id]/pay/route.ts:114-117 hands this message to the caller.
  return { error: new Error(`Privy send failed: ${raw.replace(/\nURL: \S+/g, "")}`) };
}

// The three lines both catches run. Throws in every case but a proven settlement,
// which is the one answer that is not a failure.
function orThrow(classified: SendFailure): TxResult {
  if (classified.tx) return classified.tx;
  throw classified.error;
}

// Wait for the receipt, and decide what a wait that produced none is allowed to
// say. Extracted from send() unchanged, so both signers reach one copy of the
// verdict reasoning — the `dropped`/`indeterminate` distinction is what stops a
// failed send from handing back a daily cap that was really spent.
async function awaitSettlement(sent: Sent, pollMs: number): Promise<TxResult> {
  const { hash } = sent;
  try {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      timeout: pollMs,
      pollingInterval: 1_000,
      checkReplacement: false,
    });
    return settledOrThrow(hash, receipt.status);
  } catch (err) {
    // Probed only when the wait actually ran out: for any other error the answer is
    // fixed, and two more calls on an RPC that just failed would decide nothing. The
    // probe is bounded because the budget is nearly spent by here and a slow RPC is
    // precisely why the wait timed out — a probe that does not answer in time, or an
    // unreadable chain, leaves the verdict indeterminate, which is the answer that
    // never invents a settlement.
    const outcome =
      err instanceof WaitForTransactionReceiptTimeoutError
        ? await Promise.race([probeChain(sent, err), rejectAfter(PROBE_MS)]).catch(() => INDETERMINATE)
        : INDETERMINATE;

    if (outcome.verdict === "mined" && outcome.receipt) {
      return settledOrThrow(hash, outcome.receipt.status);
    }
    if (outcome.verdict === "dropped") {
      throw new Error(
        `Privy tx ${hash} was dropped before it mined — nonce ${sent.nonce} went to another transaction, nothing moved`,
        { cause: err },
      );
    }
    throw indeterminate(hash, err);
  }
}

// Every wallet is created with the key quorum as BOTH owner and additional signer.
//
// OWNER is what makes export possible at all, and it is the one thing that cannot
// be added later: an additional signer can spend but can never export or take
// ownership, and taking ownership is itself owner-gated (measured — see the spike
// table in the design doc). Every wallet minted before this change is therefore
// permanently non-exportable, which is why scripts/privy-remint.ts exists.
//
// ADDITIONAL SIGNER is what keeps the server transacting after the user takes
// ownership of export. A first spike run without it lost signing on transfer,
// because signing had been riding on ownership. With both set explicitly,
// spending and ownership are independent — the finding the whole design rests on.
//
// A function, not a const, so a missing quorum id fails the call that needed it
// rather than the import — this module is loaded lazily by the seam and must not
// throw on load.
//
// The namespace is a parameter because the AGENT wallet gets one thing no other
// wallet does: the enclave policy. Only at creation. An agent wallet minted before
// PRIVY_AGENT_POLICY_ID was set carries no policy and cannot be given one from
// here, which is why this carries no backfill.
// EXPORTED FOR THE TEST, not for callers — creation is the only place this can
// be got right. owner_id and the enclave policy are both creation-only, so a
// wallet minted with either one wrong is wrong forever and no backfill exists.
// That is why a pure shape function has a test at all.
export const walletSpec = (namespace: string, idempotencyKey: string) => ({
  chain_type: "ethereum" as const,
  owner_id: quorumId(),
  additional_signers: [
    {
      signer_id: quorumId(),
      // The agent is the one wallet a server spends from with no user in the
      // loop, so it is the one that gets an enclave-enforced ceiling. Pay wallets
      // are only ever spent on a request the user made.
      ...(namespace === "agent" && process.env.PRIVY_AGENT_POLICY_ID
        ? { override_policy_ids: [process.env.PRIVY_AGENT_POLICY_ID] }
        : {}),
    },
  ],
  idempotency_key: idempotencyKey,
});

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

// ── User key export ────────────────────────────────────────────────────────────
// Design: docs/superpowers/specs/2026-09-08-privy-key-export-design.md
//
// These are NOT part of the WalletBackend seam. The seam has four methods and a
// Circle implementation, and a fifth would need a throwing stub over there for a
// capability Circle DCW does not have at all — its keys cannot be exported. The
// route checks walletProviderName() and imports this module directly instead.

// Who Privy says owns this wallet. The privy_wallets.export_owner_key column is a
// cache of the user's public key; THIS is the authority, and it is what the status
// route asks when the cache is empty — a wallet Privy says we no longer own, with
// no key recorded, is a half-finished setup rather than a fresh wallet.
export async function getWalletOwnerId(walletId: string): Promise<string | null> {
  return (await privy().wallets().get(walletId)).owner_id;
}

// Hand ownership to the user's P-256 key. Signed by OUR quorum because at this
// point we are still the owner — this is the one and only call in the system that
// can make this transition, and it is not reversible: afterwards our quorum is
// only an additional signer, which can spend but can never export or take
// ownership back (measured; see the spec's spike table).
//
// Spending is UNAFFECTED. additional_signers is untouched by this call, and the
// probe in scripts/privy-export-probe.ts asserts the server still signs afterwards.
export async function transferExportOwnership(walletId: string, publicKeyBase64: string): Promise<string | null> {
  const updated = await privy()
    .wallets()
    .update(walletId, { owner: { public_key: publicKeyBase64 }, authorization_context: authorizationContext() });
  return updated.owner_id;
}

// THE CLAIM. Hand the wallet to the user's key and revoke our own signer, in ONE
// call, so that afterwards Splitsy holds no key to it at all.
//
// This is strictly stronger than transferExportOwnership above, and it is what
// makes the wallet non-custodial rather than merely user-exportable. That function
// moves ownership and leaves `additional_signers` alone on purpose — which is why
// the server can still spend after an export. Here both move together.
//
// ONE REQUEST, NOT TWO, and the atomicity is the entire point. Split apart, a
// failure between them lands on one of two bad states: the wallet is the user's but
// we can still spend it (a custody lie), or our signer is gone before ownership
// moved and NOBODY can sign — an unrecoverable brick, because taking ownership is
// itself owner-gated. Privy accepts `owner` and `additional_signers` in the same
// update (resources/wallets/wallets.d.ts:4869), so neither state is reachable.
//
// IRREVERSIBLE, and more so than anything else in this file. Afterwards our quorum
// is not an owner and not a signer, so there is no call we can make against this
// wallet that Privy will honour — measured in scripts/privy-claim-probe.ts: 401 on
// signTransaction, 401 on export, 0 signers remaining. A user who loses their
// password loses the wallet, and no support path exists or can exist.
//
// Returns what Privy reports back so the caller can verify rather than assume. The
// caller MUST check both fields: an SDK that silently dropped additional_signers
// from the request would return a wallet that still lists our quorum, and recording
// that as a claim is the custody lie in its most damaging form.
// WHETHER A CLAIM ACTUALLY LANDED, read from what Privy reported back.
//
// Pure, and separate from the call, because this is the judgement that must not be
// wrong: "claimed" is recorded in our own table and every other route trusts it to
// decide whether the server may sign. Two ways to be wrong, and they are not
// symmetric — reporting a failed claim as a success tells the user Splitsy holds no
// key while it still does, which is the custody lie in its most damaging form.
// Reporting a successful claim as a failure is merely confusing.
//
// So this demands positive evidence of BOTH halves: no signers left at all, and an
// owner that is neither absent nor our quorum. An SDK or API change that silently
// ignored `additional_signers: []` would answer 200 with our quorum still listed,
// and that must read as a failure rather than as a claim.
// EXPORTED FOR THE TEST, like walletSpec: the wrong answer here is unrecoverable
// and invisible, which is exactly what earns a pure function a test.
export function claimLanded(
  result: { ownerId: string | null; remainingSigners: number; quorumStillSigns: boolean },
  quorum: string,
  expectedOwnerId?: string,
): { ok: true } | { ok: false; reason: string } {
  if (result.quorumStillSigns) return { ok: false, reason: "Splitsy still holds a signer on this wallet." };
  if (result.remainingSigners > 0) return { ok: false, reason: "A signer other than you remains on this wallet." };
  if (!result.ownerId) return { ok: false, reason: "Privy reported no owner after the handover." };
  if (result.ownerId === quorum) return { ok: false, reason: "Ownership did not move off Splitsy's key quorum." };
  // When the caller created the owner quorum it knows exactly which id should come
  // back, so "not ours" is a weaker check than it needs to accept. An owner that is
  // neither ours nor the one we just made is a wallet handed to a third party, and
  // recording that as a successful claim would be the worst possible wrong answer.
  if (expectedOwnerId && result.ownerId !== expectedOwnerId) {
    return { ok: false, reason: "Ownership moved to a key quorum other than the one created for you." };
  }
  return { ok: true };
}

// The quorum that will own a claimed wallet.
//
// THRESHOLD 1 WITH TWO KEYS IS THE RECOVERY STORY, and it is measured rather than
// assumed — scripts/privy-quorum-probe.ts: each member produces a valid signature
// on its own, a key outside the quorum gets 401, and our own quorum gets 401 on
// both sign and export afterwards. A user unlocks with their passkey day to day
// and falls back to the recovery password if the device is lost; neither key can be
// held by us, because we never see either one.
//
// One key is allowed and is what a browser without PRF gets. That wallet has no
// recovery path, which is a fact the UI has to state rather than a case to hide.
//
// NOT REUSABLE ACROSS WALLETS. Each claim creates its own quorum: the keys are
// derived per wallet address (exportSalt), so two wallets never share a member, and
// a shared quorum would make one lost password a loss of several wallets.
export async function createOwnerQuorum(publicKeysBase64: string[], walletId: string): Promise<string> {
  if (publicKeysBase64.length === 0) throw new Error("A wallet cannot be claimed with no owner key");
  const created = await privy().keyQuorums().create({
    authorization_threshold: 1,
    display_name: `splitsy wallet ${walletId}`,
    public_keys: publicKeysBase64,
  });
  if (!created.id) throw new Error("Privy created an owner quorum with no id");
  // Verified rather than assumed: a threshold Privy did not honour would mean both
  // keys are required, and the user would discover that only when their recovery
  // password failed — at which point the wallet is already theirs and unfixable.
  if (created.authorization_threshold !== 1) {
    throw new Error(`Expected an owner quorum with threshold 1, got ${created.authorization_threshold}`);
  }
  if ((created.authorization_keys ?? []).length !== publicKeysBase64.length) {
    throw new Error(
      `Expected ${publicKeysBase64.length} owner key(s) on the quorum, got ${(created.authorization_keys ?? []).length}`,
    );
  }
  return created.id;
}

// Hand the wallet to an owner QUORUM and revoke our own signer, in ONE call.
//
// `ownerId` rather than a bare public key, which is what lets two keys own one
// wallet — a quorum of one is still a quorum, so this covers the password-only
// case too and there is exactly one way to claim.
//
// ONE REQUEST, NOT TWO, and the atomicity is the entire point. Split apart, a
// failure between them lands on one of two bad states: the wallet is the user's but
// we can still spend it (a custody lie), or our signer is gone before ownership
// moved and NOBODY can sign — an unrecoverable brick, because taking ownership is
// itself owner-gated. Privy accepts `owner_id` and `additional_signers` in the same
// update, so neither state is reachable.
//
// IRREVERSIBLE. Afterwards our quorum is neither owner nor signer, so there is no
// call we can make against this wallet that Privy will honour — measured in
// scripts/privy-claim-probe.ts and again in scripts/privy-quorum-probe.ts.
export async function claimOwnershipByQuorum(
  walletId: string,
  ownerQuorumId: string,
): Promise<{ ownerId: string | null; remainingSigners: number; quorumStillSigns: boolean }> {
  const quorum = quorumId();
  const updated = await privy().wallets().update(walletId, {
    owner_id: ownerQuorumId,
    additional_signers: [],
    authorization_context: authorizationContext(),
  });
  const signers = updated.additional_signers ?? [];
  return {
    ownerId: updated.owner_id,
    remainingSigners: signers.length,
    quorumStillSigns: signers.some((s) => s.signer_id === quorum),
  };
}

// Relay, not reader. The recipient_public_key belongs to the USER'S TAB and the
// signature was produced there over a payload containing it, so we can neither
// substitute a recipient key we could decrypt (the signature would not verify) nor
// open what comes back.
//
// DELIBERATELY the raw generated _export, not wallets().exportPrivateKey() or
// .exportSeedPhrase() or .export(). Those three generate the HPKE recipient
// keypair ON THIS SERVER and return the private key in plaintext
// (public-api/services/wallets.js:94-121) — the exact outcome this design exists
// to prevent. They are also the ones you will find first when grepping for
// "export". Do not use them.
export async function exportWalletCiphertext(
  walletId: string,
  recipientPublicKey: string,
  authorizationSignature: string,
): Promise<{ ciphertext: string; encapsulated_key: string }> {
  const response = await privy().wallets()._export(walletId, {
    encryption_type: "HPKE",
    recipient_public_key: recipientPublicKey,
    "privy-authorization-signature": authorizationSignature,
  });
  // Only these two fields, explicitly. Whatever else the response carries has no
  // business reaching a browser.
  return { ciphertext: response.ciphertext, encapsulated_key: response.encapsulated_key };
}

// The USDC transfer calldata, encoded in ONE place. transferUsdc below uses it for
// the quorum-signed path and prepareUserSignedTransfer for the user-signed one, so
// the bytes the browser authorizes are the bytes the server would have sent.
const transferCalldata = (to: string, amountUsdc: string) =>
  encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    // Supabase returns numeric as a JS number, so stringify before parsing.
    args: [getAddress(to), parseUnits(String(amountUsdc), 6)],
  });

// The unsigned transaction a USER will authorize. Server-side because the nonce and
// the gas are chain reads, and ARC_TESTNET_RPC is env-driven precisely so it can be
// a keyed endpoint that never reaches a browser. The returned object is relayed back
// verbatim, so it is untouched between here and the signature.
export async function prepareUserSignedTransfer(
  walletId: string,
  to: string,
  amountUsdc: string,
): Promise<Prepared> {
  return prepareTransfer(
    getAddress((await privy().wallets().get(walletId)).address),
    ARC_TESTNET_USDC,
    transferCalldata(to, amountUsdc),
  );
}

// The general form: any contract call, prepared for the user to sign.
//
// prepareUserSignedTransfer above is this with the calldata already chosen. Kept
// separate because a bare USDC transfer is the one shape with a helper on the
// WalletBackend seam, and collapsing them would make every caller build calldata
// for the common case.
export async function prepareUserSignedCall(
  walletId: string,
  to: `0x${string}`,
  data: `0x${string}`,
): Promise<Prepared> {
  return prepareTransfer(getAddress((await privy().wallets().get(walletId)).address), to, data);
}

export const backend: WalletBackend = {
  // Our own table is the idempotency, not a Privy query. Every caller already
  // guards on a row of its own (lib/oauth-callback.ts:90, lib/wallet-resolve.ts,
  // lib/user-agent.ts); this is the net under that.
  async getOrCreateWallet(namespace: string, key: string): Promise<ProviderWallet | null> {
    const existing = await getPrivyWallet(namespace, key);
    if (existing) return { address: existing.address, walletId: existing.wallet_id };

    // create() is not idempotent on its own, and the IDEMPOTENCY KEY is what
    // replaces the users().getByCustomAuthID lookup this used to do: a retry —
    // one whose row insert failed, say — gets the SAME wallet back for 24 hours
    // rather than minting a second one and orphaning whatever the first was
    // funded with. Beyond that window our own row is the guard it always was, and
    // a wallet whose row never landed was never returned to a caller, so it was
    // never displayed and never funded.
    const wallet = await privy().wallets().create(walletSpec(namespace, `splitsy:${namespace}:${key}`));

    // Without a wallet id the server cannot sign, so stop here rather than after
    // somebody has funded an address that can never spend.
    if (!wallet.id) {
      throw new Error(
        `Privy wallet ${wallet.address} has no wallet id, so the server cannot sign for it — check ` +
          "PRIVY_KEY_QUORUM_ID, and that this PRIVY_APP_ID owns the wallet.",
      );
    }

    await insertPrivyWallet({ namespace, key, wallet_id: wallet.id, address: wallet.address });
    // Re-read rather than returning what WE got from Privy. Two concurrent
    // first-time resolutions of one key both miss the row and both create, and
    // ignoreDuplicates makes the loser's write a silent no-op — so the loser would
    // otherwise hand its own wallet to lib/oauth-callback.ts:100 to persist and
    // display while the table holds the winner's, and money sent to it would be
    // invisible to every later lookup. The idempotency key makes them the same
    // wallet inside the 24-hour window; outside it, this is still the tiebreak.
    const row = await getPrivyWallet(namespace, key);
    return row
      ? { address: row.address, walletId: row.wallet_id }
      : { address: wallet.address, walletId: wallet.id };
  },

  transferUsdc(walletId, to, amountUsdc) {
    return send(walletId, ARC_TESTNET_USDC, transferCalldata(to, amountUsdc));
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

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
    // Arc charges gas in USDC, so "not enough USDC" covers the amount and the gas
    // both, and the shortfall surfaces from the gas estimate as readily as from
    // the broadcast. Same detection the Circle backend does at lib/circle-dcw.ts:75.
    const raw = e instanceof Error ? e.message : JSON.stringify(e);
    if (/insufficient|not enough|balance|exceeds/i.test(raw)) throw new InsufficientFundsError();

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
      if (fate === "success" || fate === "reverted") return settledOrThrow(attempted.hash, fate);
      // "dropped" is not here on purpose — it proves the nonce went to different
      // bytes, so these can never mine, and the plain failure below is the truth.
      if (fate === "unknown") throw indeterminate(attempted.hash, e);
    }

    // Matched on the full text above, reported without it: viem inlines the RPC URL,
    // and getUrl only strips basic-auth credentials, not a key in the path or query.
    // ARC_TESTNET_RPC is env-driven precisely so it can be a keyed endpoint, and
    // app/api/debts/[id]/pay/route.ts:114-117 hands this message to the caller.
    throw new Error(`Privy send failed: ${raw.replace(/\nURL: \S+/g, "")}`);
  }

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

// Every wallet is created with the key quorum as an additional signer; that is
// what lets the server transact later with no user present. A function, not a
// const, so a missing quorum id fails the call that needed it rather than the
// import — this module is loaded lazily by the seam and must not throw on load.
//
// The namespace is a parameter because the AGENT wallet gets one thing no other
// wallet does: the enclave policy. Keyed here rather than at one call site
// because both creation paths in getOrCreateWallet mint wallets — an identity
// that outlived a failed wallet creation gets its wallet from
// pregenerateWallets — and a policy on only one of them would be a coin flip.
//
// Only at creation. An agent wallet minted before PRIVY_AGENT_POLICY_ID was set
// carries no policy and cannot be given one from here; on a fresh deployment
// there are none, which is why this carries no backfill.
const walletSpec = (namespace: string) => [
  {
    chain_type: "ethereum" as const,
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
];

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
// Asked ONLY about a wallet that predates this call. Anything we create ourselves is
// created with walletSpec(), so it carries the quorum by construction, and asking
// would put a read-after-write on the signup path — if a fresh wallet's signers are
// not immediately readable, every first-time signup on this stack would throw instead
// of returning a wallet. An adopted wallet is the real hazard: a foreign quorum looks
// perfectly fine until the first signature answers 401, possibly after funding.
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
    // Whether the wallet we end up with predates this call, which is the only case
    // serverCanSign is asked about. A lookup hit means it might; anything we create
    // below carries our quorum by construction.
    let adopted = true;
    try {
      user = await privy().users().getByCustomAuthID({ custom_user_id });
    } catch (caught) {
      if (!(caught instanceof NotFoundError)) throw caught;
      adopted = false;
      user = await privy()
        .users()
        .create({ linked_accounts: [{ type: "custom_auth", custom_user_id }], wallets: walletSpec(namespace) });
    }

    // The identity can outlive a call whose wallet creation failed (a bad quorum
    // id, say). Without this, that key is a dead end no retry gets past.
    let wallet = ethereumWallet(user);
    if (!wallet) {
      adopted = false;
      wallet = ethereumWallet(await privy().users().pregenerateWallets(user.id, { wallets: walletSpec(namespace) }));
    }
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
    if (adopted && !(await serverCanSign(wallet.id))) {
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

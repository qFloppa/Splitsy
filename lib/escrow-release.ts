// The last mile of the escrow rail: someone who was tagged on an IOU before they
// had a wallet signs in, proves the handle, and their money comes to them.
//
// THE SAME SENTENCE resolveDebtsForHandle ALREADY SAYS, with money attached —
// "you proved who you are, take what is tagged with your handle". So it runs
// beside that call in finishProviderLogin's shared tail, which is what makes it
// cover the Privy route and the OAuth routes at once.
//
// WHY THE RELEASE IS SIGNED RATHER THAN SENT BY A PRIVILEGED CALLER.
// HandleEscrow.release is PERMISSIONLESS: the contract checks an attester
// signature over (id, to, deadline), not who sent the transaction. So the
// authority to move money lives in a signature and nowhere else, and the key
// that makes it (ESCROW_ATTESTER_PRIVATE_KEY) never has to be a transaction
// sender at all — it is used in-process to sign and then dropped. The rejected
// alternative was a stored "owner" address the contract consults, which folds
// the signer and the sender into one key and leaves the whole escrow one stolen
// hot key away from being drained. What this design does NOT concede: money
// this escrow was never given, and a depositor's {reclaim}, which no signature
// can block. What it DOES concede, said plainly rather than softened: a stolen
// attester key can misdirect every deposit the escrow currently holds, one
// signature per id. Treat this key as money.
//
// THE RELEASER WALLET NEEDS USDC, AND NOT FOR THE AMOUNT BEING RELEASED.
// Arc charges gas in USDC, so the `splitsy`/`escrow-releaser` wallet this relays
// through cannot submit a release at all while it holds nothing. An unfunded
// releaser is indistinguishable from "escrow is broken" from the outside, and it
// fails silently on every sign-in — which is why it is called out here and in
// the plan's Step 6.
//
// NEVER THROWS. This runs inside a login: a release that fails must cost the
// login nothing, exactly like the debt linking beside it. And one deposit
// failing must not strand the next — the row stays 'open' and the next sign-in
// retries it, so the work is idempotent by construction rather than by tracking.
//
// Pure enough to unit-test: value imports are relative and carry the extension
// (the db and wallet modules are reached lazily from the deps object below), so
// `node --test` loads this file with no database, no SDK and no chain. Same rule
// and same reason as lib/handle-escrow.ts and lib/wallet-resolve.ts.
import { encodeRelease, releaseDomain, RELEASE_TYPES } from "./handle-escrow.ts";
import type { IdentityProvider } from "./types";
import { ARC } from "./arc-chain.ts";

// Whichever Arc this deployment is on. Also what releaseDomain binds the
// signature to, so a signature made for this deployment cannot be replayed
// against another chain — which now includes the other Arc. A release signed on
// testnet is rejected by a mainnet escrow and vice versa, by the contract, not
// by us.
const ARC_CHAIN_ID = ARC.chainId;

// Long enough to survive a slow block on Arc, short enough that a signature
// leaked from a log dies quickly. The contract enforces the deadline, so a
// clock-skewed server fails releases rather than minting ones that never expire.
const RELEASE_WINDOW_SECONDS = 600n;

// Injection seam, same pattern and same reason as ResolveDeps in
// lib/wallet-resolve.ts: the side-effecting calls are stubbed so the decision
// layer — who to pay, in what order, and what a failure means — can be tested
// under `node --test` with no database, no Privy and no chain.
export type ReleaseDeps = {
  getOpenDeposits: (
    provider: string,
    handle: string,
  ) => Promise<{ escrow_address: string; deposit_id: string; amount_usdc: string }[]>;
  signRelease: (escrowAddress: string, depositId: string, to: string, deadline: bigint) => Promise<string>;
  // `data` is an OPAQUE RELAYER PAYLOAD, not yet calldata. See ReleasePayload:
  // encoding here rather than in the loop is deliberate.
  relay: (escrowAddress: string, depositId: string, data: string) => Promise<{ txHash: string | null }>;
  markReleased: (escrowAddress: string, depositId: string, txHash: string | null) => Promise<void>;
};

// What the decision layer hands the relayer: everything the calldata needs, none
// of it encoded yet.
//
// WHY THE ENCODING IS NOT DONE IN THE LOOP, which is the one place this deviates
// from the obvious shape. encodeRelease goes through viem, which VALIDATES the
// recipient address and throws on anything that is not 20 bytes of hex. The loop
// is the part unit tests drive with stubbed deps, so encoding there would make
// the decision layer fail on the placeholder address a test hands it — before
// the relay it is testing was ever called, and for a reason that has nothing to
// do with the decision being tested. Building calldata is also a chain-shaped
// concern: it belongs to the component that talks to the chain, next to the
// sender that has to be funded. So the loop decides and sequences, the relayer
// encodes.
type ReleasePayload = { to: string; deadline: string; signature: string };

async function signRelease(
  escrowAddress: string,
  depositId: string,
  to: string,
  deadline: bigint,
): Promise<string> {
  const { privateKeyToAccount } = await import("viem/accounts");
  const key = process.env.ESCROW_ATTESTER_PRIVATE_KEY ?? "";
  // Read at call time, never at module load: an unset key must fail the one
  // release that needs it, not crash every route that imports this file. Gated
  // on the shape rather than truthiness, so a truncated key is this message
  // instead of a raw viem parse error naming nothing.
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("Missing or malformed ESCROW_ATTESTER_PRIVATE_KEY");
  }
  const account = privateKeyToAccount(key as `0x${string}`);
  return account.signTypedData({
    // THE DOMAIN COMES FROM THE ROW'S OWN escrow_address, not from the configured
    // NEXT_PUBLIC_HANDLE_ESCROW_ADDRESS. The address is part of the domain
    // separator, so signing against the wrong one yields a signature the contract
    // rejects — and the row is the only thing that knows which escrow a deposit
    // id belongs to, since ids restart at 1 in every deployment.
    domain: releaseDomain(ARC_CHAIN_ID, escrowAddress as `0x${string}`),
    types: RELEASE_TYPES,
    primaryType: "Release",
    message: { id: BigInt(depositId), to: to as `0x${string}`, deadline },
  });
}

const realDeps: ReleaseDeps = {
  // Lazy import: escrow-deposits-repo.ts uses "@/lib/..." aliases internally,
  // which only resolve under Next's bundler — not under node --test. Deferring
  // the import to call time lets tests load this module with injected deps.
  getOpenDeposits: async (provider, handle) => {
    const { getOpenDeposits } = await import("./escrow-deposits-repo.ts");
    return getOpenDeposits(provider, handle);
  },
  signRelease,
  relay: async (escrowAddress, depositId, data) => {
    // Lazy for the same reason as above, plus one of its own: wallet-provider.ts
    // reaches for whichever wallet SDK this deployment runs, and a login should
    // only load that when there is actually a release to send.
    const { executeContract, getOrCreateWallet } = await import("./wallet-provider.ts");
    const { getEscrowDepositOnchain } = await import("./arc-read.ts");

    // ASK BEFORE PAYING TO BE TOLD NO. A row stays 'open' forever when its
    // deposit left by another door — reclaimed by its sender, or released on an
    // attempt whose bookkeeping write failed — and nothing watches for either.
    // Submitting the release anyway means a transaction that reverts with
    // NoSuchDeposit, and Arc charges gas in USDC for a revert, so the releaser
    // would pay for that same refusal on every later sign-in of this handle,
    // forever. A read costs nothing and answers the same question: zero is the
    // contract's own "gone", because both exits delete the struct.
    const held = await getEscrowDepositOnchain(BigInt(depositId), escrowAddress as `0x${string}`);
    if (held.amount === 0n) {
      throw new Error(`Deposit ${depositId} is no longer held by ${escrowAddress} — nothing to release`);
    }

    const payload = JSON.parse(data) as ReleasePayload;
    const callData = encodeRelease(
      BigInt(depositId),
      payload.to as `0x${string}`,
      BigInt(payload.deadline),
      payload.signature as `0x${string}`,
    );
    // The same server-wallet identity the Gateway settler uses, so the one
    // address an operator has to keep funded for escrow is the one named here.
    const wallet = await getOrCreateWallet("splitsy", "escrow-releaser");
    if (!wallet) throw new Error("No escrow-releaser wallet — the wallet provider is not configured");
    const tx = await executeContract(wallet.walletId, escrowAddress as `0x${string}`, callData);
    // A revert arrives as a throw out of both backends (they refuse a FAILED
    // receipt rather than hand back a hash), so reaching this line means the
    // money moved. txHash is null when the backend accepted the transaction but
    // cannot name it yet — the row records that honestly rather than inventing a
    // hash.
    return { txHash: tx.txHash };
  },
  markReleased: async (escrowAddress, depositId, txHash) => {
    const { markDepositReleased } = await import("./escrow-deposits-repo.ts");
    return markDepositReleased(escrowAddress, depositId, txHash);
  },
};

/**
 * Pay out every open deposit filed under this (provider, handle) to the wallet
 * that just proved the handle is theirs.
 *
 * Called at login, which is the only moment this is safe: the handle has just
 * been proven by an OAuth round trip or a verified Privy token, and the handle is
 * the entire claim. `userId` is NOT part of that claim — it is carried for the
 * log line, so an operator reading a failure knows whose sign-in produced it.
 *
 * Best-effort throughout: it never throws, so a caller may await it in a login
 * path without a try/catch of its own. Every caller wraps it anyway, in the same
 * shape as the debt linking beside it, because "never throws" is a property of
 * this function that a future edit could quietly lose.
 */
export async function releaseEscrowForHandle(
  userId: string,
  provider: IdentityProvider,
  handle: string,
  walletAddress: string | null,
  deps: ReleaseDeps = realDeps,
): Promise<void> {
  // THE GUARD IS FIRST, BEFORE ANYTHING SIGNS OR READS. The Privy route calls
  // finishProviderLogin twice: once the instant authentication flips true, when
  // createOnLogin has not built the wallet yet, and again once it has. Without
  // this the first pass would sign a release to a null address — spending the one
  // signature that deposit gets and leaving the second pass to find the row
  // already marked released. There is also genuinely nothing to pay yet: the
  // money belongs to a wallet, and no wallet exists.
  if (!walletAddress) return;

  try {
    const deposits = await deps.getOpenDeposits(provider, handle);

    for (const deposit of deposits) {
      // One deposit's failure is CONTAINED HERE, inside the loop, and that is the
      // whole point: a batch whose first entry is stale must still pay the rest.
      // Deliberately sequential rather than Promise.all — a rejection in one
      // would take its siblings down with it, and there is nothing to gain by
      // racing the chain.
      try {
        const deadline = BigInt(Math.floor(Date.now() / 1000)) + RELEASE_WINDOW_SECONDS;
        // The signature is over (id, to, deadline) ONLY. amount_usdc on the row is
        // not signed and not sent: the contract pays what it holds for that
        // deposit, so a client-supplied amount must have nothing to do with it.
        const signature = await deps.signRelease(deposit.escrow_address, deposit.deposit_id, walletAddress, deadline);
        const payload: ReleasePayload = { to: walletAddress, deadline: deadline.toString(), signature };
        const { txHash } = await deps.relay(deposit.escrow_address, deposit.deposit_id, JSON.stringify(payload));
        // ONLY ON SUCCESS. The chain is the authority on whether the money moved,
        // so the row is updated after it says so and never before — a row marked
        // 'released' for a release that reverted would hide a live deposit from
        // every later sign-in.
        await deps.markReleased(deposit.escrow_address, deposit.deposit_id, txHash);
      } catch (releaseErr) {
        // Reads as expected rather than alarming, because on this rail it often
        // IS expected: a deposit that left by another door — reclaimed by its
        // sender, or released on an attempt whose row write failed — keeps its
        // 'open' row forever (the table's status constraint has only 'open' and
        // 'released' and nothing watches for Reclaimed), so "no longer held" on a
        // stale row is the design working, not breakage. Nothing to clean up and
        // nothing to retry here — the row stays 'open' and the next sign-in runs
        // this same pass, which costs a chain read and no gas.
        console.error(
          `Escrow release for ${provider}:${handle} failed for deposit ${deposit.deposit_id} (login continues):`,
          releaseErr,
        );
      }
    }
  } catch (err) {
    // The whole pass is wrapped too, not just each deposit: getOpenDeposits can
    // reject (Supabase down, table missing) and a dep can fail in a way the inner
    // catch never sees. This function is awaited inside a login, so an escaping
    // rejection would surface as a failed sign-in for a reason the user cannot
    // act on.
    console.error(`Escrow release pass for ${provider}:${handle} failed (login continues, user ${userId}):`, err);
  }
}

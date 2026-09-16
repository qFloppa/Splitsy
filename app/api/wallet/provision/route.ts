import { cookies } from "next/headers";
import { accountSalt } from "@/lib/export-crypto";
import {
  createOwnerQuorum,
  exportWalletCiphertext,
  getWalletAddress,
  mintUserOwnedWallet,
  sweepAmountUsdc,
  usdcBalanceOf,
} from "@/lib/privy-wallet";
import { getPrivyWallet, insertPrivyWallet, setClaimed } from "@/lib/privy-wallets-repo";
import { getPendingWallet } from "@/lib/pending-wallets-repo";
import { getSessionUser } from "@/lib/session";
import { verifyWalletUnlock, WALLET_UNLOCK_COOKIE } from "@/lib/session-core";
import { setUserWallet } from "@/lib/users-repo";
import { transferUsdc, walletProviderName } from "@/lib/wallet-provider";
import { json } from "@/lib/wallet-gate";
import type { IdentityProvider } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Mint this user's pay wallet, owned by THEIR keys, at first visit.
//
// THIS IS WHY THERE IS NO "TAKE OWNERSHIP" ANY MORE. The wallet used to be minted
// during the OAuth callback with our quorum as owner and signer, before a browser
// existed to hold a key — so every later ceremony was a handover, and a handover
// admits there was a window in which Splitsy could export the key. Here the keys
// exist BEFORE the wallet does: the browser makes them, we mint under a quorum of
// them, and Splitsy is never owner and never a signer.
//
// Measured, in scripts/privy-quorum-probe.ts: our quorum gets 401 on sign and 401
// on export from the very first call, while the owner signs immediately.
//
// NOT the same call as getOrCreateWallet. Agent and service wallets still mint
// custodially on purpose — autopay has to run with nobody present — and this route
// only ever mints a pay wallet.
//
// TWO PHASES, ONE ROUTE. A request without a signature MINTS and answers the
// wallet id; the request that follows carries the proof over that id and is the
// one that records anything. The split is forced rather than chosen: the proof
// signs Privy's export URL, which names the wallet, so the browser cannot build it
// before Privy has assigned an id. app/wallet-setup.ts:provisionWallet holds the
// full reasoning, including what was rejected.
//
// The phases share a route because they share every precondition — stack, session,
// PIN, and "this user has no wallet yet". Two routes would be two copies of that
// gate, and the failure mode of a missed copy is a stranger minting wallets onto
// someone else's account.

function isSpkiBase64(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 256 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    const bytes = Buffer.from(value, "base64");
    return bytes.length === 91 && bytes[0] === 0x30 && bytes[1] === 0x59;
  } catch {
    return false;
  }
}

function isDerSignatureBase64(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 256 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    const bytes = Buffer.from(value, "base64");
    return bytes.length >= 64 && bytes.length <= 80 && bytes[0] === 0x30;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  // The gate is inlined rather than walletGate's, because that one REQUIRES a
  // provisioned wallet — which is precisely what this route is here to create.
  if (walletProviderName() !== "privy") {
    return json({ error: "Wallet setup is not available on this wallet stack." }, 404);
  }
  const user = await getSessionUser();
  if (!user) return json({ error: "Not signed in" }, 401);

  // Same PIN gate as every other wallet action. Minting is not spending, but the
  // keys handed over here own the wallet forever, and a hijacked session should
  // not be able to plant one.
  const secret = process.env.SESSION_SECRET ?? "";
  const unlockToken = (await cookies()).get(WALLET_UNLOCK_COOKIE)?.value ?? "";
  if (verifyWalletUnlock(unlockToken, secret, Date.now()) !== user.id) {
    return json({ error: "locked" }, 403);
  }

  // ALREADY PROVISIONED IS A REFUSAL, NOT AN OVERWRITE. Minting a second wallet
  // for a user who has one would orphan the first — along with anything in it and
  // every on-chain bill naming its address.
  if (user.circle_wallet_id || user.wallet_address) {
    return json({ error: "This account already has a wallet." }, 409);
  }

  const body = (await request.json().catch(() => null)) as {
    walletId?: unknown;
    publicKey?: unknown;
    recoveryPublicKey?: unknown;
    passkeyCredentialId?: unknown;
    recipientPublicKey?: unknown;
    signature?: unknown;
  } | null;

  if (!isSpkiBase64(body?.publicKey)) {
    return json({ error: "Expected a base64 SPKI P-256 public key." }, 400);
  }
  if (body?.recoveryPublicKey !== undefined && body.recoveryPublicKey !== null && !isSpkiBase64(body.recoveryPublicKey)) {
    return json({ error: "Expected a base64 SPKI P-256 recovery key." }, 400);
  }
  const { publicKey } = body;
  const recoveryPublicKey = typeof body.recoveryPublicKey === "string" ? body.recoveryPublicKey : null;
  if (recoveryPublicKey && recoveryPublicKey === publicKey) {
    return json({ error: "Your recovery key must differ from your passkey." }, 400);
  }
  const ownerKind = recoveryPublicKey ? "passkey+password" : "password";

  // The salt the browser derived these keys with, recomputed from the SESSION
  // rather than read off the request. A client-supplied salt would only ever
  // mislead its own owner, but this value is what makes the key reproducible
  // tomorrow, so it comes from the same place the row's primary key does.
  const salt = accountSalt(user.provider, user.provider_user_id);

  try {
    // ── Phase 1: mint ──────────────────────────────────────────────────────────
    // Nothing is recorded here, so an abandoned attempt costs an empty Privy
    // wallet that no row references and nothing can route money to.
    if (body.signature === undefined) {
      // The owner quorum, from keys only the browser has held. Threshold 1, so
      // either the passkey or the recovery password signs alone.
      const ownerQuorumId = await createOwnerQuorum(
        recoveryPublicKey ? [publicKey, recoveryPublicKey] : [publicKey],
        `user:${user.id}`,
      );

      // The wallet. Theirs from this moment; we could not sign it if we tried.
      //
      // THE QUORUM ID IS IN THE IDEMPOTENCY KEY, which makes every mint attempt a
      // distinct request — and that is the intent. Keyed on the account alone, a
      // user retrying after a failed proof (the recovery path, and worthless unless
      // it can use different keys) would send new keys under the old key, get
      // Privy's FIRST wallet back, and trip mintUserOwnedWallet's owner check:
      // stuck for the whole 24-hour window with nothing that would move them on.
      //
      // So nothing here collapses two calls into one wallet — a fresh quorum id per
      // call means there is no key for Privy to match on. What prevents a double
      // submit from recording two wallets is downstream, in phase 2: the row is
      // claimed by an upsert and read back, and the loser stops before it writes a
      // pointer. Two orphan wallets and one recorded is the worst case.
      const wallet = await mintUserOwnedWallet(
        ownerQuorumId,
        `splitsy:${user.provider}:${user.provider_user_id}:${ownerQuorumId}`,
      );

      return json({
        walletId: wallet.walletId,
        // Not a secret: it is in every Privy request the browser's signature
        // covers, and the browser cannot build that signature without it.
        appId: process.env.PRIVY_APP_ID ?? "",
      });
    }

    // ── Phase 2: prove, then record ────────────────────────────────────────────
    if (typeof body.walletId !== "string" || !body.walletId || body.walletId.length > 128) {
      return json({ error: "Expected the wallet id from the mint step." }, 400);
    }
    if (!isSpkiBase64(body.recipientPublicKey) || !isDerSignatureBase64(body.signature)) {
      return json({ error: "Expected the proof: a recipient key and a signature." }, 400);
    }
    const { walletId, recipientPublicKey, signature } = body;

    // 1. PROVE IT WORKS BEFORE ANYTHING POINTS AT IT. The same prove-before-record
    //    rule the claim path learned (76b912a), and it matters more here: if the
    //    user's key cannot actually open this wallet, we must not hand them an
    //    address and start routing money to it. A failure leaves an orphaned,
    //    unfunded Privy wallet and no row — which is harmless and re-runnable.
    //
    //    This is also the only check on the wallet id the browser sent back. It
    //    needs no other: the export only succeeds for a wallet whose owner signed
    //    this request, so a caller naming someone else's wallet gets a 401 from
    //    Privy, and a caller naming a wallet they genuinely own is describing the
    //    truth — theirs, signable by them, which is all this route ever promises.
    await exportWalletCiphertext(walletId, recipientPublicKey, signature);

    // 2. The address, from Privy rather than from the request: it is where money
    //    will be sent, so it comes from the party that assigned it.
    const address = await getWalletAddress(walletId);

    // 3. The sweep. A pre-minted wallet exists when somebody tagged this handle on
    //    a bill before they ever signed in — the money needed an address and no key
    //    of theirs could exist yet, so we held one. It is a HOLDING ADDRESS, never
    //    their wallet: swept here and abandoned.
    //
    //    Its failure is deliberately NOT fatal. The wallet above is already theirs
    //    and already proven; refusing to finish because a sweep failed would leave
    //    them with no wallet at all over money that is still sitting safely where
    //    it was. Reported instead, and the pending row survives for a retry.
    //
    //    ponytail: sweeps the USDC BALANCE and nothing else, and that is now all it
    //    needs to do. It used to leave a gap: an on-chain position bound to the
    //    holding address — a share this handle owes on a bill created before they
    //    signed in — stayed bound to an address their wallet is not, and every
    //    pay/claim/refund route read the chain by users.wallet_address alone, so it
    //    answered "You're not a participant on this bill." Measured on bill 64,
    //    2026-09-15.
    //
    //    That is closed elsewhere rather than here, and without settling anything:
    //    the routes now ALSO read the holding address, via getSlotWalletForUser
    //    (lib/pending-wallets-repo.ts). A debt filed under it is paid with
    //    payDebtFor from the user's own wallet, and a failed all-or-nothing bill is
    //    refunded out of it by lib/slot-refund.ts. So the address keeps its
    //    positions and stays findable — which is why the pending row is no longer
    //    deleted below.
    let swept: { amountUsdc: number; txHash: string | null } | null = null;
    let sweepError: string | null = null;
    const pending =
      user.provider && user.provider !== "wallet"
        ? await getPendingWallet(user.provider as IdentityProvider, user.handle).catch(() => null)
        : null;

    if (pending) {
      try {
        // Arc charges gas in USDC, so a full-balance sweep always reverts —
        // sweepAmountUsdc leaves the reserve behind and answers 0 for dust.
        const amount = sweepAmountUsdc(await usdcBalanceOf(pending.wallet_address));
        if (amount > 0) {
          const tx = await transferUsdc(pending.circle_wallet_id, address, amount.toFixed(6));
          swept = { amountUsdc: amount, txHash: tx.txHash };
        }
      } catch (err) {
        sweepError = err instanceof Error ? err.message : "The sweep failed.";
      }
    }

    // 4. Record it. ORDER MATTERS and mirrors scripts/privy-remint.ts:200-209: the
    //    wallet row and the user pointer first, the pending row deleted LAST. A
    //    crash before that delete leaves the pending row intact, so the sweep can
    //    be re-run; a crash after it would leave money in an address nothing
    //    references.
    // (namespace, key) = (provider, provider_user_id), the SAME composite
    // getOrCreateWallet uses (lib/oauth-callback.ts:100 passes
    // profile.providerUserId). Keying on users.id instead would write a row no
    // existing reader could ever find.
    await insertPrivyWallet({
      namespace: user.provider,
      key: user.provider_user_id,
      wallet_id: walletId,
      address,
    });

    // THE UPSERT IGNORES DUPLICATES, SO IT REPORTS NOTHING — read the row back and
    // check it is ours. The same re-read lib/privy-wallet.ts does after its own
    // insert, and here it is what stops two tabs finishing setup from leaving the
    // user pointed at one wallet while the row names another: a state walletGate
    // reads as "not provisioned", locking them out of both. The loser stops before
    // it writes a pointer, and the winner's wallet is the one that counts.
    const recorded = await getPrivyWallet(user.provider, user.provider_user_id);
    if (recorded && recorded.wallet_id !== walletId) {
      return json({ error: "Your wallet was already set up — reload to see it." }, 409);
    }

    // Born claimed. There was never a custodial phase to record the absence of.
    await setClaimed(user.provider, user.provider_user_id, publicKey, {
      ownerKind,
      passkeyCredentialId: typeof body.passkeyCredentialId === "string" ? body.passkeyCredentialId : null,
      // Written in the SAME statement as the key it belongs to. A key recorded
      // without its salt is a key nobody can re-derive.
      salt,
    });
    await setUserWallet(user.id, address, walletId);

    // THE PENDING ROW IS KEPT, and that is a change from what this used to do.
    //
    // It was deleted here once the sweep had emptied the address, on the reasoning
    // that an emptied holding wallet is an orphan. That reasoning missed what the
    // `ponytail:` note above spells out: a bill created before this person signed in
    // names the SLOT as its debtor, and that binding is on chain and permanent. The
    // row is the only record of which slot belongs to which handle, so deleting it
    // makes those debts unfindable — the settle deck, /api/dashboard,
    // [billId]/pay and [billId]/refund all locate them through
    // getSlotWalletForUser, which reads exactly this row.
    //
    // Nothing depends on it being gone. resolveParticipantAddress prefers
    // users.wallet_address, so a kept row never diverts a new bill; the Circle
    // adoption path in lib/oauth-callback.ts deletes its own row by that row's key
    // and is unaffected; and this route is Privy-only.
    void pending;

    return json({
      ok: true,
      address,
      ownerKind,
      swept,
      // Surfaced rather than swallowed: the user's wallet works either way, but
      // money they were sent before joining has not moved yet and they should know.
      sweepError,
    });
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : "Could not set up your wallet. Please try again." },
      502,
    );
  }
}

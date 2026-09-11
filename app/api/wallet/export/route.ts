import {
  exportWalletCiphertext,
  getWalletOwnerId,
  transferExportOwnership,
} from "@/lib/privy-wallet";
import { setExportOwnerKey } from "@/lib/privy-wallets-repo";
import { json, claimEnabled, walletGate } from "@/lib/wallet-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Wallet key export. THE SERVER IS A RELAY, NOT A READER: the recipient key and
// the authorization signature are both made in the user's tab, and what comes back
// is ciphertext addressed to a private key only that tab holds.
//
// Design: docs/superpowers/specs/2026-09-08-privy-key-export-design.md
//
// The gate, the no-store header and the JSON helper live in lib/wallet-gate.ts,
// shared with app/api/wallet/claim — these are the checks that decide whether a
// caller may act on someone's wallet, and one copy is the point.

// Base64 that decodes to a 91-byte P-256 SPKI: SEQUENCE tag, 89-byte body, then a
// 27-byte DER prefix and the 64-byte point. Validated at the boundary rather than
// passed through: an unchecked value here becomes a wallet owner nobody can
// reproduce, which is unrecoverable by construction. The STRUCTURAL check earns its
// keep on the needs_restore branch of PUT, which records a key without a Privy call
// to reject a bad one — there, length alone is the only other thing standing
// between a typo and an unopenable wallet.
//
// Length is checked BEFORE the regex in both validators: the scan is linear, but
// there is no reason to run it across a multi-megabyte body field first.
function isSpkiBase64(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 256 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    const bytes = Buffer.from(value, "base64");
    return bytes.length === 91 && bytes[0] === 0x30 && bytes[1] === 0x59;
  } catch {
    return false;
  }
}

// A DER ECDSA P-256 signature: SEQUENCE tag, and in the length band DER allows for
// two 32-byte integers with optional leading zero bytes.
function isDerSignatureBase64(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 256 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    const bytes = Buffer.from(value, "base64");
    return bytes.length >= 64 && bytes.length <= 80 && bytes[0] === 0x30;
  } catch {
    return false;
  }
}

// Which side of the ownership line this wallet is on.
//
// A RECORDED KEY IS TRUSTED WITHOUT ASKING PRIVY. Privy is still the real gate at
// export time — a stale cache surfaces as a 401 there, which the restore path
// handles — so spending an API call to re-confirm what we already recorded buys
// nothing. When the cache is EMPTY the call is worth making: a wallet Privy says
// we no longer own, with no key recorded, is a setup whose column write failed,
// and telling that apart from a fresh wallet is the difference between a restore
// prompt and a dead end.
//
// FAILS CLOSED, AND MUST STAY THAT WAY. "needs_restore" is a NEGATIVE result, so
// every unknown collapses into it unless the inputs are checked first — an unset or
// whitespace-padded PRIVY_KEY_QUORUM_ID, or a null owner from Privy, would all read
// as "ownership already moved". That is not a cosmetic misreport: PUT skips
// transferExportOwnership on that branch, records the key anyway, and tells the user
// only they can export while we are still the sole owner — the exact lie about
// custody the transfer-first ordering below exists to prevent. It is also
// self-sealing, because the recorded key then short-circuits this function to
// "enabled" forever and the 409 blocks every retry. Both throws land in the callers'
// catches as a 502. Do not simplify this back to a one-line comparison.
//
// "needs_restore" CONFLATES TWO STATES AND ALWAYS WILL — ruled 2026-09-11, after
// the question was parked through the whole plan. A foreign owner_id with no key
// recorded is either (a) ownership moved to the user and our column write failed,
// or (b) we never owned it, so Privy's own quorum does. The server cannot tell
// them apart and no reachable signal does it: Task 5 measured that a post-transfer
// owner_id is "a NEW quorum id", indistinguishable from a Privy-assigned one, and
// our quorum is an additional_signer in BOTH states, so the signer list does not
// separate them either.
//
// It stopped mattering when the restore path started PROVING BEFORE IT RECORDS
// (76b912a, app/ExportTab.tsx). Nothing acts on the guess now: in (a) the right
// password produces a real export and the key is recorded; in (b) no password can,
// so the proof fails, nothing is written, and the attempt is retryable. What is
// left is an honest dead end for a population that walletSpec's owner_id, the
// privy-setup.ts fix (5ee4981) and Task 12's re-mint have emptied — not a custody
// claim. The distinction is made by the only party who can make it: the user,
// holding the password.
//
// If that population is ever non-empty again, the fix is a cheaper REPAIR and not
// a better guess: keyQuorums.get(owner_id) returns the quorum's authorization_keys
// (node_modules/@privy-io/node/resources/key-quorums.d.ts:74-84), which in state
// (a) is the user's own P-256 key — so the lost column value can be read back from
// Privy with no user action at all. Unbuilt deliberately: it is one API call on a
// path nobody currently reaches.
async function resolveState(walletId: string, exportOwnerKey: string | null) {
  if (exportOwnerKey) return "enabled" as const;
  // TRIMMED, because the comment above promises it is. A padded value is not
  // falsy, so it would survive the check below and then lose every comparison
  // against Privy's owner id — landing on needs_restore, which is exactly the
  // custody lie this function is written to refuse.
  const quorum = process.env.PRIVY_KEY_QUORUM_ID?.trim();
  if (!quorum) throw new Error("PRIVY_KEY_QUORUM_ID is not set");
  const owner = await getWalletOwnerId(walletId);
  if (!owner) throw new Error("Privy returned no owner for this wallet");
  return owner === quorum ? ("not_enabled" as const) : ("needs_restore" as const);
}

export async function GET() {
  const g = await walletGate();
  if ("error" in g) return g.error;

  const appId = process.env.PRIVY_APP_ID;
  // 502, not 500: the documented contract for this route is 400/401/403/404/409/502,
  // and a missing upstream credential is the same class of failure as Privy refusing
  // the call — the client cannot tell them apart and does not need to.
  if (!appId) return json({ error: "Privy is not configured." }, 502);

  try {
    return json({
      state: await resolveState(g.walletId, g.exportOwnerKey),
      walletId: g.walletId,
      // Not a secret: it is in every Privy request the browser's signature covers,
      // and the browser cannot build that signature without it.
      appId,
      address: g.address,
      exportOwnerKey: g.exportOwnerKey,
      // CLAIMED is a stronger statement than `state: "enabled"` and the UI must be
      // able to tell them apart: enabled means the user can export while Splitsy
      // can still spend; claimed means Splitsy holds no key at all. Served from the
      // same request because the wallet panel needs both to say anything true.
      claimed: Boolean(g.claimedAt),
      claimedAt: g.claimedAt,
      canClaim: claimEnabled() && !g.claimedAt,
      // HOW the wallet is unlocked, so the send tab offers the passkey rather than
      // demanding a password the user may not have typed since claiming. Neither
      // is a secret: ownerKind is a shape, and a credential id is useless without
      // the authenticator holding the key.
      ownerKind: g.ownerKind,
      passkeyCredentialId: g.passkeyCredentialId,
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Could not read wallet ownership." }, 502);
  }
}

// Enable, or restore a record we lost. The state is resolved HERE rather than
// taken from the client: a client that could claim "needs_restore" could record an
// owner key for a wallet whose ownership never moved.
export async function PUT(request: Request) {
  const g = await walletGate();
  if ("error" in g) return g.error;

  const body = (await request.json().catch(() => null)) as { publicKey?: unknown } | null;
  if (!isSpkiBase64(body?.publicKey)) {
    return json({ error: "Expected a base64 SPKI P-256 public key." }, 400);
  }
  const publicKey = body.publicKey;

  try {
    const state = await resolveState(g.walletId, g.exportOwnerKey);
    if (state === "enabled") {
      return json({ error: "Export is already enabled for this wallet." }, 409);
    }

    // TRANSFER FIRST, RECORD SECOND, and never the other way round. If the write
    // below fails we under-claim — the UI says "not enabled" for a wallet only the
    // user can export — and the restore path repairs it. The inverse ordering would
    // tell a user only they can export while we still can, which is a lie about
    // custody.
    if (state === "not_enabled") {
      await transferExportOwnership(g.walletId, publicKey);
    }
    // state === "needs_restore": ownership already moved on a previous attempt whose
    // record was lost. Recording the key without re-transferring is safe because the
    // column is a cache — a wrong key written here fails the browser's local
    // pre-check until the user retries with the right password, and Privy refuses a
    // signature from it either way.
    await setExportOwnerKey(g.namespace, g.key, publicKey);
    return json({ ok: true, state: "enabled" });
  } catch (err) {
    // The message can name the failure; it must never carry the request body.
    return json({ error: err instanceof Error ? err.message : "Could not enable export." }, 502);
  }
}

export async function POST(request: Request) {
  const g = await walletGate();
  if ("error" in g) return g.error;

  const body = (await request.json().catch(() => null)) as
    | { recipientPublicKey?: unknown; signature?: unknown }
    | null;
  if (!isSpkiBase64(body?.recipientPublicKey)) {
    return json({ error: "Expected a base64 SPKI P-256 recipient key." }, 400);
  }
  if (!isDerSignatureBase64(body?.signature)) {
    return json({ error: "Expected a base64 DER authorization signature." }, 400);
  }

  try {
    // Relayed verbatim. We do not decrypt, and we could not: the matching private
    // key is in the tab that asked.
    return json(await exportWalletCiphertext(g.walletId, body.recipientPublicKey, body.signature));
  } catch (err) {
    // Privy refusing the signature is the expected failure — a stale cached owner
    // key, or a wallet whose ownership moved elsewhere — and the browser turns it
    // into the restore prompt. Nothing about the ciphertext or the body is logged.
    const message = err instanceof Error ? err.message : "Export failed.";
    return json({ error: `Splitsy could not authorise this export: ${message}` }, 502);
  }
}

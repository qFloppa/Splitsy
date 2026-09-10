import { cookies } from "next/headers";
import {
  exportWalletCiphertext,
  getWalletOwnerId,
  transferExportOwnership,
} from "@/lib/privy-wallet";
import { getPrivyWalletByWalletId, setExportOwnerKey } from "@/lib/privy-wallets-repo";
import { getSessionUser } from "@/lib/session";
import { verifyWalletUnlock, WALLET_UNLOCK_COOKIE } from "@/lib/session-core";
import { walletProviderName } from "@/lib/wallet-provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Wallet key export. THE SERVER IS A RELAY, NOT A READER: the recipient key and
// the authorization signature are both made in the user's tab, and what comes back
// is ciphertext addressed to a private key only that tab holds.
//
// Design: docs/superpowers/specs/2026-09-08-privy-key-export-design.md
//
// no-store on every response. None of this is cacheable, and a shared cache
// holding an export response would hand ciphertext to the next reader — which is
// useless to them, but there is no reason to find out.
const NO_STORE = { "Cache-Control": "no-store" } as const;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

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

type Gate =
  | { error: Response }
  | { walletId: string; address: string; namespace: string; key: string; exportOwnerKey: string | null };

// Stack, session, wallet, and the PIN unlock — in that order, because each one
// makes the next question meaningful. The stack comes FIRST deliberately: on the
// Circle stack the route does not exist as a capability, and that is true whether
// or not anyone is signed in. Identical unlock treatment to
// app/api/wallet/send/route.ts: export is strictly more dangerous than a transfer,
// so it gets at least the same gate.
async function gate(): Promise<Gate> {
  try {
    if (walletProviderName() !== "privy") {
      // Not 403: on the Circle stack this capability does not exist at all. A DCW
      // key cannot be exported, so there is nothing here to be forbidden from.
      return { error: json({ error: "Export is not available on this wallet stack." }, 404) };
    }
    const user = await getSessionUser();
    if (!user) return { error: json({ error: "Not signed in" }, 401) };
    if (!user.circle_wallet_id || !user.wallet_address) {
      return { error: json({ error: "Your wallet isn't provisioned yet." }, 409) };
    }

    const secret = process.env.SESSION_SECRET ?? "";
    const unlockToken = (await cookies()).get(WALLET_UNLOCK_COOKIE)?.value ?? "";
    if (verifyWalletUnlock(unlockToken, secret, Date.now()) !== user.id) {
      return { error: json({ error: "locked" }, 403) };
    }

    // users.circle_wallet_id holds the PRIVY wallet id on this stack — the column
    // name is legacy from the Circle era (lib/users-repo.ts:45 writes wallet.walletId
    // into it) and is not renamed here.
    const row = await getPrivyWalletByWalletId(user.circle_wallet_id);
    if (!row) return { error: json({ error: "Your wallet isn't provisioned yet." }, 409) };

    return {
      walletId: user.circle_wallet_id,
      address: user.wallet_address,
      namespace: row.namespace,
      key: row.key,
      exportOwnerKey: row.export_owner_key ?? null,
    };
  } catch {
    // CAUGHT HERE, ONCE, FOR ALL THREE HANDLERS. Everything above can throw —
    // Supabase unconfigured, the network down, or .maybeSingle() hitting the
    // duplicate wallet_id rows nothing constrains against — and every handler
    // calls this BEFORE opening its own try. Uncaught, those escaped as a
    // framework 500 HTML page, breaking the documented JSON contract below and
    // reaching the browser as a bare "Network error". Deliberately says nothing
    // about which: the client cannot act on the difference, and the message is
    // the one place a DB error string could reach a user.
    return { error: json({ error: "Could not read your wallet. Please try again." }, 502) };
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
  const g = await gate();
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
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Could not read wallet ownership." }, 502);
  }
}

// Enable, or restore a record we lost. The state is resolved HERE rather than
// taken from the client: a client that could claim "needs_restore" could record an
// owner key for a wallet whose ownership never moved.
export async function PUT(request: Request) {
  const g = await gate();
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
  const g = await gate();
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

// The gate every wallet-custody route runs first: stack, session, wallet, PIN.
//
// EXTRACTED so the export route and the claim route share ONE copy. These are the
// checks that decide whether a caller may act on someone's wallet, and a second
// copy is a second place for one of them to be forgotten — the failure mode being
// a route that skips the unlock and lets a stolen session move money.
//
// Order matters and is not alphabetical: the stack comes FIRST because on the
// Circle stack these capabilities do not exist at all, which is true whether or not
// anyone is signed in; then identity, then provisioning, then the unlock. Each
// makes the next question meaningful.
import { cookies } from "next/headers";
import { exportSalt } from "@/lib/export-crypto";
import { getPrivyWalletByWalletId } from "@/lib/privy-wallets-repo";
import { getSessionUser } from "@/lib/session";
import { verifyWalletUnlock, WALLET_UNLOCK_COOKIE } from "@/lib/session-core";
import { walletProviderName } from "@/lib/wallet-provider";

// no-store on every response. None of this is cacheable, and a shared cache
// holding an export response would hand ciphertext to the next reader — which is
// useless to them, but there is no reason to find out.
const NO_STORE = { "Cache-Control": "no-store" } as const;
export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

// Whether a user may hand their wallet over YET.
//
// OFF BY DEFAULT, and this is a safety rail rather than a preference. Claiming is
// irreversible, and until every route a user needs has been migrated to
// prepare/sign/relay (Phase 2 — debts/pay, the onchain-bills paths, recurring,
// treasury), a claimed wallet can send from the wallet panel and little else:
// every other route still asks the server to sign and now gets a refusal it
// cannot recover from. Letting someone opt into that permanently, before the
// routes exist, would be handing them a wallet that works less well than the one
// they started with — with no way back.
//
// Exact match, like walletProviderName: a typo or a stray value must leave this
// OFF, because the failure direction is permanent.
export const claimEnabled = (): boolean => process.env.WALLET_CLAIM_ENABLED === "true";

export type WalletGate =
  | { error: Response }
  | {
      walletId: string;
      address: string;
      namespace: string;
      key: string;
      exportOwnerKey: string | null;
      // Null means Splitsy can still sign for this wallet. Carried through the gate
      // because both routes need it and neither should re-read the row to get it.
      claimedAt: string | null;
      // How a claimed wallet is unlocked, and the passkey handle if there is one.
      // Neither is a secret; both ride along so the status route needs no second
      // read of the same row.
      ownerKind: string | null;
      passkeyCredentialId: string | null;
      // The salt every owner key for this wallet is derived with, resolved HERE so
      // no caller has to know that a null column means the address. The browser
      // cannot derive it — a provisioned wallet's salt predates its address — and
      // deriving the wrong one produces a key that is silently not the owner.
      ownerSalt: string;
    };

export async function walletGate(): Promise<WalletGate> {
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
      claimedAt: row.claimed_at ?? null,
      ownerKind: row.owner_kind ?? null,
      passkeyCredentialId: row.passkey_credential_id ?? null,
      // The row's address, not the session's: they have historically disagreed on
      // casing, and exportSalt lowercases — but the salt must be built from the
      // same string for the life of the wallet, so it comes from one source.
      ownerSalt: row.owner_salt ?? exportSalt(row.address),
    };
  } catch {
    // CAUGHT HERE, ONCE, FOR EVERY HANDLER. Everything above can throw — Supabase
    // unconfigured, the network down, or .maybeSingle() hitting the duplicate
    // wallet_id rows nothing constrains against — and every handler calls this
    // BEFORE opening its own try. Uncaught, those escaped as a framework 500 HTML
    // page, breaking the documented JSON contract and reaching the browser as a
    // bare "Network error". Deliberately says nothing about which: the client
    // cannot act on the difference, and the message is the one place a DB error
    // string could reach a user.
    return { error: json({ error: "Could not read your wallet. Please try again." }, 502) };
  }
}

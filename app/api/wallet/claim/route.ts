import { claimLanded, claimOwnership, exportWalletCiphertext, getWalletOwnerId } from "@/lib/privy-wallet";
import { setClaimed } from "@/lib/privy-wallets-repo";
import { claimEnabled, json, walletGate } from "@/lib/wallet-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Take sole ownership of a pay wallet. After this Splitsy holds NO key to it: not
// as owner, not as an additional signer, and there is no call we can make against
// it that Privy will honour. Measured in scripts/privy-claim-probe.ts — 401 on
// signTransaction, 401 on export, 0 signers remaining.
//
// SEPARATE ROUTE FROM /api/wallet/export, because it is a different promise.
// Export moves ownership and leaves our signer in place on purpose, so the server
// keeps spending; that is the capability this route destroys. Folding the two into
// one handler would mean one request body deciding whether the user ends up with a
// wallet Splitsy can still spend from — which is precisely the thing a user needs
// to be unambiguous.
//
// IRREVERSIBLE, AND UNRECOVERABLE. Taking ownership is owner-gated, so once our
// quorum is neither owner nor signer there is no path back — not for the user who
// forgets their password, and not for us. The UI must say so before this is called;
// this route will not second-guess a caller that got that far.

// Base64 that decodes to a 91-byte P-256 SPKI. Same validator as the export route,
// and load-bearing for the same reason plus a sharper one: an unchecked value here
// becomes the SOLE owner of a wallet, so a malformed key is not a failed request,
// it is a wallet nobody can ever sign for again.
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
  const g = await walletGate();
  if ("error" in g) return g.error;

  // Checked AFTER the gate so an unauthenticated caller still gets 401 rather than
  // learning whether the feature exists, and BEFORE anything is read or written.
  if (!claimEnabled()) {
    return json({ error: "Taking ownership isn't available yet." }, 404);
  }

  if (g.claimedAt) {
    return json({ error: "This wallet is already yours — Splitsy holds no key to it." }, 409);
  }

  const body = (await request.json().catch(() => null)) as {
    publicKey?: unknown;
    recipientPublicKey?: unknown;
    signature?: unknown;
  } | null;

  if (!isSpkiBase64(body?.publicKey)) {
    return json({ error: "Expected a base64 SPKI P-256 public key." }, 400);
  }
  // The proof material, built in the tab: a fresh HPKE recipient key and a
  // signature over the export request, both made with the key about to become the
  // owner. Demanded UP FRONT rather than in a second round trip — see below.
  if (!isSpkiBase64(body?.recipientPublicKey) || !isDerSignatureBase64(body?.signature)) {
    return json({ error: "Expected the export proof: a recipient key and a signature." }, 400);
  }
  const { publicKey, recipientPublicKey, signature } = body;

  try {
    // WE MUST STILL OWN IT. A wallet already owned by someone else cannot be
    // "claimed" — the update below would 401 — and telling the user it worked
    // would be the custody lie in reverse. This is the positive form of the guard
    // the restore path only has negatively: there, an unexpected owner means
    // "maybe you already did this"; here it means "stop".
    const quorum = process.env.PRIVY_KEY_QUORUM_ID?.trim();
    if (!quorum) throw new Error("PRIVY_KEY_QUORUM_ID is not set");
    const owner = await getWalletOwnerId(g.walletId);
    if (!owner) throw new Error("Privy returned no owner for this wallet");
    if (owner !== quorum) {
      return json(
        {
          error:
            "Splitsy is not the owner of this wallet, so it cannot hand it over. " +
            "If you already set an export password, this wallet is partly yours already — use the export tab.",
        },
        409,
      );
    }

    // THE CLAIM. One call: ownership moves and our signer is revoked together.
    const result = await claimOwnership(g.walletId, publicKey);

    // VERIFY WHAT PRIVY ACTUALLY DID, rather than trusting the call returned 200.
    // An SDK or API change that dropped additional_signers from the request would
    // answer perfectly well and leave our quorum able to spend — and recording that
    // as a claim would tell the user we hold no key while we do. This is the single
    // most damaging wrong answer this route can give, so it is checked, not assumed.
    const landed = claimLanded(result, quorum);
    if (!landed.ok) {
      return json({ error: `The handover did not complete: ${landed.reason} Nothing was recorded.` }, 502);
    }

    // PROVE BEFORE RECORDING, the rule 76b912a established for restore. The claim
    // has happened on Privy's side either way — it is irreversible — but the ROW is
    // what every other route reads to decide whether the server may sign. Writing
    // it before knowing the user's key actually works would leave a wallet that is
    // non-custodial in fact and recorded as such, while the user cannot open it.
    //
    // The proof runs with the user's own signature over their own recipient key, so
    // a success here means the exact credential they hold controls the wallet.
    await exportWalletCiphertext(g.walletId, recipientPublicKey, signature);

    await setClaimed(g.namespace, g.key, publicKey);
    return json({ ok: true, claimed: true });
  } catch (err) {
    // A FAILURE HERE IS NOT A FAILURE TO CLAIM. The update may well have gone
    // through — it is the proof or the row write that threw — and the wallet is
    // then the user's with nothing recorded. Saying "it failed, try again" would be
    // wrong twice: the retry will hit the owner check above and refuse, and the
    // user would believe Splitsy still holds their key when it does not.
    const detail = err instanceof Error ? err.message : "Could not complete the handover.";
    return json(
      {
        error:
          `${detail} If Splitsy has already handed this wallet over, it cannot be undone — ` +
          "reload the wallet panel to see its current state before trying again.",
      },
      502,
    );
  }
}

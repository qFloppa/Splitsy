// Arc Testnet block explorer links, client-side.
//
// lib/circle-dcw.ts owns the same knowledge server-side but is server-only (it
// pulls the Circle SDK and node:crypto), so a browser component can't import it.

export const ARC_EXPLORER = "https://testnet.arcscan.app";

export const explorerTxUrl = (hash: string) => `${ARC_EXPLORER}/tx/${hash}`;

/**
 * The explorer link for a Circle DCW transaction, once it has one.
 *
 * A DCW transfer is accepted before it mines, so POST /api/wallet/send answers
 * with a Circle transaction id and no chain hash. The wallet-history endpoint
 * carries the hash as soon as the transaction lands, so poll that.
 *
 * Returns null when the hash hasn't appeared inside the window — the caller
 * shows no link rather than a dead one. The money still moved either way.
 */
export async function waitForCircleTxUrl(txId: string, tries = 6): Promise<string | null> {
  for (let i = 0; i < tries; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    let data: { transactions?: { id: string; txHash: string | null }[]; explorer?: string };
    try {
      data = await fetch("/api/wallet/transactions").then((r) => r.json());
    } catch {
      return null;
    }
    const match = data.transactions?.find((t) => t.id === txId);
    if (match?.txHash) return `${data.explorer ?? ARC_EXPLORER}/tx/${match.txHash}`;
  }
  return null;
}

// Arc Testnet block explorer links, client-side.
//
// lib/circle-dcw.ts owns the same knowledge server-side but is server-only (it
// pulls the Circle SDK and node:crypto), so a browser component can't import it.

export const ARC_EXPLORER = "https://testnet.arcscan.app";

export const explorerTxUrl = (hash: string) => `${ARC_EXPLORER}/tx/${hash}`;

/**
 * 0x + 64 hex.
 *
 * `paid_tx_hash` and the `txId` a send returns are a Circle transaction UUID on
 * the circle stack and a real chain hash on the privy one. Everything that turns
 * one into a link has to know which it was handed. Lives here rather than in
 * lib/wallet-provider.ts because browser components need it and this module has
 * no dependencies; wallet-provider re-exports it for server callers.
 */
export function looksLikeTxHash(value: string | null): boolean {
  return value !== null && /^0x[0-9a-fA-F]{64}$/.test(value);
}

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
  // The privy backend answers with the hash itself, so there is nothing to wait
  // for. Polling anyway costs six getLogs round trips to learn what the argument
  // already said.
  if (looksLikeTxHash(txId)) return explorerTxUrl(txId);
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

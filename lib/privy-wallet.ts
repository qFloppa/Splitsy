// Privy implementation of WalletBackend. Filled in by Task 3.
import type { WalletBackend } from "./wallet-provider.ts";

const notYet = (): never => {
  throw new Error("The Privy backend is not implemented yet — set WALLET_PROVIDER=circle");
};

export const backend: WalletBackend = {
  getOrCreateWallet: async () => notYet(),
  transferUsdc: async () => notYet(),
  executeContract: async () => notYet(),
  listTransactions: async () => notYet(),
};

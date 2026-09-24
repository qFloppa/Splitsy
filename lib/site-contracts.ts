// The contracts the footer's colophon prints.
//
// Every address here is one a reader can paste into the explorer and check
// against what the site claims to write to, so it is read from the same env vars
// the read paths already read — REGISTRY_ADDRESS in lib/arc-read.ts,
// RECURRING_TAB_FACTORY_ADDRESS in lib/recurring-read.ts and
// HANDLE_ESCROW_ADDRESS in both — rather than copied out of the README. A footer
// that quietly drifts from the deployment is worse than a footer with no
// addresses in it.
import { ARC_EXPLORER } from "./arc-explorer.ts";
import { forArcNetwork } from "./arc-chain.ts";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type SiteContract = {
  /** The contract's name, as the README and the deploy scripts call it. */
  label: string;
  /** The full address, for the row's title attribute. */
  address: string;
  /** The address as printed: head and tail, since a footer has no room for 42 characters. */
  short: string;
  url: string;
};

/**
 * `0x924Cf4331741401cBc720770937C132A974E1a3b` → `0x924Cf4…4E1a3b`
 *
 * Head of 8 keeps the `0x` and the six characters that actually distinguish
 * these from each other (`0x924Cf4`, `0x9Cc377`…), which a shorter head would cut
 * into. Tail of 6 is what makes the truncation checkable against an explorer page
 * at a glance.
 */
export function shortenAddress(address: string) {
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

// Three, and only Splitsy's own deployments: the contract that writes a bill,
// the one that holds a payment for someone who has no wallet yet, and the one
// that repeats a bill. Declared in that order because it is the order the money
// moves through them.
//
// Arc's own predeploys (USDC, the ERC-8004 registries), AutopayMandate and
// AgenticCommerce are deliberately not here. They are real and the app uses them,
// but a footer is not a deployment manifest — the README is — and every row costs
// height on every route. Three is also what the ledger prints on ONE line above
// ~900px (see .site-footer-ledger), so the band stays a single row tall on the
// viewport most readers arrive on.
//
// Which address each name resolves to follows NEXT_PUBLIC_ARC_NETWORK, exactly
// as the read paths do: the unsuffixed variable is the testnet slot and the
// `_MAINNET` twin is the mainnet slot (lib/arc-chain.ts). Printing the testnet
// address under a mainnet explorer link is the one failure this band cannot be
// allowed to have — it would be a wrong fact wearing a checkable link.
//
// The KEY NAME is what forArcNetwork picks between, not the value, because this
// module reads `env` by index. That is server-only, which is where the footer
// runs; nothing here is inlined into the browser bundle.
const SOURCES: { label: string; env: string }[] = [
  {
    label: "BillSplitRegistry",
    env: forArcNetwork(
      "NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS_MAINNET",
      "NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS",
    ),
  },
  {
    label: "HandleEscrow",
    env: forArcNetwork("NEXT_PUBLIC_HANDLE_ESCROW_ADDRESS_MAINNET", "NEXT_PUBLIC_HANDLE_ESCROW_ADDRESS"),
  },
  {
    label: "RecurringTabFactory",
    env: forArcNetwork(
      "NEXT_PUBLIC_RECURRING_TAB_FACTORY_ADDRESS_MAINNET",
      "NEXT_PUBLIC_RECURRING_TAB_FACTORY_ADDRESS",
    ),
  },
];

/**
 * The rows the on-chain band prints, skipping anything this deploy has not
 * configured.
 *
 * An unset var leaves its constant at the zero address across lib/ — that is
 * what `isMandateConfigured()` exists to test for — and a footer row linking to
 * `0x0000…0000` is a dead link wearing the costume of a fact. Anything missing,
 * malformed, or zero is dropped instead, so a half-configured deploy prints a
 * shorter band rather than a wrong one.
 *
 * Reads `process.env` by default, which means server-side only. The footer is a
 * server component, so this is where the real environment is. The parameter
 * exists for the test.
 */
export function siteContracts(env: Record<string, string | undefined> = process.env): SiteContract[] {
  return SOURCES.flatMap(({ label, env: key }) => {
    const address = env[key];
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return [];
    if (address.toLowerCase() === ZERO_ADDRESS) return [];

    return [{ label, address, short: shortenAddress(address), url: `${ARC_EXPLORER}/address/${address}` }];
  });
}

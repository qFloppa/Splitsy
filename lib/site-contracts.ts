// The contracts the footer's colophon prints.
//
// Every address here is one a reader can paste into the explorer and check
// against what the site claims to write to, so it is read from the same env vars
// the read paths already read — REGISTRY_ADDRESS in lib/arc-read.ts and
// RECURRING_TAB_FACTORY_ADDRESS in lib/recurring-read.ts — rather than copied out
// of the README. A footer that quietly drifts from the deployment is worse than a
// footer with no addresses in it.
import { ARC_EXPLORER } from "./arc-explorer.ts";

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

// Two, and only Splitsy's own deployments: the contract that writes a bill and
// the one that repeats it. Declared in that order because it is the order the
// money moves through them.
//
// Arc's own predeploys (USDC, the ERC-8004 registries), AutopayMandate and
// AgenticCommerce are deliberately not here. They are real and the app uses them,
// but a footer is not a deployment manifest — the README is — and every row costs
// height on every route. Two rows also divide the ledger's one-column and
// two-column layouts exactly, so neither leaves an orphaned rule.
const SOURCES: { label: string; env: string }[] = [
  { label: "BillSplitRegistry", env: "NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS" },
  { label: "RecurringTabFactory", env: "NEXT_PUBLIC_RECURRING_TAB_FACTORY_ADDRESS" },
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

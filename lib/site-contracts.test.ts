import test from "node:test";
import assert from "node:assert/strict";
import { shortenAddress, siteContracts } from "./site-contracts.ts";

const REGISTRY = "0x8e30ca7f7347854629619aec68bd29d7ebedbd48";
const ESCROW = "0xc29b959868828702c37811deba826da48f0e1a6d";
const FACTORY = "0x9Cc377C957255582BCa8084a950F52e59fB0a41E";
const ZERO = "0x0000000000000000000000000000000000000000";

// NEXT_PUBLIC_ARC_NETWORK is unset under `node --test`, so the keys below are the
// testnet slots — which is what forArcNetwork picks for any value but the exact
// string "mainnet". A mainnet run reads the `_MAINNET` twins instead and prints
// nothing for the ones that are blank, which is the "unset is dropped" case
// already covered here.
test("a configured contract becomes a row that links to the explorer", () => {
  const rows = siteContracts({ NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS: REGISTRY });

  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.label, "BillSplitRegistry");
  assert.equal(rows[0]!.address, REGISTRY);
  assert.equal(rows[0]!.url, `https://testnet.arcscan.app/address/${REGISTRY}`);
});

// The whole reason this module is not an inline array in the component: a
// half-configured deploy must print a shorter band, never a link to nothing.
// Two sources means two calls to cover both ways a row can be dropped.
test("unset, zero and malformed addresses are dropped rather than printed", () => {
  assert.deepEqual(
    siteContracts({
      NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS: REGISTRY,
      NEXT_PUBLIC_RECURRING_TAB_FACTORY_ADDRESS: ZERO,
    }).map((row) => row.label),
    ["BillSplitRegistry"],
  );

  assert.deepEqual(
    siteContracts({
      NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS: "0xnope",
      NEXT_PUBLIC_RECURRING_TAB_FACTORY_ADDRESS: FACTORY,
    }).map((row) => row.label),
    ["RecurringTabFactory"],
  );
});

test("an empty environment prints no rows at all, so the band drops out entirely", () => {
  assert.deepEqual(siteContracts({}), []);
});

// Rows are printed in the order the money moves through them, not the order the
// environment happens to define them in.
test("rows keep their declared order", () => {
  const rows = siteContracts({
    NEXT_PUBLIC_RECURRING_TAB_FACTORY_ADDRESS: FACTORY,
    NEXT_PUBLIC_HANDLE_ESCROW_ADDRESS: ESCROW,
    NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS: REGISTRY,
  });

  assert.deepEqual(
    rows.map((row) => row.label),
    ["BillSplitRegistry", "HandleEscrow", "RecurringTabFactory"],
  );
});

// Three is what the ledger fits on one line above ~900px. A fourth would wrap the
// band onto a second row under every route, which is the height this footer is
// built to refuse.
test("a fully configured environment prints exactly three rows", () => {
  const rows = siteContracts({
    NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS: REGISTRY,
    NEXT_PUBLIC_HANDLE_ESCROW_ADDRESS: ESCROW,
    NEXT_PUBLIC_RECURRING_TAB_FACTORY_ADDRESS: FACTORY,
  });

  assert.equal(rows.length, 3);
});

test("the printed address keeps the 0x and stays checkable at both ends", () => {
  assert.equal(shortenAddress(REGISTRY), "0x8e30ca…edbd48");
  // Two contracts that share a four-character head still read apart, which is
  // why the head is 8 and not 6.
  assert.notEqual(shortenAddress(REGISTRY), shortenAddress(FACTORY));
});

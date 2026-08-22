import test from "node:test";
import assert from "node:assert/strict";
import { shortenAddress, siteContracts } from "./site-contracts.ts";

const REGISTRY = "0x924Cf4331741401cBc720770937C132A974E1a3b";
const FACTORY = "0x9Cc377C957255582BCa8084a950F52e59fB0a41E";
const ZERO = "0x0000000000000000000000000000000000000000";

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
    NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS: REGISTRY,
  });

  assert.deepEqual(
    rows.map((row) => row.label),
    ["BillSplitRegistry", "RecurringTabFactory"],
  );
});

// Two is load-bearing: it divides both ledger layouts (1 column, 2 columns)
// exactly, so neither can leave a rule hanging with nothing beside it.
test("a fully configured environment prints exactly two rows", () => {
  const rows = siteContracts({
    NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS: REGISTRY,
    NEXT_PUBLIC_RECURRING_TAB_FACTORY_ADDRESS: FACTORY,
  });

  assert.equal(rows.length, 2);
});

test("the printed address keeps the 0x and stays checkable at both ends", () => {
  assert.equal(shortenAddress(REGISTRY), "0x924Cf4…4E1a3b");
  // Two contracts that share a four-character head still read apart, which is
  // why the head is 8 and not 6.
  assert.notEqual(shortenAddress(REGISTRY), shortenAddress(FACTORY));
});

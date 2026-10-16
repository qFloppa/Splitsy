// The two signups that produced this file, as tests: a Privy user with no wallet
// must be given one (and must never be reloaded instead), and a row that does not
// name the wallet yet must keep asking rather than asking once.
import test from "node:test";
import assert from "node:assert/strict";
import { bridgeAction, CREATE_AFTER_PASSES, primaryWallet, type BridgeFacts } from "./privy-bridge.ts";

const WALLET = "0x01485281B357ac42F081162eD6D041DccB8eB33B";

const facts = (over: Partial<BridgeFacts> = {}): BridgeFacts => ({
  hasWallet: true,
  browserWallet: WALLET,
  rowWallet: WALLET.toLowerCase(),
  pageRowWallet: WALLET.toLowerCase(),
  pageHadSession: true,
  pass: CREATE_AFTER_PASSES,
  ...over,
});

test("no wallet on the Privy user: make one", () => {
  assert.equal(bridgeAction(facts({ hasWallet: false, browserWallet: null, rowWallet: null })), "create-wallet");
});

// 101@ and 102@splitsy.xyz, 2026-10-16: `authenticated` flips before createOnLogin
// has finished, and Privy's own "already has a wallet" guard reads the same lagging
// user — so asking on the first pass minted HD index 1 a second after index 0.
test("no wallet on the first passes: leave it to createOnLogin rather than mint a second", () => {
  const noWallet = { hasWallet: false, browserWallet: null, rowWallet: null };
  for (let pass = 0; pass < CREATE_AFTER_PASSES; pass++) {
    assert.equal(bridgeAction(facts({ ...noWallet, pass })), "wait");
  }
  assert.equal(bridgeAction(facts({ ...noWallet, pass: CREATE_AFTER_PASSES })), "create-wallet");
});

// The same two accounts: Privy's useWallets() lists newest-connected first, so "the
// first embedded wallet" signed with index 1 while the row named index 0, and every
// payment was refused as signed by a different wallet.
test("the signing wallet is HD index 0, not whichever Privy lists first", () => {
  const w = (walletIndex: number, address: string) => ({ walletClientType: "privy", connectorType: "embedded", walletIndex, address });
  assert.equal(primaryWallet([w(1, "0xnewer"), w(0, "0xfirst")])?.address, "0xfirst");
  assert.equal(primaryWallet([{ walletClientType: "metamask", connectorType: "injected", walletIndex: 0, address: "0xext" }]), null);
  assert.equal(primaryWallet([]), null);
});

// noway2@splitsy.xyz: signed in at 11:19:59, Privy made the wallet at 11:39:10.
// The old bridge reloaded seconds after login — inside the window Privy needs —
// and a reloaded page never re-triggers createOnLogin, so the account sat with no
// wallet at all. A reload must be unreachable until a wallet exists.
test("never reload while the user has no wallet — that is what killed the creation", () => {
  for (const pageHadSession of [true, false]) {
    for (const pageRowWallet of [null, WALLET.toLowerCase()]) {
      assert.equal(
        bridgeAction(facts({ hasWallet: false, browserWallet: null, rowWallet: null, pageRowWallet, pageHadSession })),
        "create-wallet",
      );
    }
  }
});

// noway@splitsy.xyz: Privy had the wallet at 11:15:12 and still answered "no
// wallet" to the exchange at 11:15:15. The only fix is to ask again.
test("wallet exists but the row does not name it yet: exchange, however often it takes", () => {
  assert.equal(bridgeAction(facts({ rowWallet: null, pageRowWallet: null, pageHadSession: false })), "exchange");
  assert.equal(bridgeAction(facts({ rowWallet: null, browserWallet: null })), "exchange");
});

test("the row names a different wallet than this browser holds: re-point it", () => {
  assert.equal(bridgeAction(facts({ rowWallet: "0xdead00000000000000000000000000000000beef" })), "exchange");
});

// An existing account arriving on this stack gets a NEW embedded wallet, and the
// row still names the old one. `address` is null for the first seconds of every
// page load, so "the row names something" must not be read as "the row is right"
// — that is how such a row was left pointing at a wallet this browser cannot
// sign for.
test("the tab has not connected its wallet yet: wait for the comparison, do not declare victory", () => {
  assert.equal(bridgeAction(facts({ browserWallet: null })), "wait");
  assert.equal(bridgeAction(facts({ browserWallet: null, rowWallet: "0xdead00000000000000000000000000000000beef", pageRowWallet: "0xdead00000000000000000000000000000000beef" })), "wait");
  // Except on a page that loaded signed out: that user needs to see their
  // session, and the reloaded page makes the same comparison with one in hand.
  assert.equal(bridgeAction(facts({ browserWallet: null, pageHadSession: false, pageRowWallet: null })), "reload");
});

test("agreed, but the page loaded signed out or with a different wallet: reload once", () => {
  assert.equal(bridgeAction(facts({ pageHadSession: false, pageRowWallet: null })), "reload");
  assert.equal(bridgeAction(facts({ pageRowWallet: null })), "reload");
  assert.equal(bridgeAction(facts({ pageRowWallet: "0xdead00000000000000000000000000000000beef" })), "reload");
});

test("agreed and the page already knew: nothing to do", () => {
  assert.equal(bridgeAction(facts()), "settled");
  // Casing is not a disagreement: the row is stored lowercased, Privy reports
  // EIP-55. An earlier version of this comparison would have reloaded forever.
  assert.equal(bridgeAction(facts({ pageRowWallet: WALLET, browserWallet: WALLET.toLowerCase() })), "settled");
});

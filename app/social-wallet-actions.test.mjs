import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const payer = "0x1111111111111111111111111111111111111111";
const debtor = "0x2222222222222222222222222222222222222222";
const token = "a".repeat(32);
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

// Execute the actual event handler with its component closure supplied by the
// fixture. This keeps JSX rendering and external wallet SDKs out of Node tests.
function action(file, name, scope) {
  const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(declaration, `Missing handler: ${name}`);
  return runInNewContext(`${compile(declaration.getText(source))}\n${name}`, scope);
}

function signingFlow(finalData, { legs = 1, cancelAt = -1 } = {}) {
  let signed = 0;
  const requests = [];
  const fetch = async (url, options) => {
    if (url === "/api/wallet/pin") return Response.json({ unlocked: true });
    const body = JSON.parse(options.body);
    requests.push({ url, body });
    if (body.prepare) return Response.json({
      ticket: `ticket-${signed}`,
      transaction: { to: debtor, data: "0x", nonce: "0x0", chain_id: 5042002,
        gas_limit: "0x5208", max_fee_per_gas: "0x1", max_priority_fee_per_gas: "0x0" },
    });
    if (!body.ticket || !body.signedTransaction) {
      return Response.json({ error: "This wallet is yours: enter your export password." }, { status: 409 });
    }
    return Response.json(signed < legs ? { ok: true, more: true, results: [] } : finalData);
  };
  const exports = {};
  runInNewContext(compile(readFileSync(new URL("./signed-send.ts", import.meta.url), "utf8")), {
    exports, fetch, Error,
    require: (id) => {
      if (id === "./privy-signer") return {
        privyUiActive: () => true,
        signerOrNull: () => async () => {
          if (signed === cancelAt) throw new Error("Payment cancelled");
          signed += 1;
          return "0xsigned";
        },
      };
      if (id === "./session-owner-key") return { ownerKeyFor: () => null };
      if (id === "@/lib/recurring-contracts") return { ARC_USDC_ADDRESS: payer };
      assert.equal(id, "viem");
      return require(id);
    },
  });
  return { fetch, ...exports, requests, signed: () => signed };
}

test("creating as a social wallet signs the bill before showing its id and share link", async () => {
  const flow = signingFlow({ billId: "7", txHash: "0xcreated" });
  const state = {};
  const submit = action("./HomeClient.tsx", "submitBillOnchainMixed", {
    ...flow,
    fetch: async (url, options) => url === "/api/onchain-bills/resolve"
      ? Response.json({ resolved: [{ provider: "x", handle: "friend", address: debtor }] })
      : flow.fetch(url, options),
    splitMode: "equal", splitTotal: 2, confirmedUsd: 2,
    displayParticipants: [{ provider: "x", walletAddress: "@friend", label: "Friend", amountUsd: 2 }],
    createAsSocial: true, me: { walletAddress: payer, handle: "qfloppa", provider: "x" },
    looksLikeAddress: (value) => value.startsWith("0x"), rowProvider: (row) => row.provider,
    normalizeAddress: (value) => value, usdcToBillUnits: () => 2_000_000n,
    bill: { merchant: "Dinner", currency: "USD" }, receiptCommit: null,
    dueDateInput: "", dueDateToUnix: () => undefined, escrowUntilFull: false,
    publicPayLink: true, newShareToken: () => token, window: { location: { origin: "https://splitsy.test" } },
    setBillState: (value) => { state.status = value; },
    setBillMessage: (value) => { state.message = value; },
    setLiveBillId: (value) => { state.billId = value; },
    setShareLinkUrl: (value) => { state.link = value; }, setLinkCopied: () => {},
    resetSplitForm: () => {}, refreshBillRegistry: async () => {},
  });
  await submit();
  assert.equal(state.status, "success", state.message);
  assert.equal(state.billId, "7");
  assert.equal(state.link, `https://splitsy.test/pay/${token}`);
  assert.equal(flow.signed(), 1);
  assert.equal(flow.requests[0].body.prepare, true);
  assert.equal(flow.requests[1].body.signedTransaction, "0xsigned");
  assert.equal(flow.requests[1].body.participants[0].handle, "@friend");
});

function payAction(flow) {
  const state = { refreshes: 0 };
  return {
    state,
    pay: action("./pay/[token]/PayClient.tsx", "payWithSplitsyWallet", {
      ...flow, token, bill: { rows: [{ address: debtor, remainingUnits: "2000000" }] },
      selected: new Set([debtor]),
      setMessage: (value) => { state.message = value; },
      setPaying: (value) => { state.paying = value; },
      setRowStates: (value) => { state.rows = value; },
      settleRun: async (value) => { state.rows = value; state.refreshes += 1; },
      load: async () => { state.refreshes += 1; },
    }),
  };
}

test("social pay signs approval and payment before marking the selected share paid", async () => {
  const flow = signingFlow({ results: [{ address: debtor, ok: true, txHash: "0xpaid" }] }, { legs: 2 });
  const { pay, state } = payAction(flow);
  await pay();
  assert.equal(state.rows[debtor]?.status, "paid", state.message);
  assert.equal(state.rows[debtor].txHash, "0xpaid");
  assert.equal(state.paying, false);
  assert.equal(state.refreshes, 1);
  assert.equal(flow.signed(), 2);
  assert.equal(flow.requests.length, 4);
  for (const { body } of flow.requests) assert.deepEqual(body.debtors, [debtor]);
});

test("a rejected later signature clears pending rows and refreshes balances", async () => {
  const flow = signingFlow({}, { legs: 3, cancelAt: 2 });
  const { pay, state } = payAction(flow);
  await pay();
  assert.equal(state.message, "Payment cancelled");
  assert.equal(state.paying, false);
  assert.equal(Object.keys(state.rows).length, 0);
  assert.equal(state.refreshes, 1);
  assert.equal(flow.signed(), 2);
});

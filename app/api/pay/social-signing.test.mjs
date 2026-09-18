import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as calldata from "../../../lib/registry-calldata.ts";
import { isShareToken } from "../../../lib/pay-link.ts";

const debtor = "0x1111111111111111111111111111111111111111";
const registry = "0x2222222222222222222222222222222222222222";
const token = "a".repeat(32);
const routeSource = readFileSync(new URL("./[token]/social/route.ts", import.meta.url), "utf8");
const routeJs = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

// Run the real route with a real, single-use Request body. Only session,
// database and chain boundaries are replaced; no live wallet is charged.
function route({ allowance = 0n, mustSign = true, unlocked = true } = {}) {
  const calls = [];
  const dependencies = {
    "next/headers": { cookies: async () => ({ get: () => ({ value: "unlock" }) }) },
    "@/lib/session": {
      getSessionUser: async () => ({ id: "payer", circle_wallet_id: "social-wallet", wallet_address: registry }),
    },
    "@/lib/session-core": { WALLET_UNLOCK_COOKIE: "unlock", verifyWalletUnlock: () => unlocked ? "payer" : null },
    "@/lib/pay-link": { isShareToken },
    // The route approves USDC on whichever Arc it runs on; the profile is a
    // constant to it, so the stub only has to carry the one field it reads.
    "@/lib/arc-chain": { ARC: { usdcAddress: "0x3600000000000000000000000000000000000000" } },
    "@/lib/onchain-bill-preimage-repo": {
      getPreimageByShareToken: async () => ({ registryAddress: registry, billId: "7" }),
    },
    "@/lib/registry-calldata": calldata,
    "@/lib/arc-read": {
      REGISTRY_ADDRESS: registry,
      getParticipantsOnchain: async () => [{ exists: true, owed: 2_000_000n, paid: 0n }],
      getUsdcAllowanceOnchain: async () => allowance,
      usdcShortfallMessage: async () => null,
    },
    "@/lib/user-signed": {
      userMustSign: async () => mustSign,
      prepareForUser: async (args) => {
        calls.push({ kind: "prepare", ...args });
        return { ticket: "prepared-ticket", transaction: { to: args.to, data: args.data } };
      },
      relayForUser: async (args) => {
        calls.push({ kind: "relay", ...args });
        return { tx: { txHash: "0xpaid" } };
      },
    },
    "@/lib/wallet-provider": {
      InsufficientFundsError: class extends Error {},
      executeContract: async () => {
        calls.push({ kind: "server-sign" });
        assert.equal(mustSign, false, "A user-owned wallet must never be server-signed");
        return { txHash: "0xpaid" };
      },
    },
  };
  const exports = {};
  runInNewContext(routeJs, {
    exports, Response, process: { env: {} },
    require: (id) => {
      assert.ok(id in dependencies, `Unexpected dependency: ${id}`);
      return dependencies[id];
    },
  });
  return {
    calls,
    post: (body) => exports.POST(new Request(`https://splitsy.test/api/pay/${token}/social`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ debtors: [debtor], ...body }),
    }), { params: Promise.resolve({ token }) }),
  };
}

test("social pay prepares approval from the already parsed request body", async () => {
  const app = route();
  const response = await app.post({ prepare: true });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ticket, "prepared-ticket");
  assert.equal(body.transaction.data, calldata.encodeApprove(registry, 2_000_000n));
  assert.equal(body.legsRemaining, 2);
  assert.deepEqual(app.calls.map((call) => call.kind), ["prepare"]);
});

for (const authorization of [{ signedTransaction: "0xsigned" }, { signature: "owner-signature" }]) {
  test(`social pay relays ${Object.keys(authorization)[0]} with the debtor-bound ticket`, async () => {
    const app = route({ allowance: 2_000_000n });
    const response = await app.post({ ticket: "prepared-ticket", ...authorization });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true, results: [{ address: debtor, ok: true, txHash: "0xpaid" }],
    });
    assert.equal(app.calls.length, 1);
    const call = app.calls[0];
    assert.equal(call.kind, "relay");
    assert.equal(call.ticket, "prepared-ticket");
    assert.equal(call.context, `social-pay:7:${debtor}:2000000`);
    assert.equal(call.walletId, "social-wallet");
    for (const [key, value] of Object.entries(authorization)) assert.equal(call[key], value);
  });
}

test("approval relay requests the next payment leg", async () => {
  const app = route();
  const response = await app.post({ ticket: "prepared-ticket", signedTransaction: "0xsigned" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, results: [], more: true });
});

test("unsigned requests still cannot spend a user-owned wallet", async () => {
  const app = route();
  assert.equal((await app.post({})).status, 409);
  assert.equal(app.calls.length, 0);
});

test("locked wallets cannot prepare a payment", async () => {
  const app = route({ unlocked: false });
  assert.equal((await app.post({ prepare: true })).status, 403);
  assert.equal(app.calls.length, 0);
});

test("custodial wallets keep the ordinary server-signed flow", async () => {
  const app = route({ mustSign: false });
  const response = await app.post({});
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).results, [{ address: debtor, ok: true, txHash: "0xpaid" }]);
  assert.deepEqual(app.calls.map((call) => call.kind), ["server-sign", "server-sign"]);
});

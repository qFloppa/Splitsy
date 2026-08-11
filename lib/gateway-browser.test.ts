import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { formatUnits, parseUnits } from "viem";
import { GATEWAY_MAX_FEE, getGatewayBalance, waitForGatewayBalance } from "./gateway-browser.ts";

// The bug this file exists for: every number in a burn intent is a bigint, and
// a bare JSON.stringify throws on the first one — after the deposit has already
// spent USDC on the source chain. See lib/gateway-browser.ts.
describe("burn intent serialization", () => {
  const bigintToString = (_key: string, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value;

  const intent = {
    maxBlockHeight: 18446744073709551615n,
    maxFee: GATEWAY_MAX_FEE,
    spec: { version: 1, value: 4_080000n, hookData: "0x" },
  };

  it("throws without a replacer", () => {
    assert.throws(() => JSON.stringify([{ burnIntent: intent }]), /BigInt/);
  });

  it("round-trips every bigint as a decimal string", () => {
    const parsed = JSON.parse(JSON.stringify(intent, bigintToString));
    assert.strictEqual(parsed.maxFee, "2010000");
    assert.strictEqual(parsed.spec.value, "4080000");
    assert.strictEqual(parsed.maxBlockHeight, "18446744073709551615");
    // uint32s must stay numbers; stringifying them would break the EIP-712 hash.
    assert.strictEqual(parsed.spec.version, 1);
  });
});

// Gateway decrements the balance by value + fee when it attests, so a deposit
// sized to the bill total alone gets rejected for insufficient funds.
describe("funding a selection", () => {
  it("covers the transfer value plus the fee ceiling", () => {
    const total = parseUnits("4.08", 6);
    assert.strictEqual(total + GATEWAY_MAX_FEE, 6_090000n);
  });

  it("formats units for the API without floating-point drift", () => {
    // The old code used Number(units) / 1e6, which loses precision at scale.
    const awkward = 12345678901234n;
    assert.strictEqual(formatUnits(awkward, 6), "12345678.901234");
    assert.strictEqual(String(Number(awkward) / 1_000_000), "12345678.901234");
    // ...but a real bill total must survive exactly, both ways.
    assert.strictEqual(parseUnits(formatUnits(awkward, 6), 6), awkward);
  });
});

describe("getGatewayBalance", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const stub = (body: unknown, ok = true) => {
    globalThis.fetch = (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
  };

  it("parses the credited balance into 6-decimal units", async () => {
    stub({ balances: [{ balance: "4.080000", pendingBatch: "0" }] });
    assert.strictEqual(
      await getGatewayBalance({ domain: 1, depositor: "0xabc" }),
      4_080000n,
    );
  });

  it("treats an API error as zero rather than crediting funds that may not exist", async () => {
    stub({ message: "boom" }, false);
    assert.strictEqual(await getGatewayBalance({ domain: 1, depositor: "0xabc" }), 0n);
  });

  it("treats a missing balance as zero", async () => {
    stub({ balances: [] });
    assert.strictEqual(await getGatewayBalance({ domain: 1, depositor: "0xabc" }), 0n);
  });
});

describe("waitForGatewayBalance", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const stubSequence = (balances: string[]) => {
    let call = 0;
    globalThis.fetch = (async () => {
      const balance = balances[Math.min(call, balances.length - 1)];
      call += 1;
      return { ok: true, json: async () => ({ balances: [{ balance }] }) };
    }) as unknown as typeof fetch;
  };

  it("returns true as soon as the balance covers what is needed", async () => {
    stubSequence(["6.090000"]);
    assert.strictEqual(
      await waitForGatewayBalance({ domain: 1, depositor: "0xabc", needed: 6_090000n }),
      true,
    );
  });

  it("gives up rather than spinning forever when the deposit never finalizes", async () => {
    stubSequence(["0.000000"]);
    assert.strictEqual(
      await waitForGatewayBalance({
        domain: 1,
        depositor: "0xabc",
        needed: 6_090000n,
        timeoutMs: 0,
      }),
      false,
    );
  });

  it("does not settle for a partial balance", async () => {
    stubSequence(["4.080000"]);
    assert.strictEqual(
      await waitForGatewayBalance({
        domain: 1,
        depositor: "0xabc",
        needed: 6_090000n,
        timeoutMs: 0,
      }),
      false,
    );
  });
});

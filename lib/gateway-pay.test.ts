import { describe, it } from "node:test";
import assert from "node:assert";
import { getGatewayClient } from "./gateway-pay.ts";

describe("getGatewayClient", () => {
  it("throws when CIRCLE_API_KEY is missing", () => {
    const oldKey = process.env.CIRCLE_API_KEY;
    delete process.env.CIRCLE_API_KEY;
    assert.throws(() => getGatewayClient(), /CIRCLE_API_KEY/);
    if (oldKey) process.env.CIRCLE_API_KEY = oldKey;
  });

  it("returns client when CIRCLE_API_KEY is set", () => {
    if (!process.env.CIRCLE_API_KEY) {
      console.log("Skip: CIRCLE_API_KEY not set");
      return;
    }
    const client = getGatewayClient();
    assert(client);
  });
});

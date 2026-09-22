import test from "node:test";
import assert from "node:assert/strict";
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import { GATEWAY_API_ORIGIN } from "./constants.ts";

// Why this is asserted against the SDK rather than against a string: the bug it
// guards was not a wrong value here, it was NO value here. BatchFacilitatorClient
// defaults to the mainnet facilitator, which rejects every eip155:5042002
// payment with `unsupported_network` — so an unconfigured seller on testnet takes
// the money path, fails verify(), and degrades to an unpaid scan in silence.
//
// If Circle ever makes the default network-agnostic this test fails, which is
// the right outcome: someone should re-read the override rather than discover
// two days later that no scan has been paid for.
test("the facilitator is the one for this network, not the SDK's default", () => {
  assert.equal(GATEWAY_API_ORIGIN, "https://gateway-api-testnet.circle.com");
  assert.notEqual(new BatchFacilitatorClient().url, GATEWAY_API_ORIGIN);
  assert.equal(new BatchFacilitatorClient({ url: GATEWAY_API_ORIGIN }).url, GATEWAY_API_ORIGIN);
});

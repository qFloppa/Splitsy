import { test } from "node:test";
import assert from "node:assert/strict";
import { participantProvidersFromSlots } from "./participant-providers.ts";

test("wallet slots -> 'wallet', social slots -> their provider, index-aligned", () => {
  const socialRows = [{ provider: "x" }, { provider: "discord" }] as const;
  const slots = [
    { kind: "address" as const },
    { kind: "social" as const, idx: 0 },
    { kind: "social" as const, idx: 1 },
  ];
  assert.deepEqual(participantProvidersFromSlots(slots, socialRows), ["wallet", "x", "discord"]);
});

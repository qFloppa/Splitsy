import type { IdentityProvider } from "@/lib/types";

// Derive the per-participant identity provider, index-aligned with the bill's
// participant labels/addresses. Address slots are 'wallet'; social slots carry
// their resolved provider. Display/analytics only — NOT part of billMetadataHash.
export function participantProvidersFromSlots(
  slots: ReadonlyArray<{ kind: "social"; idx: number } | { kind: "address" }>,
  socialRows: ReadonlyArray<{ provider: IdentityProvider }>,
): string[] {
  return slots.map((s) => (s.kind === "address" ? "wallet" : socialRows[s.idx].provider));
}

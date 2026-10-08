import test from "node:test";
import assert from "node:assert/strict";
import { describeAccount, providerDisplay } from "./provider-display.ts";

// The wallet-collision refusals send the user to the account that already holds
// the wallet, so this phrase has to name it — provider alone is not enough.
test("an account is named by handle and platform", () => {
  assert.equal(describeAccount({ provider: "x", handle: "@alice" }), "@alice on X");
  assert.equal(describeAccount({ provider: "discord", handle: "alice" }), "alice on Discord");
  assert.equal(describeAccount({ provider: "email", handle: "a@b.com" }), "a@b.com on Email");
});

test("a wallet account names its address, not a platform it isn't on", () => {
  const label = describeAccount({ provider: "wallet", handle: "0xabcdef0123456789abcdef0123456789abcdef01" });
  assert.equal(label, "the wallet account 0xabcd…ef01");
  assert.ok(!label.includes(" on "));
});

// The avatar slot has to be filled for everyone, not just the providers that
// hand over a picture — Discord and email-OTP accounts store no avatar_url, and
// an empty slot collapses the row it is supposed to align.
test("the monogram is the handle's first letter, whatever the handle looks like", () => {
  assert.equal(providerDisplay({ provider: "x", handle: "@alice" }).monogram, "A");
  assert.equal(providerDisplay({ provider: "discord", handle: "dani" }).monogram, "D");
  assert.equal(providerDisplay({ provider: "email", handle: "sam@mail.com" }).monogram, "S");
});

// A wallet address has no initial worth drawing — "0" names nobody. The Wallet
// icon stands in for it, so the monogram is deliberately absent rather than a
// digit that looks like a name.
test("an address has no monogram, and neither does a missing handle", () => {
  assert.equal(providerDisplay({ provider: "wallet", handle: "0xabcdef0123456789abcdef0123456789abcdef01" }).monogram, null);
  assert.equal(providerDisplay({ provider: "x", handle: null }).monogram, null);
  assert.equal(providerDisplay({ provider: "discord", handle: "  " }).monogram, null);
});

// Leading punctuation is not an initial. A handle typed with its "@" still has
// to monogram as its first real character, or every X user shares one letter.
test("the monogram skips punctuation to find a real character", () => {
  assert.equal(providerDisplay({ provider: "x", handle: "@_mert" }).monogram, "M");
  assert.equal(providerDisplay({ provider: "discord", handle: "__dani__" }).monogram, "D");
  assert.equal(providerDisplay({ provider: "discord", handle: "99problems" }).monogram, "9");
});

// avatarSrc is interpolated into a CSS url() by ProviderTag, and a handle is
// untrusted text — it arrives from an OAuth provider, from Privy, or from a
// bill's creation-time snapshot label. A quote or bracket reaching the
// stylesheet intact would close the url() early and have the rest read as
// declarations.
test("a handle is percent-encoded before it reaches a URL", () => {
  const d = providerDisplay({ provider: "x", handle: 'a"); background: url(evil' });
  assert.ok(!d.avatarSrc!.includes('"'), d.avatarSrc!);
  assert.ok(!d.avatarSrc!.includes("("), d.avatarSrc!);
  assert.ok(!d.profileUrl!.includes('"'), d.profileUrl!);
  // The name still reads as it was given — only the URLs are encoded.
  assert.equal(d.label, 'a"); background: url(evil');
});

// Every real handle has to survive the encoding untouched, or this "fix" renames
// people. X allows [A-Za-z0-9_] and Discord's set is narrower.
test("encoding leaves ordinary handles and emails alone", () => {
  assert.equal(providerDisplay({ provider: "x", handle: "@mert_99" }).avatarSrc, "https://unavatar.io/x/mert_99");
  assert.equal(providerDisplay({ provider: "x", handle: "mert_99" }).profileUrl, "https://x.com/mert_99");
  assert.equal(
    providerDisplay({ provider: "email", handle: "sam@mail.com" }).avatarSrc,
    "https://unavatar.io/sam%40mail.com",
  );
});

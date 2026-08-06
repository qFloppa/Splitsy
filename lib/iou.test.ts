import { test } from "node:test";
import assert from "node:assert/strict";
import {
  askBody,
  compactTarget,
  detectProvider,
  ledgerNet,
  ledgerRows,
  nextProvider,
  parseAmount,
  pickSigner,
  planIou,
  targetName,
  validHandle,
  type IouDraft,
} from "./iou.ts";

const draft = (over: Partial<IouDraft> = {}): IouDraft => ({
  direction: "owes-me",
  target: "dani",
  provider: "x",
  amount: "42",
  note: "the cab home",
  ...over,
});

const me = { provider: "x", handle: "mhm" };

test("the direction chooses the rail, because the contract makes the creditor the signer", () => {
  const ask = planIou(draft({ direction: "owes-me" }), me);
  const settle = planIou(draft({ direction: "i-owe" }), me);
  assert.equal(ask.ok && ask.plan.kind, "ask");
  assert.equal(settle.ok && settle.plan.kind, "settle");
});

test("an email target is detected as email even when the picker still says x", () => {
  assert.equal(detectProvider("dani@example.com", "x"), "email");
  assert.equal(detectProvider("dani", "discord"), "discord");
  assert.equal(detectProvider("dani", undefined), "x");
  // "wallet" is not a taggable namespace, so it can never survive detection.
  assert.equal(detectProvider("dani", "wallet"), "x");
});

test("the provider picker cycles through all three namespaces and returns to the start", () => {
  assert.deepEqual([nextProvider("x"), nextProvider("discord"), nextProvider("email")], ["discord", "email", "x"]);
});

test("the signer is the remembered preference only when both identities are live", () => {
  const social = "0x" + "1".repeat(40);
  const wallet = "0x" + "2".repeat(40);
  assert.equal(pickSigner(social, wallet, "wallet"), "wallet");
  assert.equal(pickSigner(social, wallet, "social"), "social");
  // One identity: no choice to honor, so the preference is ignored rather than
  // returning a signer the user doesn't have.
  assert.equal(pickSigner(social, null, "wallet"), "social");
  assert.equal(pickSigner(null, wallet, "social"), "wallet");
  assert.equal(pickSigner(null, null, "wallet"), null, "nothing to sign with");
});

test("a handle is validated against the provider it was detected as, not the one picked", () => {
  const result = planIou(draft({ target: "dani@example.com", provider: "x" }), me);
  assert.ok(result.ok);
  assert.equal(result.plan.provider, "email");
  assert.equal(result.plan.handle, "dani@example.com");
});

test("handles are normalized: leading @ stripped, case folded", () => {
  const result = planIou(draft({ target: "  @DaNi " }), me);
  assert.ok(result.ok);
  assert.equal(result.plan.handle, "dani");
});

test("per-provider handle rules are enforced", () => {
  assert.ok(validHandle("x", "@dani_1"));
  assert.ok(!validHandle("x", "sixteen_chars_xx"), "x caps at 15 characters");
  assert.ok(!validHandle("x", "has-a-dash"));
  assert.ok(validHandle("discord", "dani.one"));
  assert.ok(!validHandle("discord", "d"), "discord needs at least 2 characters");
  assert.ok(validHandle("email", "a@b.co"));
  assert.ok(!validHandle("email", "not-an-email"));
});

test("a raw 0x address is a wallet target — it needs no namespace, it IS the resolution", () => {
  const address = "0x" + "A".repeat(40);
  assert.equal(detectProvider(address, "x"), "wallet", "detection beats the picker");
  const result = planIou(draft({ target: address }), me);
  assert.ok(result.ok);
  assert.equal(result.plan.provider, "wallet");
  assert.equal(result.plan.handle, address.toLowerCase());
});

test("a short 0x value is still a plausible X handle — crypto Twitter is full of them", () => {
  const result = planIou(draft({ target: "0xfoobar" }), me);
  assert.ok(result.ok);
  assert.equal(result.plan.provider, "x", "not every 0x is an address");
});

test("an address of the wrong length is refused as an address, not resolved as a handle", () => {
  // One hex digit short. Left to fall through it would be tagged x:0xaaa… and
  // pre-mint a wallet for a handle nobody owns.
  const result = planIou(draft({ target: "0x" + "a".repeat(39) }), me);
  assert.ok(!result.ok);
  assert.match(result.error, /42 characters/);
});

test("sending an IOU to the wallet that would sign it is refused", () => {
  const mine = "0x" + "b".repeat(40);
  const signing = { ...me, signerAddress: mine.toUpperCase() };
  const result = planIou(draft({ target: mine }), signing);
  assert.ok(!result.ok);
  assert.equal(result.error, "That's your own wallet.");
  // The user's OTHER wallet stays a legitimate counterparty — the same rule the
  // split form applies to its "Create as" identity.
  assert.ok(planIou(draft({ target: "0x" + "c".repeat(40) }), signing).ok);
});

test("a wallet ask sends an address row, not a handle to resolve", () => {
  const planned = planIou(draft({ target: "0x" + "d".repeat(40), note: "" }), me);
  assert.ok(planned.ok);
  const body = askBody(planned.plan);
  const short = `0x${"d".repeat(4)}…${"d".repeat(4)}`;
  assert.deepEqual(body.participants, [{ address: "0x" + "d".repeat(40), label: short, amountUsd: 42 }]);
  // The label is what gets hashed, so the merchant fallback has to read from the
  // same helper — this is the string a payer recomputes.
  assert.equal(body.merchant, `${short} owes me`);
  assert.equal(targetName(planned.plan), short);
});

test("a pasted address or a long email compacts; anything that already fits doesn't", () => {
  assert.equal(compactTarget("0x" + "a".repeat(36) + "bcde"), "0xaaaa…bcde");
  assert.equal(compactTarget("dani"), null, "a bare handle is already short");
  assert.equal(compactTarget("0xabc"), null, "half an address is still being typed");
  assert.equal(compactTarget("dani@gmail.com"), null, "14 characters is inside the budget");
  assert.equal(compactTarget("daniel.hernandez@gmail.com"), "daniel.h…@gmail.com");
  // A long domain can't blow the budget on its own.
  assert.equal(compactTarget("me@some-very-long-domain-name.co"), "me@some-very-lon…");
});

test("a handle is budgeted at X's own ceiling, which only Discord can exceed", () => {
  assert.equal(compactTarget("fifteen_chars_x"), null, "15 is the widest X allows, so it always fits");
  // Discord permits 32. Clipped to the same 15, plus the ellipsis.
  assert.equal(compactTarget("a".repeat(32)), `${"a".repeat(15)}…`);
  assert.ok(validHandle("discord", "a".repeat(32)), "and it is still a legal target");
});

test("amounts accept dollars and cents and reject a third decimal", () => {
  assert.equal(parseAmount("42"), 42);
  assert.equal(parseAmount("42.5"), 42.5);
  assert.equal(parseAmount("$1,234.56"), 1234.56);
  assert.equal(parseAmount(".50"), 0.5);
  assert.equal(parseAmount("4.200015"), null, "USDC carries 6dp but an IOU is dollars");
  assert.equal(parseAmount("9999999.99"), 9999999.99, "seven figures is the ceiling");
  assert.equal(parseAmount("10000000"), null, "past it the number stops being a debt and starts being a layout");
  assert.equal(parseAmount("0"), null);
  assert.equal(parseAmount("-5"), null);
  assert.equal(parseAmount(""), null);
  assert.equal(parseAmount("."), null);
  assert.equal(parseAmount("abc"), null);
});

test("tagging yourself is refused in both directions", () => {
  for (const direction of ["owes-me", "i-owe"] as const) {
    const result = planIou(draft({ direction, target: "@MHM" }), me);
    assert.ok(!result.ok, `${direction} should refuse a self-tag`);
    assert.equal(result.error, "That's you.");
  }
});

test("the same handle on a different provider is a different person", () => {
  const result = planIou(draft({ target: "mhm", provider: "discord" }), me);
  assert.ok(result.ok, "x:mhm and discord:mhm are not the same identity");
});

test("a signed-out user can still plan — the self-tag check just doesn't apply", () => {
  const result = planIou(draft({ target: "@mhm" }), null);
  assert.ok(result.ok);
});

test("an ask becomes a one-participant bill whose merchant is the note", () => {
  const planned = planIou(draft({ note: "the cab home", amount: "42.50" }), me);
  assert.ok(planned.ok);
  const body = askBody(planned.plan);
  assert.equal(body.merchant, "the cab home");
  assert.equal(body.total, 42.5);
  assert.deepEqual(body.participants, [{ provider: "x", handle: "dani", amountUsd: 42.5 }]);
});

test("an empty note falls back to the sentence so the bill isn't blank downstream", () => {
  const planned = planIou(draft({ note: "   " }), me);
  assert.ok(planned.ok);
  assert.equal(askBody(planned.plan).merchant, "@dani owes me");
});

test("the ledger reads direction from the sign of the netted position", () => {
  const rows = ledgerRows([
    { counterparty: "0xaaa", label: "@sam", netUsdc: "18.50", payBillIds: [] },
    { counterparty: "0xbbb", label: "@kai", netUsdc: "-7.00", payBillIds: ["3"] },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.label, r.direction, r.amountUsd]),
    [
      ["@sam", "owes-me", 18.5],
      ["@kai", "i-owe", 7],
    ],
  );
});

test("a fully netted counterparty drops out of the ledger", () => {
  const rows = ledgerRows([
    { counterparty: "0xaaa", label: "@sam", netUsdc: "0", payBillIds: [] },
    { counterparty: "0xbbb", label: "@kai", netUsdc: "0.001", payBillIds: [] },
    { counterparty: "0xccc", label: "@lee", netUsdc: "not-a-number", payBillIds: [] },
  ]);
  assert.equal(rows.length, 0, "nothing left to state, and sub-cent dust isn't a debt");
});

test("the ledger net is signed: positive means you're up", () => {
  const rows = ledgerRows([
    { counterparty: "0xaaa", label: "@sam", netUsdc: "18.50", payBillIds: [] },
    { counterparty: "0xbbb", label: "@kai", netUsdc: "-7.00", payBillIds: [] },
  ]);
  assert.equal(ledgerNet(rows), 11.5);
  assert.equal(ledgerNet([]), 0);
});

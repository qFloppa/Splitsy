import assert from "node:assert/strict";
import { test } from "node:test";
import { decideDunning, NUDGE_WINDOW_SECONDS, type DunningAction, type DunningInput } from "./dunning.ts";

const DUE = 1_800_000_000; // an arbitrary fixed Unix second — never Date.now()
const DAY = 86_400;

function input(overrides: Partial<DunningInput> = {}): DunningInput {
  return {
    dueDate: DUE,
    remaining: 20_000_000n,
    hasMandate: false,
    collectible: 0n,
    alreadyLogged: [],
    ...overrides,
  };
}

test("does nothing for a bill with no due date — there is nothing to escalate toward", () => {
  const d = decideDunning(input({ dueDate: 0 }), DUE + 10 * DAY);
  assert.equal(d.action, "none");
  assert.equal(d.reason, "no_due_date");
});

test("does nothing for a fully paid debt", () => {
  const d = decideDunning(input({ remaining: 0n }), DUE - DAY);
  assert.equal(d.action, "none");
  assert.equal(d.reason, "nothing_owed");
});

test("does nothing while the due date is still far off", () => {
  const d = decideDunning(input(), DUE - NUDGE_WINDOW_SECONDS - DAY);
  assert.equal(d.action, "none");
  assert.equal(d.reason, "not_yet");
});

test("nudges inside the pre-due window when nothing has been sent", () => {
  const d = decideDunning(input(), DUE - 3 * DAY);
  assert.equal(d.action, "nudge");
});

test("does not nudge twice", () => {
  const d = decideDunning(input({ alreadyLogged: ["nudge"] }), DUE - 3 * DAY);
  assert.equal(d.action, "none");
  assert.equal(d.reason, "already_nudged");
});

test("escalates past the due date when there is no mandate — a nudge is all we can do", () => {
  const d = decideDunning(input(), DUE + DAY);
  assert.equal(d.action, "escalate");
  assert.equal(d.reason, "no_mandate");
});

test("does not escalate twice", () => {
  const d = decideDunning(input({ alreadyLogged: ["nudge", "escalate"] }), DUE + DAY);
  assert.equal(d.action, "none");
  assert.equal(d.reason, "already_escalated");
});

test("collects past the due date when the mandate is set and there is something to pull", () => {
  const d = decideDunning(input({ hasMandate: true, collectible: 12_000_000n }), DUE + DAY);
  assert.equal(d.action, "collect");
  assert.equal(d.amount, 12_000_000n);
});

// The debtor authorized us but is empty. Pulling nothing and logging a failure
// is worse than nudging.
test("escalates instead of collecting when the mandate exists but nothing is collectible", () => {
  const d = decideDunning(input({ hasMandate: true, collectible: 0n }), DUE + DAY);
  assert.equal(d.action, "escalate");
  assert.equal(d.reason, "no_funds");
});

// A collect can legitimately repeat as the debtor tops up, unlike a nudge.
test("collects again after an earlier collect", () => {
  const d = decideDunning(
    input({ hasMandate: true, collectible: 5_000_000n, alreadyLogged: ["nudge", "escalate", "collect"] }),
    DUE + 2 * DAY,
  );
  assert.equal(d.action, "collect");
  assert.equal(d.amount, 5_000_000n);
});

test("collects exactly at the due instant, matching the contract's >= comparison", () => {
  const d = decideDunning(input({ hasMandate: true, collectible: 1n }), DUE);
  assert.equal(d.action, "collect");
});

test("still only nudges one second before the due date", () => {
  const d = decideDunning(input({ hasMandate: true, collectible: 20_000_000n }), DUE - 1);
  assert.equal(d.action, "nudge");
});

test("never returns an amount for a non-collect action", () => {
  for (const now of [DUE - 10 * DAY, DUE - 3 * DAY, DUE + DAY]) {
    const d = decideDunning(input(), now);
    if (d.action !== "collect") assert.equal(d.amount, 0n);
  }
});

// A creditor who took sole ownership of their wallet cannot be pulled from by a
// cron: collectDebt is splitter-only (BillSplitRegistry.sol:431 reverts
// NotSplitter for anyone else), the splitter IS the creditor, and the server holds
// no key to their wallet. The rung is unavailable rather than postponed.
test("a claimed creditor escalates instead of collecting", () => {
  const input = {
    dueDate: 1000,
    remaining: 5_000_000n,
    hasMandate: true,
    collectible: 5_000_000n,
    alreadyLogged: [] as DunningAction[],
  };
  // The same inputs still collect for a custodial creditor.
  assert.equal(decideDunning(input, 2000).action, "collect");
  // And drop one rung for a claimed one, rather than returning an action whose
  // transaction would revert after the caller has burned the action slot.
  const claimed = decideDunning({ ...input, canPull: false }, 2000);
  assert.equal(claimed.action, "escalate");
  assert.equal(claimed.reason, "creditor_self_custody");
  assert.equal(claimed.amount, 0n);
});

// Absent means true, so every existing caller keeps pulling.
test("canPull defaults to allowed when the field is absent", () => {
  const input = {
    dueDate: 1000,
    remaining: 5_000_000n,
    hasMandate: true,
    collectible: 5_000_000n,
    alreadyLogged: [] as DunningAction[],
  };
  assert.equal(decideDunning(input, 2000).action, "collect");
  assert.equal(decideDunning({ ...input, canPull: true }, 2000).action, "collect");
});

// The nudge rung is untouched: a claimed creditor still warns before the due date,
// because that costs no signature at all.
test("a claimed creditor still nudges before the due date", () => {
  const decision = decideDunning(
    {
      dueDate: 1_000_000,
      remaining: 5_000_000n,
      hasMandate: true,
      collectible: 5_000_000n,
      alreadyLogged: [],
      canPull: false,
    },
    1_000_000 - 86_400,
  );
  assert.equal(decision.action, "nudge");
});

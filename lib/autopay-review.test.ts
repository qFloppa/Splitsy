import test from "node:test";
import assert from "node:assert/strict";
import { parseReviewVerdict, REVIEW_UNAVAILABLE } from "./autopay-review.ts";

test("an approval passes through with its reason", () => {
  const verdict = parseReviewVerdict('{"approve":true,"reason":"Share matches the two items listed."}');
  assert.equal(verdict.approve, true);
  assert.equal(verdict.reason, "Share matches the two items listed.");
});

test("a refusal carries the model's sentence", () => {
  const verdict = parseReviewVerdict(
    '{"approve":false,"reason":"The receipt lists two mains but you are charged for four."}',
  );
  assert.equal(verdict.approve, false);
  assert.equal(verdict.reason, "The receipt lists two mains but you are charged for four.");
});

test("unparseable output fails closed", () => {
  const verdict = parseReviewVerdict("not json at all");
  assert.equal(verdict.approve, false);
  assert.equal(verdict.reason, REVIEW_UNAVAILABLE);
});

test("a null response fails closed", () => {
  const verdict = parseReviewVerdict(null);
  assert.equal(verdict.approve, false);
  assert.equal(verdict.reason, REVIEW_UNAVAILABLE);
});

test("valid JSON of the wrong shape fails closed", () => {
  // A model that answers in prose inside JSON must not be read as approval.
  const verdict = parseReviewVerdict('{"verdict":"looks fine"}');
  assert.equal(verdict.approve, false);
  assert.equal(verdict.reason, REVIEW_UNAVAILABLE);
});

test("an approval with no reason still approves, with a stand-in sentence", () => {
  const verdict = parseReviewVerdict('{"approve":true}');
  assert.equal(verdict.approve, true);
  assert.ok(verdict.reason.length > 0);
});

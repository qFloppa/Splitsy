import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzzyScore, matchAll } from "./search-score.ts";

test("exact substring scores high", () => {
  assert.ok(fuzzyScore("bill splits", "splits")! > 100);
});

test("word-boundary prefix beats mid-word substring", () => {
  // "split" at the start of "splits" → boundary bonus.
  const boundary = fuzzyScore("bill splits", "split")!;
  // "end" inside "dependent" is mid-word, no boundary bonus.
  const midword = fuzzyScore("dependent", "end")!;
  assert.ok(boundary > midword, `boundary ${boundary} should beat midword ${midword}`);
});

test("subsequence match returns a positive score", () => {
  assert.ok(fuzzyScore("circle appkit bridge", "cab")! > 0);
});

test("no subsequence → null", () => {
  assert.equal(fuzzyScore("arc testnet", "xyz"), null);
});

test("empty needle scores zero (matches everything)", () => {
  assert.equal(fuzzyScore("anything", ""), 0);
});

test("matchAll: all words must match (AND)", () => {
  assert.ok(matchAll("circle appkit bridge", ["circle", "bridge"]) !== null);
  assert.equal(matchAll("circle appkit bridge", ["circle", "xyz"]), null);
});

test("matchAll: score is monotonic in match count", () => {
  const one = matchAll("circle appkit bridge", ["circle"])!.score;
  const two = matchAll("circle appkit bridge", ["circle", "appkit"])!.score;
  assert.ok(two > one);
});

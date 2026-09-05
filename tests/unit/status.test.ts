#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import { commitMatches, statusForCommits } from "../../src/status.ts";

const DESIRED = "896224c4b1879920ab573417e68fd51d2ccc9072";
const SHORT = "896224c";
const OTHER = "a".repeat(40);

void test("commitMatches accepts the full SHA and its 7-character prefix", () => {
  assert.equal(commitMatches(DESIRED, DESIRED), true);
  assert.equal(commitMatches(DESIRED, SHORT), true);
});

void test("commitMatches rejects a different commit", () => {
  assert.equal(commitMatches(DESIRED, OTHER), false);
});

void test("an empty observed commit never matches", () => {
  // Load-bearing: `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/status.sh:7::cut` guards with [ -n "$observed" ]
  // before either comparison. Without it, `statusForCommits` would read an
  // absent generated tree as current and report success for state it never
  // verified.
  assert.equal(commitMatches(DESIRED, ""), false);
  assert.equal(commitMatches("", ""), false);
});

void test("statusForCommits walks the shell's branch order", () => {
  assert.equal(statusForCommits(DESIRED, "", ""), "needs prepare");
  assert.equal(statusForCommits(DESIRED, OTHER, ""), "needs prepare");
  assert.equal(statusForCommits(DESIRED, DESIRED, ""), "needs install");
  assert.equal(statusForCommits(DESIRED, DESIRED, OTHER), "needs install");
  assert.equal(statusForCommits(DESIRED, OTHER, DESIRED), "needs prepare");
  assert.equal(statusForCommits(DESIRED, OTHER, SHORT), "needs prepare");
  assert.equal(statusForCommits(DESIRED, DESIRED, DESIRED), "current");
  assert.equal(statusForCommits(DESIRED, DESIRED, SHORT), "current");
});

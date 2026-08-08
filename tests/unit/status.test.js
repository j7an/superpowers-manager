#!/usr/bin/env node
// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

// A static import from `dist/` fails the `typecheck:js` gate: dist output has
// no accompanying .d.ts, so checkJs treats every parameter along the chain as
// implicit `any`. Load the built module dynamically while typing it against
// its `src/` source instead.
/** @type {typeof import("../../src/status.js")} */
const { commitMatches, statusForCommits } = await import(
  new URL("../../dist/status.js", import.meta.url).href
);

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
  // Load-bearing: scripts/core/status.sh:7 guards with [ -n "$observed" ]
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

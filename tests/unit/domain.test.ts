import assert from "node:assert/strict";
import test from "node:test";

import { SafetyError } from "../../src/safety-error.ts";

import * as refs from "../../src/domain/refs.ts";

import { commitMatches } from "../../src/domain/fingerprint.ts";

const lower = "0123456789abcdef0123456789abcdef01234567";
const upper = lower.toUpperCase();

void test("SafetyError exposes stable structured fields", () => {
  const cause = new Error("cause");
  const error = new SafetyError("unit", "failed", {
    cause,
    details: { phase: "pre-replacement" },
  });
  assert.equal(error.name, "SafetyError");
  assert.equal(error.module, "unit");
  assert.equal(error.message, "failed");
  assert.equal(error.cause, cause);
  assert.deepEqual(error.details, { phase: "pre-replacement" });
});

void test("REF-PINNABLE-01 / SEL-SCHEMA-REFS-01 tag grammar", () => {
  for (const value of ["v0.0.0", "v1.2.3-0", "v1.2.3-alpha.1"]) {
    assert.equal(refs.isTagRef(value), true, value);
  }
  for (const value of [
    "1.2.3",
    "V1.2.3",
    "v01.2.3",
    "v1.02.3",
    "v1.2.03",
    "v1.2.3-01",
    "v1.2.3+build.1",
    "v1.2.3\nextra",
  ]) {
    assert.equal(refs.isTagRef(value), false, value);
  }
});

void test("REF-PIN-SOURCE-01 / SEL-SCHEMA-COMMIT-01 / SEL-SCHEMA-COMMIT-WRITE-01 commit forms", () => {
  assert.equal(refs.isCommit(lower), true);
  assert.equal(refs.isCommit(upper), false);
  assert.equal(refs.COMMIT_INPUT_RE.test(lower), true);
  assert.equal(refs.COMMIT_INPUT_RE.test(upper), true);
  assert.equal(refs.normalizeCommitInput(upper), lower);
  assert.equal(refs.normalizeCommitInput("0123456"), null);
});

void test("INSTALL-VERIFY-01 fingerprints match full or seven-character observed commits only", () => {
  assert.equal(commitMatches(lower, lower), true);
  assert.equal(commitMatches(lower, lower.slice(0, 7)), true);
  assert.equal(commitMatches(lower, ""), false);
  assert.equal(commitMatches(lower, lower.slice(0, 8)), false);
  assert.equal(commitMatches(lower, "deadbee"), false);
});

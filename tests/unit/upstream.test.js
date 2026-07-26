// @ts-check
import assert from "node:assert/strict";
import test from "node:test";

/** @type {typeof import("../../src/domain/refs.js")} */
const { parseStableTag, compareStable, TAG_RE, SEMVER_BASE_RE } = await import(
  new URL("../../dist/domain/refs.js", import.meta.url).href
);

void test("parseStableTag accepts three-component stable tags only", () => {
  assert.deepEqual(parseStableTag("v6.0.10"), {
    major: 6n,
    minor: 0n,
    patch: 10n,
  });
  assert.equal(parseStableTag("v6.1.0-beta.1"), null, "prerelease rejected");
  assert.equal(parseStableTag("v7.0"), null, "two components rejected");
  assert.equal(parseStableTag("v8.0.0+build"), null, "build metadata rejected");
  assert.equal(parseStableTag("6.0.3"), null, "missing v prefix rejected");
  assert.equal(parseStableTag("v01.2.3"), null, "leading zero rejected");
});

void test("compareStable orders components numerically at arbitrary width", () => {
  const a = parseStableTag("v6.0.2");
  const b = parseStableTag("v6.0.10");
  if (a === null || b === null) throw new Error("fixture failed to parse");
  assert.ok(compareStable(a, b) < 0);
  assert.ok(compareStable(b, a) > 0);
  assert.equal(compareStable(a, a), 0);

  const wide = parseStableTag("v99999999999999999999.0.0");
  const narrow = parseStableTag("v9999999999.0.0");
  if (wide === null || narrow === null) throw new Error("wide fixture failed");
  assert.ok(
    compareStable(narrow, wide) < 0,
    "twenty-digit major must exceed ten-digit major",
  );
});

void test("the SemVer grammar has one source", () => {
  assert.equal(SEMVER_BASE_RE.test("6.1.0-beta.1"), true);
  assert.equal(SEMVER_BASE_RE.test("01.2.3"), false);
  assert.equal(TAG_RE.test("v6.1.0-beta.1"), true);
  assert.equal(TAG_RE.test("6.1.0-beta.1"), false);
});

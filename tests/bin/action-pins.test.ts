// Characterises findLiteralActionPinSnapshots, the detector behind the
// literal-pin source policy in tests/bin/workflows.test.ts.
//
// Fixture SHAs are CONSTRUCTED, never written as literals. The literal-pin
// source policy scans this file, and an inline 40-hex pin here would fail the
// very policy these tests pin. The correct response to such a failure is
// restructuring the fixture, never adding an exclusion.

import { scratch } from "../lib/scratch.ts";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { findLiteralActionPinSnapshots } from "./workflow-support.ts";

const SHA_ONE = "1".padStart(40, "0");
const SHA_TWO = "2".padStart(40, "0");
const SHORT_SHA = "1".padStart(39, "0");
const LONG_SHA = "1".padStart(41, "0");
const CHECKOUT = "actions/checkout";

// --- the literal-pin detector ------------------------------------------
// The detector's fixtures are written to a temp file because it reads from
// disk. The SHAs are still constructed, never inline literals.

const DETECTOR_POSITIVE_LINES = [
  `assert_contains "$block" "${CHECKOUT}@${SHA_ONE}"`,
  `uses: ${CHECKOUT}@${SHA_ONE} # v7.0.0`,
  `uses: '${CHECKOUT}@${SHA_ONE}' # v7.0.0`,
  `uses: "${CHECKOUT}@${SHA_ONE}" # v7.0.0`,
  `block="uses: \\"${CHECKOUT}@${SHA_ONE}\\" # v7.0.0"`,
  `pin=(${CHECKOUT}@${SHA_ONE})`,
  `pin=\`${CHECKOUT}@${SHA_ONE}\``,
  `pin=${CHECKOUT}@${SHA_ONE};`,
];

const DETECTOR_NEGATIVE_LINES = [
  `HEAD_SHA=${SHA_ONE}`,
  `uses: ${CHECKOUT}@${SHORT_SHA} # v7.0.0`,
  `uses: ${CHECKOUT}@${LONG_SHA} # v7.0.0`,
  `uses: ${CHECKOUT}@v7 # v7.0.0`,
];

assert.equal(
  DETECTOR_POSITIVE_LINES.length,
  8,
  "DETECTOR_POSITIVE_LINES lost or gained a case; review the detector contract",
);
assert.equal(
  DETECTOR_NEGATIVE_LINES.length,
  4,
  "DETECTOR_NEGATIVE_LINES lost or gained a case; review the detector contract",
);

void test("literal pin detector reports every embedded-pin form", (t) => {
  const dir = scratch(t, "spw-pins-");

  const file = join(dir, "literal-pins.sh");
  writeFileSync(file, `${DETECTOR_POSITIVE_LINES.join("\n")}\n`, "utf8");

  const expected = DETECTOR_POSITIVE_LINES.map(
    (line, index) => `${file}:${index + 1}:${line}`,
  );
  assert.deepEqual(findLiteralActionPinSnapshots([file]), expected);
});

void test("literal pin detector accepts the negative fixtures", (t) => {
  const dir = scratch(t, "spw-pins-");

  const file = join(dir, "non-literal-pins.sh");
  writeFileSync(file, `${DETECTOR_NEGATIVE_LINES.join("\n")}\n`, "utf8");

  assert.deepEqual(findLiteralActionPinSnapshots([file]), []);
});

// --- port-only: discriminating fixtures for the two properties none of the
// shell-derived fixtures above actually exercises (controller ruling,
// 2026-08-02). Mutation-tested: disabling the boundary check left all 20
// existing tests GREEN, and letting the scan continue past the first
// per-line finding (a `break`-shaped bug instead of `return`) also left all
// 20 GREEN. Neither property has shell-corpus coverage; these two fixtures
// close the gap and were each proven discriminating by the same
// break/observe/restore cycle against tests/bin/workflow-support.ts.

void test("literal pin detector port-only: a sha immediately followed by a non-hex letter is not a boundary and is rejected", (t) => {
  const dir = scratch(t, "spw-pins-");

  const file = join(dir, "boundary-pins.sh");
  const line = `uses: ${CHECKOUT}@${SHA_ONE}z # v7.0.0`;
  writeFileSync(file, `${line}\n`, "utf8");

  assert.deepEqual(findLiteralActionPinSnapshots([file]), []);
});

void test("literal pin detector port-only: two valid pins on one line still produce exactly one finding", (t) => {
  const dir = scratch(t, "spw-pins-");

  const file = join(dir, "double-pin.sh");
  const line = `pin_a=${CHECKOUT}@${SHA_ONE} pin_b=${CHECKOUT}@${SHA_TWO}`;
  writeFileSync(file, `${line}\n`, "utf8");

  assert.deepEqual(findLiteralActionPinSnapshots([file]), [
    `${file}:1:${line}`,
  ]);
});

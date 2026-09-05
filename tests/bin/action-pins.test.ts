// Ported from tests/test_workflows.sh's test_action_pin_helper (:347-419)
// and test_literal_action_pin_detector (:486-537), which characterise the
// awk functions in tests/lib/action-pin-assertions.sh. See
// tests/migration-inventory/workflows.md for the numbered inventory.
//
// Fixture SHAs are CONSTRUCTED, never written as literals. The literal-pin
// source policy in tests/bin/workflows.test.js scans this file, and an
// inline 40-hex pin here would fail the very policy these functions
// implement. The correct response to such a failure is restructuring the
// fixture, never adding an exclusion.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  actionPinPair,
  findLiteralActionPinSnapshots,
} from "./workflow-support.ts";

const SHA_ONE = "1".padStart(40, "0");
const SHA_TWO = "2".padStart(40, "0");
const SHORT_SHA = "1".padStart(39, "0");
const LONG_SHA = "1".padStart(41, "0");
const UPPERCASE_SHA = "A".repeat(40);
const TARGET = "github/codeql-action/analyze";
const CHECKOUT = "actions/checkout";

// --- inventory items 2-4: accepted pin forms ---------------------------
const ACCEPTED_PIN_BLOCKS = [
  { name: "unquoted", block: `        uses: ${TARGET}@${SHA_ONE} # v4.99.0` },
  {
    name: "single-quoted",
    block: `        uses: '${TARGET}@${SHA_ONE}' # v4.99.0`,
  },
  {
    name: "double-quoted",
    block: `        uses: "${TARGET}@${SHA_ONE}" # v4.99.0`,
  },
];

assert.equal(
  ACCEPTED_PIN_BLOCKS.length,
  3,
  "ACCEPTED_PIN_BLOCKS lost or gained a case — update tests/migration-inventory/workflows.md",
);

for (const { name, block } of ACCEPTED_PIN_BLOCKS) {
  void test(`action pin accepted: ${name}`, () => {
    assert.deepEqual(actionPinPair(block, TARGET), {
      sha: SHA_ONE,
      version: "v4.99.0",
    });
  });
}

// --- inventory item 5: agreeing duplicate references ------------------
void test("action pin pair: agreeing duplicate references yield one pair", () => {
  const block = [
    `        uses: ${TARGET}@${SHA_ONE} # v4.99.0`,
    `        uses: ${TARGET}@${SHA_ONE} # v4.99.0`,
  ].join("\n");
  assert.deepEqual(actionPinPair(block, TARGET), {
    sha: SHA_ONE,
    version: "v4.99.0",
  });
});

// --- inventory items 6-16: rejected pin forms -------------------------
const OSV_EXACT =
  "google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml";
const OSV_NEAR =
  "google/osv-scanner-action/Xgithub/workflows/osv-scanner-reusableXyml";

const REJECTED_PIN_BLOCKS = [
  {
    name: "floating tag instead of a sha",
    target: TARGET,
    block: `        uses: ${TARGET}@v4.99.0 # v4.99.0`,
  },
  {
    name: "uppercase sha",
    target: TARGET,
    block: `        uses: ${TARGET}@${UPPERCASE_SHA} # v4.99.0`,
  },
  {
    name: "39-character sha",
    target: TARGET,
    block: `        uses: ${TARGET}@${SHORT_SHA} # v4.99.0`,
  },
  {
    name: "41-character sha",
    target: TARGET,
    block: `        uses: ${TARGET}@${LONG_SHA} # v4.99.0`,
  },
  {
    name: "missing version comment",
    target: TARGET,
    block: `        uses: ${TARGET}@${SHA_ONE}`,
  },
  {
    name: "truncated version comment",
    target: TARGET,
    block: `        uses: ${TARGET}@${SHA_ONE} # v4`,
  },
  {
    name: "near-miss target must not satisfy the exact target",
    target: OSV_EXACT,
    block: `        uses: ${OSV_NEAR}@${SHA_ONE} # v2.99.0`,
  },
  {
    name: "disagreeing shas",
    target: CHECKOUT,
    block: [
      `        uses: ${CHECKOUT}@${SHA_ONE} # v7.0.0`,
      `        uses: ${CHECKOUT}@${SHA_TWO} # v7.1.0`,
    ].join("\n"),
  },
  {
    name: "sha alongside an unquoted floating tag",
    target: CHECKOUT,
    block: [
      `        uses: ${CHECKOUT}@${SHA_ONE} # v7.0.0`,
      `        uses: ${CHECKOUT}@v7 # v7.0.0`,
    ].join("\n"),
  },
  {
    name: "sha alongside a single-quoted floating tag",
    target: CHECKOUT,
    block: [
      `        uses: ${CHECKOUT}@${SHA_ONE} # v7.0.0`,
      `        uses: '${CHECKOUT}@v7' # v7.0.0`,
    ].join("\n"),
  },
  {
    name: "sha alongside a double-quoted floating tag",
    target: CHECKOUT,
    block: [
      `        uses: ${CHECKOUT}@${SHA_ONE} # v7.0.0`,
      `        uses: "${CHECKOUT}@v7" # v7.0.0`,
    ].join("\n"),
  },
];

assert.equal(
  REJECTED_PIN_BLOCKS.length,
  11,
  "REJECTED_PIN_BLOCKS lost or gained a case — update tests/migration-inventory/workflows.md",
);

for (const { name, target, block } of REJECTED_PIN_BLOCKS) {
  void test(`action pin rejected: ${name}`, () => {
    assert.throws(
      () => actionPinPair(block, target),
      /expected agreeing semantic action pins/,
    );
  });
}

// --- port-only: discriminating fixtures for the three properties a naive
// port silently loses (controller ruling, 2026-08-02). None of the shell's
// 16 action-pin fixtures actually exercises any of these three properties —
// verified by mutation testing each one and observing every existing
// fixture stay GREEN (see tests/migration-inventory/workflows.md). These
// three have no shell counterpart; they exist only in the port. Each was
// proven discriminating: break the property in tests/bin/workflow-support.js,
// this fixture (and only this one, among these three) goes RED; restore, it
// goes GREEN again.
const PORT_ONLY_DISCRIMINATING_BLOCKS = [
  {
    name: "anchored prefix match: target embedded mid-line, not at the start, is not accepted",
    target: CHECKOUT,
    block: `        uses: prefix-${CHECKOUT}@${SHA_ONE} # v1.0.0`,
  },
  {
    name: "quote-close boundary: a reference opened with one quote and apparently closed with a different quote is not accepted",
    target: CHECKOUT,
    block: `        uses: '${CHECKOUT}@${SHA_ONE}" # v1.0.0`,
  },
  {
    name: "reference-count ordering: a bare reference alongside a valid one to the same target forces a count disagreement",
    target: CHECKOUT,
    block: [
      `        uses: ${CHECKOUT}@${SHA_ONE} # v1.0.0`,
      `        uses: ${CHECKOUT}@${SHA_ONE}`,
    ].join("\n"),
  },
];

assert.equal(
  PORT_ONLY_DISCRIMINATING_BLOCKS.length,
  3,
  "PORT_ONLY_DISCRIMINATING_BLOCKS lost or gained a case — update tests/migration-inventory/workflows.md",
);

for (const { name, target, block } of PORT_ONLY_DISCRIMINATING_BLOCKS) {
  void test(`action pin port-only: ${name}`, () => {
    assert.throws(
      () => actionPinPair(block, target),
      /expected agreeing semantic action pins/,
    );
  });
}

// --- inventory items 17-18: the literal-pin detector -------------------
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
  "DETECTOR_POSITIVE_LINES lost or gained a case — update tests/migration-inventory/workflows.md",
);
assert.equal(
  DETECTOR_NEGATIVE_LINES.length,
  4,
  "DETECTOR_NEGATIVE_LINES lost or gained a case — update tests/migration-inventory/workflows.md",
);

void test("literal pin detector reports every embedded-pin form", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "spw-pins-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const file = join(dir, "literal-pins.sh");
  writeFileSync(file, `${DETECTOR_POSITIVE_LINES.join("\n")}\n`, "utf8");

  const expected = DETECTOR_POSITIVE_LINES.map(
    (line, index) => `${file}:${index + 1}:${line}`,
  );
  assert.deepEqual(findLiteralActionPinSnapshots([file]), expected);
});

void test("literal pin detector accepts the negative fixtures", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "spw-pins-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

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
// break/observe/restore cycle against tests/bin/workflow-support.js.

void test("literal pin detector port-only: a sha immediately followed by a non-hex letter is not a boundary and is rejected", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "spw-pins-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const file = join(dir, "boundary-pins.sh");
  const line = `uses: ${CHECKOUT}@${SHA_ONE}z # v7.0.0`;
  writeFileSync(file, `${line}\n`, "utf8");

  assert.deepEqual(findLiteralActionPinSnapshots([file]), []);
});

void test("literal pin detector port-only: two valid pins on one line still produce exactly one finding", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "spw-pins-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const file = join(dir, "double-pin.sh");
  const line = `pin_a=${CHECKOUT}@${SHA_ONE} pin_b=${CHECKOUT}@${SHA_TWO}`;
  writeFileSync(file, `${line}\n`, "utf8");

  assert.deepEqual(findLiteralActionPinSnapshots([file]), [
    `${file}:1:${line}`,
  ]);
});

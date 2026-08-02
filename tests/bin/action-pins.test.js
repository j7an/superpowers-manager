// @ts-check
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
import test from "node:test";

import { actionPinPair } from "./workflow-support.js";

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

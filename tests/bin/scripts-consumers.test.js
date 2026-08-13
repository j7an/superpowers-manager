// @ts-check
// D2a's gate: re-run the audit, reconcile it against the declared disposition
// map in tests/bin/scripts-consumers.js.
//
// The gate proves the declared set and the observed set are the SAME HITS. It
// does not — and no gate can — prove that a disposition is the right one. Read
// the module header for what per-hit keying does buy, which is attribution
// rather than semantics.
//
// Three mutation cases below keep the reconciliation from going vacuous, and
// each isolates ONE way it can be wrong: a hit nobody declared, an entry
// somebody deleted, and an entry left behind after its hit went. They exercise
// `reconcileAudit` directly rather than by editing the tree, so the permanent
// suite stays hermetic; the tree-level versions of the first two were run by
// hand at Task 10 and are recorded in that task's report.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  auditKey,
  DISPOSITIONS,
  reconcileAudit,
  runScriptsAudit,
  SCRIPTS_CONSUMERS,
} from "./scripts-consumers.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** A root with one known hit, so a zero real-tree audit cannot be a broken command. */
function positiveControl() {
  const root = mkdtempSync(join(tmpdir(), "spw-audit-control-"));
  try {
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(
      join(root, "tests", "probe.test.js"),
      'const p = "scripts/core/common.sh";\n',
    );
    return runScriptsAudit(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void test("the audit still matches, so an empty real-tree result means the tree", () => {
  assert.equal(positiveControl().length, 1);
});

void test("scripts/ is gone, so the audit and the declaration map are both empty", () => {
  assert.deepEqual(runScriptsAudit(ROOT), []);
  assert.deepEqual(SCRIPTS_CONSUMERS, []);
});

void test("every declaration names a disposition from the three-value set and a target", () => {
  for (const entry of SCRIPTS_CONSUMERS) {
    const key = auditKey(entry);
    assert.ok(
      /** @type {readonly string[]} */ (DISPOSITIONS).includes(
        entry.disposition,
      ),
      `${key} carries the disposition ${JSON.stringify(entry.disposition)}, which is not one of ${DISPOSITIONS.join(", ")}`,
    );
    // Non-empty for all three, not only for re-express and relocate. A retire
    // that names no 4c work item is the same deferral the target field exists
    // to stop; see the module header.
    assert.ok(
      entry.target.trim().length > 0,
      `${key} is dispositioned ${entry.disposition} with no target`,
    );
  }
});

// Retired in Slice 4c: D2a's 29/52 sizing question was discharged by the
// relocation map in Task 1; the protocol suite now lives under fixtures, and
// Task 2 removes the remaining shell drivers.

const FIXTURE_HIT = {
  file: "tests/bin/fixture.test.js",
  line: 1,
  normalized: 'const p = join(ROOT, "scripts/core/common.sh");',
  ordinal: 1,
};
const FIXTURE_DECL = {
  ...FIXTURE_HIT,
  disposition: /** @type {const} */ ("retire"),
  target: "fixture entry for this mutation case only",
};

void test("the reconciliation fails when the audit reports a hit nobody declared", () => {
  const injected = [FIXTURE_HIT];
  const { undeclared, stale } = reconcileAudit(injected, SCRIPTS_CONSUMERS);
  assert.deepEqual(stale, []);
  assert.deepEqual(undeclared, [
    'tests/bin/fixture.test.js :: const p = join(ROOT, "scripts/core/common.sh"); :: #1',
  ]);
});

void test("the reconciliation fails when a declared entry is deleted", () => {
  const { undeclared, stale } = reconcileAudit([FIXTURE_HIT], []);
  assert.deepEqual(stale, []);
  assert.deepEqual(undeclared, [auditKey(FIXTURE_HIT)]);
});

void test("the reconciliation fails when a declaration outlives its hit", () => {
  const { undeclared, stale } = reconcileAudit([], [FIXTURE_DECL]);
  assert.deepEqual(undeclared, []);
  assert.deepEqual(stale, [auditKey(FIXTURE_DECL)]);
});

void test("a D2a audit that cannot run raises instead of reporting zero rows", () => {
  // The fourth mutation case, and the one 4c depends on. The other three ask
  // whether reconciliation notices a wrong set; this asks whether the audit
  // can tell "found nothing" from "did not run". 4c's exit check asserts zero
  // rows, so the two must not be the same observable.
  //
  // Driven by the root, the one input runScriptsAudit takes. An empty
  // directory has no tests/, so AUDIT_COMMAND's producing grep exits 2 with a
  // diagnostic on stderr while the trailing `grep -v` exits 1 — a status the
  // guard above reads as "matched nothing". No tracked file is touched and
  // nothing outside mkdtemp is written.
  //
  // Against the pre-fix implementation this returned [] and threw nothing,
  // which is the fail-open it exists to pin.
  const empty = mkdtempSync(join(tmpdir(), "spw-audit-cannot-run-"));
  try {
    assert.throws(
      () => runScriptsAudit(empty),
      /the D2a audit command wrote to stderr, so the audit did not run to completion/,
    );
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

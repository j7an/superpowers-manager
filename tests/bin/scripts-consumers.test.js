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
import { mkdtempSync, rmSync } from "node:fs";
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

/** @returns {import("./scripts-consumers.js").AuditHit[]} */
function observe() {
  const rows = runScriptsAudit(ROOT);
  // A zero-row audit is 4c's success condition, not 4b's: reaching it here
  // would mean the command stopped matching rather than that the tree changed,
  // and every case below would then pass over an empty set.
  assert.ok(
    rows.length > 0,
    "the D2a audit returned no rows at all — the command, not the tree, is the likely cause",
  );
  return rows;
}

void test("every audit hit is declared, and every declaration is an audit hit", () => {
  const { undeclared, stale } = reconcileAudit(observe(), SCRIPTS_CONSUMERS);
  assert.deepEqual(
    undeclared,
    [],
    `these scripts/ consumers have no disposition in tests/bin/scripts-consumers.js:\n${undeclared.join("\n")}`,
  );
  assert.deepEqual(
    stale,
    [],
    `these declared dispositions match no audit hit any more:\n${stale.join("\n")}`,
  );
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

void test("the two figures 4c plans against are re-derived from the map, not carried as prose", () => {
  /** @param {string} file */
  const hits = (file) =>
    SCRIPTS_CONSUMERS.filter((entry) => entry.file === file).length;
  // Exact literals on purpose: these two are spec D2a's own post-merge
  // amendment, the numbers 4c sizes the relocation against, so the contract IS
  // the figure. A tree change that moves either one has to be re-adjudicated
  // against D2a rather than absorbed.
  assert.equal(
    hits("tests/test_adapter_protocol.sh"),
    29,
    "D2a: one protocol suite holding 29 literal scripts/ path sites",
  );
  assert.equal(
    hits("tests/test_adapter_protocol.sh") +
      hits("tests/test_probe.sh") +
      hits("tests/test_marketplace_reconcile.sh") +
      hits("tests/test_node_cli_helper.sh"),
    52,
    "D2a: 52 sites across the four surviving shell drivers",
  );
});

void test("the reconciliation fails when the audit reports a hit nobody declared", () => {
  const injected = [
    ...observe(),
    {
      file: "tests/bin/invented.test.js",
      line: 1,
      normalized: 'const p = join(ROOT, "scripts/core/common.sh");',
      ordinal: 1,
    },
  ];
  const { undeclared, stale } = reconcileAudit(injected, SCRIPTS_CONSUMERS);
  assert.deepEqual(stale, []);
  assert.deepEqual(undeclared, [
    'tests/bin/invented.test.js :: const p = join(ROOT, "scripts/core/common.sh"); :: #1',
  ]);
});

void test("the reconciliation fails when a declared entry is deleted", () => {
  const rows = observe();
  const dropped = SCRIPTS_CONSUMERS.slice(1);
  const { undeclared, stale } = reconcileAudit(rows, dropped);
  assert.deepEqual(stale, []);
  assert.deepEqual(undeclared, [auditKey(SCRIPTS_CONSUMERS[0])]);
});

void test("the reconciliation fails when a declaration outlives its hit", () => {
  const rows = observe();
  const extra = [
    ...SCRIPTS_CONSUMERS,
    {
      file: "tests/bin/retired.test.js",
      line: 1,
      normalized: 'cpSync(join(ROOT, "scripts"), dest);',
      ordinal: 1,
      disposition: /** @type {const} */ ("retire"),
      target: "fixture entry for this mutation case only",
    },
  ];
  const { undeclared, stale } = reconcileAudit(rows, extra);
  assert.deepEqual(undeclared, []);
  assert.deepEqual(stale, [
    'tests/bin/retired.test.js :: cpSync(join(ROOT, "scripts"), dest); :: #1',
  ]);
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

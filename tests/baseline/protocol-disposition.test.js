#!/usr/bin/env node
// @ts-check
// The gate PR 11.5 is run against, shipped before the deletion it guards so it
// is written by someone who does not yet know the answer.
//
// The input is the frozen 29-ID literal below — never a query over
// traceability.md. A selector-derived input empties exactly when PR 11.5
// deletes the protocol suites, at which point the gate passes vacuously and
// orphans all 29. FROZEN_IDS deliberately lives here and not in the table, so
// that editing the table alone cannot move its own expectation.

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DISPOSITION = join(ROOT, "docs", "baseline", "protocol-disposition.md");
const TRACEABILITY = join(ROOT, "docs", "baseline", "traceability.md");

const SUITES = [
  "tests/test_adapter_protocol.py",
  "tests/test_adapter_protocol.sh",
];

const FROZEN_IDS = [
  "ADAPTER-CONTROLLED-FAILURE-01",
  "ADAPTER-ENVELOPE-01",
  "ADAPTER-ENVELOPE-KEYS-01",
  "ADAPTER-ENVELOPE-TYPES-01",
  "ADAPTER-FINGERPRINT-01",
  "ADAPTER-FINGERPRINT-REJECT-01",
  "ADAPTER-INSTALL-REJECT-01",
  "ADAPTER-INSTALL-RESULT-01",
  "ADAPTER-OWNERSHIP-01",
  "ADAPTER-OWNERSHIP-REJECT-01",
  "ADAPTER-PROTOCOL-01",
  "ADAPTER-READER-BYTES-01",
  "ADAPTER-READER-CONSTANTS-01",
  "ADAPTER-READER-DEPTH-01",
  "ADAPTER-READER-DUPLICATES-01",
  "ADAPTER-READER-UTF8-01",
  "ADAPTER-REPLAY-01",
  "ADAPTER-STATUS-01",
  "ADAPTER-SURROGATE-01",
  "ADAPTER-TERMINAL-01",
  "ADAPTER-TERMINAL-SHAPE-01",
  "ADAPTER-UPDATE-CONTROL-01",
  "CLI-ENV-CODEX-LISTING-01",
  "CLI-ENV-CODEX-MUTATION-01",
  "CLI-ENV-INSTALLED-DEFAULTS-01",
  "CLI-ENV-INSTALLED-ROOT-01",
  "CLI-ENV-REFRESH-MODE-01",
  "DIAG-ADAPTER-01",
  "PROV-READER-CODEX-SOURCE-01",
];

const HEADER =
  /^\|\s*Behavior ID\s*\|\s*Disposition\s*\|\s*Owning suite\s*\|\s*Target\s*\|\s*Rationale\s*\|$/;

/** @param {string} line */
function markdownCells(line) {
  return line
    .trim()
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

// Uses String.prototype.match rather than the RegExp.prototype.exec form in
// traceability.test.js:58-62. Identical result for a non-global pattern; the
// exec form trips this repo's security hook, which reads it as child_process.
/** @param {string} cell */
function uncode(cell) {
  const match = cell.match(/^`([^`]*)`$/);
  return match ? match[1] : cell;
}

/**
 * @returns {Array<{ id: string, disposition: string, suite: string, target: string, rationale: string }>}
 */
function dispositionRows() {
  const lines = readFileSync(DISPOSITION, "utf8").split("\n");
  const headerIndex = lines.findIndex((line) => HEADER.test(line));
  assert.notEqual(
    headerIndex,
    -1,
    "the disposition table header row is missing or misspelled",
  );
  const delimiter = lines[headerIndex + 1] || "";
  assert.match(
    delimiter,
    /^\|.*\|$/,
    "the disposition delimiter row is missing",
  );
  const delimiterCells = markdownCells(delimiter);
  assert.equal(
    delimiterCells.length,
    5,
    `the disposition delimiter must have five fields: ${delimiter}`,
  );
  for (const cell of delimiterCells) {
    assert.match(
      cell,
      /^:?-{3,}:?$/,
      `invalid disposition delimiter cell: ${cell}`,
    );
  }
  const rows = [];
  for (
    let index = headerIndex + 2;
    /^\|.*\|$/.test(lines[index] || "");
    index += 1
  ) {
    const fields = markdownCells(lines[index]);
    assert.equal(
      fields.length,
      5,
      `disposition row must have five fields: ${lines[index]}`,
    );
    rows.push({
      id: uncode(fields[0]),
      disposition: uncode(fields[1]),
      suite: uncode(fields[2]),
      target: uncode(fields[3]),
      rationale: fields[4],
    });
  }
  return rows;
}

/**
 * Behavior ID to the PATH half of its traceability selector. Deliberately
 * ignores the selector: the selector-level guarantee already belongs to
 * TRACEABILITY-TESTS-01, and a second weaker copy of it here would be a
 * liability rather than a defence.
 * @returns {Map<string, string>}
 */
function traceabilityPaths() {
  const lines = readFileSync(TRACEABILITY, "utf8").split("\n");
  const headerIndex = lines.findIndex((line) =>
    /^\|\s*Behavior ID\s*\|\s*Exact test case\s*\|\s*Fixture \/ builder\s*\|$/.test(
      line,
    ),
  );
  assert.notEqual(headerIndex, -1, "the traceability table header is missing");
  /** @type {Map<string, string>} */
  const paths = new Map();
  for (
    let index = headerIndex + 2;
    /^\|.*\|$/.test(lines[index] || "");
    index += 1
  ) {
    const fields = markdownCells(lines[index]);
    assert.equal(
      fields.length,
      3,
      `traceability row must have three fields: ${lines[index]}`,
    );
    const id = uncode(fields[0]);
    const testCase = uncode(fields[1]);
    const separator = testCase.indexOf("::");
    assert.ok(separator > 0, `${id} test case must use PATH::SELECTOR`);
    assert.equal(paths.has(id), false, `duplicate traceability row: ${id}`);
    paths.set(id, testCase.slice(0, separator));
  }
  assert.ok(paths.size > 0, "traceability has no rows");
  return paths;
}

void test("PROTOCOL-DISPOSITION-SET-01 the table covers exactly the frozen 29", () => {
  const ids = dispositionRows().map((row) => row.id);
  const seen = new Set();
  const duplicates = [
    ...new Set(
      ids.filter((id) => {
        if (seen.has(id)) return true;
        seen.add(id);
        return false;
      }),
    ),
  ].sort();
  assert.deepEqual(
    duplicates,
    [],
    "duplicate behavior IDs in the disposition table",
  );
  assert.deepEqual(
    [...ids].sort(),
    [...FROZEN_IDS].sort(),
    "the disposition table's ID set must equal the frozen 29-ID list exactly",
  );
});

void test("PROTOCOL-DISPOSITION-VALUES-01 every row is well formed", () => {
  const rows = dispositionRows();
  assert.ok(rows.length > 0, "the disposition table has no rows");
  for (const { id, disposition, suite, target, rationale } of rows) {
    assert.ok(
      disposition === "retire" || disposition === "remap",
      `${id}: disposition must be exactly "retire" or "remap", found: ${disposition}`,
    );
    assert.ok(
      SUITES.includes(suite),
      `${id}: owning suite must be one of ${SUITES.join(", ")}, found: ${suite}`,
    );
    assert.ok(rationale.length > 0, `${id}: rationale must not be empty`);
    if (disposition === "retire") {
      assert.equal(
        target,
        "—",
        `${id}: a retire row's target must be the em dash, found: ${target}`,
      );
      continue;
    }
    assert.ok(
      target.startsWith("tests/"),
      `${id}: a remap target must be under tests/, found: ${target}`,
    );
    assert.equal(
      target.split("/").includes(".."),
      false,
      `${id}: a remap target must not traverse: ${target}`,
    );
    // A protocol suite satisfies "exists and is a file under tests/" today,
    // which would collapse REMAP-01's disjunction to a tautology and break
    // this gate at the exact moment PR 11.5 deletes the file. A remap must
    // point somewhere that survives the deletion.
    assert.equal(
      SUITES.includes(target),
      false,
      `${id}: a remap target must not be a protocol suite — ${target} is deleted by PR 11.5`,
    );
    const absolute = join(ROOT, target);
    assert.equal(
      existsSync(absolute),
      true,
      `${id}: remap target does not exist: ${target}`,
    );
    assert.equal(
      statSync(absolute).isFile(),
      true,
      `${id}: remap target is not a file: ${target}`,
    );
  }
});

void test("PROTOCOL-DISPOSITION-REMAP-01 every remap sits at its owning suite or its declared target", () => {
  const paths = traceabilityPaths();
  const remaps = dispositionRows().filter((row) => row.disposition === "remap");
  // Fail closed: an all-retire table would make this test iterate nothing and
  // report success. If adjudication genuinely produced zero remaps, escalate —
  // do not delete this guard.
  assert.ok(
    remaps.length > 0,
    "no remap rows: this assertion would iterate nothing",
  );
  for (const { id, suite, target } of remaps) {
    const actual = paths.get(id);
    assert.ok(
      actual !== undefined,
      `${id} is a remap but has no traceability row`,
    );
    assert.ok(
      actual === suite || actual === target,
      `${id} traceability path must be its owning suite (${suite}) or its declared target (${target}), found: ${actual}`,
    );
  }
});

void test("PROTOCOL-DISPOSITION-RETIRE-01 a retire is present exactly while its owning suite exists", () => {
  const paths = traceabilityPaths();
  const retires = dispositionRows().filter(
    (row) => row.disposition === "retire",
  );
  // Fail closed, as above.
  assert.ok(
    retires.length > 0,
    "no retire rows: this assertion would iterate nothing",
  );
  for (const { id, suite } of retires) {
    const suiteExists = existsSync(join(ROOT, suite));
    assert.equal(
      paths.has(id),
      suiteExists,
      suiteExists
        ? `${id} was retired from traceability.md while its owning suite ${suite} still exists — retirement follows deletion, it does not precede it`
        : `${id} remains in traceability.md but its owning suite ${suite} is gone — the retirement was never carried out`,
    );
    // The biconditional alone cannot see a wrong Owning suite: both protocol
    // suites exist, so swapping .py for .sh leaves both sides unchanged. Remap
    // rows are already pinned by REMAP-01's disjunction; without this, retire
    // rows would be the only ones whose declared owner is unconstrained, and
    // the column that justifies the retirement could name the wrong artifact.
    if (paths.has(id)) {
      assert.equal(
        paths.get(id),
        suite,
        `${id}: declared owning suite ${suite} disagrees with its traceability path ${paths.get(id)}`,
      );
    }
  }
});

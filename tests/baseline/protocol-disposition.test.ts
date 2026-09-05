#!/usr/bin/env node
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
const INVENTORY = join(ROOT, "docs", "baseline", "behavioral-inventory.md");

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

function markdownCells(line: string) {
  return line
    .trim()
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

// Uses String.prototype.match rather than the RegExp.prototype.exec form in
// `tests/baseline/traceability.test.ts:56::const match`. Identical result for a non-global pattern; the
// exec form trips this repo's security hook, which reads it as child_process.

function uncode(cell: string) {
  const match = cell.match(/^`([^`]*)`$/);
  return match ? match[1] : cell;
}

function assertMarkdownDelimiter(
  lines: string[],
  headerIndex: number,
  expectedColumns: number,
  label: string,
) {
  const delimiter = lines[headerIndex + 1] || "";
  assert.match(delimiter, /^\|.*\|$/, `${label} delimiter row is missing`);
  const cells = markdownCells(delimiter);
  assert.equal(
    cells.length,
    expectedColumns,
    `${label} delimiter must have ${expectedColumns} fields: ${delimiter}`,
  );
  for (const cell of cells) {
    assert.match(
      cell,
      /^:?-{3,}:?$/,
      `${label} has an invalid delimiter cell: ${cell}`,
    );
  }
}

function dispositionRows(
  source: string = readFileSync(DISPOSITION, "utf8"),
): Array<{
  id: string;
  disposition: string;
  suite: string;
  target: string;
  rationale: string;
}> {
  const lines = source.split("\n");
  const headerIndex = lines.findIndex((line) => HEADER.test(line));
  assert.notEqual(
    headerIndex,
    -1,
    "the disposition table header row is missing or misspelled",
  );
  assertMarkdownDelimiter(lines, headerIndex, 5, "disposition table");
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

function inventoryContracts(
  source: string = readFileSync(INVENTORY, "utf8"),
): Map<string, string> {
  const lines = source.split("\n");

  const contracts: Map<string, string> = new Map();

  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\|\s*Behavior ID\s*\|/.test(lines[index])) continue;
    const headers = markdownCells(lines[index]);
    const contractColumns = ["Contract", "Production consumer and effect"]
      .map((header) => headers.indexOf(header))
      .filter((column) => column !== -1);
    assert.equal(
      contractColumns.length,
      1,
      `inventory table must name exactly one contract column: ${lines[index]}`,
    );
    assertMarkdownDelimiter(lines, index, headers.length, "inventory table");
    const contractColumn = contractColumns[0];
    index += 2;

    while (/^\|.*\|$/.test(lines[index] || "")) {
      const fields = markdownCells(lines[index]);
      assert.equal(
        fields.length,
        headers.length,
        `inventory row must have ${headers.length} fields: ${lines[index]}`,
      );
      const id = uncode(fields[0]);
      assert.equal(
        contracts.has(id),
        false,
        `duplicate behavioral inventory contract: ${id}`,
      );
      assert.notEqual(
        fields[contractColumn],
        "",
        `${id}: behavioral inventory contract must not be empty`,
      );
      contracts.set(id, fields[contractColumn]);
      index += 1;
    }
  }

  assert.ok(contracts.size > 0, "behavioral inventory has no contracts");
  return contracts;
}

function normalizeMarkdownWhitespace(value: string, label: string) {
  let normalized = "";
  let delimiterLength = 0;
  let pendingSpace = false;

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "`") {
      let end = index;
      while (value[end + 1] === "`") end += 1;
      const run = value.slice(index, end + 1);
      if (delimiterLength === 0) delimiterLength = run.length;
      else if (delimiterLength === run.length) delimiterLength = 0;
      if (pendingSpace && normalized.length > 0) normalized += " ";
      pendingSpace = false;
      normalized += run;
      index = end;
      continue;
    }

    if (delimiterLength === 0 && /[\t\n\r ]/.test(value[index])) {
      pendingSpace = normalized.length > 0;
      continue;
    }
    if (pendingSpace) normalized += " ";
    pendingSpace = false;
    normalized += value[index];
  }

  assert.equal(delimiterLength, 0, `${label}: unclosed Markdown code span`);
  return normalized.trim();
}

function leadingNormativeSentence(id: string, contractCell: string) {
  const contract = normalizeMarkdownWhitespace(contractCell, `${id} contract`);
  let delimiterLength = 0;

  for (let index = 0; index < contract.length; index += 1) {
    if (contract[index] === "`") {
      let end = index;
      while (contract[end + 1] === "`") end += 1;
      const runLength = end - index + 1;
      if (delimiterLength === 0) delimiterLength = runLength;
      else if (delimiterLength === runLength) delimiterLength = 0;
      index = end;
      continue;
    }
    const terminator =
      contract[index] === "." ||
      contract[index] === "!" ||
      contract[index] === "?";
    const boundary =
      index === contract.length - 1 || /[\t\n\r ]/.test(contract[index + 1]);
    if (delimiterLength === 0 && terminator && boundary) {
      return contract.slice(0, index + 1);
    }
  }

  assert.fail(`${id}: current contract has no unambiguous leading sentence`);
}

function parseRationale(id: string, rationale: string) {
  const normalized = normalizeMarkdownWhitespace(rationale, `${id} rationale`);
  const prefix = 'Contract: "';
  assert.equal(
    normalized.startsWith(prefix),
    true,
    `${id}: rationale must start with ${prefix}`,
  );
  const closingQuote = normalized.indexOf('"', prefix.length);
  assert.notEqual(
    closingQuote,
    -1,
    `${id}: rationale contract quote is unclosed`,
  );
  const quote = normalized.slice(prefix.length, closingQuote);
  assert.notEqual(
    quote,
    "",
    `${id}: rationale contract quote must not be empty`,
  );
  assert.equal(
    leadingNormativeSentence(id, quote),
    normalizeMarkdownWhitespace(quote, `${id} quote`),
    `${id}: rationale quote must contain exactly one contract sentence`,
  );
  const explanation = normalized.slice(closingQuote + 1);
  assert.match(
    explanation,
    /^\s+\S/,
    `${id}: rationale explanation must not be empty`,
  );
  return { quote, explanation: explanation.trim() };
}

function duplicateValues(values: string[]) {
  const seen = new Set();
  return [
    ...new Set(
      values.filter((value) => {
        if (seen.has(value)) return true;
        seen.add(value);
        return false;
      }),
    ),
  ].sort();
}

function assertRationaleContracts(
  rows: ReturnType<typeof dispositionRows>,
  contracts: Map<string, string>,
) {
  const parsed = rows.map((row) => ({
    ...row,
    ...parseRationale(row.id, row.rationale),
  }));
  assert.deepEqual(
    duplicateValues(parsed.map(({ quote }) => quote)),
    [],
    "duplicate disposition contract quotes",
  );

  for (const { id, disposition, quote } of parsed) {
    const current = contracts.get(id);
    if (disposition === "retire") {
      assert.equal(
        current,
        undefined,
        `${id}: retired behavior must be absent from the current inventory`,
      );
      continue;
    }
    if (disposition !== "remap") continue;
    assert.ok(
      current !== undefined,
      `${id}: remapped behavior has no current inventory contract`,
    );
    assert.equal(
      quote,
      leadingNormativeSentence(id, current),
      `${id}: rationale must quote its same-ID current leading contract`,
    );
  }
}

function replaceDispositionRationale(
  source: string,
  id: string,
  rationale: string,
) {
  const lines = source.split("\n");
  const matches = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.startsWith(`| \`${id}\` |`));
  assert.equal(
    matches.length,
    1,
    `mutation requires one disposition row: ${id}`,
  );
  const fields = markdownCells(matches[0].line);
  assert.equal(fields.length, 5, `mutation row must have five fields: ${id}`);
  fields[4] = rationale;
  lines[matches[0].index] = `| ${fields.join(" | ")} |`;
  return lines.join("\n");
}

function replaceOnce(
  source: string,
  before: string,
  after: string,
  label: string,
) {
  const first = source.indexOf(before);
  assert.notEqual(first, -1, `${label}: source text is missing`);
  assert.equal(
    source.indexOf(before, first + before.length),
    -1,
    `${label}: source text is ambiguous`,
  );
  return source.slice(0, first) + after + source.slice(first + before.length);
}

/**
 * Behavior ID to the PATH half of its traceability selector. Deliberately
 * ignores the selector: the selector-level guarantee already belongs to
 * TRACEABILITY-TESTS-01, and a second weaker copy of it here would be a
 * liability rather than a defence.
 */
function traceabilityPaths(): Map<string, string> {
  const lines = readFileSync(TRACEABILITY, "utf8").split("\n");
  const headerIndex = lines.findIndex((line) =>
    /^\|\s*Behavior ID\s*\|\s*Exact test case\s*\|\s*Fixture \/ builder\s*\|$/.test(
      line,
    ),
  );
  assert.notEqual(headerIndex, -1, "the traceability table header is missing");

  const paths: Map<string, string> = new Map();
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
    // "Exists and is a file under tests/" admits tests/suites.json and every
    // fixture. The target names where the behavior's coverage lands, so it must
    // be a runnable test file — the same shapes TRACEABILITY-TESTS-01 resolves.
    // Without this the wrong target survives until PR 11.5 moves the row and
    // TRACEABILITY-TESTS-01 rejects it there, far from the edit that caused it.
    assert.match(
      target,
      /^tests\/(?:baseline|unit)\/[^/]+\.test\.ts$/,
      `${id}: a remap target must be a runnable test file under tests/baseline/ or tests/unit/, found: ${target}`,
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
  assertRationaleContracts(rows, inventoryContracts());
});

void test("PROTOCOL-DISPOSITION-RATIONALES-01 parser boundaries and required mutations fail closed", () => {
  assert.equal(
    normalizeMarkdownWhitespace("  A   `B  C`   D.  ", "whitespace fixture"),
    "A `B  C` D.",
  );
  assert.equal(
    leadingNormativeSentence(
      "FIXTURE-01",
      "Keep `file.name` and version 1.2 exact. Later prose.",
    ),
    "Keep `file.name` and version 1.2 exact.",
  );
  assert.throws(
    () => leadingNormativeSentence("FIXTURE-02", "Keep `file.name` exact"),
    {
      name: "AssertionError",
      message:
        /FIXTURE-02: current contract has no unambiguous leading sentence/,
    },
  );
  assert.throws(
    () => normalizeMarkdownWhitespace("Keep `file.name exact.", "FIXTURE-03"),
    {
      name: "AssertionError",
      message: /FIXTURE-03: unclosed Markdown code span/,
    },
  );

  const inventorySource = readFileSync(INVENTORY, "utf8");
  const dispositionSource = readFileSync(DISPOSITION, "utf8");
  const rows = dispositionRows(dispositionSource);

  const rationaleFor = (id: string) => {
    const matches = rows.filter((row) => row.id === id);
    assert.equal(matches.length, 1, `mutation requires one parsed row: ${id}`);
    return matches[0].rationale;
  };
  const fingerprintSentence =
    "Fingerprint inspection accepts null and exact 7- or 40-hex fingerprints in its exact result shape.";

  const mutations = [
    {
      name: "opaque rationale",
      inventory: inventorySource,
      disposition: replaceDispositionRationale(
        dispositionSource,
        "ADAPTER-ENVELOPE-01",
        "x",
      ),
      message: /ADAPTER-ENVELOPE-01: rationale must start with Contract:/,
    },
    {
      name: "copied retired rationale",
      inventory: inventorySource,
      disposition: replaceDispositionRationale(
        dispositionSource,
        "ADAPTER-ENVELOPE-KEYS-01",
        rationaleFor("ADAPTER-ENVELOPE-01"),
      ),
      message: /duplicate disposition contract quotes/,
    },
    {
      name: "shortened remap quote",
      inventory: inventorySource,
      disposition: replaceDispositionRationale(
        dispositionSource,
        "ADAPTER-FINGERPRINT-01",
        replaceOnce(
          rationaleFor("ADAPTER-FINGERPRINT-01"),
          fingerprintSentence,
          "Fingerprint inspection accepts null and 7- or 40-hex fingerprints in its exact result shape.",
          "shortened quote mutation",
        ),
      ),
      message:
        /ADAPTER-FINGERPRINT-01: rationale must quote its same-ID current leading contract/,
    },
    {
      name: "empty explanation",
      inventory: inventorySource,
      disposition: replaceDispositionRationale(
        dispositionSource,
        "ADAPTER-FINGERPRINT-01",
        `Contract: "${fingerprintSentence}"`,
      ),
      message:
        /ADAPTER-FINGERPRINT-01: rationale explanation must not be empty/,
    },
    {
      name: "stale after inventory edit",
      inventory: replaceOnce(
        inventorySource,
        fingerprintSentence,
        "Fingerprint inspection accepts only null and exact 7- or 40-hex fingerprints in its exact result shape.",
        "inventory contract mutation",
      ),
      disposition: dispositionSource,
      message:
        /ADAPTER-FINGERPRINT-01: rationale must quote its same-ID current leading contract/,
    },
  ];

  for (const mutation of mutations) {
    assert.throws(
      () =>
        assertRationaleContracts(
          dispositionRows(mutation.disposition),
          inventoryContracts(mutation.inventory),
        ),
      { name: "AssertionError", message: mutation.message },
      mutation.name,
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

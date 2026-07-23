#!/usr/bin/env node
// @ts-check

import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const INVENTORY = join(ROOT, 'docs', 'baseline', 'behavioral-inventory.md');
const TRACEABILITY = join(ROOT, 'docs', 'baseline', 'traceability.md');
const ID_PATTERN = /^(?:CLI-MODE|CLI-COMMANDS|CLI-USAGE|CLI-PREFLIGHT|CLI-CHILD-STATUS|CLI-ENV|SEL-LOCATION|SEL-PRECEDENCE|SEL-SCHEMA|SEL-BYTES|SEL-READER|REF|PROVENANCE-BYTES|PROV-READER|MANIFEST-READER|CODEX-JSON|ADAPTER|ADAPTER-READER|GENERATED|FS|PREPARE|PROBE|INSTALL|UPDATE|UNINSTALL|DIAG|PACKAGE)-[A-Z0-9-]+$/;
const FORBIDDEN_PREFIXES = [
  'docs/superpowers/',
  'tests/manual/',
  'bin/',
  'scripts/',
  'config/',
  'plugins/',
  '.agents/',
];

function markdownCells(line) {
  return line.trim().slice(1, -1).split('|').map((cell) => cell.trim());
}

function assertMarkdownDelimiter(lines, headerIndex, expectedColumns, label) {
  const delimiter = lines[headerIndex + 1] || '';
  assert.match(delimiter, /^\|.*\|$/, `${label} delimiter row is missing`);
  const cells = markdownCells(delimiter);
  assert.equal(
    cells.length,
    expectedColumns,
    `${label} delimiter must have ${expectedColumns} fields: ${delimiter}`,
  );
  for (const cell of cells) {
    assert.match(cell, /^:?-{3,}:?$/, `${label} has an invalid delimiter cell: ${cell}`);
  }
}

function uncode(cell) {
  const match = /^`([^`]*)`$/.exec(cell);
  return match ? match[1] : cell;
}

function inventoryIds() {
  const lines = readFileSync(INVENTORY, 'utf8').split('\n');
  const ids = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\|\s*Behavior ID\s*\|/.test(lines[index])) continue;
    const headerCells = markdownCells(lines[index]);
    assertMarkdownDelimiter(lines, index, headerCells.length, 'inventory table');
    index += 2;
    while (/^\|.*\|$/.test(lines[index] || '')) {
      const fields = markdownCells(lines[index]);
      assert.equal(
        fields.length,
        headerCells.length,
        `inventory row must have ${headerCells.length} fields: ${lines[index]}`,
      );
      const id = uncode(fields[0]);
      assert.match(id, ID_PATTERN, `invalid inventory behavior ID: ${id}`);
      ids.push(id);
      index += 1;
    }
  }
  assert.ok(ids.length > 0, 'inventory has no behavior contract rows');
  return ids;
}

function traceabilityRows() {
  const lines = readFileSync(TRACEABILITY, 'utf8').split('\n');
  const headerIndex = lines.findIndex(
    (line) => /^\|\s*Behavior ID\s*\|\s*Exact test case\s*\|\s*Fixture \/ builder\s*\|$/.test(line),
  );
  assert.notEqual(headerIndex, -1, 'traceability table header is missing');
  assertMarkdownDelimiter(lines, headerIndex, 3, 'traceability table');
  const rows = [];
  for (let index = headerIndex + 2; /^\|.*\|$/.test(lines[index] || ''); index += 1) {
    const fields = markdownCells(lines[index]);
    assert.equal(fields.length, 3, `traceability row must have three fields: ${lines[index]}`);
    const [rawId, rawTestCase, rawSupport] = fields;
    const id = uncode(rawId);
    assert.match(id, ID_PATTERN, `invalid traceability behavior ID: ${id}`);
    assert.ok(rawTestCase, `${id} has an empty exact test case`);
    assert.ok(rawSupport, `${id} has an empty fixture / builder field`);
    rows.push({
      id,
      testCase: uncode(rawTestCase),
      support: uncode(rawSupport),
    });
  }
  assert.ok(rows.length > 0, 'traceability has no rows');
  return rows;
}

function duplicates(values) {
  const seen = new Set();
  return [...new Set(values.filter((value) => {
    if (seen.has(value)) return true;
    seen.add(value);
    return false;
  }))].sort();
}

function assertSafeRepositoryPath(path, label) {
  assert.equal(path.startsWith('/'), false, `${label} must be repository-relative: ${path}`);
  assert.equal(path.split('/').includes('..'), false, `${label} must not traverse: ${path}`);
  for (const prefix of FORBIDDEN_PREFIXES) {
    assert.equal(path.startsWith(prefix), false, `${label} uses forbidden path ${path}`);
  }
}

test('TRACEABILITY-IDS-01 every assigned behavior ID has exactly one row', () => {
  const inventory = inventoryIds();
  const traceability = traceabilityRows().map(({ id }) => id);
  assert.deepEqual(duplicates(inventory), [], 'duplicate inventory behavior IDs');
  assert.deepEqual(duplicates(traceability), [], 'duplicate traceability behavior IDs');

  const inventorySet = new Set(inventory);
  const traceabilitySet = new Set(traceability);
  const missing = inventory.filter((id) => !traceabilitySet.has(id)).sort();
  const unknown = traceability.filter((id) => !inventorySet.has(id)).sort();
  assert.deepEqual(
    { missing, unknown },
    { missing: [], unknown: [] },
    `unmapped inventory IDs: ${missing.join(', ') || 'none'}; unknown traceability IDs: ${unknown.join(', ') || 'none'}`,
  );
});

test('TRACEABILITY-TESTS-01 every row names an exact running test case', () => {
  for (const { id, testCase } of traceabilityRows()) {
    assert.equal(
      testCase.match(/::/g)?.length,
      1,
      `${id} test case must contain exactly one PATH::SELECTOR separator`,
    );
    const separator = testCase.indexOf('::');
    assert.ok(separator > 0, `${id} test case must use PATH::SELECTOR`);
    assert.ok(separator < testCase.length - 2, `${id} test selector is empty`);
    const path = testCase.slice(0, separator);
    const selector = testCase.slice(separator + 2);
    assert.ok(selector, `${id} test selector is empty`);
    assertSafeRepositoryPath(path, `${id} test`);
    assert.equal(path.startsWith('tests/'), true, `${id} test path must be under tests/: ${path}`);
    assert.equal(path.startsWith('tests/fixtures/'), false, `${id} cannot map to a fixture`);
    assert.notEqual(path, 'tests/run.sh', `${id} cannot map to the host-suite entrypoint`);
    assert.notEqual(
      path,
      'tests/test_behavioral_baseline.sh',
      `${id} cannot map to the baseline driver`,
    );

    const absolute = join(ROOT, path);
    assert.equal(existsSync(absolute), true, `${id} test path does not exist: ${path}`);
    assert.equal(statSync(absolute).isFile(), true, `${id} test path is not a file: ${path}`);
    const source = readFileSync(absolute, 'utf8');
    if (/^tests\/baseline\/[^/]+\.test\.js$/.test(path)) {
      assert.equal(
        source.includes(`test('${selector}'`) || source.includes(`test("${selector}"`),
        true,
        `${id} Node test selector is not a literal test name in ${path}: ${selector}`,
      );
    } else if (/^tests\/test_[^/]+\.py$/.test(path)) {
      assert.match(selector, /^test_[A-Za-z0-9_]+$/, `${id} Python selector must be a unittest method`);
      assert.equal(
        source.includes(`def ${selector}(`),
        true,
        `${id} Python unittest method is absent from ${path}: ${selector}`,
      );
    } else if (/^tests\/test_[^/]+\.sh$/.test(path)) {
      assert.match(selector, /^# BASELINE CASE: [A-Z0-9-]+ .+$/, `${id} shell selector must be a BASELINE CASE marker`);
      assert.equal(
        source.includes(selector),
        true,
        `${id} shell BASELINE CASE marker is absent from ${path}: ${selector}`,
      );
    } else {
      assert.fail(`${id} path is not an exact runnable test file: ${path}`);
    }
  }
});

test('TRACEABILITY-FIXTURES-01 every supporting artifact exists', () => {
  for (const { id, support } of traceabilityRows()) {
    if (support === '—') continue;
    assertSafeRepositoryPath(support, `${id} supporting artifact`);
    assert.equal(
      support === 'tests/builders/baseline-scenario.sh'
        || support.startsWith('tests/fixtures/baseline/'),
      true,
      `${id} supporting artifact is outside the baseline fixture/builder scope: ${support}`,
    );
    const absolute = join(ROOT, support);
    assert.equal(existsSync(absolute), true, `${id} supporting artifact does not exist: ${support}`);
    assert.equal(statSync(absolute).isFile(), true, `${id} supporting artifact is not a file: ${support}`);
    assert.equal(relative(ROOT, absolute).split(sep).includes('..'), false);
  }
});

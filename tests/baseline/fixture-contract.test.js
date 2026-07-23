import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import test from 'node:test';
import { join } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const FIXTURES = join(ROOT, 'tests', 'fixtures', 'baseline');

function read(relative) {
  return readFileSync(join(FIXTURES, relative));
}

function maxJsonNesting(value, depth = 0) {
  if (value === null || typeof value !== 'object') return depth;
  const nextDepth = depth + 1;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.reduce(
    (maximum, child) => Math.max(maximum, maxJsonNesting(child, nextDepth)),
    nextDepth,
  );
}

test('FIXTURE-SELECTION-01 canonical selection bytes', () => {
  const expected = {
    'selection/track-latest.json': '{\n  "schema_version": 1,\n  "mode": "track-latest",\n  "source": "https://github.com/obra/superpowers"\n}\n',
    'selection/pinned-tag.json': '{\n  "schema_version": 1,\n  "mode": "pinned",\n  "source": "https://github.com/obra/superpowers",\n  "requested_ref": "v6.1.1",\n  "resolved_ref": "v6.1.1",\n  "commit": "0123456789abcdef0123456789abcdef01234567"\n}\n',
    'selection/pinned-commit.json': '{\n  "schema_version": 1,\n  "mode": "pinned",\n  "source": "https://github.com/obra/superpowers",\n  "requested_ref": "0123456789abcdef0123456789abcdef01234567",\n  "resolved_ref": "0123456789abcdef0123456789abcdef01234567",\n  "commit": "0123456789abcdef0123456789abcdef01234567"\n}\n',
  };
  for (const [relative, text] of Object.entries(expected)) {
    assert.deepEqual(read(relative), Buffer.from(text, 'utf8'));
  }
});

test('FIXTURE-PROVENANCE-01 canonical provenance bytes', () => {
  const expected = {
    'provenance/valid-tag.json': '{\n  "source": "https://example.invalid/superpowers.git",\n  "requested_ref": "latest-release",\n  "resolved_ref": "v6.1.1",\n  "commit": "d884ae04edebef577e82ff7c4e143debd0bbec99",\n  "upstream_manifest_version": "6.1.1"\n}\n',
    'provenance/valid-commit.json': '{\n  "source": "https://example.invalid/superpowers.git",\n  "requested_ref": "d884ae04edebef577e82ff7c4e143debd0bbec99",\n  "resolved_ref": "d884ae04edebef577e82ff7c4e143debd0bbec99",\n  "commit": "d884ae04edebef577e82ff7c4e143debd0bbec99",\n  "upstream_manifest_version": "6.1.1"\n}\n',
  };
  for (const [relative, text] of Object.entries(expected)) {
    assert.deepEqual(read(relative), Buffer.from(text, 'utf8'));
  }
});

test('FIXTURE-ADAPTER-SIZE-01 adapter byte boundaries', () => {
  for (const [relative, expected] of [
    ['adapter-responses/size-1048576.json', 1_048_576],
    ['adapter-responses/size-1048577.json', 1_048_577],
  ]) {
    const path = join(FIXTURES, relative);
    assert.equal(statSync(path).size, expected);
    JSON.parse(readFileSync(path, 'utf8'));
  }
});

test('FIXTURE-ADAPTER-DEPTH-01 adapter depth boundaries', () => {
  for (const [relative, expected] of [
    ['adapter-responses/depth-64.json', 64],
    ['adapter-responses/depth-65.json', 65],
  ]) {
    assert.equal(maxJsonNesting(JSON.parse(readFileSync(join(FIXTURES, relative), 'utf8'))), expected);
  }
});

test('FIXTURE-TREE-01 generated tree listings are sorted and canonical', () => {
  for (const relative of [
    'generated-tree/no-hooks.txt',
    'generated-tree/default-hooks.txt',
    'generated-tree/declared-hooks.txt',
  ]) {
    const text = readFileSync(join(FIXTURES, relative), 'utf8');
    assert.ok(text.endsWith('\n'));
    const paths = text.slice(0, -1).split('\n');
    assert.ok(paths.every((path) => path));
    assert.deepEqual(paths, [...paths].sort());
    assert.ok(paths.every((path) => !path.includes('\\')));
    assert.ok(paths.every((path) => !path.includes('.git/')));
  }
});

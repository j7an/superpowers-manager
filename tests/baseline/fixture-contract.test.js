// @ts-check

import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
const FIXTURES = join(ROOT, "tests", "fixtures", "baseline");

/**
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {number}
 */
function maxJsonNesting(value, depth = 0) {
  if (value === null || typeof value !== "object") return depth;
  const nextDepth = depth + 1;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.reduce(
    (maximum, child) => Math.max(maximum, maxJsonNesting(child, nextDepth)),
    nextDepth,
  );
}

void test("FIXTURE-ADAPTER-SIZE-01 adapter byte boundaries", () => {
  /** @type {[string, number][]} */
  const cases = [
    ["adapter-responses/size-1048576.json", 1_048_576],
    ["adapter-responses/size-1048577.json", 1_048_577],
  ];
  for (const [relative, expected] of cases) {
    const path = join(FIXTURES, relative);
    assert.equal(statSync(path).size, expected);
    JSON.parse(readFileSync(path, "utf8"));
  }
});

void test("FIXTURE-ADAPTER-DEPTH-01 adapter depth boundaries", () => {
  /** @type {[string, number][]} */
  const cases = [
    ["adapter-responses/depth-64.json", 64],
    ["adapter-responses/depth-65.json", 65],
  ];
  for (const [relative, expected] of cases) {
    assert.equal(
      maxJsonNesting(
        JSON.parse(readFileSync(join(FIXTURES, relative), "utf8")),
      ),
      expected,
    );
  }
});

void test("FIXTURE-TREE-01 generated tree listings are sorted and canonical", () => {
  for (const relative of [
    "generated-tree/no-hooks.txt",
    "generated-tree/default-hooks.txt",
    "generated-tree/declared-hooks.txt",
  ]) {
    const text = readFileSync(join(FIXTURES, relative), "utf8");
    assert.ok(text.endsWith("\n"));
    const paths = text.slice(0, -1).split("\n");
    assert.ok(paths.every((path) => path));
    assert.deepEqual(paths, [...paths].sort());
    assert.ok(paths.every((path) => !path.includes("\\")));
    assert.ok(paths.every((path) => !path.includes(".git/")));
  }
});

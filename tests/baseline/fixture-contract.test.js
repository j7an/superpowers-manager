// @ts-check

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
const FIXTURES = join(ROOT, "tests", "fixtures", "baseline");

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

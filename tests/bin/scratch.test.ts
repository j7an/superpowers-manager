import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { scratch } from "../lib/scratch.ts";

const SCRATCH_MODULE = new URL("../lib/scratch.ts", import.meta.url).href;

void test("scratch removes its tree when its test ends; suiteScratch keeps its tree for the file's tests and removes it afterwards, even when a test fails", (t) => {
  // A separate `node --test` run, so each tree's whole lifetime is observable
  // from outside: the suite tree must outlive the first test and not outlive
  // the file; the per-test tree must not outlive its test.
  const file = join(scratch(t, "spw-suite-scratch-"), "fixture.test.ts");
  writeFileSync(
    file,
    [
      'import assert from "node:assert/strict";',
      'import { existsSync, writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'import test from "node:test";',
      `import { scratch, suiteScratch } from ${JSON.stringify(SCRATCH_MODULE)};`,
      'const tree = suiteScratch("spw-suite-scratch-tree-");',
      'let dir = "";',
      "process.stdout.write(`tree=${tree}\\n`);",
      'test("writes", () => writeFileSync(join(tree, "marker"), "x"));',
      'test("survives", () => assert.ok(existsSync(join(tree, "marker"))));',
      'test("fails", () => assert.fail("deliberate"));',
      'test("per-test", (t) => {',
      '  dir = scratch(t, "spw-test-scratch-tree-");',
      '  writeFileSync(join(dir, "marker"), "x");',
      "  process.stdout.write(`dir=${dir}\\n`);",
      "});",
      'test("per-test gone", () => assert.equal(existsSync(dir), false, "the per-test tree must be removed when its test ends"));',
      "",
    ].join("\n"),
  );
  const env = { ...process.env };
  // Inherited from the outer `node --test`, these make the inner run treat
  // itself as nested and skip every file with exit 0.
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  const r = spawnSync(process.execPath, ["--test", file], {
    encoding: "utf8",
    env,
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /pass 4/);
  assert.match(r.stdout, /fail 1/);
  const tree = /tree=(\S+)/.exec(r.stdout)?.[1];
  assert.ok(tree, "the fixture must print its tree");
  assert.equal(existsSync(tree), false, "the tree must be removed");
  const dir = /dir=(\S+)/.exec(r.stdout)?.[1];
  assert.ok(dir, "the fixture must print its per-test tree");
  assert.equal(existsSync(dir), false, "the per-test tree must be removed");
});

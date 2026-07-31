// @ts-check
// Ported from tests/test_node_tooling.sh (see
// tests/migration-inventory/node-tooling.md for the assertion inventory).
//
// This is the only typechecker invocation on the `sh tests/run.sh` path —
// package.json's "typecheck:js" script duplicates the same command but does
// not replace this coverage.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TSCONFIG = join(ROOT, "tests", "tsconfig.json");
const DEFAULT_TSC = join(ROOT, "node_modules", ".bin", "tsc");

/**
 * Mirrors `tsc_bin="${SPW_TSC:-$root/node_modules/.bin/tsc}"` from
 * tests/test_node_tooling.sh: the container harness overrides the compiler
 * path through this environment variable; production runs fall back to the
 * repo-local binary.
 * @returns {string}
 */
function resolveTscBin() {
  return process.env.SPW_TSC || DEFAULT_TSC;
}

/**
 * Mirrors test_js_types() from tests/test_node_tooling.sh: fail closed if
 * the resolved compiler is not an executable file, otherwise run it against
 * tests/tsconfig.json.
 * @returns {{ ok: true, status: number | null } | { ok: false }}
 */
function runJsTypecheck() {
  const tscBin = resolveTscBin();
  try {
    accessSync(tscBin, constants.X_OK);
  } catch {
    return { ok: false };
  }
  const result = spawnSync(tscBin, ["-p", TSCONFIG], { encoding: "utf8" });
  return { ok: true, status: result.status };
}

/**
 * @param {import('node:test').TestContext} t
 * @param {string | undefined} value
 */
function withSpwTsc(t, value) {
  const previous = process.env.SPW_TSC;
  if (value === undefined) delete process.env.SPW_TSC;
  else process.env.SPW_TSC = value;
  t.after(() => {
    if (previous === undefined) delete process.env.SPW_TSC;
    else process.env.SPW_TSC = previous;
  });
}

void test("SPW_TSC unset resolves the default repo compiler and exits 0", (t) => {
  withSpwTsc(t, undefined);

  const outcome = runJsTypecheck();

  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok ? outcome.status : -1, 0);
});

void test("SPW_TSC pointing at a missing binary overrides the default and fails closed without invoking tsc", (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "spw-node-tooling-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  // Deliberately never created. The real default compiler
  // (node_modules/.bin/tsc) is still present and valid at this point, so a
  // failure here can only mean SPW_TSC was actually read and preferred over
  // it — proof the override seam is live, not incidentally bypassed.
  const missingBin = join(scratch, "tsc");
  withSpwTsc(t, missingBin);

  const outcome = runJsTypecheck();

  assert.equal(outcome.ok, false);
});

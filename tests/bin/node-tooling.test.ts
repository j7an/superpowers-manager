// Ported from tests/test_node_tooling.sh (see
// tests/migration-inventory/node-tooling.md for the assertion inventory).
//
// This is the only typechecker invocation on the `sh tests/run.sh` path —
// package.json's "typecheck" script includes the same project but does
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
 * Byte-for-byte the message the deleted tests/test_node_tooling.sh printed
 * to stderr on a missing compiler (line 12 of that file at
 * d41fb88^:tests/test_node_tooling.sh), em dash (U+2014) included. Defined
 * once here, independently of runTsTypecheck's own literal, so the
 * assertion below is a real check against production output rather than a
 * comparison against a constant the implementation and the test both import.
 */
const MISSING_COMPILER_DIAGNOSTIC =
  "error: repo TypeScript compiler missing — run pnpm install --frozen-lockfile";

/**
 * Mirrors `tsc_bin="${SPW_TSC:-$root/node_modules/.bin/tsc}"` from the
 * deleted tests/test_node_tooling.sh: that shell driver supported overriding
 * the compiler path through this environment variable, and this port
 * preserves the seam. No in-repo caller sets `SPW_TSC` today — the two tests
 * below exercise both branches by setting and unsetting it directly.
 */
function resolveTscBin(): string {
  return process.env.SPW_TSC || DEFAULT_TSC;
}

/**
 * Mirrors test_js_types() from tests/test_node_tooling.sh: fail closed if
 * the resolved compiler is not an executable file, otherwise run it against
 * tests/tsconfig.json.
 */
function runTsTypecheck():
  { ok: true; status: number | null } | { ok: false; diagnostic: string } {
  const tscBin = resolveTscBin();
  try {
    accessSync(tscBin, constants.X_OK);
  } catch {
    return {
      ok: false,
      diagnostic:
        "error: repo TypeScript compiler missing — run pnpm install --frozen-lockfile",
    };
  }
  const result = spawnSync(tscBin, ["-p", TSCONFIG], { encoding: "utf8" });
  return { ok: true, status: result.status };
}

function withSpwTsc(
  t: import("node:test").TestContext,
  value: string | undefined,
) {
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

  const outcome = runTsTypecheck();

  assert.equal(outcome.ok, true, outcome.ok ? undefined : outcome.diagnostic);
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

  const outcome = runTsTypecheck();

  assert.equal(outcome.ok, false);
  assert.equal(
    outcome.ok ? undefined : outcome.diagnostic,
    MISSING_COMPILER_DIAGNOSTIC,
  );
});

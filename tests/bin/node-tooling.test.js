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
const FROZEN_MESSAGE =
  "error: repo TypeScript compiler missing — run pnpm install --frozen-lockfile";

/**
 * Mirrors test_js_types() from tests/test_node_tooling.sh: resolve the
 * TypeScript compiler from the SPW_TSC seam, fail closed with the frozen
 * message if it is not an executable file, otherwise run it against
 * tests/tsconfig.json.
 * @param {string} tscBin
 * @returns {{ ok: true, status: number | null } | { ok: false, message: string }}
 */
function runJsTypecheck(tscBin) {
  try {
    accessSync(tscBin, constants.X_OK);
  } catch {
    return { ok: false, message: FROZEN_MESSAGE };
  }
  const result = spawnSync(tscBin, ["-p", TSCONFIG], { encoding: "utf8" });
  return { ok: true, status: result.status };
}

void test("SPW_TSC pointing at a missing binary fails closed without invoking tsc", (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "spw-node-tooling-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  // Deliberately never created — the seam the container harness uses to
  // override the compiler path, pointed at nothing.
  const missingBin = join(scratch, "tsc");

  const outcome = runJsTypecheck(missingBin);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok ? undefined : outcome.message, FROZEN_MESSAGE);
});

void test("SPW_TSC pointing at the real compiler exits 0 against tests/tsconfig.json", () => {
  const realTsc = join(ROOT, "node_modules", ".bin", "tsc");

  const outcome = runJsTypecheck(realTsc);

  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok ? outcome.status : -1, 0);
});

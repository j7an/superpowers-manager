// The properties of the shared fake shell (tests/bin/lifecycle-fakes.js) that
// nothing else in the tree asserts.
//
// `process.exitCode = 94` does not halt execution, so an adapter role has to
// stop of its own accord. Each adapter-role case below proves it does: the
// role ends at the tripwire, with the tripwire's exact status and diagnostic
// and nothing running after it.
//
// Nothing here goes through runScript (tests/bin/lifecycle-fixture.js), or
// through a CaseEnv at all: every case below spawns a fake executable directly
// with an env it builds itself. Two committed cases go the other way, driving
// the real subject through runScript — the row-18 cases in
// tests/bin/install-commands.test.js and tests/bin/uninstall-commands.test.js.
// With the seam retired no channel points the subject at a fake adapter, so
// those cases read its log as a residual structural check, and pair that with
// an armed-witness spawn of their own case's fake (lifecycle-fixture.js's
// spawnFakeAdapter) so the check is not reading a path nothing writes to.
// This file is the complement, not a duplicate: it exercises the fixture's own
// contract with no subject in the picture, which is how the exit codes below
// stay reachable at all.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { registerScratch } from "./fixture-scratch.ts";

const BIN = fileURLToPath(new URL(".", import.meta.url));

// mkdtemp under os.tmpdir() for the same reason `tests/bin/lifecycle-fixture.ts:27-36::mkdtempSync(join(tmpdir(), "spw-lifecycle-"))`
// gives: TMPDIR when the runner sets one, the platform default when it does
// not, and uniqueness from mkdtemp rather than from a fixed name.
const SCRATCH = mkdtempSync(join(tmpdir(), "spw-fakes-"));
// registerScratch, not a bare process.on("exit"): the exit-only form is the
// carried defect (row :2040) that fixture-scratch.js exists to close, and it
// leaks this tree on SIGHUP/SIGINT/SIGTERM. This file was added before that
// module landed and kept the old form for five commits.
registerScratch(SCRATCH);

/**
 * The env builder pins the state directory and clears the package root. An
 * ambient package root in the developer's shell would otherwise decide what
 * these cases test.
 *
 */
function fakeEnv(request: { state: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SPW_FIXTURE_STATE: request.state,
  };
  delete env.SPW_TEST_PKG_ROOT;
  return env;
}

function runAdapterRole(kind: "install" | "uninstall"): {
  status: number | null;
  stderr: string;
  state: string;
  adapterLog: string;
} {
  const state = mkdtempSync(join(SCRATCH, `${kind}-`));
  writeFileSync(join(state, "config.json"), "{}");
  const env = fakeEnv({ state });
  const result = spawnSync(
    process.execPath,
    [
      join(BIN, `${kind}-fakes.ts`),
      "adapter",
      "inspect",
      "--view",
      "ownership",
    ],
    { encoding: "utf8", env },
  );
  return {
    status: result.status,
    stderr: result.stderr,
    state,
    adapterLog: readFileSync(join(state, "adapter.log"), "utf8"),
  };
}

for (const kind of ["install", "uninstall"] as const) {
  void test(`${kind}: the adapter role refuses unconditionally`, () => {
    // This exact call — a bare adapter role, with nothing arming it — used to
    // delegate to the real adapter. It is the direct evidence that the
    // tripwire fires on every invocation rather than on a selected one.
    const run = runAdapterRole(kind);
    assert.equal(run.status, 94);
    assert.equal(run.stderr, `fixture: ${kind} must not spawn the adapter\n`);
    // The role body did run, so the exact tripwire result is not vacuous.
    assert.equal(run.adapterLog, "inspect --view ownership\n");
  });
}

// ============================================================================
// runFake's own traps: SPW_FIXTURE_STATE unset (90) and an unknown role (98).
// Both fire inside runFake itself, before any per-kind role body or the
// tripwire runs, so they are unaffected by Task 9's unconditional-tripwire
// change and are exercised here through a single kind — the check is
// kind-independent, since neither branch reads `fake.kind`.
// ============================================================================

void test("runFake refuses when SPW_FIXTURE_STATE is unset (exit 90)", () => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.SPW_FIXTURE_STATE;
  const result = spawnSync(
    process.execPath,
    [join(BIN, "install-fakes.ts"), "codex", "plugin", "list", "--json"],
    { encoding: "utf8", env },
  );
  assert.equal(result.status, 90);
  assert.equal(result.stderr, "fixture: SPW_FIXTURE_STATE is unset\n");
});

void test("runFake refuses an unknown role (exit 98)", () => {
  const state = mkdtempSync(join(SCRATCH, "unknown-role-"));
  writeFileSync(join(state, "config.json"), "{}");

  const env: NodeJS.ProcessEnv = { ...process.env, SPW_FIXTURE_STATE: state };
  const result = spawnSync(
    process.execPath,
    [join(BIN, "install-fakes.ts"), "banana"],
    { encoding: "utf8", env },
  );
  assert.equal(result.status, 98);
  assert.equal(result.stderr, "fixture: unknown role: banana\n");
});

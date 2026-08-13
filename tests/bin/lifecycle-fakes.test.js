// @ts-check
// The properties of the shared fake shell (tests/bin/lifecycle-fakes.js) that
// nothing else in the tree asserts.
//
// `process.exitCode = 94` does not halt execution. The return after
// `tripwireTriggered(ctx, …)` remains load-bearing in both mutating fakes:
// each case below proves the role stops with the tripwire's exact status and
// diagnostic, including when no seam is armed.
//
// Nothing here goes through runScript (tests/bin/lifecycle-fixture.js), or
// through a CaseEnv at all: every case below spawns a fake executable directly
// with an env it builds itself. Two committed cases DO arm adapterSeam:
// "tripwire" through
// runScript — tests/bin/install-commands.test.js:1609 and
// tests/bin/uninstall-commands.test.js:963, row 18's consumer (Task 9,
// Step 3). They drive the real subject, prove it never spawns the fake
// adapter, and pair that with an armed-witness spawn of their own case's fake
// (lifecycle-fixture.js's spawnFakeAdapter) so the emptiness half cannot pass
// on a disarmed tripwire. This file is the complement, not a duplicate: it
// exercises the fixture's own contract with no subject in the picture, which
// is how the exit codes below stay reachable at all.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { registerScratch } from "./fixture-scratch.js";

const BIN = fileURLToPath(new URL(".", import.meta.url));

// mkdtemp under os.tmpdir() for the same reason lifecycle-fixture.js:28-36
// gives: TMPDIR when the runner sets one, the platform default when it does
// not, and uniqueness from mkdtemp rather than from a fixed name.
const SCRATCH = mkdtempSync(join(tmpdir(), "spw-fakes-"));
// registerScratch, not a bare process.on("exit"): the exit-only form is the
// carried defect (row :2040) that fixture-scratch.js exists to close, and it
// leaks this tree on SIGHUP/SIGINT/SIGTERM. This file was added before that
// module landed and kept the old form for five commits.
registerScratch(SCRATCH);

/**
 * The env builder deletes both fixture variables before conditionally setting
 * the seam. An ambient seam or package root in the developer's shell would
 * otherwise decide what these cases test.
 *
 * @param {{ state: string, seam?: string }} request
 * @returns {NodeJS.ProcessEnv}
 */
function fakeEnv(request) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, SPW_FIXTURE_STATE: request.state };
  delete env.SPW_FIXTURE_ADAPTER_SEAM;
  delete env.SPW_TEST_PKG_ROOT;
  if (request.seam !== undefined) env.SPW_FIXTURE_ADAPTER_SEAM = request.seam;
  return env;
}

/**
 * @param {"install" | "uninstall"} kind
 * @param {string | undefined} seam
 * @returns {{
 *   status: number | null,
 *   stderr: string,
 *   state: string,
 *   adapterLog: string,
 * }}
 */
function runAdapterRole(kind, seam) {
  const state = mkdtempSync(join(SCRATCH, `${kind}-`));
  writeFileSync(join(state, "config.json"), "{}");
  const env = fakeEnv({ state, seam });
  const result = spawnSync(
    process.execPath,
    [
      join(BIN, `${kind}-fakes.js`),
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

for (const kind of /** @type {const} */ (["install", "uninstall"])) {
  void test(`${kind}: the adapter role refuses under the tripwire seam`, () => {
    const run = runAdapterRole(kind, "tripwire");
    assert.equal(run.status, 94);
    assert.equal(run.stderr, `fixture: ${kind} must not spawn the adapter\n`);
    // The role body did run, so the exact tripwire result is not vacuous.
    assert.equal(run.adapterLog, "inspect --view ownership\n");
  });

  void test(`${kind}: the adapter role refuses even without the tripwire seam`, () => {
    // Before Task 9, this exact call (no SPW_FIXTURE_ADAPTER_SEAM at all)
    // delegated — see the file header. It is the direct evidence that the
    // tripwire is now unconditional rather than gated on ctx.seam: a case
    // that used to reach the real adapter now refuses identically to the
    // tripwire-armed case above.
    const run = runAdapterRole(kind, undefined);
    assert.equal(run.status, 94);
    assert.equal(run.stderr, `fixture: ${kind} must not spawn the adapter\n`);
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
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env };
  delete env.SPW_FIXTURE_STATE;
  const result = spawnSync(
    process.execPath,
    [join(BIN, "install-fakes.js"), "codex", "plugin", "list", "--json"],
    { encoding: "utf8", env },
  );
  assert.equal(result.status, 90);
  assert.equal(result.stderr, "fixture: SPW_FIXTURE_STATE is unset\n");
});

void test("runFake refuses an unknown role (exit 98)", () => {
  const state = mkdtempSync(join(SCRATCH, "unknown-role-"));
  writeFileSync(join(state, "config.json"), "{}");
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, SPW_FIXTURE_STATE: state };
  delete env.SPW_FIXTURE_ADAPTER_SEAM;
  const result = spawnSync(
    process.execPath,
    [join(BIN, "install-fakes.js"), "banana"],
    { encoding: "utf8", env },
  );
  assert.equal(result.status, 98);
  assert.equal(result.stderr, "fixture: unknown role: banana\n");
});

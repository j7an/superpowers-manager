// @ts-check
// The properties of the shared fake shell (tests/bin/lifecycle-fakes.js) that
// nothing else in the tree asserts.
//
// `process.exitCode = 94` does not halt execution. Drop the `return` after
// `tripwireTriggered(ctx, …)` in any fake and the tripwire still reports, then
// falls through and spawns `scripts/adapters/codex/adapter` for real — the
// exact inverse of what the tripwire is for, and a breach of the Layer 1-3
// hermeticity rule rather than merely a wrong exit code. It would not turn any
// suite red: the real adapter's own status simply overwrites the 94.
//
// So each tripwire case asserts BOTH halves — the 94 AND the absence of a
// delegation footprint. The exit code alone proves nothing, because a
// delegation that happens to exit 94 is indistinguishable from a tripwire
// that held.
//
// PR 11.5 slice 4b's Task 9 (matrix rows 18 and 20) made install and
// uninstall's adapter role refuse UNCONDITIONALLY, matching probe's own
// adapter role: post-flip, `ctx.adapter` is a direct in-process call into
// src/adapter.ts, so no `SPW_FIXTURE_ADAPTER_SEAM` value makes reaching this
// executable legitimate any more. Before this task, only `adapterSeam:
// "tripwire"` refused; every other seam — including no seam at all — fell
// through to `delegateToRealAdapter`. The loop below used to carry a second
// case per kind proving that fall-through happened, as the non-vacuity
// control for the tripwire case beside it. That second case is retired here:
// its assertion encoded exactly the conditional behaviour this task removes,
// so keeping it passing would mean the tripwire had NOT been made
// unconditional. In its place, the loop's second case proves the SAME
// property the retired one used to guard against losing — that a case which
// used to fall through now refuses too — which is the direct evidence that
// wiring, not weakening, happened.
//
// The non-vacuity concern the retired control case existed for — proving this
// harness can tell "refused" from "delegated, then failed" apart, so a "no
// marker" result means "did not delegate" rather than "did not look" — still
// needs an answer once install/uninstall's own adapter role can no longer
// delegate under any input. The "delegateToRealAdapter itself" section below
// answers it: it calls the exported function directly, bypassing the now-
// unconditional tripwire, and proves the STANDIN + marker mechanism this file
// relies on genuinely observes a delegation when one happens. It also covers
// exit codes 95, 96, and 97 (Task 9, Step 4, matrix item 5) — none of which
// are reachable through any fake's normal role dispatch any more, now that
// all three fakes' adapter roles trip unconditionally.
//
// No committed case passes adapterSeam: "tripwire" through runScript
// (tests/bin/lifecycle-fixture.js) — every declared seam is "intercept" or
// the "delegate" default. Every case below spawns a fake, or calls
// delegateToRealAdapter, directly instead, which is also what keeps this file
// independent of tests/bin/install-commands.test.js and
// tests/bin/uninstall-commands.test.js's own new tripwire-armed cases (Task
// 9, Step 3) — those two are row 18's genuine consumer, driving the real
// subject; this file exercises the fixture's own contract in isolation.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
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

// A stand-in for `scripts/adapters/codex/adapter` whose only job is to be
// noticed. It exits 7 — a status no branch of the shell produces — so a
// delegation case can also prove the delegated status is what propagates.
const STANDIN_STATUS = 7;
const STANDIN =
  "#!/bin/sh\n" +
  'echo "DELEGATED $*" >>"$SPW_FIXTURE_STATE/delegated.marker"\n' +
  `exit ${STANDIN_STATUS}\n`;

/**
 * A package root holding nothing but the stand-in adapter, so a delegation
 * cannot reach the repository's real adapter even if one of these cases
 * regresses.
 * @returns {string}
 */
function makePkgRoot() {
  const pkg = mkdtempSync(join(SCRATCH, "pkg-"));
  const dir = join(pkg, "scripts", "adapters", "codex");
  mkdirSync(dir, { recursive: true });
  const adapter = join(dir, "adapter");
  writeFileSync(adapter, STANDIN);
  chmodSync(adapter, 0o755);
  return pkg;
}

/**
 * @param {"install" | "uninstall"} kind
 * @param {string | undefined} seam
 * @returns {{
 *   status: number | null,
 *   stderr: string,
 *   state: string,
 *   delegated: boolean,
 *   adapterLog: string,
 * }}
 */
function runAdapterRole(kind, seam) {
  const state = mkdtempSync(join(SCRATCH, `${kind}-`));
  writeFileSync(join(state, "config.json"), "{}");
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    SPW_FIXTURE_STATE: state,
    SPW_TEST_PKG_ROOT: makePkgRoot(),
  };
  // Deleted rather than left alone: an ambient seam in the developer's shell
  // would otherwise decide what these cases test.
  delete env.SPW_FIXTURE_ADAPTER_SEAM;
  if (seam !== undefined) env.SPW_FIXTURE_ADAPTER_SEAM = seam;
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
  const marker = join(state, "delegated.marker");
  return {
    status: result.status,
    stderr: result.stderr,
    state,
    delegated: existsSync(marker),
    adapterLog: readFileSync(join(state, "adapter.log"), "utf8"),
  };
}

for (const kind of /** @type {const} */ (["install", "uninstall"])) {
  void test(`${kind}: the adapter role refuses under the tripwire seam`, () => {
    const run = runAdapterRole(kind, "tripwire");
    assert.equal(run.status, 94);
    assert.equal(run.stderr, `fixture: ${kind} must not spawn the adapter\n`);
    assert.equal(
      run.delegated,
      false,
      "the tripwire reported but execution fell through into the real adapter",
    );
    // The role body did run — otherwise "no delegation" would be true for the
    // uninteresting reason that nothing happened at all.
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
    assert.equal(
      run.delegated,
      false,
      "the adapter role delegated with no seam armed — the tripwire is no longer unconditional",
    );
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

// ============================================================================
// delegateToRealAdapter itself (matrix item 5, declined for exit 94 which the
// loop above already covers through the normal role dispatch). Task 9 makes
// every fake's adapter role trip unconditionally, so none of exit codes 95,
// 96, or 97 — all internal to delegateToRealAdapter — is reachable through
// any fake's role dispatch any more. These cases call the exported function
// directly instead, in a fresh child process (never this test file's own
// process: delegateToRealAdapter sets process.exitCode as a side effect, and
// mutating that in-process would leak into node:test's own exit status).
//
// The first case below is also this file's replacement for the non-vacuity
// control the retired per-kind test used to provide: it proves the STANDIN +
// marker mechanism this file relies on genuinely observes a delegation when
// one happens, now that no fake's own adapter role can be made to delegate.
// ============================================================================

const DIRECT_DELEGATE_SCRIPT = join(SCRATCH, "direct-delegate.mjs");
writeFileSync(
  DIRECT_DELEGATE_SCRIPT,
  `import { delegateToRealAdapter } from ${JSON.stringify(
    pathToFileURL(join(BIN, "lifecycle-fakes.js")).href,
  )};\ndelegateToRealAdapter({ args: process.argv.slice(2) });\n`,
);

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ status: number | null, stderr: string, delegated: boolean }}
 */
function runDirectDelegate(env) {
  const state = /** @type {string} */ (env.SPW_FIXTURE_STATE);
  const result = spawnSync(
    process.execPath,
    [DIRECT_DELEGATE_SCRIPT, "inspect", "--view", "ownership"],
    { encoding: "utf8", env },
  );
  return {
    status: result.status,
    stderr: result.stderr,
    delegated: existsSync(join(state, "delegated.marker")),
  };
}

void test("delegateToRealAdapter spawns the real adapter and the marker proves it", () => {
  const state = mkdtempSync(join(SCRATCH, "direct-delegate-ok-"));
  const run = runDirectDelegate({
    ...process.env,
    SPW_FIXTURE_STATE: state,
    SPW_TEST_PKG_ROOT: makePkgRoot(),
  });
  assert.equal(run.status, STANDIN_STATUS);
  assert.equal(
    run.delegated,
    true,
    "the marker mechanism this file relies on did not observe a real delegation",
  );
});

void test("delegateToRealAdapter refuses when SPW_TEST_PKG_ROOT is unset (exit 95)", () => {
  const state = mkdtempSync(join(SCRATCH, "direct-delegate-95-"));
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, SPW_FIXTURE_STATE: state };
  delete env.SPW_TEST_PKG_ROOT;
  const run = runDirectDelegate(env);
  assert.equal(run.status, 95);
  assert.equal(run.stderr, "fixture: SPW_TEST_PKG_ROOT is unset\n");
  assert.equal(run.delegated, false);
});

void test("delegateToRealAdapter refuses when the real adapter is missing (exit 96)", () => {
  const state = mkdtempSync(join(SCRATCH, "direct-delegate-96-"));
  const pkgRoot = mkdtempSync(join(SCRATCH, "pkg-empty-"));
  const real = join(pkgRoot, "scripts", "adapters", "codex", "adapter");
  const run = runDirectDelegate({
    ...process.env,
    SPW_FIXTURE_STATE: state,
    SPW_TEST_PKG_ROOT: pkgRoot,
  });
  assert.equal(run.status, 96);
  assert.equal(run.stderr, `fixture: real adapter is missing at ${real}\n`);
  assert.equal(run.delegated, false);
});

void test("delegateToRealAdapter falls back to 97 when spawnSync reports no status", () => {
  // existsSync(real) must be true so the case reaches spawnSync at all, but
  // the path must not be executable. A directory at the exact expected path
  // satisfies both: it exists, and spawnSync's attempt to exec it fails with
  // EACCES, leaving status AND signal both null — the one condition
  // `result.status ?? 97` (lifecycle-fakes.js) exists to catch.
  const state = mkdtempSync(join(SCRATCH, "direct-delegate-97-"));
  const pkgRoot = mkdtempSync(join(SCRATCH, "pkg-unexecutable-"));
  const real = join(pkgRoot, "scripts", "adapters", "codex", "adapter");
  mkdirSync(real, { recursive: true });
  const run = runDirectDelegate({
    ...process.env,
    SPW_FIXTURE_STATE: state,
    SPW_TEST_PKG_ROOT: pkgRoot,
  });
  assert.equal(run.status, 97);
  assert.equal(run.delegated, false);
});

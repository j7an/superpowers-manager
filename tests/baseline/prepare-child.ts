// Test-only runner. NOT a *.test.ts file:
// `tests/run-node-suites.ts:13::const SUITE_DIRS = ["tests/bin", "tests/unit", "tests/baseline"]` would
// otherwise register it as a suite.
//
// runPrepare is called in a child process, not in the test process, because
// ctx.env does not govern what its dependencies actually run under: runGit
// (`src/git.ts:32::env: { ...process.env`) spreads process.env and never sees
// ctx.env, and runBuild's `withWorkspace(tmpdir(), …)` in src/adapter.ts reads
// process.env too. Spawning with the case's environment as the child's REAL
// process.env is what makes PATH, TMPDIR, and git configuration hermetic.
//
// This file holds no logic beyond that translation. Anything else belongs in
// src/commands/prepare.ts or in the suite.

import { runPrepare } from "../../src/commands/prepare.ts";

import { runAdapter } from "../../src/adapter.ts";

const root = process.argv[2];
if (root === undefined) {
  process.stderr.write("prepare-child: missing package root argument\n");
  process.exit(90);
}

process.exitCode = await runPrepare(process.argv.slice(3), {
  root,
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  // Real, not a double: this is the end-to-end fixture, and gatherPrepare's
  // build call must reach the case's fake `codex` on PATH the same way it
  // did before ctx.adapter existed.
  adapter: runAdapter,
});

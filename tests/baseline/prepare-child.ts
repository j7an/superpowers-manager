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

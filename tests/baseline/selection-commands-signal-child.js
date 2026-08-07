#!/usr/bin/env node
// @ts-check

// Spawned by REF-PIN-CLEANUP-01 in tests/baseline/selection-commands.test.js.
// Calls runPin against a real fixture repository while a fake `git` on this
// process's PATH hangs the inner raw-commit verification fetch (see
// FAKE_GIT_PIN_SIGNAL_BODY in the test file), so the parent can interrupt
// this process — and, via its own process group, the hung fetch descendant
// too — with a real POSIX signal. Ports the child half of
// tests/test_selection_commands.sh:301-330's Python fixture, the same shape
// tests/baseline/ref-resolution-signal-child.js already uses for
// fetchExactCommit.

/** @type {typeof import("../../src/commands/pin.js")} */
const { runPin } = await import(
  new URL("../../dist/commands/pin.js", import.meta.url).href
);

const [root, ref] = process.argv.slice(2);
if (root === undefined || ref === undefined) {
  process.stderr.write("error: signal child requires root, ref\n");
  process.exit(2);
}

const status = await runPin([ref], {
  root,
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
});
process.exit(status);

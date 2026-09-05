#!/usr/bin/env node

// Spawned by REF-PIN-CLEANUP-01 in
// tests/baseline/selection-commands.test.ts. Calls runPin against a real
// fixture repository while a fake `git` on this process's PATH hangs the
// inner raw-commit verification fetch (see FAKE_GIT_PIN_SIGNAL_BODY in the
// test file), so the parent can interrupt this process — and, via its own
// process group, the hung fetch descendant too — with a real POSIX signal.
// Ports the child half of
// `git show 349fe2ed405b371ec2de1347bb3fc50c6bc15dc4:tests/test_selection_commands.sh:301-330::start_new_session=True`, the same shape
// tests/baseline/ref-resolution-signal-child.ts already uses for
// fetchExactCommit.

import { runPin } from "../../src/commands/pin.ts";

const [root, ref] = process.argv.slice(2);
if (root === undefined || ref === undefined) {
  process.stderr.write("error: signal child requires root, ref\n");
  process.exit(2);
}

// runPin never calls ctx.adapter (src/commands/pin.ts has no adapter
// reference at all), so a throwing stand-in is a loud failure rather than a
// silent pass-through if that ever changes.
const status = await runPin([ref], {
  root,
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  adapter: async () => {
    throw new Error("ctx.adapter must not be called by runPin");
  },
});
process.exit(status);

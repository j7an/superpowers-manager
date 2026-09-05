#!/usr/bin/env node

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

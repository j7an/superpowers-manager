import assert from "node:assert/strict";
import test from "node:test";

import { openCodeHarness } from "../../../../src/harnesses/opencode/harness.ts";

void test("OpenCode adapter needs its native command only for mutation commands", () => {
  for (const command of [
    "pin",
    "track-latest",
    "unpin",
    "prepare",
    "probe",
  ] as const)
    assert.deepEqual(openCodeHarness.requirements(command, {}), []);

  for (const command of ["install", "update", "uninstall"] as const) {
    assert.equal(
      openCodeHarness.requirements(command, {})[0]?.executable,
      "opencode",
    );
    assert.equal(
      openCodeHarness.requirements(command, {
        SUPERPOWERS_OPENCODE: "./selected-opencode",
      })[0]?.executable,
      "./selected-opencode",
    );
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import { activationBlock } from "../../src/harness-compatibility.ts";

void test("experimental permission cannot admit missing mechanics", () => {
  assert.equal(
    activationBlock({ kind: "unsupported", reason: "missing bootstrap" }, true),
    "missing bootstrap",
  );
  assert.equal(
    activationBlock(
      {
        kind: "experimental",
        generation: "pi-native",
        reason: "qualification incomplete",
      },
      false,
    ),
    "experimental integration requires --allow-experimental",
  );
  assert.equal(
    activationBlock(
      {
        kind: "experimental",
        generation: "pi-native",
        reason: "qualification incomplete",
      },
      true,
    ),
    null,
  );
  assert.equal(
    activationBlock({ kind: "unknown", reason: "candidate absent" }, true),
    "candidate absent",
  );
});

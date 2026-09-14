import assert from "node:assert/strict";
import test from "node:test";

import { openCodeHarness } from "../../../../src/harnesses/opencode/harness.ts";
import type { ProbeSnapshot } from "../../../../src/harness.ts";
import type { OpenCodeRemovalInput } from "../../../../src/harnesses/opencode/state.ts";
import { nativeSelection } from "../../../lib/harnesses/pi/package-fixture.ts";

void test("OpenCode adapter needs its native command only for install and update", () => {
  for (const command of [
    "pin",
    "track-latest",
    "unpin",
    "prepare",
    "probe",
  ] as const)
    assert.deepEqual(openCodeHarness.requirements(command, {}), []);

  assert.deepEqual(
    openCodeHarness.requirements("uninstall", {
      SUPERPOWERS_OPENCODE: "./missing-opencode",
    }),
    [],
  );

  for (const command of ["install", "update"] as const) {
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

function probeFacts(): ProbeSnapshot<OpenCodeRemovalInput> {
  const compatibility = {
    kind: "supported",
    generation: "opencode-native-bootstrap-v1",
    reason: "qualified profile",
  } as const;
  const removalInput: OpenCodeRemovalInput = {
    installedRoot: "/isolated/installed",
    registration: null,
    receiptDigest: null,
  };
  return {
    selection: {
      ...nativeSelection(),
      upstreamSourceOrigin: "environment",
      effectiveSource: "https://example.invalid/upstream",
    },
    prepared: {
      kind: "needs-prepare",
      observedIdentity: "",
      compatibility,
    },
    installed: { kind: "absent", observedIdentity: "" },
    ownership: {
      installEligibility: { kind: "allowed" },
      removalInput,
      removalVerification: { kind: "allowed" },
      postRemovalOutput: { stdout: [], stderr: [] },
      presentationValue: "managed at /safe\n\u001b[31mowned",
      presentationConflicts: ["conflict at /unsafe\n\u001b[2Jpath"],
    },
    control: {
      probeEligibility: { kind: "allowed" },
      mutationEligibility: { kind: "allowed" },
      presentationValue: "recovery at /state\n\u001b[1mroot",
    },
    compatibility,
    status: "needs prepare",
  };
}

void test("OpenCode probe presents source provenance and escapes every field value in both formats", () => {
  const rendered = openCodeHarness.presentation.renderProbe(probeFacts());

  for (const output of [rendered.human, rendered.porcelain]) {
    assert.equal(output.includes("\u001b"), false);
    assert.doesNotMatch(output, /\/safe\n|\/unsafe\n|\/state\n/);
    assert.match(output, /\\n\\x1b/);
    assert.match(output, /environment/);
    assert.match(output, /https:\/\/example\.invalid\/upstream/);
  }
  assert.match(rendered.human, /^upstream source origin: environment$/m);
  assert.match(
    rendered.human,
    /^effective source: https:\/\/example\.invalid\/upstream$/m,
  );
  assert.match(rendered.porcelain, /^upstream_source_origin=environment$/m);
  assert.match(
    rendered.porcelain,
    /^effective_source=https:\/\/example\.invalid\/upstream$/m,
  );
});

void test("OpenCode no-op uninstall reports prior absence without restart", () => {
  const facts = probeFacts();
  const output = openCodeHarness.presentation.renderRemovalCompletion(
    facts.ownership,
    facts.ownership.removalInput,
  );

  assert.deepEqual(output, {
    stdout: ["No managed Superpowers OpenCode installation is present."],
    stderr: [],
  });
  assert.doesNotMatch(output.stdout.join("\n"), /restart/i);
});

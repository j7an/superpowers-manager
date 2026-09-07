import assert from "node:assert/strict";
import test from "node:test";
import { piHarness } from "../../src/pi-harness.ts";
import type { ProbeSnapshot } from "../../src/harness.ts";
import type { PiRemovalInput } from "../../src/pi-state.ts";
import { nativeSelection } from "../lib/pi-package-fixture.ts";

void test("Pi local inspection requires no executable and mutations honor the override", () => {
  for (const command of [
    "probe",
    "prepare",
    "pin",
    "unpin",
    "track-latest",
  ] as const)
    assert.deepEqual(piHarness.requirements(command, {}), []);
  for (const command of ["install", "update", "uninstall"] as const) {
    assert.equal(piHarness.requirements(command, {})[0]?.executable, "pi");
    assert.equal(
      piHarness.requirements(command, { SUPERPOWERS_PI: "./selected-pi" })[0]
        ?.executable,
      "./selected-pi",
    );
  }
  assert.match(piHarness.presentation.installNotice, /restart Pi/i);
  assert.doesNotMatch(piHarness.presentation.currentNotice, /restart/i);
});

void test("Pi presentation separates installed facts from unsupported desired compatibility", () => {
  const compatibility = {
    kind: "unsupported",
    reason: "desired package lacks the qualified bootstrap",
  } as const;
  const ownership = {
    installEligibility: { kind: "allowed" },
    removalInput: {
      installedRoot: "/isolated/installed",
      receiptDigest: "old-digest",
      registrationIdentity: "/isolated/installed",
    },
    removalVerification: {
      kind: "blocked",
      output: { stdout: [], stderr: ["still installed"] },
    },
    postRemovalOutput: { stdout: [], stderr: [] },
    presentationValue: "managed old-digest",
    presentationConflicts: ["native Pi extension superpowers.ts"],
  } as const;
  const facts: ProbeSnapshot<PiRemovalInput> = {
    selection: nativeSelection(),
    prepared: { kind: "needs-prepare", observedIdentity: "", compatibility },
    installed: { kind: "mismatch", observedIdentity: "old-digest" },
    ownership,
    control: {
      probeEligibility: { kind: "allowed" },
      mutationEligibility: { kind: "allowed" },
      presentationValue: "managed local registration",
    },
    compatibility,
    status: "needs prepare",
  };
  const rendered = piHarness.presentation.renderProbe(facts);
  assert.match(rendered.porcelain, /installed_identity=old-digest\n/);
  assert.match(rendered.porcelain, /compatibility=unsupported\n/);
  assert.match(rendered.human, /native Pi extension superpowers.ts/);
  assert.doesNotMatch(rendered.human, /restart/i);
  assert.match(
    piHarness.presentation.renderRemovalCompletion(ownership).stdout.join("\n"),
    /restart Pi/i,
  );
  assert.doesNotMatch(
    piHarness.presentation
      .renderRemovalCompletion({
        ...ownership,
        removalInput: {
          ...ownership.removalInput,
          receiptDigest: null,
          registrationIdentity: null,
        },
      })
      .stdout.join("\n"),
    /restart/i,
  );
});

void test("Pi verification output follows inspection failures rather than a claimed receipt", () => {
  const receipt = {
    status: 0,
    outcome: {
      operation: "install-pi",
      ok: true,
      result: {
        missingVerificationOutput: { stdout: [], stderr: ["missing"] },
        mismatchVerificationOutput: { stdout: [], stderr: ["mismatch"] },
      },
      error: null,
      messages: [],
    },
  } as const;
  const result = (kind: "absent" | "current" | "mismatch") =>
    ({
      status: 0,
      outcome: {
        operation: "inspect-pi-installed",
        ok: true,
        result:
          kind === "absent"
            ? ({ kind, observedIdentity: "" } as const)
            : { kind, observedIdentity: "digest" },
        error: null,
        messages: [],
      },
    }) as const;
  assert.deepEqual(
    piHarness.presentation.renderInstallVerification(
      "commit",
      receipt,
      result("absent"),
    ).stderr,
    ["missing"],
  );
  assert.deepEqual(
    piHarness.presentation.renderInstallVerification(
      "commit",
      receipt,
      result("mismatch"),
    ).stderr,
    ["mismatch"],
  );
  assert.deepEqual(
    piHarness.presentation.renderInstallVerification(
      "commit",
      receipt,
      result("current"),
    ),
    { stdout: [], stderr: [] },
  );
});

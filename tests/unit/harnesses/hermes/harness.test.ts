import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { preflight } from "../../../../src/cli.ts";
import { runProbe } from "../../../../src/commands/probe.ts";
import type { ProbeSnapshot } from "../../../../src/harness.ts";
import { hermesHarness } from "../../../../src/harnesses/hermes/harness.ts";
import {
  inspectHermesControl,
  type HermesRemovalInput,
} from "../../../../src/harnesses/hermes/state.ts";
import { createResourceCoordinator } from "../../../../src/resource-lock.ts";
import { capture } from "../../../lib/command-doubles.ts";
import { hermesSandbox } from "../../../lib/harnesses/hermes/package-fixture.ts";
import { nativeSelection } from "../../../lib/harnesses/pi/package-fixture.ts";

void test("Hermes needs its CLI for install, update, and uninstall only", () => {
  for (const command of [
    "pin",
    "track-latest",
    "unpin",
    "prepare",
    "probe",
  ] as const)
    assert.deepEqual(hermesHarness.requirements(command, {}), []);
  for (const command of ["install", "update", "uninstall"] as const) {
    const [requirement] = hermesHarness.requirements(command, {});
    assert.equal(requirement?.name, "hermes");
    assert.equal(requirement?.executable, "hermes");
    assert.equal(requirement?.lookup, "explicit-path-or-path");
    assert.match(
      requirement?.missingMessage ?? "",
      /install Hermes Agent or set SUPERPOWERS_HERMES/,
    );
    assert.equal(
      hermesHarness.requirements(command, {
        SUPERPOWERS_HERMES: "./selected-hermes",
      })[0]?.executable,
      "./selected-hermes",
    );
  }
});

void test("preflight escapes the configured Hermes executable in its error", () => {
  const executable = "/missing/hermes\n\u001b[31m";
  const env = { ...process.env, SUPERPOWERS_HERMES: executable };
  const requirement = hermesHarness.requirements("install", env)[0];
  assert.equal(requirement?.executable, executable);
  const result = preflight("install", env, process.platform, hermesHarness);
  assert.equal(result.ok, false);
  if (result.ok)
    return assert.fail("preflight unexpectedly accepted the missing CLI");
  const message = result.errors.join("\n");
  assert.equal(message.includes("\u001b"), false);
  assert.equal(message.includes(executable), false);
  assert.match(
    message,
    /required command not found: \/missing\/hermes\\n\\x1b\[31m/,
  );
});

void test("shared probe reports recovery required and names the leftover path", async (t) => {
  const sandbox = hermesSandbox(t);
  const leftover = join(sandbox.paths.managerRoot, "publish.1.ab");
  mkdirSync(leftover, { recursive: true });
  const control = await inspectHermesControl(sandbox.ctx);
  assert.equal(control.outcome.ok, true);
  if (!control.outcome.ok)
    return assert.fail("recovery control inspection failed");
  assert.equal(control.outcome.result.recoveryState, "required");
  assert.equal(control.outcome.result.probeEligibility.kind, "blocked");
  assert.equal(control.outcome.result.mutationEligibility.kind, "blocked");
  const stdout = capture();
  const stderr = capture();
  const status = await runProbe(["--porcelain"], {
    root: sandbox.root,
    env: sandbox.env,
    stdout: stdout.stream,
    stderr: stderr.stream,
    options: { harness: "hermes", allowExperimental: false },
    coordination: createResourceCoordinator(),
    selection: nativeSelection(),
    adapter: hermesHarness,
  });
  assert.equal(status, 1, stderr.text());
  assert.match(stdout.text(), /^resource_state=recovery-required$/m);
  assert.ok(
    stdout.text().includes(`update_control=recovery required at ${leftover}`),
    stdout.text(),
  );
});

void test("Hermes probe escapes every value and keeps a stable field order", () => {
  const compatibility = {
    kind: "supported",
    generation: "hermes-flat-plugin-v1",
    reason: "native Hermes\n\u001b[31mplugin",
  } as const;
  const removalInput: HermesRemovalInput = {
    ownership: "absent",
    listed: false,
  };
  const facts: ProbeSnapshot<HermesRemovalInput> = {
    selection: {
      ...nativeSelection(),
      desiredCommit: "commit\n\u001b[31mvalue",
      effectiveSource: "/source\u001b[31mvalue",
    },
    prepared: {
      kind: "needs-prepare",
      observedIdentity: "prepared\n\u001b[31mvalue",
      compatibility,
    },
    installed: {
      kind: "mismatch",
      observedIdentity: "installed\n\u001b[31mvalue",
    },
    ownership: {
      installEligibility: { kind: "allowed" },
      removalInput,
      removalVerification: { kind: "allowed" },
      postRemovalOutput: { stdout: [], stderr: [] },
      presentationValue: "managed\n\u001b[31mx",
      presentationConflicts: ["superpowers@a\n\u001b[31mx", "superpowers@b"],
    },
    control: {
      probeEligibility: { kind: "allowed" },
      mutationEligibility: { kind: "allowed" },
      presentationValue: "clear\n\u001b[31mx",
    },
    compatibility,
    resourceState: "idle",
    status: "needs prepare",
  };
  const rendered = hermesHarness.presentation.renderProbe(facts);
  for (const output of [rendered.human, rendered.porcelain])
    assert.equal(output.includes("\u001b"), false);
  assert.match(rendered.porcelain, /^harness=hermes$/m);
  assert.match(
    rendered.porcelain,
    /^conflicts=superpowers@a\\n\\x1b\[31mx; superpowers@b$/m,
  );
  assert.match(rendered.porcelain, /^update_control=clear\\n\\x1b\[31mx$/m);
  assert.deepEqual(
    rendered.porcelain
      .trimEnd()
      .split("\n")
      .map((line) => line.split("=", 1)[0]),
    [
      "harness",
      "desired_commit",
      "upstream_source_origin",
      "effective_source",
      "prepared_identity",
      "installed_identity",
      "installation_state",
      "resource_state",
      "ownership",
      "conflicts",
      "update_control",
      "compatibility",
      "compatibility_reason",
      "status",
    ],
  );
});

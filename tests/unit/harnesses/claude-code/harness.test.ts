import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runProbe } from "../../../../src/commands/probe.ts";
import type { ProbeSnapshot } from "../../../../src/harness.ts";
import { claudeCodeHarness } from "../../../../src/harnesses/claude-code/harness.ts";
import {
  inspectClaudeCodeControl,
  inspectClaudeCodeInstalled,
  inspectClaudeCodeOwnership,
  type ClaudeCodeRemovalInput,
} from "../../../../src/harnesses/claude-code/state.ts";
import { createResourceCoordinator } from "../../../../src/resource-lock.ts";
import { capture } from "../../../lib/command-doubles.ts";
import { fakeClaude } from "../../../lib/harnesses/claude-code/fake-claude.ts";
import { claudeCodeSandbox } from "../../../lib/harnesses/claude-code/package-fixture.ts";
import { nativeSelection } from "../../../lib/harnesses/pi/package-fixture.ts";

void test("Claude Code needs its CLI for probe, install, update, and uninstall only", () => {
  for (const command of ["pin", "track-latest", "unpin", "prepare"] as const)
    assert.deepEqual(claudeCodeHarness.requirements(command, {}), []);
  for (const command of ["probe", "install", "update", "uninstall"] as const) {
    const [requirement] = claudeCodeHarness.requirements(command, {});
    assert.equal(requirement?.name, "claude");
    assert.equal(requirement?.executable, "claude");
    assert.match(
      requirement?.missingMessage ?? "",
      /set SUPERPOWERS_CLAUDE_CODE/,
    );
    assert.equal(
      claudeCodeHarness.requirements(command, {
        SUPERPOWERS_CLAUDE_CODE: "./selected-claude",
      })[0]?.executable,
      "./selected-claude",
    );
  }
});

void test("shared probe reports recovery required and names the leftover path", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const leftover = join(sandbox.paths.pluginsRoot, ".superpowers.bak.1.ab");
  mkdirSync(leftover, { recursive: true });
  const fake = fakeClaude();
  const control = await inspectClaudeCodeControl(sandbox.ctx);
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
    options: { harness: "claude-code", allowExperimental: false },
    coordination: createResourceCoordinator(),
    selection: nativeSelection(),
    adapter: {
      ...claudeCodeHarness,
      inspectOwnership: (ctx) => inspectClaudeCodeOwnership(ctx, fake.run),
      inspectInstalled: (selection, ctx) =>
        inspectClaudeCodeInstalled(selection, ctx, fake.run),
    },
  });
  assert.equal(status, 1, stderr.text());
  assert.match(stdout.text(), /^resource_state=recovery-required$/m);
  assert.ok(
    stdout.text().includes(`update_control=recovery required at ${leftover}`),
    stdout.text(),
  );
});

void test("Claude Code probe escapes every value and keeps a stable field order", () => {
  const compatibility = {
    kind: "supported",
    generation: "claude-code-native-plugin-v1",
    reason: "native Claude Code plugin",
  } as const;
  const removalInput: ClaudeCodeRemovalInput = {
    registration: "absent",
    pluginInstalled: false,
    published: false,
  };
  const facts: ProbeSnapshot<ClaudeCodeRemovalInput> = {
    selection: nativeSelection(),
    prepared: { kind: "needs-prepare", observedIdentity: "", compatibility },
    installed: { kind: "absent", observedIdentity: "" },
    ownership: {
      installEligibility: { kind: "allowed" },
      removalInput,
      removalVerification: { kind: "allowed" },
      postRemovalOutput: { stdout: [], stderr: [] },
      presentationValue: "managed\n\u001b[31mx",
      presentationConflicts: ["superpowers@a", "superpowers@b"],
    },
    control: {
      probeEligibility: { kind: "allowed" },
      mutationEligibility: { kind: "allowed" },
      presentationValue: "clear\n\u001b[31mx",
    },
    compatibility,
    status: "needs prepare",
  };
  const rendered = claudeCodeHarness.presentation.renderProbe(facts);
  for (const output of [rendered.human, rendered.porcelain])
    assert.equal(output.includes("\u001b"), false);
  assert.match(rendered.porcelain, /^harness=claude-code$/m);
  assert.match(rendered.porcelain, /^conflicts=superpowers@a; superpowers@b$/m);
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

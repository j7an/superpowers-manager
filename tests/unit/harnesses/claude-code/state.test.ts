import assert from "node:assert/strict";
import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { readClaudeCodeManifestVersion } from "../../../../src/harnesses/claude-code/prepare.ts";
import {
  inspectClaudeCodeControl,
  inspectClaudeCodeInstalled,
  inspectClaudeCodeOwnership,
} from "../../../../src/harnesses/claude-code/state.ts";
import {
  claudeCodeSandbox,
  prepareClaudeCodeArtifact,
  type ClaudeCodeSandbox,
} from "../../../lib/harnesses/claude-code/package-fixture.ts";
import { fakeClaude } from "../../../lib/harnesses/claude-code/fake-claude.ts";

function plugin(id: string, enabled: boolean) {
  return { id, version: "1.0.0", scope: "user", enabled, installPath: "/p" };
}

void test("ownership is absent and eligible with no registration", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const result = await inspectClaudeCodeOwnership(
    sandbox.ctx,
    fakeClaude().run,
  );
  assert.equal(result.outcome.ok, true);
  assert.deepEqual(result.outcome.result?.installEligibility, {
    kind: "allowed",
  });
  assert.deepEqual(result.outcome.result?.removalInput, {
    registration: "absent",
    pluginInstalled: false,
    published: false,
  });
  assert.equal(result.outcome.result?.presentationValue, "absent");
});

void test("a superpowers-manager marketplace from another source is foreign and blocks install", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const fake = fakeClaude();
  fake.marketplaces.push({
    name: "superpowers-manager",
    source: "directory",
    path: join(sandbox.root, "elsewhere"),
  });
  const result = await inspectClaudeCodeOwnership(sandbox.ctx, fake.run);
  const decision = result.outcome.result?.installEligibility;
  assert.equal(decision?.kind, "blocked");
  assert.match(
    decision?.kind === "blocked" ? decision.output.stderr.join("\n") : "",
    /registered from another source/,
  );
  assert.match(
    decision?.kind === "blocked" ? decision.output.stderr.join("\n") : "",
    /elsewhere/,
  );
  assert.equal(result.outcome.result?.removalInput.registration, "foreign");
});

void test("an enabled Superpowers from another marketplace blocks install and prints the disable command", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const fake = fakeClaude();
  fake.plugins.push(plugin("superpowers@claude-plugins-official", true));
  const result = await inspectClaudeCodeOwnership(sandbox.ctx, fake.run);
  const decision = result.outcome.result?.installEligibility;
  assert.equal(decision?.kind, "blocked");
  assert.match(
    decision?.kind === "blocked" ? decision.output.stderr.join("\n") : "",
    /claude plugin disable superpowers@claude-plugins-official/,
  );
  assert.deepEqual(result.outcome.result?.presentationConflicts, [
    "superpowers@claude-plugins-official",
  ]);
});

void test("disabled, synced, and unrelated plugins do not conflict", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const fake = fakeClaude();
  fake.plugins.push(
    plugin("superpowers@claude-plugins-official", false),
    plugin("superpowers@synced", true),
    plugin("formatter@team", true),
  );
  const result = await inspectClaudeCodeOwnership(sandbox.ctx, fake.run);
  assert.deepEqual(result.outcome.result?.installEligibility, {
    kind: "allowed",
  });
});

void test("a conflicting ID with control characters is never printed", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const fake = fakeClaude();
  fake.plugins.push(plugin("superpowers@evil\u001b[2J", true));
  const result = await inspectClaudeCodeOwnership(sandbox.ctx, fake.run);
  const decision = result.outcome.result?.installEligibility;
  const text =
    decision?.kind === "blocked" ? decision.output.stderr.join("\n") : "";
  assert.equal(text.includes("\u001b"), false);
  assert.match(text, /non-displayable Superpowers identity/);
});

void test("ownership fails closed when native state cannot be read", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const fake = fakeClaude();
  fake.failOn = "plugin list";
  const result = await inspectClaudeCodeOwnership(sandbox.ctx, fake.run);
  assert.equal(result.outcome.ok, false);
  assert.match(
    result.outcome.error?.message ?? "",
    /cannot inspect Claude Code ownership/,
  );
});

async function installedFixture(t: test.TestContext) {
  const sandbox = claudeCodeSandbox(t);
  const { selection } = await prepareClaudeCodeArtifact(t, sandbox);
  mkdirSync(sandbox.paths.pluginsRoot, { recursive: true });
  cpSync(sandbox.paths.preparedRoot, sandbox.paths.pluginRoot, {
    recursive: true,
    verbatimSymlinks: true,
  });
  const fake = fakeClaude();
  fake.marketplaces.push({
    name: "superpowers-manager",
    source: "directory",
    path: sandbox.paths.marketplaceRoot,
  });
  fake.plugins.push({
    id: "superpowers@superpowers-manager",
    version: await readClaudeCodeManifestVersion(sandbox.paths.pluginRoot),
    scope: "user",
    enabled: true,
    installPath: join(sandbox.paths.marketplaceRoot, "native-cache", "v1"),
  });
  return { sandbox, selection, fake };
}

async function installedKind(
  sandbox: ClaudeCodeSandbox,
  selection: Parameters<typeof inspectClaudeCodeInstalled>[0],
  fake: ReturnType<typeof fakeClaude>,
) {
  const result = await inspectClaudeCodeInstalled(
    selection,
    sandbox.ctx,
    fake.run,
  );
  assert.equal(result.outcome.ok, true);
  return result.outcome.result?.kind;
}

void test("installed state is current when owned registration, version, and digest agree despite a separate native cache path", async (t) => {
  const { sandbox, selection, fake } = await installedFixture(t);
  assert.equal(await installedKind(sandbox, selection, fake), "current");
  fake.plugins[0]!.version = "6.4.1";
  assert.equal(await installedKind(sandbox, selection, fake), "mismatch");
});

void test("installed state is a mismatch after a same-commit ref change", async (t) => {
  const { sandbox, selection, fake } = await installedFixture(t);
  const rawCommit = {
    ...selection,
    requestedRef: selection.desiredCommit,
    resolvedRef: selection.desiredCommit,
    resolutionKind: "raw-commit" as const,
  };
  assert.equal(await installedKind(sandbox, rawCommit, fake), "mismatch");
});

void test("installed state is a mismatch when Claude Code reports load errors", async (t) => {
  const { sandbox, selection, fake } = await installedFixture(t);
  fake.plugins[0]!.errors = ["failed to load"];
  assert.equal(await installedKind(sandbox, selection, fake), "mismatch");
});

void test("installed state is absent with nothing registered or published", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const { selection } = await prepareClaudeCodeArtifact(t, sandbox);
  assert.equal(await installedKind(sandbox, selection, fakeClaude()), "absent");
});

void test("a published marketplace without a plugin snapshot is a mismatch", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const { selection } = await prepareClaudeCodeArtifact(t, sandbox);
  mkdirSync(sandbox.paths.marketplaceRoot, { recursive: true });
  assert.equal(
    await installedKind(sandbox, selection, fakeClaude()),
    "mismatch",
  );
});

for (const leftover of [".superpowers.bak.1.ab", ".superpowers.stage.1.ab"]) {
  void test(`update control blocks on a leftover ${leftover}`, async (t) => {
    const sandbox = claudeCodeSandbox(t);
    mkdirSync(join(sandbox.paths.pluginsRoot, leftover), { recursive: true });
    const result = await inspectClaudeCodeControl(sandbox.ctx);
    assert.equal(result.outcome.result?.mutationEligibility.kind, "blocked");
    assert.equal(result.outcome.result?.probeEligibility.kind, "blocked");
    assert.equal(result.outcome.result?.recoveryState, "required");
    assert.match(
      result.outcome.result?.presentationValue ?? "",
      /recovery required/,
    );
  });
}

void test("update control is clear without leftovers", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const result = await inspectClaudeCodeControl(sandbox.ctx);
  assert.deepEqual(result.outcome.result?.mutationEligibility, {
    kind: "allowed",
  });
  assert.equal(result.outcome.result?.presentationValue, "clear");
});

import assert from "node:assert/strict";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { digestArtifactTree } from "../../../../src/artifact-tree.ts";
import { openCodeReceiptBinding } from "../../../../src/harnesses/opencode/package.ts";
import {
  inspectOpenCodeControl,
  inspectOpenCodeInstalled,
  inspectOpenCodeOwnership,
} from "../../../../src/harnesses/opencode/state.ts";
import {
  openCodeSandbox,
  openCodeSelection,
  writeOpenCodeArtifact,
} from "../../../lib/harnesses/opencode/package-fixture.ts";

function config(path: string, plugins: readonly unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ plugin: plugins }) + "\n");
}

void test("current state requires one registration and matching desired, prepared, receipt, and installed bytes", async (t) => {
  const state = openCodeSandbox(t);
  const selection = openCodeSelection();
  const prepared = await writeOpenCodeArtifact(
    t,
    state.paths.preparedRoot,
    selection,
  );
  const installed = await writeOpenCodeArtifact(
    t,
    state.paths.installedRoot,
    selection,
  );
  config(join(state.paths.configRoot, "opencode.json"), [
    state.paths.installedRoot,
  ]);
  assert.equal(prepared, installed);
  const result = await inspectOpenCodeInstalled(selection, state.ctx);
  assert.deepEqual(result.outcome.ok && result.outcome.result, {
    kind: "current",
    observedIdentity: installed,
  });
  const ownership = await inspectOpenCodeOwnership(state.ctx);
  assert.equal(ownership.outcome.ok, true);
  if (!ownership.outcome.ok) assert.fail("expected ownership facts");
  assert.equal(ownership.outcome.result.installEligibility.kind, "allowed");
  assert.equal(ownership.outcome.result.removalInput.receiptDigest, installed);
  assert.equal(
    ownership.outcome.result.removalInput.registration?.entryIndex,
    0,
  );
  const control = await inspectOpenCodeControl(state.ctx);
  assert.equal(
    control.outcome.ok && control.outcome.result.mutationEligibility.kind,
    "allowed",
  );
});

void test("an unmanaged upstream registration blocks install without editing it", async (t) => {
  const state = openCodeSandbox(t);
  const file = join(state.paths.configRoot, "opencode.json");
  const before =
    '{"plugin":["superpowers@git+https://github.com/obra/superpowers.git"]}\n';
  mkdirSync(state.paths.configRoot, { recursive: true });
  writeFileSync(file, before);
  const result = await inspectOpenCodeOwnership(state.ctx);
  assert.equal(result.outcome.ok, true);
  if (!result.outcome.ok) assert.fail("expected ownership observation");
  assert.equal(result.outcome.result.installEligibility.kind, "blocked");
  assert.equal(readFileSync(file, "utf8"), before);
});

void test("foreign or changed Manager state fails closed while retired owned bytes remain removable", async (t) => {
  const state = openCodeSandbox(t);
  const selection = openCodeSelection();
  const retired = {
    kind: "unsupported" as const,
    reason: "retired fixture profile",
  };
  const digest = await writeOpenCodeArtifact(
    t,
    state.paths.installedRoot,
    selection,
    retired,
  );
  config(join(state.paths.configRoot, "opencode.json"), [
    state.paths.installedRoot,
  ]);
  let ownership = await inspectOpenCodeOwnership(state.ctx);
  assert.equal(ownership.outcome.ok, true);
  if (!ownership.outcome.ok) assert.fail("expected retired ownership facts");
  assert.equal(ownership.outcome.result.removalInput.receiptDigest, digest);

  writeFileSync(join(state.paths.installedRoot, "LICENSE"), "tampered");
  ownership = await inspectOpenCodeOwnership(state.ctx);
  assert.equal(ownership.outcome.ok, false);
});

void test("a Manager-path registration without verified bytes cannot authorize removal", async (t) => {
  const state = openCodeSandbox(t);
  config(join(state.paths.configRoot, "opencode.json"), [
    state.paths.installedRoot,
  ]);
  assert.equal((await inspectOpenCodeOwnership(state.ctx)).outcome.ok, false);
  const installed = await inspectOpenCodeInstalled(
    openCodeSelection(),
    state.ctx,
  );
  assert.deepEqual(installed.outcome.ok && installed.outcome.result, {
    kind: "mismatch",
    observedIdentity: "registered without an installed snapshot",
  });
});

void test("missing preparation, wrong selection, changed binding, duplicate registration, and recovery never report current", async (t) => {
  const state = openCodeSandbox(t);
  const selection = openCodeSelection();
  await writeOpenCodeArtifact(t, state.paths.installedRoot, selection);
  const file = join(state.paths.configRoot, "opencode.json");
  config(file, [state.paths.installedRoot]);
  const missingPrepared = await inspectOpenCodeInstalled(selection, state.ctx);
  assert.equal(
    missingPrepared.outcome.ok && missingPrepared.outcome.result.kind,
    "mismatch",
  );
  await writeOpenCodeArtifact(t, state.paths.preparedRoot, selection);
  const wrongSelection = await inspectOpenCodeInstalled(
    openCodeSelection("2".repeat(40)),
    state.ctx,
  );
  assert.equal(
    wrongSelection.outcome.ok && wrongSelection.outcome.result.kind,
    "mismatch",
  );
  config(file, [
    state.paths.installedRoot,
    `file://${state.paths.installedRoot}`,
  ]);
  assert.equal((await inspectOpenCodeOwnership(state.ctx)).outcome.ok, false);
  assert.equal(
    (await inspectOpenCodeInstalled(selection, state.ctx)).outcome.ok,
    false,
  );
  config(file, [state.paths.installedRoot]);
  mkdirSync(state.paths.recoveryRoot, { recursive: true });
  const control = await inspectOpenCodeControl(state.ctx);
  assert.equal(control.outcome.ok, true);
  if (!control.outcome.ok) assert.fail("expected control facts");
  assert.equal(control.outcome.result.mutationEligibility.kind, "blocked");
  assert.equal(control.outcome.result.recoveryState, "required");

  rmSync(state.paths.recoveryRoot, { recursive: true });
  const receiptPath = join(
    state.paths.installedRoot,
    ".superpowers-manager.json",
  );
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  writeFileSync(
    receiptPath,
    JSON.stringify({ ...receipt, binding: "0".repeat(64) }),
  );
  assert.equal((await inspectOpenCodeOwnership(state.ctx)).outcome.ok, false);
});

void test("an uninspectable configuration origin fails every ownership claim closed", async (t) => {
  const state = openCodeSandbox(t);
  mkdirSync(state.paths.configRoot, { recursive: true });
  const target = join(state.root, "foreign-config.json");
  writeFileSync(target, '{"plugin":[]}');
  symlinkSync(target, join(state.paths.configRoot, "opencode.json"));
  assert.equal((await inspectOpenCodeOwnership(state.ctx)).outcome.ok, false);
  assert.equal((await inspectOpenCodeControl(state.ctx)).outcome.ok, false);
  assert.equal(
    (await inspectOpenCodeInstalled(openCodeSelection(), state.ctx)).outcome.ok,
    false,
  );
});

void test("probe inspection never launches a configured OpenCode executable", async (t) => {
  const state = openCodeSandbox(t);
  const callLog = join(state.root, "calls");
  const executable = join(state.root, "opencode-fail");
  writeFileSync(
    executable,
    `#!/bin/sh\nprintf called >> '${callLog}'\nexit 99\n`,
    { mode: 0o755 },
  );
  const ctx = { ...state.ctx, env: { ...state.env, OPENCODE_BIN: executable } };
  await inspectOpenCodeInstalled(openCodeSelection(), ctx);
  await inspectOpenCodeOwnership(ctx);
  await inspectOpenCodeControl(ctx);
  assert.throws(() => readFileSync(callLog), { code: "ENOENT" });
});

void test("receipt digest remains bound to actual artifact bytes", async (t) => {
  const state = openCodeSandbox(t);
  const selection = openCodeSelection();
  await writeOpenCodeArtifact(t, state.paths.installedRoot, selection);
  const receiptPath = join(
    state.paths.installedRoot,
    ".superpowers-manager.json",
  );
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  writeFileSync(join(state.paths.installedRoot, "LICENSE"), "changed");
  const digest = await digestArtifactTree(state.paths.installedRoot);
  const changed = { ...receipt, digest };
  writeFileSync(
    receiptPath,
    JSON.stringify({ ...changed, binding: openCodeReceiptBinding(changed) }),
  );
  config(join(state.paths.configRoot, "opencode.json"), [
    state.paths.installedRoot,
  ]);
  const ownership = await inspectOpenCodeOwnership(state.ctx);
  assert.equal(ownership.outcome.ok, true);
  const installed = await inspectOpenCodeInstalled(selection, state.ctx);
  assert.equal(
    installed.outcome.ok && installed.outcome.result.kind,
    "mismatch",
  );
});

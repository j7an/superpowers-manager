import assert from "node:assert/strict";
import { hasTerminalControl } from "../../../../src/adapter-result.ts";
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
import { openCodePaths } from "../../../../src/harnesses/opencode/paths.ts";
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

void test("installed bytes remain current while a retained journal blocks control", async (t) => {
  const state = openCodeSandbox(t);
  const selection = openCodeSelection();
  const digest = await writeOpenCodeArtifact(
    t,
    state.paths.preparedRoot,
    selection,
  );
  await writeOpenCodeArtifact(t, state.paths.installedRoot, selection);
  config(join(state.paths.configRoot, "opencode.json"), [
    state.paths.installedRoot,
  ]);
  mkdirSync(state.paths.recoveryRoot, { recursive: true });
  writeFileSync(join(state.paths.recoveryRoot, "transaction.json"), "pending");

  const installed = await inspectOpenCodeInstalled(selection, state.ctx);
  assert.deepEqual(installed.outcome.ok && installed.outcome.result, {
    kind: "current",
    observedIdentity: digest,
  });
  const control = await inspectOpenCodeControl(state.ctx);
  assert.equal(
    control.outcome.ok && control.outcome.result.mutationEligibility.kind,
    "blocked",
  );
});

void test("a verified snapshot without registration stays removable but is not installed current", async (t) => {
  const state = openCodeSandbox(t);
  const selection = openCodeSelection();
  const digest = await writeOpenCodeArtifact(
    t,
    state.paths.installedRoot,
    selection,
  );

  const installed = await inspectOpenCodeInstalled(selection, state.ctx);
  assert.deepEqual(installed.outcome.ok && installed.outcome.result, {
    kind: "mismatch",
    observedIdentity: digest,
  });
  const ownership = await inspectOpenCodeOwnership(state.ctx);
  assert.equal(ownership.outcome.ok, true);
  if (!ownership.outcome.ok) assert.fail("expected snapshot ownership facts");
  assert.equal(ownership.outcome.result.installEligibility.kind, "allowed");
  assert.deepEqual(ownership.outcome.result.removalInput, {
    installedRoot: state.paths.installedRoot,
    registration: null,
    receiptDigest: digest,
  });
  assert.equal(ownership.outcome.result.removalVerification.kind, "blocked");
  const control = await inspectOpenCodeControl(state.ctx);
  assert.equal(
    control.outcome.ok && control.outcome.result.mutationEligibility.kind,
    "allowed",
  );
});

void test("skill-only uncertainty permits an absent removal postcondition but still blocks mutation", async (t) => {
  const state = openCodeSandbox(t);
  mkdirSync(state.paths.configRoot, { recursive: true });
  writeFileSync(
    join(state.paths.configRoot, "opencode.json"),
    JSON.stringify({ skills: { urls: ["https://example.test/skills"] } }),
  );

  const installed = await inspectOpenCodeInstalled(
    openCodeSelection(),
    state.ctx,
  );
  assert.deepEqual(installed.outcome.ok && installed.outcome.result, {
    kind: "absent",
    observedIdentity: "",
  });
  const ownership = await inspectOpenCodeOwnership(state.ctx);
  assert.equal(ownership.outcome.ok, true);
  if (!ownership.outcome.ok) assert.fail("expected absent ownership facts");
  assert.equal(ownership.outcome.result.installEligibility.kind, "blocked");
  assert.equal(ownership.outcome.result.removalVerification.kind, "allowed");
  assert.equal(ownership.outcome.result.presentationValue, "absent");
  const control = await inspectOpenCodeControl(state.ctx);
  assert.equal(
    control.outcome.ok && control.outcome.result.mutationEligibility.kind,
    "blocked",
  );
});

void test("whole-config uncertainty still refuses an absent removal postcondition", async (t) => {
  const state = openCodeSandbox(t);
  const ctx = {
    ...state.ctx,
    env: { ...state.env, OPENCODE_CONFIG_CONTENT: "{" },
  };
  const installed = await inspectOpenCodeInstalled(openCodeSelection(), ctx);
  assert.equal(
    installed.outcome.ok && installed.outcome.result.kind,
    "mismatch",
  );
  const ownership = await inspectOpenCodeOwnership(ctx);
  assert.equal(ownership.outcome.ok, true);
  if (!ownership.outcome.ok) assert.fail("expected uncertain ownership facts");
  assert.equal(ownership.outcome.result.removalVerification.kind, "blocked");
  assert.equal(
    ownership.outcome.result.presentationValue,
    "unresolved configuration",
  );
});

void test("only native XDG writer origins can authorize a Manager registration edit", async (t) => {
  for (const origin of [
    "config-json",
    "project",
    "custom",
    "managed",
    "inline",
  ] as const) {
    await t.test(origin, async (t) => {
      const state = openCodeSandbox(t);
      const plugins = [state.paths.installedRoot];
      let ctx = state.ctx;
      const originalCwd = process.cwd();
      try {
        if (origin === "config-json") {
          config(join(state.paths.configRoot, "config.json"), plugins);
        } else if (origin === "project") {
          process.chdir(state.root);
          config(join(state.root, "opencode.json"), plugins);
        } else if (origin === "custom") {
          const path = join(state.root, "custom.json");
          config(path, plugins);
          ctx = {
            ...ctx,
            env: { ...state.env, OPENCODE_CONFIG: path },
          };
        } else if (origin === "managed") {
          config(
            join(state.env.OPENCODE_TEST_MANAGED_CONFIG_DIR!, "opencode.json"),
            plugins,
          );
        } else {
          ctx = {
            ...ctx,
            env: {
              ...state.env,
              MANAGER_ALIAS: state.paths.installedRoot,
              OPENCODE_CONFIG_CONTENT: JSON.stringify({
                plugin: ["{env:MANAGER_ALIAS}"],
              }),
            },
          };
        }
        const ownership = await inspectOpenCodeOwnership(ctx);
        assert.equal(ownership.outcome.ok, true);
        if (!ownership.outcome.ok) assert.fail("expected ownership facts");
        assert.equal(
          ownership.outcome.result.installEligibility.kind,
          "blocked",
        );
        assert.equal(ownership.outcome.result.removalInput.registration, null);
        assert.equal(
          ownership.outcome.result.removalVerification.kind,
          "blocked",
        );
      } finally {
        process.chdir(originalCwd);
      }
    });
  }
});

void test("an owned global registration remains removable beside unrelated known conflicts", async (t) => {
  const state = openCodeSandbox(t);
  await writeOpenCodeArtifact(t, state.paths.installedRoot);
  config(join(state.paths.configRoot, "opencode.json"), [
    state.paths.installedRoot,
    "superpowers@git+https://github.com/obra/superpowers.git",
  ]);
  const ownership = await inspectOpenCodeOwnership(state.ctx);
  assert.equal(ownership.outcome.ok, true);
  if (!ownership.outcome.ok) assert.fail("expected owned removal facts");
  assert.equal(ownership.outcome.result.installEligibility.kind, "blocked");
  assert.equal(
    ownership.outcome.result.removalInput.registration?.entryIndex,
    0,
  );
  assert.equal(
    ownership.outcome.result.removalInput.receiptDigest !== null,
    true,
  );
});

void test("pure mode is the qualified disable flag and tuple options do not invent disable semantics", async (t) => {
  const state = openCodeSandbox(t);
  const selection = openCodeSelection();
  const digest = await writeOpenCodeArtifact(
    t,
    state.paths.preparedRoot,
    selection,
  );
  await writeOpenCodeArtifact(t, state.paths.installedRoot, selection);
  config(join(state.paths.configRoot, "opencode.json"), [
    [state.paths.installedRoot, { enabled: false }],
  ]);
  const tuple = await inspectOpenCodeInstalled(selection, state.ctx);
  assert.deepEqual(tuple.outcome.ok && tuple.outcome.result, {
    kind: "current",
    observedIdentity: digest,
  });

  const pureCtx = {
    ...state.ctx,
    env: { ...state.env, OPENCODE_PURE: "1" },
  };
  const pure = await inspectOpenCodeInstalled(selection, pureCtx);
  assert.equal(pure.outcome.ok && pure.outcome.result.kind, "mismatch");
  const ownership = await inspectOpenCodeOwnership(pureCtx);
  assert.equal(ownership.outcome.ok, true);
  if (!ownership.outcome.ok) assert.fail("expected pure-mode ownership facts");
  assert.equal(ownership.outcome.result.installEligibility.kind, "blocked");
  assert.equal(
    ownership.outcome.result.removalInput.registration?.entryIndex,
    0,
  );

  rmSync(join(state.paths.configRoot, "opencode.json"));
  rmSync(state.paths.installedRoot, { recursive: true });
  const removed = await inspectOpenCodeOwnership(pureCtx);
  assert.equal(removed.outcome.ok, true);
  if (!removed.outcome.ok) assert.fail("expected removed pure-mode facts");
  assert.equal(removed.outcome.result.removalVerification.kind, "allowed");
  assert.equal(removed.outcome.result.presentationValue, "absent");
});

void test("installed source and commit must each independently match intended evidence", async (t) => {
  for (const mismatch of ["source", "commit"] as const) {
    await t.test(mismatch, async (t) => {
      const state = openCodeSandbox(t);
      const desired = openCodeSelection();
      const installedSelection =
        mismatch === "source"
          ? openCodeSelection(
              desired.desiredCommit,
              "https://example.test/custom-superpowers.git",
            )
          : openCodeSelection("2".repeat(40), desired.effectiveSource);
      await writeOpenCodeArtifact(t, state.paths.preparedRoot, desired);
      await writeOpenCodeArtifact(
        t,
        state.paths.installedRoot,
        installedSelection,
      );
      config(join(state.paths.configRoot, "opencode.json"), [
        state.paths.installedRoot,
      ]);
      const result = await inspectOpenCodeInstalled(desired, state.ctx);
      assert.equal(result.outcome.ok && result.outcome.result.kind, "mismatch");
    });
  }
});

void test("path-bearing control diagnostics escape newline and ANSI bytes", async (t) => {
  const state = openCodeSandbox(t);
  const env = {
    ...state.env,
    XDG_CONFIG_HOME: join(state.root, "config\n\u001b[31m"),
  };
  const paths = openCodePaths(env, state.root);
  mkdirSync(paths.recoveryRoot, { recursive: true });
  const result = await inspectOpenCodeControl({ root: state.root, env });
  assert.equal(result.outcome.ok, true);
  if (!result.outcome.ok) assert.fail("expected escaped control facts");
  assert.equal(result.outcome.result.mutationEligibility.kind, "blocked");
  if (result.outcome.result.mutationEligibility.kind !== "blocked")
    assert.fail("expected recovery decision");
  const lines = result.outcome.result.mutationEligibility.output.stderr;
  assert.equal(
    lines.every((line) => !hasTerminalControl(line)),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("\\n\\x1b")),
    true,
  );
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

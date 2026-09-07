import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import type {
  AdapterContext,
  AdapterResult,
} from "../../src/adapter-result.ts";
import type { EffectiveSelection } from "../../src/effective-selection.ts";
import type { OwnershipInspection } from "../../src/harness.ts";
import { digestPiTree, piReceiptBinding } from "../../src/pi-package.ts";
import { piPaths, type PiPaths } from "../../src/pi-paths.ts";
import {
  inspectPiControl,
  inspectPiInstalled,
  inspectPiOwnership,
  type PiRemovalInput,
} from "../../src/pi-state.ts";
import { nativeFixture, nativeSelection } from "../lib/pi-package-fixture.ts";

interface StateSandbox {
  readonly root: string;
  readonly ctx: AdapterContext;
  readonly paths: PiPaths;
}

function sandbox(t: TestContext): StateSandbox {
  const root = mkdtempSync(join(tmpdir(), "spw-pi-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "selected-home");
  const agentDir = join(home, "agent");
  mkdirSync(agentDir, { recursive: true });
  const env = { HOME: home, PI_CODING_AGENT_DIR: agentDir };
  return { root, ctx: { root, env }, paths: piPaths(env, root) };
}

function settings(paths: PiPaths, packages: unknown): void {
  mkdirSync(dirname(paths.settingsFile), { recursive: true });
  writeFileSync(paths.settingsFile, JSON.stringify({ packages }));
}

async function preparedAndInstalled(
  t: TestContext,
  state: StateSandbox,
): Promise<{
  readonly selection: EffectiveSelection;
  readonly digest: string;
}> {
  const upstream = nativeFixture(t);
  const selection = nativeSelection();
  cpSync(upstream, state.paths.preparedRoot, { recursive: true });
  const digest = await digestPiTree(state.paths.preparedRoot);
  const identity = {
    schema: 1 as const,
    manager: "superpowers-manager" as const,
    harness: "pi" as const,
    source: selection.effectiveSource,
    commit: selection.desiredCommit,
    digest,
  };
  writeFileSync(
    join(state.paths.preparedRoot, ".superpowers-manager.json"),
    JSON.stringify({
      ...identity,
      binding: piReceiptBinding(identity),
      compatibility: {
        kind: "supported",
        generation: "pi-native-bootstrap-v1",
        reason: "fixture",
      },
    }),
  );
  cpSync(state.paths.preparedRoot, state.paths.installedRoot, {
    recursive: true,
  });
  return { selection, digest };
}

function unwrapOwnership(
  result: AdapterResult<OwnershipInspection<PiRemovalInput>>,
): OwnershipInspection<PiRemovalInput> {
  assert.equal(result.outcome.ok, true, JSON.stringify(result));
  if (!result.outcome.ok) assert.fail("expected ownership facts");
  return result.outcome.result;
}

void test("current Pi state requires registration, resources, owned bytes, and intended bytes", async (t) => {
  const state = sandbox(t);
  const { selection, digest } = await preparedAndInstalled(t, state);
  settings(state.paths, ["superpowers-manager/installed"]);

  assert.deepEqual(await inspectPiInstalled(selection, state.ctx), {
    status: 0,
    outcome: {
      operation: "inspect-pi-installed",
      ok: true,
      messages: [],
      result: { kind: "current", observedIdentity: digest },
      error: null,
    },
  });
  const ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
  assert.equal(ownership.installEligibility.kind, "allowed");
  assert.deepEqual(ownership.removalInput, {
    installedRoot: state.paths.installedRoot,
    registrationIdentity: "superpowers-manager/installed",
    receiptDigest: digest,
  });
  assert.equal(ownership.removalVerification.kind, "blocked");
  const control = await inspectPiControl(state.ctx);
  assert.equal(
    control.outcome.ok && control.outcome.result.mutationEligibility.kind,
    "allowed",
  );
});

void test("Pi inspection keeps registration, filesystem, and configuration evidence independent", async (t) => {
  await t.test(
    "no registration never reports installed content current",
    async (t) => {
      const state = sandbox(t);
      const { selection, digest } = await preparedAndInstalled(t, state);
      settings(state.paths, []);
      const installed = await inspectPiInstalled(selection, state.ctx);
      assert.deepEqual(installed.outcome.ok && installed.outcome.result, {
        kind: "mismatch",
        observedIdentity: digest,
      });
      const ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
      assert.equal(ownership.installEligibility.kind, "allowed");
      assert.deepEqual(ownership.removalInput, {
        installedRoot: state.paths.installedRoot,
        registrationIdentity: null,
        receiptDigest: digest,
      });
    },
  );

  await t.test(
    "registration without a tree is observed, not adopted",
    async (t) => {
      const state = sandbox(t);
      const selection = nativeSelection();
      settings(state.paths, ["superpowers-manager/installed"]);
      const installed = await inspectPiInstalled(selection, state.ctx);
      assert.deepEqual(installed.outcome.ok && installed.outcome.result, {
        kind: "mismatch",
        observedIdentity: "registered without an installed snapshot",
      });
      const ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
      assert.deepEqual(ownership.removalInput, {
        installedRoot: state.paths.installedRoot,
        registrationIdentity: "superpowers-manager/installed",
        receiptDigest: null,
      });
    },
  );

  await t.test(
    "unrelated future settings remain outside Manager state",
    async (t) => {
      const state = sandbox(t);
      const { selection } = await preparedAndInstalled(t, state);
      writeFileSync(
        state.paths.settingsFile,
        JSON.stringify({
          futureUserSetting: { untouched: true },
          packages: [
            {
              source: "superpowers-manager/installed",
              futurePackageSetting: "untouched",
            },
          ],
        }),
      );
      const inspected = await inspectPiInstalled(selection, state.ctx);
      assert.equal(
        inspected.outcome.ok && inspected.outcome.result.kind,
        "current",
      );
    },
  );

  await t.test(
    "changed installed bytes are mismatch and cannot authorize removal",
    async (t) => {
      const state = sandbox(t);
      const { selection } = await preparedAndInstalled(t, state);
      settings(state.paths, ["superpowers-manager/installed"]);
      writeFileSync(join(state.paths.installedRoot, "LICENSE"), "changed");
      const installed = await inspectPiInstalled(selection, state.ctx);
      assert.equal(
        installed.outcome.ok && installed.outcome.result.kind,
        "mismatch",
      );
      assert.equal((await inspectPiOwnership(state.ctx)).outcome.ok, false);
    },
  );

  await t.test(
    "a coherent receipt rewrite still cannot replace intended-byte comparison",
    async (t) => {
      const state = sandbox(t);
      const { selection, digest: intendedDigest } = await preparedAndInstalled(
        t,
        state,
      );
      settings(state.paths, ["superpowers-manager/installed"]);
      writeFileSync(join(state.paths.installedRoot, "LICENSE"), "changed");
      const receiptPath = join(
        state.paths.installedRoot,
        ".superpowers-manager.json",
      );
      const original = JSON.parse(readFileSync(receiptPath, "utf8"));
      const changed = {
        ...original,
        digest: await digestPiTree(state.paths.installedRoot),
      };
      writeFileSync(
        receiptPath,
        JSON.stringify({ ...changed, binding: piReceiptBinding(changed) }),
      );

      const inspected = await inspectPiInstalled(selection, state.ctx);
      assert.equal(inspected.outcome.ok, true);
      if (!inspected.outcome.ok) assert.fail("expected installed facts");
      assert.deepEqual(inspected.outcome.result, {
        kind: "mismatch",
        observedIdentity: changed.digest,
      });
      assert.notEqual(changed.digest, intendedDigest);
      assert.equal((await inspectPiOwnership(state.ctx)).outcome.ok, true);
    },
  );

  for (const [name, registration] of [
    [
      "disabled resources",
      { source: "superpowers-manager/installed", autoload: false },
    ],
    [
      "unsupported filters",
      {
        source: "superpowers-manager/installed",
        skills: ["+skills/using-superpowers/SKILL.md"],
        extensions: ["+.pi/extensions/superpowers.ts"],
      },
    ],
  ] as const)
    await t.test(name, async (t) => {
      const state = sandbox(t);
      const { selection } = await preparedAndInstalled(t, state);
      settings(state.paths, [registration]);
      const inspected = await inspectPiInstalled(selection, state.ctx);
      assert.equal(
        inspected.outcome.ok && inspected.outcome.result.kind,
        "mismatch",
      );
      const ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
      assert.equal(ownership.installEligibility.kind, "blocked");
      const control = await inspectPiControl(state.ctx);
      assert.equal(
        control.outcome.ok && control.outcome.result.mutationEligibility.kind,
        "blocked",
      );
    });
});

void test("malformed, duplicate, and foreign ownership evidence fails closed", async (t) => {
  await t.test("duplicate Manager aliases", async (t) => {
    const state = sandbox(t);
    const { selection } = await preparedAndInstalled(t, state);
    settings(state.paths, [
      "superpowers-manager/installed",
      state.paths.installedRoot,
    ]);
    assert.equal(
      (await inspectPiInstalled(selection, state.ctx)).outcome.ok,
      false,
    );
    assert.equal((await inspectPiOwnership(state.ctx)).outcome.ok, false);
    assert.equal((await inspectPiControl(state.ctx)).outcome.ok, false);
  });

  await t.test("malformed Manager configuration", async (t) => {
    const state = sandbox(t);
    settings(state.paths, [
      { source: "superpowers-manager/installed", autoload: "unknown" },
    ]);
    assert.equal(
      (await inspectPiInstalled(nativeSelection(), state.ctx)).outcome.ok,
      false,
    );
    assert.equal((await inspectPiOwnership(state.ctx)).outcome.ok, false);
    assert.equal((await inspectPiControl(state.ctx)).outcome.ok, false);
  });

  await t.test("foreign directory at the Manager root", async (t) => {
    const state = sandbox(t);
    mkdirSync(state.paths.installedRoot, { recursive: true });
    writeFileSync(join(state.paths.installedRoot, "foreign.txt"), "mine");
    settings(state.paths, []);
    const inspected = await inspectPiInstalled(nativeSelection(), state.ctx);
    assert.deepEqual(inspected.outcome.ok && inspected.outcome.result, {
      kind: "mismatch",
      observedIdentity: "unverified installed snapshot",
    });
    assert.equal((await inspectPiOwnership(state.ctx)).outcome.ok, false);
  });
});

void test("missing or unsupported desired preparation does not suppress installed facts", async (t) => {
  const state = sandbox(t);
  const { selection, digest } = await preparedAndInstalled(t, state);
  settings(state.paths, ["superpowers-manager/installed"]);

  rmSync(state.paths.preparedRoot, { recursive: true });
  const absent = await inspectPiInstalled(selection, state.ctx);
  assert.deepEqual(absent.outcome.ok && absent.outcome.result, {
    kind: "mismatch",
    observedIdentity: digest,
  });
  assert.equal((await inspectPiOwnership(state.ctx)).outcome.ok, true);

  cpSync(state.paths.installedRoot, state.paths.preparedRoot, {
    recursive: true,
  });
  const bootstrap = join(
    state.paths.preparedRoot,
    ".pi/extensions/superpowers.ts",
  );
  writeFileSync(bootstrap, "unsupported mechanics");
  const receiptPath = join(
    state.paths.preparedRoot,
    ".superpowers-manager.json",
  );
  const original = JSON.parse(readFileSync(receiptPath, "utf8"));
  const rewritten = {
    ...original,
    digest: await digestPiTree(state.paths.preparedRoot),
  };
  writeFileSync(
    receiptPath,
    JSON.stringify({ ...rewritten, binding: piReceiptBinding(rewritten) }),
  );
  const unsupported = await inspectPiInstalled(selection, state.ctx);
  assert.deepEqual(unsupported.outcome.ok && unsupported.outcome.result, {
    kind: "mismatch",
    observedIdentity: digest,
  });
});

void test("selected HOME resolves tilde registrations without ambient state", async (t) => {
  const state = sandbox(t);
  const { selection } = await preparedAndInstalled(t, state);
  settings(state.paths, ["~/agent/superpowers-manager/installed"]);
  const result = await inspectPiInstalled(selection, {
    ...state.ctx,
    env: { ...state.ctx.env, HOME: state.paths.homeDir },
  });
  assert.equal(result.outcome.ok && result.outcome.result.kind, "current");
});

void test("recognizable unmanaged Pi package and native resources block activation only", async (t) => {
  const state = sandbox(t);
  const { selection } = await preparedAndInstalled(t, state);
  const localPackage = nativeFixture(t);
  settings(state.paths, [
    "superpowers-manager/installed",
    "git:github.com/obra/superpowers",
  ]);
  const conflictControl = await inspectPiControl(state.ctx);
  assert.equal(
    conflictControl.outcome.ok &&
      conflictControl.outcome.result.mutationEligibility.kind,
    "blocked",
  );

  settings(state.paths, [
    "superpowers-manager/installed",
    "git:github.com/obra/superpowers",
    localPackage,
  ]);
  mkdirSync(join(state.paths.agentDir, "extensions"), { recursive: true });
  writeFileSync(
    join(state.paths.agentDir, "extensions/superpowers.ts"),
    "unmanaged",
  );
  mkdirSync(join(state.paths.agentDir, "skills/using-superpowers"), {
    recursive: true,
  });
  writeFileSync(
    join(state.paths.agentDir, "skills/using-superpowers/SKILL.md"),
    "unmanaged",
  );

  const installed = await inspectPiInstalled(selection, state.ctx);
  assert.equal(
    installed.outcome.ok && installed.outcome.result.kind,
    "current",
  );
  const ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
  assert.equal(ownership.installEligibility.kind, "blocked");
  assert.equal(ownership.removalVerification.kind, "blocked");
  assert.deepEqual(ownership.presentationConflicts, [
    "registered Pi package for obra/superpowers",
    "registered local Pi package named superpowers",
    "native Pi extension superpowers.ts",
    "native Pi skill using-superpowers",
  ]);
  assert.equal(
    ownership.removalInput.registrationIdentity,
    "superpowers-manager/installed",
  );

  rmSync(join(state.paths.agentDir, "extensions/superpowers.ts"));
  rmSync(join(state.paths.agentDir, "skills/using-superpowers"), {
    recursive: true,
  });
  settings(state.paths, [
    "superpowers-manager/installed",
    { source: "git:github.com/obra/superpowers@v6.3.0", autoload: false },
  ]);
  const disabled = unwrapOwnership(await inspectPiOwnership(state.ctx));
  assert.equal(disabled.installEligibility.kind, "allowed");
  assert.deepEqual(disabled.presentationConflicts, []);
  const disabledControl = await inspectPiControl(state.ctx);
  assert.equal(
    disabledControl.outcome.ok &&
      disabledControl.outcome.result.mutationEligibility.kind,
    "allowed",
  );
});

void test("only evidenced official Pi source spellings are recognized as upstream conflicts", async (t) => {
  for (const source of [
    "git:github.com/obra/superpowers",
    "git:github.com/obra/superpowers@v6.3.0",
    "git:github.com/obra/superpowers.git@refs/heads/main",
    "git:git@github.com:obra/superpowers",
    "git:git@github.com:obra/superpowers@v6.3.0",
    "https://github.com/obra/superpowers",
    "https://github.com/obra/superpowers.git",
    "https://github.com/obra/superpowers@v6.3.0",
    "ssh://git@github.com/obra/superpowers.git",
    "ssh://git@github.com/obra/superpowers.git@v6.3.0",
  ])
    await t.test(source, async (t) => {
      const state = sandbox(t);
      await preparedAndInstalled(t, state);
      settings(state.paths, ["superpowers-manager/installed", source]);
      const ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
      assert.equal(ownership.installEligibility.kind, "blocked");
      assert.deepEqual(ownership.presentationConflicts, [
        "registered Pi package for obra/superpowers",
      ]);
    });

  for (const source of [
    "git:github.com/Obra/superpowers",
    "git:git@github.com:Obra/superpowers@v6.3.0",
    "git:github.com/obra/superpowers-fork",
    "git:github.com/obra/superpowers-fork@v6.3.0",
    "git:github.com/obra/superpowers@",
  ])
    await t.test(`unrecognized ${source}`, async (t) => {
      const state = sandbox(t);
      await preparedAndInstalled(t, state);
      settings(state.paths, ["superpowers-manager/installed", source]);
      const ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
      assert.equal(ownership.installEligibility.kind, "allowed");
      assert.deepEqual(ownership.presentationConflicts, []);
    });
});

void test("local package conflicts fail closed only when present metadata is uninspectable", async (t) => {
  for (const kind of [
    "missing source",
    "missing metadata",
    "unrelated metadata",
    "single extension",
  ] as const)
    await t.test(kind, async (t) => {
      const state = sandbox(t);
      await preparedAndInstalled(t, state);
      const local = join(state.root, kind.replaceAll(" ", "-"));
      if (kind === "missing metadata") mkdirSync(local);
      if (kind === "unrelated metadata") {
        mkdirSync(local);
        writeFileSync(join(local, "package.json"), '{"name":"other"}');
      }
      if (kind === "single extension") writeFileSync(local, "export {};");
      settings(state.paths, ["superpowers-manager/installed", local]);
      const ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
      assert.equal(ownership.installEligibility.kind, "allowed");
      assert.deepEqual(ownership.presentationConflicts, []);
    });

  for (const kind of ["malformed", "unreadable"] as const)
    await t.test(kind, async (t) => {
      const state = sandbox(t);
      await preparedAndInstalled(t, state);
      const local = join(state.root, kind);
      const metadata = join(local, "package.json");
      mkdirSync(local);
      writeFileSync(
        metadata,
        kind === "malformed" ? "{" : '{"name":"superpowers"}',
      );
      if (kind === "unreadable") {
        chmodSync(metadata, 0o000);
      }
      settings(state.paths, ["superpowers-manager/installed", local]);
      try {
        const ownership = await inspectPiOwnership(state.ctx);
        assert.equal(ownership.outcome.ok, false);
        if (ownership.outcome.ok) assert.fail("expected ownership failure");
        assert.equal(
          ownership.outcome.error.message,
          `cannot inspect Pi ownership at ${state.paths.installedRoot}`,
        );
        const control = await inspectPiControl(state.ctx);
        assert.equal(control.outcome.ok, false);
        if (control.outcome.ok) assert.fail("expected control failure");
        assert.equal(
          control.outcome.error.message,
          `cannot inspect Pi update control at ${state.paths.settingsFile}`,
        );
      } finally {
        if (kind === "unreadable") chmodSync(metadata, 0o600);
      }
    });
});

void test("an absent Manager registration and snapshot permit idempotent uninstall", async (t) => {
  const state = sandbox(t);
  settings(state.paths, []);
  const ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
  assert.equal(ownership.installEligibility.kind, "allowed");
  assert.equal(ownership.removalVerification.kind, "allowed");
  assert.deepEqual(ownership.removalInput, {
    installedRoot: state.paths.installedRoot,
    registrationIdentity: null,
    receiptDigest: null,
  });

  mkdirSync(join(state.paths.agentDir, "extensions"), { recursive: true });
  writeFileSync(
    join(state.paths.agentDir, "extensions/superpowers.ts"),
    "unmanaged",
  );
  const withConflict = unwrapOwnership(await inspectPiOwnership(state.ctx));
  assert.equal(withConflict.installEligibility.kind, "blocked");
  assert.equal(withConflict.removalVerification.kind, "allowed");
  assert.deepEqual(withConflict.removalInput, ownership.removalInput);
});

void test("Codex user resources do not conflict with Pi ownership", async (t) => {
  const state = sandbox(t);
  await preparedAndInstalled(t, state);
  settings(state.paths, ["superpowers-manager/installed"]);
  const codexSkill = join(
    state.paths.homeDir,
    ".agents/skills/superpowers/using-superpowers/SKILL.md",
  );
  mkdirSync(dirname(codexSkill), { recursive: true });
  writeFileSync(codexSkill, "Codex only");

  const ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
  assert.equal(ownership.installEligibility.kind, "allowed");
  assert.deepEqual(ownership.presentationConflicts, []);
});

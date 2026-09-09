import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";

import type {
  AdapterContext,
  AdapterResult,
} from "../../../../src/adapter-result.ts";
import type { EffectiveSelection } from "../../../../src/effective-selection.ts";
import type { OwnershipInspection } from "../../../../src/harness.ts";
import {
  digestPiTree,
  piReceiptBinding,
} from "../../../../src/harnesses/pi/package.ts";
import { piPaths, type PiPaths } from "../../../../src/harnesses/pi/paths.ts";
import {
  inspectPiControl,
  inspectPiInstalled,
  inspectPiOwnership,
  type PiRemovalInput,
} from "../../../../src/harnesses/pi/state.ts";
import {
  nativeFixture,
  nativeSelection,
} from "../../../lib/harnesses/pi/package-fixture.ts";

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

function settingsWithSkills(
  paths: PiPaths,
  packages: unknown,
  skills: readonly string[],
): void {
  mkdirSync(dirname(paths.settingsFile), { recursive: true });
  writeFileSync(paths.settingsFile, JSON.stringify({ packages, skills }));
}

function writeSkill(path: string, name: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `---\nname: ${name}\ndescription: fixture ${name}\n---\n# Fixture\n`,
  );
}

function sharedSkillRoot(state: StateSandbox): string {
  return join(state.paths.homeDir, ".agents/skills/superpowers");
}

function sharedSkill(
  state: StateSandbox,
  name: string,
  filename = "SKILL.md",
): string {
  return join(sharedSkillRoot(state), name, filename);
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

void test("Pi state recognizes the canonical Manager registration through a symlinked agent directory", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "spw-pi-state-linked-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const physicalRoot = join(root, "physical-root");
  const linkedRoot = join(root, "linked-root");
  const physicalAgent = join(physicalRoot, "agent");
  const linkedAgent = join(linkedRoot, "agent");
  mkdirSync(physicalAgent, { recursive: true });
  symlinkSync(physicalRoot, linkedRoot, "dir");
  const env = { HOME: root, PI_CODING_AGENT_DIR: linkedAgent };
  const state: StateSandbox = {
    root,
    ctx: { root, env },
    paths: piPaths(env, root),
  };
  const { selection, digest } = await preparedAndInstalled(t, state);
  const savedSource = join(
    realpathSync(state.paths.agentDir),
    "superpowers-manager",
    "installed",
  );
  settings(state.paths, [savedSource]);

  const installed = await inspectPiInstalled(selection, state.ctx);
  assert.deepEqual(installed.outcome.ok && installed.outcome.result, {
    kind: "current",
    observedIdentity: digest,
  });
  const ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
  assert.equal(ownership.installEligibility.kind, "allowed");
  assert.equal(ownership.removalInput.registrationIdentity, savedSource);
  assert.deepEqual(ownership.presentationConflicts, []);
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
    { source: "http://github.com/obra/superpowers", autoload: false },
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

  const githubLocal = join(state.paths.agentDir, "github:obra", "superpowers");
  cpSync(nativeFixture(t), githubLocal, { recursive: true });
  settings(state.paths, [
    "superpowers-manager/installed",
    "github:obra/superpowers",
  ]);
  const localGithub = unwrapOwnership(await inspectPiOwnership(state.ctx));
  assert.equal(localGithub.installEligibility.kind, "blocked");
  assert.deepEqual(localGithub.presentationConflicts, [
    "registered local Pi package named superpowers",
  ]);

  settings(state.paths, [
    "superpowers-manager/installed",
    { source: "github:obra/superpowers", autoload: false },
  ]);
  const disabledLocalGithub = unwrapOwnership(
    await inspectPiOwnership(state.ctx),
  );
  assert.equal(disabledLocalGithub.installEligibility.kind, "allowed");
  assert.deepEqual(disabledLocalGithub.presentationConflicts, []);

  const aliasState = sandbox(t);
  const { selection: aliasSelection } = await preparedAndInstalled(
    t,
    aliasState,
  );
  const githubAlias = join(
    aliasState.paths.agentDir,
    "github:obra",
    "superpowers",
  );
  mkdirSync(dirname(githubAlias), { recursive: true });
  symlinkSync(aliasState.paths.installedRoot, githubAlias, "dir");
  settings(aliasState.paths, ["github:obra/superpowers"]);
  const aliasInstalled = await inspectPiInstalled(
    aliasSelection,
    aliasState.ctx,
  );
  assert.equal(
    aliasInstalled.outcome.ok && aliasInstalled.outcome.result.kind,
    "current",
  );
  const aliasOwnership = unwrapOwnership(
    await inspectPiOwnership(aliasState.ctx),
  );
  assert.equal(aliasOwnership.installEligibility.kind, "allowed");
  assert.equal(
    aliasOwnership.removalInput.registrationIdentity,
    "github:obra/superpowers",
  );
  assert.deepEqual(aliasOwnership.presentationConflicts, []);
});

void test("only evidenced official Pi source spellings are recognized as upstream conflicts", async (t) => {
  const explicitTransportBases = [
    "http://github.com/obra/superpowers",
    "http://www.github.com/obra/superpowers",
    "https://github.com/obra/superpowers",
    "ssh://git@github.com/obra/superpowers",
    "git://github.com/obra/superpowers",
    "git://user@github.com/obra/superpowers",
  ];
  const explicitTransportSources = explicitTransportBases.flatMap((base) =>
    [
      "",
      ".git",
      "@refs/heads/main",
      ".git@refs/heads/main",
      "#main",
      ".git#main",
    ].flatMap((suffix) => [`${base}${suffix}`, `git:${base}${suffix}`]),
  );
  const hostedShorthandSources = [
    "git:github.com/obra/superpowers",
    "git:github.com/obra/superpowers.git",
    "git:github.com/obra/superpowers@refs/heads/main",
    "git:github.com/obra/superpowers.git@refs/heads/main",
    "git:github.com/obra/superpowers#main",
    "git:github.com/obra/superpowers.git#main",
    "git:git@github.com:obra/superpowers",
    "git:git@github.com:obra/superpowers@refs/heads/main",
    "git:git@github.com:obra/superpowers#main",
    "git:github:obra/superpowers",
    "git:github:obra/superpowers#main",
    "git:obra/superpowers",
    "git:obra/superpowers#main",
  ];
  const documentedAliasSources = [
    "git:obra/superpowers.git",
    "git:github:obra/superpowers.git",
    "git:git+https://github.com/obra/superpowers",
    "git:git+ssh://git@github.com/obra/superpowers",
    "git:git@github.com/obra/superpowers",
    "https://www.github.com/obra/superpowers",
    "https://github.com/obra/superpowers/",
    "https://user@github.com/obra/superpowers",
    "ssh://github.com/obra/superpowers",
    "https://other-user@github.com/obra/superpowers",
  ];
  const documentedAliasRefSources = [
    "git:git+https://github.com/obra/superpowers.git@refs/heads/main",
    "git:git+ssh://git@github.com/obra/superpowers#main",
    "git:git@github.com/obra/superpowers.git/",
    "https://www.github.com/obra/superpowers/@refs/heads/main",
    "https://user@github.com/obra/superpowers.git#main",
    "ssh://github.com/obra/superpowers.git/",
  ];

  for (const source of [
    ...explicitTransportSources,
    ...hostedShorthandSources,
    ...documentedAliasSources,
    ...documentedAliasRefSources,
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
      const control = await inspectPiControl(state.ctx);
      assert.equal(
        control.outcome.ok && control.outcome.result.mutationEligibility.kind,
        "blocked",
      );

      settings(state.paths, [
        "superpowers-manager/installed",
        { source, autoload: false },
      ]);
      const disabledOwnership = unwrapOwnership(
        await inspectPiOwnership(state.ctx),
      );
      assert.equal(disabledOwnership.installEligibility.kind, "allowed");
      assert.deepEqual(disabledOwnership.presentationConflicts, []);
      const disabledControl = await inspectPiControl(state.ctx);
      assert.equal(
        disabledControl.outcome.ok &&
          disabledControl.outcome.result.mutationEligibility.kind,
        "allowed",
      );
    });

  for (const source of [
    "git:github.com/Obra/superpowers",
    "git:git@github.com:Obra/superpowers@v6.3.0",
    "git:github.com/obra/superpowers-fork",
    "git:github.com/obra/superpowers-fork@v6.3.0",
    "git:github.com/obra/superpowers@",
    "git:https://github.com/obra/superpowers@",
    "git:https://github.com/obra/superpowers#",
    "git:github:obra/superpowers-fork",
    "git:github:obra/superpowers#",
    "git:obra/superpowers#",
    "git:someone/superpowers",
    "git+https://github.com/obra/superpowers",
    "git+ssh://git@github.com/obra/superpowers",
    "github:obra/superpowers",
    "https://github.com.evil/obra/superpowers",
    "https://user@github.com.evil/obra/superpowers",
    "https://www.github.com.evil/obra/superpowers",
    "https://github.com/Obra/superpowers",
    "https://github.com/obra/Superpowers",
    "https://github.com/obra/superpowers/extra",
    "https://github.com/obra/superpowers//",
    "https://other.example?user@github.com/obra/superpowers",
    "https://other.example#user@github.com/obra/superpowers",
    "https://u\u0000ser@github.com/obra/superpowers",
    "git:git+https://github.com/obra/superpowers@",
    "git:git+ssh://git@github.com/obra/superpowers#",
    "git:git+https://github.com/obra/superpowers@refs/\u0000heads/main",
    "https://user@github.com/obra/superpowers#main\u0001",
  ])
    await t.test(`unrecognized ${source}`, async (t) => {
      const state = sandbox(t);
      await preparedAndInstalled(t, state);
      settings(state.paths, ["superpowers-manager/installed", source]);
      const ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
      assert.equal(ownership.installEligibility.kind, "allowed");
      assert.deepEqual(ownership.presentationConflicts, []);
      const control = await inspectPiControl(state.ctx);
      assert.equal(
        control.outcome.ok && control.outcome.result.mutationEligibility.kind,
        "allowed",
      );
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

void test("Pi detects shared user-wide Superpowers skills without crossing into Codex-only state", async (t) => {
  const packages = ["superpowers-manager/installed"];

  await t.test(
    "default and empty controls leave shared skills active",
    async (t) => {
      for (const skills of [undefined, [], ["unrelated-skill.md"]] as const) {
        const state = sandbox(t);
        const { selection } = await preparedAndInstalled(t, state);
        writeSkill(
          sharedSkill(state, "using-superpowers"),
          "using-superpowers",
        );
        if (skills === undefined) settings(state.paths, packages);
        else settingsWithSkills(state.paths, packages, skills);

        const installed = await inspectPiInstalled(selection, state.ctx);
        assert.equal(
          installed.outcome.ok && installed.outcome.result.kind,
          "current",
        );
        const ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
        assert.equal(ownership.installEligibility.kind, "blocked");
        assert.equal(ownership.removalVerification.kind, "blocked");
        assert.deepEqual(ownership.presentationConflicts, [
          "native Pi skills route ~/.agents/skills/superpowers",
        ]);
        const control = await inspectPiControl(state.ctx);
        assert.equal(
          control.outcome.ok && control.outcome.result.mutationEligibility.kind,
          "blocked",
        );
      }
    },
  );

  await t.test("exact controls follow native class priority", async (t) => {
    const state = sandbox(t);
    await preparedAndInstalled(t, state);
    writeSkill(sharedSkill(state, "using-superpowers"), "using-superpowers");

    settingsWithSkills(state.paths, packages, [
      "!using-superpowers",
      "+skills/superpowers/using-superpowers",
    ]);
    let ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
    assert.equal(ownership.installEligibility.kind, "blocked");

    settingsWithSkills(state.paths, packages, [
      "-skills/superpowers/using-superpowers",
      "+skills/superpowers/using-superpowers",
      "!using-superpowers",
    ]);
    ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
    assert.equal(ownership.installEligibility.kind, "allowed");
    assert.deepEqual(ownership.presentationConflicts, []);

    settingsWithSkills(state.paths, packages, [
      "-skills/superpowers/using-superpowers ",
    ]);
    ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
    assert.equal(ownership.installEligibility.kind, "blocked");

    settingsWithSkills(state.paths, packages, [
      `-${dirname(sharedSkill(state, "using-superpowers"))}`,
    ]);
    ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
    assert.equal(ownership.installEligibility.kind, "allowed");
  });

  await t.test("every discovered sibling must be disabled", async (t) => {
    const state = sandbox(t);
    await preparedAndInstalled(t, state);
    writeSkill(sharedSkill(state, "using-superpowers"), "using-superpowers");
    writeSkill(
      sharedSkill(state, "test-driven-development"),
      "test-driven-development",
    );

    settingsWithSkills(state.paths, packages, [
      "-skills/superpowers/using-superpowers",
    ]);
    let ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
    assert.equal(ownership.installEligibility.kind, "blocked");

    settingsWithSkills(state.paths, packages, [
      "-skills/superpowers/using-superpowers",
      "-./skills/superpowers/test-driven-development/SKILL.md",
    ]);
    ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
    assert.equal(ownership.installEligibility.kind, "allowed");
    assert.deepEqual(ownership.presentationConflicts, []);
  });

  await t.test("a root SKILL stops its subtree", async (t) => {
    const state = sandbox(t);
    await preparedAndInstalled(t, state);
    writeSkill(join(sharedSkillRoot(state), "SKILL.md"), "superpowers-root");
    writeSkill(sharedSkill(state, "using-superpowers"), "using-superpowers");
    settingsWithSkills(state.paths, packages, ["-skills/superpowers"]);

    const ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
    assert.equal(ownership.installEligibility.kind, "allowed");
    assert.deepEqual(ownership.presentationConflicts, []);
  });

  await t.test(
    "a global discovery-root SKILL suppresses the known subtree",
    async (t) => {
      const state = sandbox(t);
      await preparedAndInstalled(t, state);
      writeSkill(
        join(state.paths.homeDir, ".agents/skills/SKILL.md"),
        "global-root",
      );
      const external = join(state.root, "suppressed-superpowers");
      writeSkill(
        join(external, "using-superpowers/SKILL.md"),
        "using-superpowers",
      );
      symlinkSync(external, sharedSkillRoot(state), "dir");
      settings(state.paths, packages);

      const ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
      assert.equal(ownership.installEligibility.kind, "allowed");
      assert.deepEqual(ownership.presentationConflicts, []);
    },
  );

  await t.test(
    "nested plain markdown is a shared skill candidate",
    async (t) => {
      const state = sandbox(t);
      await preparedAndInstalled(t, state);
      writeSkill(join(sharedSkillRoot(state), "workflow.md"), "workflow");
      settings(state.paths, packages);

      const ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
      assert.equal(ownership.installEligibility.kind, "blocked");
    },
  );

  await t.test(
    "hidden and node_modules subtrees are not discovered",
    async (t) => {
      const state = sandbox(t);
      await preparedAndInstalled(t, state);
      writeSkill(
        join(sharedSkillRoot(state), ".hidden/skill/SKILL.md"),
        "hidden-skill",
      );
      writeSkill(
        join(sharedSkillRoot(state), "node_modules/skill/SKILL.md"),
        "dependency-skill",
      );
      settings(state.paths, packages);

      const ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
      assert.equal(ownership.installEligibility.kind, "allowed");
      assert.deepEqual(ownership.presentationConflicts, []);
    },
  );

  await t.test("unsupported glob controls fail closed", async (t) => {
    const state = sandbox(t);
    await preparedAndInstalled(t, state);
    writeSkill(sharedSkill(state, "using-superpowers"), "using-superpowers");
    writeSkill(
      sharedSkill(state, "test-driven-development"),
      "test-driven-development",
    );
    settingsWithSkills(state.paths, packages, [
      "!skills/superpowers/**",
      "+skills/superpowers/using-superpowers",
    ]);

    const ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
    assert.equal(ownership.installEligibility.kind, "blocked");
    assert.deepEqual(ownership.presentationConflicts, [
      "native Pi skills route ~/.agents/skills/superpowers has indeterminate activity",
    ]);
  });

  await t.test(
    "minimatch comment controls do not prove a candidate disabled",
    async (t) => {
      const state = sandbox(t);
      await preparedAndInstalled(t, state);
      writeSkill(join(sharedSkillRoot(state), "#skill.md"), "hash-skill");
      settingsWithSkills(state.paths, packages, ["!#skill.md"]);

      const ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
      assert.equal(ownership.installEligibility.kind, "blocked");
      assert.deepEqual(ownership.presentationConflicts, [
        "native Pi skills route ~/.agents/skills/superpowers has indeterminate activity",
      ]);
    },
  );

  await t.test("ignore controls fail closed", async (t) => {
    const state = sandbox(t);
    await preparedAndInstalled(t, state);
    writeSkill(sharedSkill(state, "using-superpowers"), "using-superpowers");
    writeFileSync(
      join(state.paths.homeDir, ".agents/skills/.ignore"),
      "superpowers/\n",
    );
    settings(state.paths, packages);

    const ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
    assert.equal(ownership.installEligibility.kind, "blocked");
    assert.deepEqual(ownership.presentationConflicts, [
      "native Pi skills route ~/.agents/skills/superpowers has indeterminate activity",
    ]);
  });

  await t.test(
    "ancestor ignores do not conflict with an absent route",
    async (t) => {
      const state = sandbox(t);
      await preparedAndInstalled(t, state);
      mkdirSync(join(state.paths.homeDir, ".agents/skills"), {
        recursive: true,
      });
      writeFileSync(
        join(state.paths.homeDir, ".agents/skills/.gitignore"),
        "superpowers/\n",
      );
      settings(state.paths, packages);

      const ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
      assert.equal(ownership.installEligibility.kind, "allowed");
      assert.deepEqual(ownership.presentationConflicts, []);
    },
  );

  await t.test(
    "an explicit known file uses agent-directory filter identities",
    async (t) => {
      const state = sandbox(t);
      await preparedAndInstalled(t, state);
      const skill = sharedSkill(state, "using-superpowers");
      writeSkill(skill, "using-superpowers");

      settingsWithSkills(state.paths, packages, [
        skill,
        "-skills/superpowers/using-superpowers",
      ]);
      let ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
      assert.equal(ownership.installEligibility.kind, "blocked");
      assert.deepEqual(ownership.presentationConflicts, [
        "native Pi skills route ~/.agents/skills/superpowers",
      ]);

      settingsWithSkills(state.paths, packages, [skill, `-${skill}`]);
      ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
      assert.equal(ownership.installEligibility.kind, "allowed");
      assert.deepEqual(ownership.presentationConflicts, []);
    },
  );

  await t.test(
    "external file aliases keep lexical filters before canonical deduplication",
    async (t) => {
      const state = sandbox(t);
      await preparedAndInstalled(t, state);
      const target = sharedSkill(state, "using-superpowers");
      const alias = join(state.paths.homeDir, "shared-using-superpowers.md");
      writeSkill(target, "using-superpowers");
      symlinkSync(target, alias);

      for (const targetControl of [
        "-skills/superpowers/using-superpowers",
        `-${target}`,
      ]) {
        settingsWithSkills(state.paths, packages, [alias, targetControl]);
        const ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
        assert.equal(ownership.installEligibility.kind, "blocked");
        assert.deepEqual(ownership.presentationConflicts, [
          "native Pi skills route ~/.agents/skills/superpowers",
        ]);
      }

      settingsWithSkills(state.paths, packages, [alias, `-${alias}`]);
      const disabled = unwrapOwnership(await inspectPiOwnership(state.ctx));
      assert.equal(disabled.installEligibility.kind, "allowed");
      assert.deepEqual(disabled.presentationConflicts, []);
    },
  );

  await t.test(
    "the first explicit alias owns activity for one canonical skill",
    async (t) => {
      const state = sandbox(t);
      await preparedAndInstalled(t, state);
      const target = sharedSkill(state, "using-superpowers");
      const first = join(state.paths.homeDir, "shared-first.md");
      const second = join(state.paths.homeDir, "shared-second.md");
      writeSkill(target, "using-superpowers");
      symlinkSync(target, first);
      symlinkSync(target, second);

      settingsWithSkills(state.paths, packages, [first, second, `-${first}`]);
      let ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
      assert.equal(ownership.installEligibility.kind, "allowed");
      assert.deepEqual(ownership.presentationConflicts, []);

      settingsWithSkills(state.paths, packages, [second, first, `-${first}`]);
      ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
      assert.equal(ownership.installEligibility.kind, "blocked");
      assert.deepEqual(ownership.presentationConflicts, [
        "native Pi skills route ~/.agents/skills/superpowers",
      ]);
    },
  );

  await t.test(
    "unrelated file aliases remain unrelated and related directory aliases are indeterminate",
    async (t) => {
      const unrelatedState = sandbox(t);
      await preparedAndInstalled(t, unrelatedState);
      const known = sharedSkill(unrelatedState, "using-superpowers");
      const unrelatedTarget = join(unrelatedState.root, "unrelated/SKILL.md");
      const unrelatedAlias = join(unrelatedState.paths.homeDir, "unrelated.md");
      writeSkill(known, "using-superpowers");
      writeSkill(unrelatedTarget, "unrelated");
      symlinkSync(unrelatedTarget, unrelatedAlias);
      settingsWithSkills(unrelatedState.paths, packages, [
        unrelatedAlias,
        "-skills/superpowers/using-superpowers",
      ]);
      let ownership = unwrapOwnership(
        await inspectPiOwnership(unrelatedState.ctx),
      );
      assert.equal(ownership.installEligibility.kind, "allowed");
      assert.deepEqual(ownership.presentationConflicts, []);

      const relatedState = sandbox(t);
      await preparedAndInstalled(t, relatedState);
      const relatedTarget = dirname(
        sharedSkill(relatedState, "using-superpowers"),
      );
      const relatedAlias = join(relatedState.paths.homeDir, "shared-skill");
      writeSkill(join(relatedTarget, "SKILL.md"), "using-superpowers");
      symlinkSync(relatedTarget, relatedAlias, "dir");
      settingsWithSkills(relatedState.paths, packages, [
        relatedAlias,
        "-skills/superpowers/using-superpowers",
      ]);
      ownership = unwrapOwnership(await inspectPiOwnership(relatedState.ctx));
      assert.equal(ownership.installEligibility.kind, "blocked");
      assert.deepEqual(ownership.presentationConflicts, [
        "native Pi skills route ~/.agents/skills/superpowers has indeterminate activity",
      ]);
    },
  );

  await t.test(
    "explicit known file sources use native trim tilde and file URL resolution",
    async (t) => {
      const state = sandbox(t);
      await preparedAndInstalled(t, state);
      const skill = sharedSkill(state, "using-superpowers");
      writeSkill(skill, "using-superpowers");
      const relativeToHome = skill.slice(state.paths.homeDir.length + 1);

      for (const source of [
        `  ~/${relativeToHome}  `,
        `  ${pathToFileURL(skill).href}  `,
      ]) {
        settingsWithSkills(state.paths, packages, [
          source,
          "-skills/superpowers/using-superpowers",
        ]);
        const ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
        assert.equal(ownership.installEligibility.kind, "blocked", source);
      }
    },
  );

  await t.test(
    "explicit files remain active when a global root SKILL suppresses auto discovery",
    async (t) => {
      const state = sandbox(t);
      await preparedAndInstalled(t, state);
      writeSkill(
        join(state.paths.homeDir, ".agents/skills/SKILL.md"),
        "global-root",
      );
      const skill = sharedSkill(state, "using-superpowers");
      writeSkill(skill, "using-superpowers");
      settingsWithSkills(state.paths, packages, [skill]);

      const ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
      assert.equal(ownership.installEligibility.kind, "blocked");
      assert.deepEqual(ownership.presentationConflicts, [
        "native Pi skills route ~/.agents/skills/superpowers",
      ]);
    },
  );

  await t.test(
    "unrelated explicit files do not invalidate disabled known skills",
    async (t) => {
      const state = sandbox(t);
      await preparedAndInstalled(t, state);
      const skill = sharedSkill(state, "using-superpowers");
      writeSkill(skill, "using-superpowers");
      const unrelated = join(state.root, "unrelated/SKILL.md");
      writeSkill(unrelated, "unrelated");
      settingsWithSkills(state.paths, packages, [
        unrelated,
        "-skills/superpowers/using-superpowers",
      ]);

      const ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
      assert.equal(ownership.installEligibility.kind, "allowed");
      assert.deepEqual(ownership.presentationConflicts, []);
    },
  );

  await t.test(
    "overlapping explicit directories remain indeterminate",
    async (t) => {
      const state = sandbox(t);
      await preparedAndInstalled(t, state);
      const skill = sharedSkill(state, "using-superpowers");
      writeSkill(skill, "using-superpowers");
      settingsWithSkills(state.paths, packages, [
        dirname(skill),
        "-skills/superpowers/using-superpowers",
      ]);

      const ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
      assert.equal(ownership.installEligibility.kind, "blocked");
      assert.deepEqual(ownership.presentationConflicts, [
        "native Pi skills route ~/.agents/skills/superpowers has indeterminate activity",
      ]);
    },
  );

  await t.test("symlinked and unreadable routes fail closed", async (t) => {
    const linked = sandbox(t);
    await preparedAndInstalled(t, linked);
    const external = join(linked.root, "external-skill");
    writeSkill(join(external, "SKILL.md"), "linked-skill");
    mkdirSync(sharedSkillRoot(linked), { recursive: true });
    symlinkSync(external, join(sharedSkillRoot(linked), "linked"), "dir");
    settings(linked.paths, packages);
    let ownership = unwrapOwnership(await inspectPiOwnership(linked.ctx));
    assert.equal(ownership.installEligibility.kind, "blocked");
    assert.deepEqual(ownership.presentationConflicts, [
      "native Pi skills route ~/.agents/skills/superpowers has indeterminate activity",
    ]);

    const unreadable = sandbox(t);
    await preparedAndInstalled(t, unreadable);
    writeSkill(
      sharedSkill(unreadable, "using-superpowers"),
      "using-superpowers",
    );
    settings(unreadable.paths, packages);
    chmodSync(sharedSkillRoot(unreadable), 0o000);
    try {
      ownership = unwrapOwnership(await inspectPiOwnership(unreadable.ctx));
      assert.equal(ownership.installEligibility.kind, "blocked");
      assert.deepEqual(ownership.presentationConflicts, [
        "native Pi skills route ~/.agents/skills/superpowers has indeterminate activity",
      ]);
    } finally {
      chmodSync(sharedSkillRoot(unreadable), 0o700);
    }
  });

  await t.test(
    "default Codex skills remain outside Pi discovery",
    async (t) => {
      const state = sandbox(t);
      await preparedAndInstalled(t, state);
      settings(state.paths, packages);
      writeSkill(
        join(
          state.paths.homeDir,
          ".codex/skills/superpowers/using-superpowers/SKILL.md",
        ),
        "using-superpowers",
      );

      const ownership = unwrapOwnership(await inspectPiOwnership(state.ctx));
      assert.equal(ownership.installEligibility.kind, "allowed");
      assert.deepEqual(ownership.presentationConflicts, []);
    },
  );
});

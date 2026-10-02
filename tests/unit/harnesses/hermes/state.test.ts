import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  ARTIFACT_RECEIPT,
  digestArtifactTree,
} from "../../../../src/artifact-tree.ts";
import { readHermesReceipt } from "../../../../src/harnesses/hermes/prepare.ts";
import {
  inspectHermesControl,
  inspectHermesInstalled,
  inspectHermesOwnership,
  leftoverHermesPublication,
  observeHermesOwnership,
  otherSuperpowersManifests,
} from "../../../../src/harnesses/hermes/state.ts";
import { snapshotReceiptBinding } from "../../../../src/snapshot-package.ts";
import { displayPath } from "../../../../src/validator.ts";
import { fakeHermes } from "../../../lib/harnesses/hermes/fake-hermes.ts";
import {
  hermesSandbox,
  prepareHermesArtifact,
  type HermesSandbox,
} from "../../../lib/harnesses/hermes/package-fixture.ts";
import { nativeSelection } from "../../../lib/harnesses/pi/package-fixture.ts";

const foreignLines = [
  "error: another Superpowers copy is present in Hermes; remove it manually, then retry:",
  "  hermes plugins remove superpowers",
];

async function installedFixture(t: test.TestContext) {
  const s = hermesSandbox(t);
  const { selection, artifact } = await prepareHermesArtifact(t, s);
  mkdirSync(s.paths.pluginsRoot, { recursive: true });
  cpSync(s.paths.preparedRoot, s.paths.pluginRoot, {
    recursive: true,
    verbatimSymlinks: true,
  });
  const fake = fakeHermes(s.paths);
  const enabled = await fake.run(["plugins", "enable", "superpowers"], s.ctx);
  assert.equal(enabled.outcome.ok, true);
  return { s, selection, artifact, fake };
}

function tree(root: string): unknown {
  if (!existsSync(root)) return null;
  const info = lstatSync(root);
  if (info.isDirectory())
    return readdirSync(root)
      .sort()
      .map((name) => [name, tree(join(root, name))]);
  return readFileSync(root).toString("hex");
}

async function installedKind(
  s: HermesSandbox,
  selection: Parameters<typeof inspectHermesInstalled>[0],
) {
  const result = await inspectHermesInstalled(selection, s.ctx);
  assert.equal(result.outcome.ok, true);
  return result.outcome.result?.kind;
}

void test("ownership is absent and eligible with nothing published or listed", async (t) => {
  const s = hermesSandbox(t);
  assert.deepEqual(await observeHermesOwnership(s.paths), { kind: "absent" });
  const result = await inspectHermesOwnership(s.ctx);
  assert.equal(result.outcome.ok, true);
  assert.deepEqual(result.outcome.result, {
    installEligibility: { kind: "allowed" },
    removalInput: { ownership: "absent", listed: false },
    removalVerification: { kind: "allowed" },
    postRemovalOutput: { stdout: [], stderr: [] },
    presentationValue: "absent",
    presentationConflicts: [],
  });
});

void test("an unowned plugins/superpowers is foreign and blocks install with the remove command", async (t) => {
  const s = hermesSandbox(t);
  mkdirSync(s.paths.pluginRoot, { recursive: true });
  const result = await inspectHermesOwnership(s.ctx);
  assert.equal(result.outcome.ok, true);
  assert.deepEqual(result.outcome.result?.installEligibility, {
    kind: "blocked",
    output: { stdout: [], stderr: foreignLines },
  });
  assert.deepEqual(result.outcome.result?.removalInput, {
    ownership: "foreign",
    listed: false,
  });
  assert.equal(result.outcome.result?.removalVerification.kind, "blocked");
  assert.equal(
    result.outcome.result?.presentationValue,
    "foreign plugin directory",
  );
});

for (const kind of ["symlink", "regular file"] as const) {
  void test(`a ${kind} plugins/superpowers is foreign and never followed`, async (t) => {
    const s = hermesSandbox(t);
    mkdirSync(s.paths.pluginsRoot, { recursive: true });
    const target = join(s.root, "target");
    mkdirSync(target);
    writeFileSync(join(target, "plugin.yaml"), "name: superpowers\n");
    const before = tree(target);
    if (kind === "symlink") symlinkSync(target, s.paths.pluginRoot);
    else writeFileSync(s.paths.pluginRoot, "foreign bytes\n");
    assert.deepEqual(await observeHermesOwnership(s.paths), {
      kind: "foreign",
    });
    const result = await inspectHermesOwnership(s.ctx);
    assert.equal(result.outcome.ok, true);
    assert.deepEqual(result.outcome.result?.installEligibility, {
      kind: "blocked",
      output: { stdout: [], stderr: foreignLines },
    });
    assert.equal(
      await installedKind(s, nativeSelection("a".repeat(40))),
      "mismatch",
    );
    assert.deepEqual(tree(target), before);
    if (kind === "regular file")
      assert.equal(readFileSync(s.paths.pluginRoot, "utf8"), "foreign bytes\n");
  });
}

for (const owned of [true, false]) {
  void test(`another superpowers manifest blocks install and names its path with ${owned ? "owned" : "absent"} publication`, async (t) => {
    const s = owned ? (await installedFixture(t)).s : hermesSandbox(t);
    const other = join(s.paths.pluginsRoot, "zz\ncopy");
    mkdirSync(other, { recursive: true });
    writeFileSync(
      join(other, owned ? "plugin.yaml" : "plugin.json"),
      owned ? "name: superpowers\n" : '{"name":"superpowers"}\n',
    );
    assert.deepEqual(await otherSuperpowersManifests(s.paths), [other]);
    const result = await inspectHermesOwnership(s.ctx);
    assert.equal(result.outcome.ok, true);
    assert.deepEqual(result.outcome.result?.installEligibility, {
      kind: "blocked",
      output: {
        stdout: [],
        stderr: [
          "error: Hermes discovers another plugin named superpowers; remove it manually, then retry:",
          `  ${displayPath(other)}`,
        ],
      },
    });
    assert.deepEqual(result.outcome.result?.presentationConflicts, [other]);
  });
}

void test("a truthy HERMES_ENABLE_PROJECT_PLUGINS blocks install", async (t) => {
  const s = hermesSandbox(t);
  s.env.HERMES_ENABLE_PROJECT_PLUGINS = " YES ";
  const result = await inspectHermesOwnership(s.ctx);
  assert.deepEqual(result.outcome.result?.installEligibility, {
    kind: "blocked",
    output: {
      stdout: [],
      stderr: [
        "error: HERMES_ENABLE_PROJECT_PLUGINS is set; a project-local Superpowers copy would override the managed one. Unset HERMES_ENABLE_PROJECT_PLUGINS, then retry.",
      ],
    },
  });
});

void test("install refusal prioritizes foreign publication, then other manifests, then project plugins", async (t) => {
  const { s } = await installedFixture(t);
  s.env.HERMES_ENABLE_PROJECT_PLUGINS = "on";
  const other = join(s.paths.pluginsRoot, "zz");
  mkdirSync(other);
  writeFileSync(join(other, "plugin.yaml"), "name: superpowers\n");
  let result = await inspectHermesOwnership(s.ctx);
  assert.match(
    result.outcome.result?.installEligibility.kind === "blocked"
      ? result.outcome.result.installEligibility.output.stderr[0]!
      : "",
    /discovers another plugin/,
  );
  rmSync(join(s.paths.pluginRoot, ARTIFACT_RECEIPT));
  result = await inspectHermesOwnership(s.ctx);
  assert.deepEqual(result.outcome.result?.installEligibility, {
    kind: "blocked",
    output: { stdout: [], stderr: foreignLines },
  });
});

void test("a __pycache__ directory in the published copy makes it foreign", async (t) => {
  const { s } = await installedFixture(t);
  rmSync(join(s.paths.pluginRoot, "__pycache__"));
  mkdirSync(join(s.paths.pluginRoot, "__pycache__"));
  writeFileSync(join(s.paths.pluginRoot, "__pycache__/native.pyc"), "bytecode");
  assert.deepEqual(await observeHermesOwnership(s.paths), { kind: "foreign" });
});

void test("ownership fails closed when Hermes configuration is malformed", async (t) => {
  const s = hermesSandbox(t);
  mkdirSync(s.paths.hermesHome);
  writeFileSync(join(s.paths.hermesHome, "config.yaml"), "plugins: [\n");
  const result = await inspectHermesOwnership(s.ctx);
  assert.equal(result.outcome.ok, false);
  assert.equal(
    result.outcome.error?.message,
    "cannot inspect Hermes ownership",
  );
});

for (const ancestor of [
  "hermesHome",
  "managerRoot",
  "preparedRoot",
  "pluginsRoot",
] as const) {
  void test(`all Hermes inspections refuse a symlinked ${ancestor} without changing its target`, async (t) => {
    const s = hermesSandbox(t);
    const target = join(s.root, "unsafe-target");
    mkdirSync(target);
    writeFileSync(join(target, "marker"), "preserve\n");
    if (ancestor !== "hermesHome") mkdirSync(s.paths.hermesHome);
    if (ancestor === "preparedRoot") mkdirSync(s.paths.managerRoot);
    symlinkSync(target, s.paths[ancestor]);
    const before = tree(target);
    await assert.rejects(
      observeHermesOwnership(s.paths),
      /disallowed type symlink/,
    );
    for (const result of [
      await inspectHermesOwnership(s.ctx),
      await inspectHermesInstalled(nativeSelection("a".repeat(40)), s.ctx),
      await inspectHermesControl(s.ctx),
    ])
      assert.equal(result.outcome.ok, false);
    assert.deepEqual(tree(target), before);
  });
}

void test("inspection never runs hermes and creates nothing in a fresh HERMES_HOME", async (t) => {
  const s = hermesSandbox(t);
  s.env.SUPERPOWERS_HERMES = join(s.root, "missing-hermes");
  const before = tree(s.root);
  for (const result of [
    await inspectHermesOwnership(s.ctx),
    await inspectHermesInstalled(nativeSelection("a".repeat(40)), s.ctx),
    await inspectHermesControl(s.ctx),
  ])
    assert.equal(result.outcome.ok, true);
  assert.deepEqual(tree(s.root), before);
});

void test("installed state is current when owned, enabled, and matching prepared", async (t) => {
  const { s, selection, artifact } = await installedFixture(t);
  const result = await inspectHermesInstalled(selection, s.ctx);
  assert.equal(result.outcome.ok, true);
  assert.deepEqual(result.outcome.result, {
    kind: "current",
    observedIdentity: artifact.identity,
  });
  const ownership = await inspectHermesOwnership(s.ctx);
  assert.equal(
    ownership.outcome.result?.presentationValue,
    `managed ${artifact.identity}`,
  );
  assert.deepEqual(ownership.outcome.result?.removalInput, {
    ownership: "owned",
    listed: true,
  });
  assert.equal(ownership.outcome.result?.removalVerification.kind, "blocked");
});

for (const problem of [
  "disabled",
  "not enabled",
  "different prepared commit",
  "foreign directory",
  "another superpowers manifest",
  "enabled without a directory",
  "renamed manifest",
  "unparseable manifest",
  "tagged non-mapping manifest",
  "different selected source",
  "different selected commit",
  "different prepared digest",
] as const) {
  void test(`installed state is a mismatch when ${problem}`, async (t) => {
    const { s, selection, fake } = await installedFixture(t);
    let selected = selection;
    if (problem === "disabled")
      await fake.run(["plugins", "disable", "superpowers"], s.ctx);
    if (problem === "not enabled")
      writeFileSync(join(s.paths.hermesHome, "config.yaml"), "plugins: {}\n");
    if (
      problem === "different prepared commit" ||
      problem === "different prepared digest"
    )
      await prepareHermesArtifact(t, s, "changed");
    if (problem === "foreign directory")
      rmSync(join(s.paths.pluginRoot, ARTIFACT_RECEIPT));
    if (problem === "another superpowers manifest") {
      const other = join(s.paths.pluginsRoot, "zz");
      mkdirSync(other);
      writeFileSync(join(other, "plugin.yaml"), "name: superpowers\n");
    }
    if (problem === "enabled without a directory")
      rmSync(s.paths.pluginRoot, { recursive: true });
    if (problem === "different selected source")
      selected = {
        ...selection,
        effectiveSource: "https://github.com/example/superpowers",
      };
    if (problem === "different selected commit")
      selected = { ...selection, desiredCommit: "b".repeat(40) };
    if (
      problem === "renamed manifest" ||
      problem === "unparseable manifest" ||
      problem === "tagged non-mapping manifest" ||
      problem === "different prepared digest"
    ) {
      const root =
        problem === "different prepared digest"
          ? s.paths.preparedRoot
          : s.paths.pluginRoot;
      const receipt = await readHermesReceipt(root);
      if (
        problem === "renamed manifest" ||
        problem === "unparseable manifest" ||
        problem === "tagged non-mapping manifest"
      )
        writeFileSync(
          join(root, "plugin.yaml"),
          problem === "renamed manifest"
            ? "name: other\n"
            : problem === "tagged non-mapping manifest"
              ? "!!set {unrelated: null}\n"
              : "name: [\n",
        );
      else writeFileSync(join(root, "marker"), "digest-only difference\n");
      const identity = {
        ...receipt,
        commit:
          problem === "different prepared digest"
            ? selection.desiredCommit
            : receipt.commit,
        digest: await digestArtifactTree(root),
      };
      writeFileSync(
        join(root, ARTIFACT_RECEIPT),
        JSON.stringify({
          ...identity,
          binding: snapshotReceiptBinding(identity),
        }),
      );
      if (problem !== "different prepared digest") {
        rmSync(s.paths.preparedRoot, { recursive: true });
        cpSync(s.paths.pluginRoot, s.paths.preparedRoot, { recursive: true });
        assert.equal((await observeHermesOwnership(s.paths)).kind, "owned");
      }
    }
    assert.equal(await installedKind(s, selected), "mismatch");
  });
}

void test("installed state is absent with nothing published or listed", async (t) => {
  const s = hermesSandbox(t);
  assert.equal(
    await installedKind(s, nativeSelection("a".repeat(40))),
    "absent",
  );
});

void test("a listed plugin without publication blocks removal verification", async (t) => {
  const s = hermesSandbox(t);
  const fake = fakeHermes(s.paths);
  await fake.run(["plugins", "disable", "superpowers"], s.ctx);
  const result = await inspectHermesOwnership(s.ctx);
  assert.deepEqual(result.outcome.result?.removalInput, {
    ownership: "absent",
    listed: true,
  });
  assert.equal(result.outcome.result?.removalVerification.kind, "blocked");
});

void test("update control blocks on leftover publication entries and sorts their absolute paths", async (t) => {
  const s = hermesSandbox(t);
  mkdirSync(s.paths.managerRoot, { recursive: true });
  const first = join(s.paths.managerRoot, "publish.a\nbackup");
  const second = join(s.paths.managerRoot, "publish.z");
  writeFileSync(second, "leftover");
  mkdirSync(first);
  mkdirSync(join(s.paths.managerRoot, "unrelated"));
  assert.deepEqual(await leftoverHermesPublication(s.paths), [first, second]);
  const result = await inspectHermesControl(s.ctx);
  const decision = {
    kind: "blocked",
    output: {
      stdout: [],
      stderr: [
        "error: Hermes recovery required; inspect and remove leftover publication material manually:",
        `  ${displayPath(first)}`,
        `  ${displayPath(second)}`,
      ],
    },
  };
  assert.equal(result.outcome.ok, true);
  assert.deepEqual(result.outcome.result?.mutationEligibility, decision);
  assert.deepEqual(result.outcome.result?.probeEligibility, decision);
  assert.equal(result.outcome.result?.recoveryState, "required");
});

void test("update control is clear without leftovers", async (t) => {
  const s = hermesSandbox(t);
  const result = await inspectHermesControl(s.ctx);
  assert.deepEqual(result.outcome.result, {
    probeEligibility: { kind: "allowed" },
    mutationEligibility: { kind: "allowed" },
    presentationValue: "clear",
  });
});

for (const field of ["source", "commit"] as const) {
  void test(`installed state verifies the owned receipt ${field} independently of prepared bytes`, async (t) => {
    const { s, selection } = await installedFixture(t);
    const receipt = await readHermesReceipt(s.paths.pluginRoot);
    const identity = {
      ...receipt,
      [field]:
        field === "source"
          ? "https://github.com/example/superpowers"
          : "c".repeat(40),
    };
    writeFileSync(
      join(s.paths.pluginRoot, ARTIFACT_RECEIPT),
      JSON.stringify({
        ...identity,
        binding: snapshotReceiptBinding(identity),
      }),
    );
    assert.equal((await observeHermesOwnership(s.paths)).kind, "owned");
    assert.equal(await installedKind(s, selection), "mismatch");
  });
}

void test("installed state accepts equivalent official snapshot sources", async (t) => {
  const { s, selection } = await installedFixture(t);
  const receipt = await readHermesReceipt(s.paths.pluginRoot);
  const identity = {
    ...receipt,
    source: "git@github.com:obra/superpowers.git",
  };
  writeFileSync(
    join(s.paths.pluginRoot, ARTIFACT_RECEIPT),
    JSON.stringify({ ...identity, binding: snapshotReceiptBinding(identity) }),
  );
  assert.equal(await installedKind(s, selection), "current");
});

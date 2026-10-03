import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import {
  failureResult,
  successResult,
} from "../../../../src/adapter-result.ts";
import type {
  InstallTransaction,
  PreparedArtifact,
} from "../../../../src/harness.ts";
import {
  installHermes,
  removeHermes,
} from "../../../../src/harnesses/hermes/install.ts";
import { readHermesStatus } from "../../../../src/harnesses/hermes/observe.ts";
import {
  prepareHermesCandidate,
  readHermesReceipt,
} from "../../../../src/harnesses/hermes/prepare.ts";
import {
  inspectHermesInstalled,
  inspectHermesOwnership,
  leftoverHermesPublication,
  otherSuperpowersManifests,
} from "../../../../src/harnesses/hermes/state.ts";
import {
  fakeHermes,
  type FakeHermes,
} from "../../../lib/harnesses/hermes/fake-hermes.ts";
import {
  hermesSandbox,
  nativeHermesFixture,
  prepareHermesArtifact,
  type HermesSandbox,
} from "../../../lib/harnesses/hermes/package-fixture.ts";
import {
  commitFixture,
  nativeSelection,
} from "../../../lib/harnesses/pi/package-fixture.ts";

async function install(
  s: HermesSandbox,
  fake: FakeHermes,
  artifact: PreparedArtifact,
): Promise<InstallTransaction> {
  const result = await installHermes(artifact, s.ctx, { run: fake.run });
  assert.equal(result.outcome.ok, true, result.outcome.error?.message);
  const transaction = result.outcome.result?.transaction;
  assert.ok(transaction);
  return transaction;
}

void test("the prior snapshot stays outside Hermes discovery during enable", async (t) => {
  const { s, fake, first } = await installedFixture(t);
  await fake.run(["plugins", "disable", "superpowers"], s.ctx);
  const second = await prepareHermesArtifact(t, s, "B");
  let observedEnable = false;
  const result = await installHermes(second.artifact, s.ctx, {
    run: async (args, ctx) => {
      if (args[1] === "enable") {
        observedEnable = true;
        assert.deepEqual(await otherSuperpowersManifests(s.paths), []);
        const [publication] = await leftoverHermesPublication(s.paths);
        assert.ok(publication);
        assert.equal(
          (await readHermesReceipt(join(publication, "backup"))).digest,
          first.artifact.identity,
        );
      }
      return fake.run(args, ctx);
    },
  });
  assert.equal(result.outcome.ok, true);
  assert.equal(observedEnable, true);
  assert.equal(
    (await result.outcome.result!.transaction!.finalize()).outcome.ok,
    true,
  );
});

void test("a partially failed enable restores the snapshot and inactive status", async (t) => {
  const { s, fake, first } = await installedFixture(t);
  await fake.run(["plugins", "disable", "superpowers"], s.ctx);
  fake.calls.length = 0;
  const second = await prepareHermesArtifact(t, s, "B");
  const result = await installHermes(second.artifact, s.ctx, {
    run: async (args, ctx) => {
      const result = await fake.run(args, ctx);
      return args[1] === "enable"
        ? failureResult(
            "hermes-command",
            "nonzero-exit",
            "Hermes command exited with status 1",
            [],
            [],
          )
        : result;
    },
  });
  assert.equal(result.outcome.ok, false);
  assert.deepEqual(fake.calls, [
    "plugins enable superpowers",
    "plugins disable superpowers",
  ]);
  assert.equal(
    (await readHermesReceipt(s.paths.pluginRoot)).digest,
    first.artifact.identity,
  );
  assert.equal(await readHermesStatus(s.paths, s.env), "disabled");
  assert.deepEqual(await leftoverHermesPublication(s.paths), []);
});

void test("finalization preserves changed backup content for recovery", async (t) => {
  const { s, fake } = await installedFixture(t);
  const second = await prepareHermesArtifact(t, s, "B");
  const transaction = await install(s, fake, second.artifact);
  const [publication] = await leftoverHermesPublication(s.paths);
  assert.ok(publication);
  const marker = join(publication, "backup", "foreign");
  writeFileSync(marker, "preserve\n");
  const result = await transaction.finalize();
  assert.equal(result.outcome.ok, false);
  assert.match(result.outcome.error?.message ?? "", /backup cleanup failed/);
  assert.equal(readFileSync(marker, "utf8"), "preserve\n");
  assert.equal(
    (await readHermesReceipt(s.paths.pluginRoot)).digest,
    second.artifact.identity,
  );
});

void test("removal refuses a listed activation without an owned directory", async (t) => {
  const s = hermesSandbox(t);
  const fake = fakeHermes(s.paths);
  await fake.run(["plugins", "disable", "superpowers"], s.ctx);
  fake.calls.length = 0;
  const before = tree(s.paths.hermesHome);
  const result = await removeHermes(
    { ownership: "absent", listed: true },
    s.ctx,
    { run: fake.run },
  );
  assert.equal(result.outcome.ok, false);
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(tree(s.paths.hermesHome), before);
});

async function installedFixture(t: test.TestContext) {
  const s = hermesSandbox(t);
  const fake = fakeHermes(s.paths);
  const first = await prepareHermesArtifact(t, s, "A");
  assert.equal(
    (await (await install(s, fake, first.artifact)).finalize()).outcome.ok,
    true,
  );
  fake.calls.length = 0;
  return { s, fake, first };
}

function tree(root: string): unknown {
  const info = lstatSync(root, { throwIfNoEntry: false });
  if (!info) return null;
  if (info.isSymbolicLink()) return { link: readlinkSync(root) };
  if (info.isDirectory())
    return readdirSync(root)
      .sort()
      .map((name) => [name, tree(join(root, name))]);
  return readFileSync(root).toString("hex");
}

void test("first install publishes, enables, and verifies current", async (t) => {
  const s = hermesSandbox(t);
  const fake = fakeHermes(s.paths);
  const { artifact, selection } = await prepareHermesArtifact(t, s);
  const transaction = await install(s, fake, artifact);
  assert.deepEqual(fake.calls, ["plugins enable superpowers"]);
  assert.equal(
    (await inspectHermesInstalled(selection, s.ctx)).outcome.result?.kind,
    "current",
  );
  assert.equal((await transaction.finalize()).outcome.ok, true);
  assert.deepEqual(await leftoverHermesPublication(s.paths), []);
});

void test("update swaps the snapshot without re-enabling an enabled plugin", async (t) => {
  const { s, fake, first } = await installedFixture(t);
  const second = await prepareHermesArtifact(t, s, "B");
  const transaction = await install(s, fake, second.artifact);
  assert.notEqual(second.artifact.identity, first.artifact.identity);
  assert.deepEqual(fake.calls, []);
  assert.equal(
    (await inspectHermesInstalled(second.selection, s.ctx)).outcome.result
      ?.kind,
    "current",
  );
  assert.equal((await transaction.finalize()).outcome.ok, true);
  assert.deepEqual(await leftoverHermesPublication(s.paths), []);
});

for (const kind of ["renamed", "unparseable"] as const) {
  void test(`an already-enabled update to a snapshot whose manifest is ${kind} is not current`, async (t) => {
    const { s, fake, first } = await installedFixture(t);
    const upstream = nativeHermesFixture(t);
    writeFileSync(
      join(upstream, ".hermes-plugin/plugin.yaml"),
      kind === "renamed" ? "name: other\n" : "name: [\n",
    );
    const selection = nativeSelection(commitFixture(upstream));
    rmSync(s.paths.preparedRoot, { recursive: true });
    const prepared = await prepareHermesCandidate(
      {
        upstreamRoot: upstream,
        workspaceRoot: s.root,
        candidateRoot: s.paths.preparedRoot,
        selection,
      },
      s.ctx,
    );
    assert.equal(prepared.outcome.ok, true);
    const transaction = await install(s, fake, prepared.outcome.result!);
    assert.deepEqual(fake.calls, []);
    assert.equal(
      (await inspectHermesInstalled(selection, s.ctx)).outcome.result?.kind,
      "mismatch",
    );
    assert.equal((await transaction.rollback()).outcome.ok, true);
    assert.equal(
      (await readHermesReceipt(s.paths.pluginRoot)).digest,
      first.artifact.identity,
    );
  });
}

void test("update re-enables a disabled plugin", async (t) => {
  const { s, fake } = await installedFixture(t);
  await fake.run(["plugins", "disable", "superpowers"], s.ctx);
  fake.calls.length = 0;
  const second = await prepareHermesArtifact(t, s, "B");
  const transaction = await install(s, fake, second.artifact);
  assert.deepEqual(fake.calls, ["plugins enable superpowers"]);
  assert.equal(
    (await inspectHermesInstalled(second.selection, s.ctx)).outcome.result
      ?.kind,
    "current",
  );
  assert.equal((await transaction.finalize()).outcome.ok, true);
});

void test("rolling back a first install removes it through Hermes", async (t) => {
  const s = hermesSandbox(t);
  const fake = fakeHermes(s.paths);
  const { artifact } = await prepareHermesArtifact(t, s);
  const transaction = await install(s, fake, artifact);
  fake.calls.length = 0;
  assert.equal((await transaction.rollback()).outcome.ok, true);
  assert.deepEqual(fake.calls, ["plugins remove superpowers"]);
  assert.equal(existsSync(s.paths.pluginRoot), false);
  assert.equal(await readHermesStatus(s.paths, s.env), "not enabled");
  assert.deepEqual(await leftoverHermesPublication(s.paths), []);
});

for (const status of ["enabled", "disabled", "not enabled"] as const) {
  void test(`rolling back an update restores the prior snapshot and disables what it enabled from ${status}`, async (t) => {
    const { s, fake, first } = await installedFixture(t);
    if (status === "disabled")
      await fake.run(["plugins", "disable", "superpowers"], s.ctx);
    if (status === "not enabled")
      writeFileSync(join(s.paths.hermesHome, "config.yaml"), "plugins: {}\n");
    const second = await prepareHermesArtifact(t, s, "B");
    const transaction = await install(s, fake, second.artifact);
    fake.calls.length = 0;
    assert.equal((await transaction.rollback()).outcome.ok, true);
    assert.deepEqual(
      fake.calls,
      status === "enabled" ? [] : ["plugins disable superpowers"],
    );
    assert.equal(
      (await readHermesReceipt(s.paths.pluginRoot)).digest,
      first.artifact.identity,
    );
    assert.equal(
      await readHermesStatus(s.paths, s.env),
      status === "enabled" ? "enabled" : "disabled",
    );
    assert.deepEqual(await leftoverHermesPublication(s.paths), []);
  });
}

for (const prior of ["absent", "disabled"] as const) {
  void test(`a failed enable restores prior ${prior} state and leaves no publication material`, async (t) => {
    const setup = prior === "disabled" ? await installedFixture(t) : undefined;
    const s = setup?.s ?? hermesSandbox(t);
    const fake = setup?.fake ?? fakeHermes(s.paths);
    if (setup) await fake.run(["plugins", "disable", "superpowers"], s.ctx);
    const { artifact } = await prepareHermesArtifact(t, s, "B");
    fake.failOn = "plugins enable";
    const result = await installHermes(artifact, s.ctx, { run: fake.run });
    assert.equal(result.outcome.ok, false);
    assert.match(
      result.outcome.error?.message ?? "",
      /^hermes plugins enable superpowers did not complete \(exit status 1\)/,
    );
    if (setup) {
      assert.equal(
        (await readHermesReceipt(s.paths.pluginRoot)).digest,
        setup.first.artifact.identity,
      );
      assert.equal(await readHermesStatus(s.paths, s.env), "disabled");
    } else assert.equal(existsSync(s.paths.pluginRoot), false);
    assert.deepEqual(await leftoverHermesPublication(s.paths), []);
  });
}

for (const problem of [
  "foreign",
  "conflicting",
  "project-plugin",
  "leftover",
  "symlinked ancestor",
  "malformed config",
] as const) {
  void test(`install refuses ${problem} state before any mutation`, async (t) => {
    const s = hermesSandbox(t);
    const { artifact } = await prepareHermesArtifact(t, s);
    const fake = fakeHermes(s.paths);
    if (problem === "foreign") {
      mkdirSync(s.paths.pluginRoot, { recursive: true });
      writeFileSync(join(s.paths.pluginRoot, "keep"), "foreign\n");
    }
    if (problem === "conflicting") {
      const other = join(s.paths.pluginsRoot, "other");
      mkdirSync(other, { recursive: true });
      writeFileSync(join(other, "plugin.yaml"), "name: superpowers\n");
    }
    if (problem === "project-plugin")
      s.env.HERMES_ENABLE_PROJECT_PLUGINS = "yes";
    if (problem === "leftover")
      mkdirSync(join(s.paths.managerRoot, "publish.leftover"));
    if (problem === "symlinked ancestor")
      symlinkSync(s.paths.managerRoot, s.paths.pluginsRoot);
    if (problem === "malformed config")
      writeFileSync(join(s.paths.hermesHome, "config.yaml"), "plugins: [\n");
    const before = tree(s.paths.hermesHome);
    const result = await installHermes(artifact, s.ctx, { run: fake.run });
    assert.equal(result.outcome.ok, false);
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(tree(s.paths.hermesHome), before);
  });
}

void test("install refuses a prepared artifact that changed before activation", async (t) => {
  const s = hermesSandbox(t);
  const { artifact } = await prepareHermesArtifact(t, s);
  writeFileSync(join(artifact.root, "plugin.yaml"), "name: replaced\n");
  const before = tree(s.paths.hermesHome);
  const fake = fakeHermes(s.paths);
  const result = await installHermes(artifact, s.ctx, { run: fake.run });
  assert.equal(result.outcome.ok, false);
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(tree(s.paths.hermesHome), before);
});

void test("a changed staged digest refuses publication and preserves the prior snapshot", async (t) => {
  const { s, fake, first } = await installedFixture(t);
  const second = await prepareHermesArtifact(t, s, "B");
  const copy = fs.cp;
  t.mock.method(fs, "cp", async (...args: Parameters<typeof fs.cp>) => {
    await copy(...args);
    writeFileSync(join(String(args[1]), "marker"), "changed after copy\n");
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const result = await installHermes(second.artifact, s.ctx, { run: fake.run });
  assert.equal(result.outcome.ok, false);
  assert.equal(
    (await readHermesReceipt(s.paths.pluginRoot)).digest,
    first.artifact.identity,
  );
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(await leftoverHermesPublication(s.paths), []);
});

for (const restoreFails of [false, true]) {
  void test(`a failed stage rename ${restoreFails ? "retains the backup when restoration fails" : "restores the prior snapshot"}`, async (t) => {
    const { s, fake, first } = await installedFixture(t);
    const second = await prepareHermesArtifact(t, s, "B");
    const move = fs.rename;
    t.mock.method(fs, "rename", async (from: string, to: string) => {
      if (
        to === s.paths.pluginRoot &&
        (from.endsWith("/stage") || restoreFails)
      )
        throw new Error("injected rename failure");
      await move(from, to);
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const result = await installHermes(second.artifact, s.ctx, {
      run: fake.run,
    });
    assert.equal(result.outcome.ok, false);
    assert.deepEqual(fake.calls, []);
    const publications = await leftoverHermesPublication(s.paths);
    if (restoreFails) {
      assert.match(
        result.outcome.error?.message ?? "",
        /previous Hermes state may not be restored/,
      );
      assert.equal(existsSync(s.paths.pluginRoot), false);
      assert.equal(publications.length, 1);
      assert.equal(
        (await readHermesReceipt(join(publications[0]!, "backup"))).digest,
        first.artifact.identity,
      );
    } else {
      assert.deepEqual(publications, []);
      assert.equal(
        (await readHermesReceipt(s.paths.pluginRoot)).digest,
        first.artifact.identity,
      );
    }
  });
}

void test("removal removes through Hermes and verifies nothing remains", async (t) => {
  const { s, fake } = await installedFixture(t);
  const preparedBefore = tree(s.paths.preparedRoot);
  const result = await removeHermes(
    { ownership: "owned", listed: true },
    s.ctx,
    { run: fake.run },
  );
  assert.equal(result.outcome.ok, true);
  assert.deepEqual(fake.calls, ["plugins remove superpowers"]);
  assert.equal(existsSync(s.paths.pluginRoot), false);
  assert.equal(await readHermesStatus(s.paths, s.env), "not enabled");
  assert.deepEqual(tree(s.paths.preparedRoot), preparedBefore);
});

void test("removal of absent state issues no native mutation", async (t) => {
  const s = hermesSandbox(t);
  const fake = fakeHermes(s.paths);
  const before = tree(s.root);
  const result = await removeHermes(
    { ownership: "absent", listed: false },
    s.ctx,
    { run: fake.run },
  );
  assert.equal(result.outcome.ok, true);
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(tree(s.root), before);
});

for (const kind of ["foreign", "symlinked"] as const) {
  void test(`removal refuses a ${kind} plugin directory and preserves it`, async (t) => {
    const s = hermesSandbox(t);
    const fake = fakeHermes(s.paths);
    mkdirSync(s.paths.pluginsRoot, { recursive: true });
    if (kind === "foreign") mkdirSync(s.paths.pluginRoot);
    else symlinkSync(s.env.HOME!, s.paths.pluginRoot);
    const before = tree(s.root);
    const result = await removeHermes(
      { ownership: "owned", listed: false },
      s.ctx,
      { run: fake.run },
    );
    assert.equal(result.outcome.ok, false);
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(tree(s.root), before);
  });
}

void test("removal fails closed when config.yaml still names superpowers after remove", async (t) => {
  const { s, fake } = await installedFixture(t);
  const result = await removeHermes(
    { ownership: "owned", listed: true },
    s.ctx,
    {
      run: async (args, ctx) => {
        const result = await fake.run(args, ctx);
        writeFileSync(
          join(s.paths.hermesHome, "config.yaml"),
          "plugins:\n  disabled: [superpowers]\n",
        );
        return result;
      },
    },
  );
  assert.equal(result.outcome.ok, false);
  assert.equal(result.outcome.error?.code, "removal-unverified");
  assert.equal(existsSync(s.paths.pluginRoot), false);
});

for (const problem of [
  "stale input",
  "conflicting",
  "leftover",
  "malformed config",
] as const) {
  void test(`removal rechecks ${problem} before native mutation`, async (t) => {
    const { s, fake } = await installedFixture(t);
    if (problem === "conflicting") {
      const other = join(s.paths.pluginsRoot, "other");
      mkdirSync(other);
      writeFileSync(join(other, "plugin.yaml"), "name: superpowers\n");
    }
    if (problem === "leftover")
      mkdirSync(join(s.paths.managerRoot, "publish.leftover"));
    if (problem === "malformed config")
      writeFileSync(join(s.paths.hermesHome, "config.yaml"), "plugins: [\n");
    const before = tree(s.paths.hermesHome);
    const result = await removeHermes(
      {
        ownership: problem === "stale input" ? "absent" : "owned",
        listed: true,
      },
      s.ctx,
      { run: fake.run },
    );
    assert.equal(result.outcome.ok, false);
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(tree(s.paths.hermesHome), before);
  });
}

void test("owned removal succeeds with project plugins enabled and preserves project content", async (t) => {
  const { s, fake } = await installedFixture(t);
  s.env.HERMES_ENABLE_PROJECT_PLUGINS = "1";
  const project = join(s.root, ".hermes/plugins/superpowers");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "plugin.yaml"), "name: superpowers\n");
  const before = tree(project);
  const result = await removeHermes(
    { ownership: "owned", listed: true },
    s.ctx,
    { run: fake.run },
  );
  assert.equal(result.outcome.ok, true);
  assert.deepEqual(fake.calls, ["plugins remove superpowers"]);
  assert.deepEqual(tree(project), before);
});

void test("failed rollback retains recovery material and the restored prior snapshot", async (t) => {
  const { s, fake, first } = await installedFixture(t);
  await fake.run(["plugins", "disable", "superpowers"], s.ctx);
  const second = await prepareHermesArtifact(t, s, "B");
  const transaction = await install(s, fake, second.artifact);
  fake.failOn = "plugins disable";
  const result = await transaction.rollback();
  assert.equal(result.outcome.ok, false);
  assert.match(
    result.outcome.error?.message ?? "",
    /rollback did not complete/,
  );
  assert.equal(
    (await readHermesReceipt(s.paths.pluginRoot)).digest,
    first.artifact.identity,
  );
  assert.equal((await leftoverHermesPublication(s.paths)).length, 1);
});

void test("rollback preserves the backup when the published snapshot changes", async (t) => {
  const { s, fake, first } = await installedFixture(t);
  const second = await prepareHermesArtifact(t, s, "B");
  const transaction = await install(s, fake, second.artifact);
  writeFileSync(join(s.paths.pluginRoot, "foreign"), "keep\n");
  const result = await transaction.rollback();
  assert.equal(result.outcome.ok, false);
  assert.equal(
    readFileSync(join(s.paths.pluginRoot, "foreign"), "utf8"),
    "keep\n",
  );
  const [publication] = await leftoverHermesPublication(s.paths);
  assert.ok(publication);
  assert.equal(
    (await readHermesReceipt(join(publication, "backup"))).digest,
    first.artifact.identity,
  );
  assert.deepEqual(fake.calls, []);
});

void test("rollback refuses uninspectable configuration and retains the backup", async (t) => {
  const { s, fake, first } = await installedFixture(t);
  const second = await prepareHermesArtifact(t, s, "B");
  const transaction = await install(s, fake, second.artifact);
  writeFileSync(join(s.paths.hermesHome, "config.yaml"), "plugins: [\n");
  const result = await transaction.rollback();
  assert.equal(result.outcome.ok, false);
  assert.deepEqual(fake.calls, []);
  const [publication] = await leftoverHermesPublication(s.paths);
  assert.ok(publication);
  assert.equal(
    (await readHermesReceipt(join(publication, "backup"))).digest,
    first.artifact.identity,
  );
});

void test("fresh rollback verifies native removal and retains recovery material on incomplete removal", async (t) => {
  const s = hermesSandbox(t);
  const fake = fakeHermes(s.paths);
  const { artifact } = await prepareHermesArtifact(t, s);
  const result = await installHermes(artifact, s.ctx, {
    run: async (args, ctx) =>
      args[1] === "remove"
        ? successResult("hermes-command", { stdout: "" }, [])
        : fake.run(args, ctx),
  });
  assert.equal(result.outcome.ok, true);
  assert.equal(
    (await result.outcome.result!.transaction!.rollback()).outcome.ok,
    false,
  );
  assert.equal(existsSync(s.paths.pluginRoot), true);
  assert.equal((await leftoverHermesPublication(s.paths)).length, 1);
});

for (const message of [
  "Hermes command exited with status 255",
  "Hermes command exited with status 256",
  "raw\u001b[2J failure",
]) {
  void test(`native failure bounds diagnostic ${JSON.stringify(message)}`, async (t) => {
    const s = hermesSandbox(t);
    const fake = fakeHermes(s.paths);
    const { artifact } = await prepareHermesArtifact(t, s);
    const result = await installHermes(artifact, s.ctx, {
      run: async (args, ctx) =>
        args[1] === "enable"
          ? failureResult("hermes-command", "failed", message, [], [])
          : fake.run(args, ctx),
    });
    assert.equal(result.outcome.ok, false);
    assert.equal(
      result.outcome.error?.message,
      `hermes plugins enable superpowers did not complete${message.endsWith("255") ? " (exit status 255)" : ""}`,
    );
  });
}

void test("an unrelated directory alias permits install, current probe, update, and removal without changing its target", async (t) => {
  const s = hermesSandbox(t);
  const fake = fakeHermes(s.paths);
  const target = join(s.root, "external");
  const alias = join(s.paths.pluginsRoot, "unrelated-alias");
  mkdirSync(target);
  writeFileSync(join(target, "plugin.yaml"), "name: unrelated\n");
  mkdirSync(s.paths.pluginsRoot, { recursive: true });
  symlinkSync(target, alias);
  const before = tree(target);
  const ownership = await inspectHermesOwnership(s.ctx);
  assert.equal(ownership.outcome.ok, true);
  assert.equal(ownership.outcome.result?.installEligibility.kind, "allowed");
  const first = await prepareHermesArtifact(t, s, "A");
  assert.equal(
    (await (await install(s, fake, first.artifact)).finalize()).outcome.ok,
    true,
  );
  assert.equal(
    (await inspectHermesInstalled(first.selection, s.ctx)).outcome.result?.kind,
    "current",
  );
  const second = await prepareHermesArtifact(t, s, "B");
  assert.equal(
    (await (await install(s, fake, second.artifact)).finalize()).outcome.ok,
    true,
  );
  assert.equal(
    (await inspectHermesInstalled(second.selection, s.ctx)).outcome.result
      ?.kind,
    "current",
  );
  const removal = await removeHermes(
    { ownership: "owned", listed: true },
    s.ctx,
    { run: fake.run },
  );
  assert.equal(removal.outcome.ok, true);
  assert.equal(
    (await inspectHermesOwnership(s.ctx)).outcome.result?.removalVerification
      .kind,
    "allowed",
  );
  assert.equal(
    (await inspectHermesInstalled(second.selection, s.ctx)).outcome.result
      ?.kind,
    "absent",
  );
  assert.deepEqual(tree(target), before);
  assert.equal(readlinkSync(alias), target);
});

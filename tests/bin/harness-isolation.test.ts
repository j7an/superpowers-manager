import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  createCase,
  readLog,
  runScript,
  snapshotTree,
  type CaseEnv,
  writePiExecutable,
} from "./lifecycle-fixture.ts";
import {
  commitFixture,
  crossHarnessUpstream,
  fixtureGit,
} from "../lib/harnesses/pi/package-fixture.ts";
import { piPaths } from "../../src/harnesses/pi/paths.ts";
import { readPiReceipt } from "../../src/harnesses/pi/package.ts";

type Harness = "codex" | "pi";
type Command = "prepare" | "probe" | "install" | "update" | "uninstall";
function commandArgs(command: Command, harness: Harness): string[] {
  return [
    "--harness",
    harness,
    ...(harness === "pi" && (command === "install" || command === "update")
      ? ["--allow-experimental"]
      : []),
  ];
}

function clearNativeLogs(c: CaseEnv, piLog: string): void {
  writeFileSync(c.codexLog, "");
  writeFileSync(c.adapterLog, "");
  writeFileSync(piLog, "");
}

function harnessEnv(
  c: CaseEnv,
  upstream: string,
  commit: string,
  pi: string,
  piLog: string,
): Record<string, string> {
  return {
    CODEX_HOME: join(c.dir, "codex-home"),
    SPW_PI_LOG: piLog,
    SUPERPOWERS_PI: pi,
    SUPERPOWERS_REF: commit,
    SUPERPOWERS_UPSTREAM_URL: upstream,
  };
}

async function invoke(
  c: CaseEnv,
  command: Command,
  harness: Harness,
  env: Record<string, string>,
) {
  return await runScript(c, command, {
    args: commandArgs(command, harness),
    env,
  });
}

async function seed(
  c: CaseEnv,
  harness: Harness,
  env: Record<string, string>,
): Promise<void> {
  for (const command of ["prepare", "install"] as const) {
    const result = await invoke(c, command, harness, env);
    assert.equal(
      result.status,
      0,
      `${harness} ${command} setup failed:\n${result.stdout}${result.stderr}`,
    );
  }
}

function snapshotHarness(c: CaseEnv, harness: Harness): unknown {
  if (harness === "codex") {
    return {
      configuredState: snapshotTree(join(c.dir, "codex-home")),
      generated: snapshotTree(join(c.pkg, "plugins", "superpowers")),
      installed: snapshotTree(join(c.state, "codex-home")),
      registrations: ["marketplace_list.json", "plugin_list.json"].map(
        (name) => {
          const file = join(c.state, name);
          const stat = lstatSync(file);
          assert.equal(
            stat.isFile(),
            true,
            `${name} must remain a regular file`,
          );
          return [
            name,
            stat.mode & 0o7777,
            readFileSync(file).toString("base64"),
          ];
        },
      ),
    };
  }
  return snapshotTree(join(c.home, ".pi", "agent"));
}

function assertNoUnselectedCalls(
  c: CaseEnv,
  selected: Harness,
  piLog: string,
): void {
  const calls = selected === "codex" ? readLog(piLog) : readLog(c.codexLog);
  assert.deepEqual(
    calls,
    [],
    `unselected ${selected === "codex" ? "Pi" : "Codex"} CLI was called`,
  );
  assert.deepEqual(
    readLog(c.adapterLog),
    [],
    "maintained CLI must not spawn the retired adapter executable",
  );
}

function assertInstalled(c: CaseEnv, harness: Harness): void {
  if (harness === "codex") {
    assert.match(
      readFileSync(join(c.state, "plugin_list.json"), "utf8"),
      /superpowers@superpowers-manager/,
    );
    assert.match(
      readFileSync(join(c.state, "marketplace_list.json"), "utf8"),
      /superpowers-manager/,
    );
    assert.equal(
      existsSync(
        join(c.state, "codex-home", "plugins", "cache", "superpowers-manager"),
      ),
      true,
    );
    return;
  }
  const paths = piPaths({ HOME: c.home }, process.cwd());
  assert.equal(existsSync(paths.preparedRoot), true);
  assert.equal(existsSync(paths.installedRoot), true);
  assert.match(readFileSync(paths.settingsFile, "utf8"), /installed/);
}

async function assertPrepared(
  c: CaseEnv,
  harness: Harness,
  commit: string,
): Promise<void> {
  if (harness === "codex") {
    const provenance = JSON.parse(
      readFileSync(
        join(c.pkg, "plugins", "superpowers", ".superpowers-upstream.json"),
        "utf8",
      ),
    ) as { commit?: unknown };
    assert.equal(provenance.commit, commit);
    return;
  }
  const paths = piPaths({ HOME: c.home }, process.cwd());
  assert.equal((await readPiReceipt(paths.preparedRoot)).commit, commit);
}

async function assertInstalledCommit(
  c: CaseEnv,
  harness: Harness,
  commit: string,
): Promise<void> {
  if (harness === "codex") {
    const receipt = JSON.parse(
      readFileSync(
        join(
          c.state,
          "codex-home",
          "plugins",
          "cache",
          "superpowers-manager",
          "superpowers",
          "1.0.0",
          ".superpowers-upstream.json",
        ),
        "utf8",
      ),
    ) as { commit?: unknown };
    assert.equal(receipt.commit, commit);
    return;
  }
  const paths = piPaths({ HOME: c.home }, process.cwd());
  assert.equal((await readPiReceipt(paths.installedRoot)).commit, commit);
}

function assertNoSelectedUpdateMutation(
  c: CaseEnv,
  selected: Harness,
  piLog: string,
): void {
  const calls = selected === "codex" ? readLog(c.codexLog) : readLog(piLog);
  const mutation =
    selected === "codex"
      ? /^plugin (?:add|remove) |^plugin marketplace (?:add|remove) /
      : /^(?:install|remove) /;
  assert.deepEqual(
    calls.filter((call) => mutation.test(call)),
    [],
  );
}

function assertAbsent(c: CaseEnv, harness: Harness): void {
  if (harness === "codex") {
    assert.doesNotMatch(
      readFileSync(join(c.state, "plugin_list.json"), "utf8"),
      /superpowers@superpowers-manager/,
    );
    assert.doesNotMatch(
      readFileSync(join(c.state, "marketplace_list.json"), "utf8"),
      /superpowers-manager/,
    );
    return;
  }
  const paths = piPaths({ HOME: c.home }, process.cwd());
  assert.equal(existsSync(paths.installedRoot), false);
  const settings = existsSync(paths.settingsFile)
    ? readFileSync(paths.settingsFile, "utf8")
    : "{}";
  assert.doesNotMatch(settings, /installed/);
}

function isolationCase(
  t: test.TestContext,
  config: Record<string, unknown> = {},
) {
  const c = createCase({ fakes: "install", config });
  writeFileSync(
    join(c.state, "plugin_list.json"),
    '{"installed":[],"available":[]}\n',
  );
  writeFileSync(
    join(c.state, "marketplace_list.json"),
    '{"marketplaces":[]}\n',
  );
  const codexHome = join(c.dir, "codex-home");
  mkdirSync(join(codexHome, "trust"), { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), 'model = "fixture"\n');
  writeFileSync(join(codexHome, "trust", "sentinel"), "preserve\n");
  symlinkSync("config.toml", join(codexHome, "config-link"));
  const piSentinel = join(c.home, ".pi", "agent", "unrelated-config");
  mkdirSync(piSentinel, { recursive: true });
  writeFileSync(join(piSentinel, "sentinel"), "preserve\n", { mode: 0o640 });
  symlinkSync("sentinel", join(piSentinel, "config-link"));
  const upstream = crossHarnessUpstream(t);
  const commitA = commitFixture(upstream);
  const piLog = join(c.state, "pi.log");
  const pi = writePiExecutable(c);
  return { c, commitA, pi, piLog, upstream };
}

function commitB(upstream: string): string {
  const skill = join(upstream, "skills", "using-superpowers", "SKILL.md");
  writeFileSync(skill, `${readFileSync(skill, "utf8")}phase B\n`);
  fixtureGit(upstream, "add", ".");
  fixtureGit(upstream, "commit", "-qm", "phase B");
  return fixtureGit(upstream, "rev-parse", "HEAD");
}

function writeFailingValidator(c: CaseEnv): string {
  const path = join(c.dir, "bin", "reject-candidate.py");
  writeFileSync(path, "raise SystemExit(1)\n");
  return path;
}

for (const selected of ["codex", "pi"] as const) {
  const other: Harness = selected === "codex" ? "pi" : "codex";

  void test(`${selected}: every maintained lifecycle command leaves ${other} state unchanged`, async (t) => {
    for (const command of [
      "prepare",
      "probe",
      "install",
      "update",
      "uninstall",
    ] as const) {
      await t.test(command, async (t) => {
        const fixture = isolationCase(t);
        const env = harnessEnv(
          fixture.c,
          fixture.upstream,
          fixture.commitA,
          fixture.pi,
          fixture.piLog,
        );
        if (command === "install" || command === "prepare")
          await seed(fixture.c, other, env);
        else {
          await seed(fixture.c, "codex", env);
          await seed(fixture.c, "pi", env);
        }
        const before = snapshotHarness(fixture.c, other);
        clearNativeLogs(fixture.c, fixture.piLog);
        const result = await invoke(fixture.c, command, selected, env);
        assert.equal(
          result.status,
          0,
          `${selected} ${command} failed:\n${result.stdout}${result.stderr}`,
        );
        if (command === "install") assertInstalled(fixture.c, selected);
        if (command === "prepare") {
          await assertPrepared(fixture.c, selected, fixture.commitA);
        }
        if (command === "probe") {
          assert.match(
            result.stdout,
            new RegExp(`^harness: ${selected}$`, "m"),
          );
          assert.match(result.stdout, /^installation state: current$/m);
        }
        if (command === "update") {
          assert.match(
            result.stdout,
            selected === "codex"
              ? /manager is current/
              : /Superpowers Pi snapshot is current/,
          );
          assertInstalled(fixture.c, selected);
          assertNoSelectedUpdateMutation(fixture.c, selected, fixture.piLog);
        }
        if (command === "uninstall") assertAbsent(fixture.c, selected);
        assert.deepEqual(snapshotHarness(fixture.c, other), before);
        assertNoUnselectedCalls(fixture.c, selected, fixture.piLog);
      });
    }
  });

  void test(`${selected}: update publishes B without changing ${other}`, async (t) => {
    const fixture = isolationCase(t);
    const envA = harnessEnv(
      fixture.c,
      fixture.upstream,
      fixture.commitA,
      fixture.pi,
      fixture.piLog,
    );
    await seed(fixture.c, "codex", envA);
    await seed(fixture.c, "pi", envA);
    const before = snapshotHarness(fixture.c, other);
    const next = commitB(fixture.upstream);
    const envB = harnessEnv(
      fixture.c,
      fixture.upstream,
      next,
      fixture.pi,
      fixture.piLog,
    );
    clearNativeLogs(fixture.c, fixture.piLog);
    const result = await invoke(fixture.c, "update", selected, envB);
    assert.equal(
      result.status,
      0,
      `${selected} update failed:\n${result.stdout}${result.stderr}`,
    );
    assert.match(
      result.stdout,
      selected === "codex"
        ? /manager updated/
        : /Installed the frozen Superpowers Pi snapshot/,
    );
    await assertPrepared(fixture.c, selected, next);
    await assertInstalledCommit(fixture.c, selected, next);
    assert.deepEqual(snapshotHarness(fixture.c, other), before);
    assertNoUnselectedCalls(fixture.c, selected, fixture.piLog);
  });

  void test(`${selected}: invalid preparation preserves ${other}`, async (t) => {
    const fixture = isolationCase(t);
    const valid = harnessEnv(
      fixture.c,
      fixture.upstream,
      fixture.commitA,
      fixture.pi,
      fixture.piLog,
    );
    await seed(fixture.c, other, valid);
    const before = snapshotHarness(fixture.c, other);
    clearNativeLogs(fixture.c, fixture.piLog);
    const result = await invoke(fixture.c, "prepare", selected, {
      ...valid,
      SUPERPOWERS_VALIDATOR: writeFailingValidator(fixture.c),
    });
    assert.equal(
      result.status,
      1,
      `${selected} invalid preparation unexpectedly succeeded`,
    );
    assert.match(result.stderr, /additional plugin validation failed/);
    assert.deepEqual(snapshotHarness(fixture.c, other), before);
    assertNoUnselectedCalls(fixture.c, selected, fixture.piLog);
  });

  void test(`${selected}: native installation failure preserves ${other}`, async (t) => {
    const config = selected === "codex" ? { pluginAdd: "fail" } : {};
    const fixture = isolationCase(t, config);
    const pi =
      selected === "pi"
        ? writePiExecutable(fixture.c, { failure: "install" })
        : fixture.pi;
    const env = harnessEnv(
      fixture.c,
      fixture.upstream,
      fixture.commitA,
      pi,
      fixture.piLog,
    );
    await seed(fixture.c, other, env);
    const before = snapshotHarness(fixture.c, other);
    clearNativeLogs(fixture.c, fixture.piLog);
    const result = await invoke(fixture.c, "install", selected, env);
    assert.notEqual(
      result.status,
      0,
      `${selected} failed native install unexpectedly succeeded`,
    );
    const calls =
      selected === "codex"
        ? readLog(fixture.c.codexLog)
        : readLog(fixture.piLog);
    assert.ok(
      calls.some((call) => /^(?:plugin add |install )/.test(call)),
      "native install injection was not reached",
    );
    assert.match(
      result.stderr,
      selected === "codex"
        ? /Codex activation may have changed native state; preserve recovery material at /
        : /Pi activation failed; the previous snapshot and registration were restored/,
    );
    assert.deepEqual(snapshotHarness(fixture.c, other), before);
    assertNoUnselectedCalls(fixture.c, selected, fixture.piLog);
  });

  void test(`${selected}: native removal failure preserves ${other}`, async (t) => {
    const config = selected === "codex" ? { marketplaceRemove: "fail" } : {};
    const fixture = isolationCase(t, config);
    const pi =
      selected === "pi"
        ? writePiExecutable(fixture.c, { failure: "remove" })
        : fixture.pi;
    const env = harnessEnv(
      fixture.c,
      fixture.upstream,
      fixture.commitA,
      pi,
      fixture.piLog,
    );
    await seed(fixture.c, "codex", env);
    await seed(fixture.c, "pi", env);
    const before = snapshotHarness(fixture.c, other);
    clearNativeLogs(fixture.c, fixture.piLog);
    const result = await invoke(fixture.c, "uninstall", selected, env);
    assert.notEqual(
      result.status,
      0,
      `${selected} failed native removal unexpectedly succeeded`,
    );
    const calls =
      selected === "codex"
        ? readLog(fixture.c.codexLog)
        : readLog(fixture.piLog);
    assert.ok(
      calls.some((call) =>
        /^(?:plugin marketplace remove |remove )/.test(call),
      ),
      "native removal injection was not reached",
    );
    assert.match(
      result.stderr,
      selected === "codex"
        ? /Codex native removal failed; preserve the marketplace and recovery material at /
        : /cannot verify Pi removal at .*; preserve the snapshot and any recovery material at /,
    );
    assert.deepEqual(snapshotHarness(fixture.c, other), before);
    assertNoUnselectedCalls(fixture.c, selected, fixture.piLog);
  });

  void test(`${selected}: absent uninstall is a no-op for ${other}`, async (t) => {
    const fixture = isolationCase(t);
    const env = harnessEnv(
      fixture.c,
      fixture.upstream,
      fixture.commitA,
      fixture.pi,
      fixture.piLog,
    );
    await seed(fixture.c, other, env);
    const before = snapshotHarness(fixture.c, other);
    clearNativeLogs(fixture.c, fixture.piLog);
    const result = await invoke(fixture.c, "uninstall", selected, env);
    assert.equal(
      result.status,
      0,
      `${selected} absent uninstall failed:\n${result.stdout}${result.stderr}`,
    );
    assertAbsent(fixture.c, selected);
    assert.deepEqual(snapshotHarness(fixture.c, other), before);
    assertNoUnselectedCalls(fixture.c, selected, fixture.piLog);
  });
}

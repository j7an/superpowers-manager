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
  writeOpenCodeExecutable,
  writeClaudeCodeExecutable,
} from "./lifecycle-fixture.ts";
import {
  commitFixture,
  crossHarnessUpstream,
  fixtureGit,
} from "../lib/harnesses/pi/package-fixture.ts";
import { piPaths } from "../../src/harnesses/pi/paths.ts";
import { readPiReceipt } from "../../src/harnesses/pi/package.ts";
import { openCodePaths } from "../../src/harnesses/opencode/paths.ts";
import { readOpenCodeReceipt } from "../../src/harnesses/opencode/package.ts";
import { claudeCodePaths } from "../../src/harnesses/claude-code/paths.ts";
import { readClaudeCodeReceipt } from "../../src/harnesses/claude-code/prepare.ts";

type Harness = "codex" | "pi" | "opencode" | "claude-code";
type Command = "prepare" | "probe" | "install" | "update" | "uninstall";
const HARNESSES = ["codex", "pi", "opencode", "claude-code"] as const;
function commandArgs(command: Command, harness: Harness): string[] {
  return [
    "--harness",
    harness,
    ...((harness === "pi" || harness === "opencode") &&
    (command === "install" || command === "update")
      ? ["--allow-experimental"]
      : []),
  ];
}

function clearNativeLogs(c: CaseEnv, piLog: string): void {
  writeFileSync(c.codexLog, "");
  writeFileSync(c.adapterLog, "");
  writeFileSync(piLog, "");
  writeFileSync(join(c.state, "opencode.log"), "");
  writeFileSync(join(c.state, "claude.log"), "");
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
    SUPERPOWERS_OPENCODE: join(c.dir, "opencode"),
    SUPERPOWERS_CLAUDE_CODE: join(c.dir, "claude"),
    CLAUDE_CONFIG_DIR: join(c.home, ".claude"),
    SUPERPOWERS_REF: commit,
    SUPERPOWERS_UPSTREAM_URL: upstream,
  };
}

function claudePaths(c: CaseEnv) {
  return claudeCodePaths(
    { HOME: c.home, CLAUDE_CONFIG_DIR: join(c.home, ".claude") },
    process.cwd(),
  );
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
  if (harness === "claude-code")
    return [
      snapshotTree(join(c.home, ".claude")),
      readFileSync(join(c.state, "claude-state.json"), "utf8"),
    ];
  if (harness === "pi") return snapshotTree(join(c.home, ".pi", "agent"));
  return snapshotTree(join(c.home, ".config", "opencode"));
}

function assertNoUnselectedCalls(
  c: CaseEnv,
  selected: Harness,
  piLog: string,
): void {
  const logs: Record<Harness, string[]> = {
    codex: readLog(c.codexLog),
    pi: readLog(piLog),
    opencode: readLog(join(c.state, "opencode.log")),
    "claude-code": readLog(join(c.state, "claude.log")),
  };
  for (const harness of HARNESSES) {
    if (harness === selected) continue;
    assert.deepEqual(logs[harness], [], `unselected ${harness} CLI was called`);
  }
  assert.deepEqual(
    readLog(c.adapterLog),
    [],
    "maintained CLI must not spawn the retired adapter executable",
  );
}

function snapshotHarnesses(c: CaseEnv, harnesses: readonly Harness[]) {
  return harnesses.map(
    (harness) => [harness, snapshotHarness(c, harness)] as const,
  );
}

function assertHarnessesUnchanged(
  c: CaseEnv,
  snapshots: ReturnType<typeof snapshotHarnesses>,
): void {
  for (const [harness, snapshot] of snapshots)
    assert.deepEqual(snapshotHarness(c, harness), snapshot);
}

function assertInstalled(c: CaseEnv, harness: Harness): void {
  if (harness === "claude-code") {
    assert.equal(existsSync(claudePaths(c).pluginRoot), true);
    assert.match(
      readFileSync(join(c.state, "claude-state.json"), "utf8"),
      /superpowers@superpowers-manager/,
    );
    return;
  }
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
  if (harness === "opencode") {
    const paths = openCodePaths(
      { HOME: c.home, XDG_CONFIG_HOME: join(c.home, ".config") },
      process.cwd(),
    );
    assert.equal(existsSync(paths.preparedRoot), true);
    assert.equal(existsSync(paths.installedRoot), true);
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
  if (harness === "claude-code") {
    assert.equal(
      (await readClaudeCodeReceipt(claudePaths(c).preparedRoot)).commit,
      commit,
    );
    return;
  }
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
  if (harness === "opencode") {
    const paths = openCodePaths(
      { HOME: c.home, XDG_CONFIG_HOME: join(c.home, ".config") },
      process.cwd(),
    );
    assert.equal(
      (await readOpenCodeReceipt(paths.preparedRoot)).commit,
      commit,
    );
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
  if (harness === "claude-code") {
    assert.equal(
      (await readClaudeCodeReceipt(claudePaths(c).pluginRoot)).commit,
      commit,
    );
    return;
  }
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
  if (harness === "opencode") {
    const paths = openCodePaths(
      { HOME: c.home, XDG_CONFIG_HOME: join(c.home, ".config") },
      process.cwd(),
    );
    assert.equal(
      (await readOpenCodeReceipt(paths.installedRoot)).commit,
      commit,
    );
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
  if (selected === "claude-code") {
    assert.deepEqual(
      readLog(join(c.state, "claude.log")).filter(
        (call) => !call.endsWith("list --json"),
      ),
      [],
    );
    return;
  }
  if (selected === "opencode") {
    assert.deepEqual(
      readLog(join(c.state, "opencode.log")).filter((call) =>
        call.startsWith("plugin "),
      ),
      [],
    );
    return;
  }
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
  if (harness === "claude-code") {
    assert.equal(existsSync(claudePaths(c).marketplaceRoot), false);
    assert.doesNotMatch(
      readFileSync(join(c.state, "claude-state.json"), "utf8"),
      /superpowers@superpowers-manager/,
    );
    return;
  }
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
  if (harness === "opencode") {
    const paths = openCodePaths(
      { HOME: c.home, XDG_CONFIG_HOME: join(c.home, ".config") },
      process.cwd(),
    );
    assert.equal(existsSync(paths.installedRoot), false);
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
  mkdirSync(join(c.state, "codex-home"), { recursive: true });
  const codexHome = join(c.dir, "codex-home");
  mkdirSync(join(codexHome, "trust"), { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), 'model = "fixture"\n');
  writeFileSync(join(codexHome, "trust", "sentinel"), "preserve\n");
  symlinkSync("config.toml", join(codexHome, "config-link"));
  const piSentinel = join(c.home, ".pi", "agent", "unrelated-config");
  mkdirSync(piSentinel, { recursive: true });
  writeFileSync(join(piSentinel, "sentinel"), "preserve\n", { mode: 0o640 });
  symlinkSync("sentinel", join(piSentinel, "config-link"));
  mkdirSync(join(c.home, ".config", "opencode"), { recursive: true });
  mkdirSync(join(c.home, ".claude"), { recursive: true });
  const upstream = crossHarnessUpstream(t);
  const commitA = commitFixture(upstream);
  const piLog = join(c.state, "pi.log");
  const pi = writePiExecutable(c);
  const opencode = writeOpenCodeExecutable(c);
  writeClaudeCodeExecutable(c);
  return { c, commitA, pi, piLog, opencode, upstream };
}

function commitB(upstream: string): string {
  const skill = join(upstream, "skills", "using-superpowers", "SKILL.md");
  writeFileSync(skill, `${readFileSync(skill, "utf8")}phase B\n`);
  fixtureGit(upstream, "add", ".");
  fixtureGit(upstream, "commit", "-qm", "phase B");
  return fixtureGit(upstream, "rev-parse", "HEAD");
}

function invalidOpenCodeCommit(upstream: string): string {
  writeFileSync(
    join(upstream, ".opencode", "plugins", "superpowers.js"),
    "export default {};\n",
  );
  fixtureGit(upstream, "add", ".");
  fixtureGit(upstream, "commit", "-qm", "invalidate OpenCode profile");
  return fixtureGit(upstream, "rev-parse", "HEAD");
}

function writeFailingValidator(c: CaseEnv): string {
  const path = join(c.dir, "bin", "reject-candidate.sh");
  writeFileSync(path, "#!/bin/sh\nexit 1\n", {
    mode: 0o755,
  });
  return path;
}

for (const selected of HARNESSES) {
  const unselected = HARNESSES.filter((harness) => harness !== selected);

  void test(`${selected}: every maintained lifecycle command leaves unselected state unchanged`, async (t) => {
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
          for (const other of unselected) await seed(fixture.c, other, env);
        else {
          for (const harness of HARNESSES) await seed(fixture.c, harness, env);
        }
        const before = unselected.map(
          (other) => [other, snapshotHarness(fixture.c, other)] as const,
        );
        const selectedBefore =
          command === "probe" ? snapshotHarness(fixture.c, selected) : null;
        if (command === "probe" && selected === "opencode")
          writeOpenCodeExecutable(fixture.c, { failOnCall: true });
        const commandEnv =
          command === "uninstall" && selected === "opencode"
            ? {
                ...env,
                SUPERPOWERS_OPENCODE: join(fixture.c.dir, "missing-opencode"),
              }
            : env;
        clearNativeLogs(fixture.c, fixture.piLog);
        const result = await invoke(fixture.c, command, selected, commandEnv);
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
          assert.deepEqual(
            snapshotHarness(fixture.c, selected),
            selectedBefore,
          );
          if (selected === "opencode")
            assert.deepEqual(
              readLog(join(fixture.c.state, "opencode.log")),
              [],
              "OpenCode probe invoked its fail-on-call native double",
            );
        }
        if (command === "update") {
          assert.match(
            result.stdout,
            selected === "codex"
              ? /manager is current/
              : selected === "pi"
                ? /Superpowers Pi snapshot is current/
                : selected === "opencode"
                  ? /Superpowers OpenCode snapshot is current/
                  : /Superpowers Claude Code snapshot is current/,
          );
          assertInstalled(fixture.c, selected);
          assertNoSelectedUpdateMutation(fixture.c, selected, fixture.piLog);
        }
        if (command === "uninstall") assertAbsent(fixture.c, selected);
        if (command === "uninstall" && selected === "opencode")
          assert.deepEqual(
            readLog(join(fixture.c.state, "opencode.log")),
            [],
            "OpenCode uninstall invoked a configured missing native CLI",
          );
        for (const [other, snapshot] of before)
          assert.deepEqual(snapshotHarness(fixture.c, other), snapshot);
        assertNoUnselectedCalls(fixture.c, selected, fixture.piLog);
      });
    }
  });

  void test(`${selected}: update publishes B without changing either unselected harness`, async (t) => {
    const fixture = isolationCase(t);
    const envA = harnessEnv(
      fixture.c,
      fixture.upstream,
      fixture.commitA,
      fixture.pi,
      fixture.piLog,
    );
    for (const harness of HARNESSES) await seed(fixture.c, harness, envA);
    const before = snapshotHarnesses(fixture.c, unselected);
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
        : selected === "pi"
          ? /Installed the frozen Superpowers Pi snapshot/
          : selected === "opencode"
            ? /Installed the frozen Superpowers OpenCode snapshot/
            : /Installed the frozen Superpowers Claude Code snapshot/,
    );
    await assertPrepared(fixture.c, selected, next);
    await assertInstalledCommit(fixture.c, selected, next);
    assertHarnessesUnchanged(fixture.c, before);
    assertNoUnselectedCalls(fixture.c, selected, fixture.piLog);
  });

  void test(`${selected}: invalid preparation preserves both unselected harnesses`, async (t) => {
    const fixture = isolationCase(t);
    const valid = harnessEnv(
      fixture.c,
      fixture.upstream,
      fixture.commitA,
      fixture.pi,
      fixture.piLog,
    );
    for (const harness of unselected) await seed(fixture.c, harness, valid);
    const before = snapshotHarnesses(fixture.c, unselected);
    const invalidCommit =
      selected === "opencode"
        ? invalidOpenCodeCommit(fixture.upstream)
        : fixture.commitA;
    clearNativeLogs(fixture.c, fixture.piLog);
    const result = await invoke(
      fixture.c,
      "prepare",
      selected,
      selected === "opencode"
        ? { ...valid, SUPERPOWERS_REF: invalidCommit }
        : {
            ...valid,
            SUPERPOWERS_VALIDATOR_EXECUTABLE: writeFailingValidator(fixture.c),
          },
    );
    assert.equal(
      result.status,
      1,
      `${selected} invalid preparation unexpectedly succeeded`,
    );
    assert.match(
      result.stderr,
      selected === "opencode"
        ? /does not match the qualified native bootstrap profile/
        : /external plugin validation failed/,
    );
    assertHarnessesUnchanged(fixture.c, before);
    assertNoUnselectedCalls(fixture.c, selected, fixture.piLog);
  });

  void test(`${selected}: native installation failure preserves both unselected harnesses`, async (t) => {
    const config = selected === "codex" ? { pluginAdd: "fail" } : {};
    const fixture = isolationCase(t, config);
    const pi =
      selected === "pi"
        ? writePiExecutable(fixture.c, { failure: "install" })
        : fixture.pi;
    if (selected === "opencode")
      writeOpenCodeExecutable(fixture.c, { failure: "install" });
    if (selected === "claude-code")
      writeClaudeCodeExecutable(fixture.c, { failure: "install" });
    const env = harnessEnv(
      fixture.c,
      fixture.upstream,
      fixture.commitA,
      pi,
      fixture.piLog,
    );
    for (const harness of unselected) await seed(fixture.c, harness, env);
    const before = snapshotHarnesses(fixture.c, unselected);
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
        : selected === "pi"
          ? readLog(fixture.piLog)
          : selected === "opencode"
            ? readLog(join(fixture.c.state, "opencode.log"))
            : readLog(join(fixture.c.state, "claude.log"));
    assert.ok(
      calls.some((call) =>
        /^(?:plugin add |install |plugin \/|plugin install )/.test(call),
      ),
      "native install injection was not reached",
    );
    assert.match(
      result.stderr,
      selected === "codex"
        ? /Codex activation may have changed native state; preserve recovery material at /
        : selected === "pi"
          ? /Pi activation failed; the previous snapshot and registration were restored/
          : selected === "opencode"
            ? /OpenCode activation failed; the previous snapshot and registration were restored/
            : /claude plugin install superpowers@superpowers-manager --scope user did not complete \(exit status 7\)/,
    );
    assertHarnessesUnchanged(fixture.c, before);
    assertNoUnselectedCalls(fixture.c, selected, fixture.piLog);
  });

  void test(`${selected}: removal failure preserves both unselected harnesses`, async (t) => {
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
    for (const harness of HARNESSES) await seed(fixture.c, harness, env);
    if (selected === "claude-code")
      writeClaudeCodeExecutable(fixture.c, { failure: "remove" });
    const before = snapshotHarnesses(fixture.c, unselected);
    if (selected === "opencode") {
      const paths = openCodePaths(
        {
          HOME: fixture.c.home,
          XDG_CONFIG_HOME: join(fixture.c.home, ".config"),
        },
        process.cwd(),
      );
      writeFileSync(paths.recoveryRoot, "unresolved recovery material\n");
    }
    clearNativeLogs(fixture.c, fixture.piLog);
    const result = await invoke(fixture.c, "uninstall", selected, env);
    assert.notEqual(
      result.status,
      0,
      `${selected} failed native removal unexpectedly succeeded`,
    );
    if (selected !== "opencode") {
      const calls =
        selected === "codex"
          ? readLog(fixture.c.codexLog)
          : selected === "pi"
            ? readLog(fixture.piLog)
            : readLog(join(fixture.c.state, "claude.log"));
      assert.ok(
        calls.some((call) =>
          /^(?:plugin marketplace remove |remove )/.test(call),
        ),
        "native removal injection was not reached",
      );
    }
    assert.match(
      result.stderr,
      selected === "codex"
        ? /Codex native removal failed; preserve the marketplace and recovery material at /
        : selected === "pi"
          ? /cannot verify Pi removal at .*; preserve the snapshot and any recovery material at /
          : selected === "opencode"
            ? /cannot determine harness mutation resources/
            : /claude plugin marketplace remove superpowers-manager did not complete \(exit status 7\)/,
    );
    assertHarnessesUnchanged(fixture.c, before);
    assertNoUnselectedCalls(fixture.c, selected, fixture.piLog);
  });

  void test(`${selected}: absent uninstall is a no-op for both unselected harnesses`, async (t) => {
    const fixture = isolationCase(t);
    const env = harnessEnv(
      fixture.c,
      fixture.upstream,
      fixture.commitA,
      fixture.pi,
      fixture.piLog,
    );
    for (const harness of unselected) await seed(fixture.c, harness, env);
    const before = snapshotHarnesses(fixture.c, unselected);
    clearNativeLogs(fixture.c, fixture.piLog);
    const result = await invoke(fixture.c, "uninstall", selected, env);
    assert.equal(
      result.status,
      0,
      `${selected} absent uninstall failed:\n${result.stdout}${result.stderr}`,
    );
    assertAbsent(fixture.c, selected);
    assertHarnessesUnchanged(fixture.c, before);
    assertNoUnselectedCalls(fixture.c, selected, fixture.piLog);
  });

  void test(`${selected}: invalid saved selection preserves every harness and invokes no native CLI`, async (t) => {
    const fixture = isolationCase(t);
    const env = harnessEnv(
      fixture.c,
      fixture.upstream,
      fixture.commitA,
      fixture.pi,
      fixture.piLog,
    );
    const selectionDir = join(fixture.c.home, ".config", "superpowers-manager");
    mkdirSync(selectionDir, { recursive: true });
    writeFileSync(join(selectionDir, "selection.json"), "{");
    const before = snapshotHarnesses(fixture.c, HARNESSES);
    clearNativeLogs(fixture.c, fixture.piLog);

    const result = await invoke(fixture.c, "probe", selected, env);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid JSON/);
    assertHarnessesUnchanged(fixture.c, before);
    assert.deepEqual(readLog(fixture.c.codexLog), []);
    assert.deepEqual(readLog(fixture.piLog), []);
    assert.deepEqual(readLog(join(fixture.c.state, "opencode.log")), []);
    assert.deepEqual(readLog(fixture.c.adapterLog), []);
  });
}

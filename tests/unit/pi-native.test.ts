import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  SUPPORTED_PI_RUNTIME_VERSION,
  readPiRuntimeVersion,
  runPi,
} from "../../src/pi-native.ts";
import { piPaths } from "../../src/pi-paths.ts";
import { BOUNDED_EXECUTABLE, type ValidatorRun } from "../../src/validator.ts";

function sandbox(t: TestContext): {
  readonly root: string;
  readonly paths: ReturnType<typeof piPaths>;
} {
  const root = mkdtempSync(join(tmpdir(), "spw-pi-native-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "selected-home");
  const agentDir = join(home, "selected-agent");
  mkdirSync(agentDir, { recursive: true });
  return {
    root,
    paths: piPaths({ HOME: home, PI_CODING_AGENT_DIR: agentDir }, root),
  };
}

function exited(
  stdout: string,
  options: { readonly code?: number; readonly stderr?: string } = {},
): ValidatorRun {
  return {
    kind: "exited",
    code: options.code ?? 0,
    stdout: { text: stdout, droppedBytes: 0 },
    stderr: { text: options.stderr ?? "", droppedBytes: 0 },
  };
}

void test("runPi invokes one bounded argv in an isolated native environment", async (t) => {
  const { root, paths } = sandbox(t);
  const callerCwd = process.cwd();
  const explicit = "./tooling/pi";
  let workspace = "";
  const result = await runPi(
    ["install", paths.installedRoot, "--no-approve"],
    paths,
    {
      root,
      env: {
        HOME: "/ambient-home-must-not-win",
        PI_CODING_AGENT_DIR: "/ambient-agent-must-not-win",
        PI_OFFLINE: "0",
        PI_SKIP_VERSION_CHECK: "0",
        SUPERPOWERS_PI: explicit,
        TMPDIR: root,
      },
    },
    async (argv, policy, env, receivedWorkspace, cwd) => {
      workspace = receivedWorkspace;
      assert.deepEqual(argv, [
        join(callerCwd, "tooling/pi"),
        "install",
        paths.installedRoot,
        "--no-approve",
      ]);
      assert.equal(policy, BOUNDED_EXECUTABLE);
      assert.equal(env.HOME, paths.homeDir);
      assert.equal(env.PI_CODING_AGENT_DIR, paths.agentDir);
      assert.equal(env.PI_OFFLINE, "1");
      assert.equal(env.PI_SKIP_VERSION_CHECK, "1");
      assert.equal(receivedWorkspace, cwd);
      assert.equal(isAbsolute(receivedWorkspace), true);
      assert.equal(existsSync(receivedWorkspace), true);
      assert.deepEqual(readdirSync(receivedWorkspace), []);
      return exited("installed\n", { stderr: "progress\u001b\n" });
    },
  );

  assert.equal(existsSync(workspace), false);
  assert.equal(result.status, 0);
  assert.deepEqual(result.outcome.ok && result.outcome.result, {
    stdout: "installed\n",
  });
  assert.deepEqual(result.outcome.messages, [
    { channel: "stderr", text: "progress\\x1b" },
  ]);

  await t.test(
    "a bare configured executable remains a PATH lookup",
    async () => {
      const bare = await runPi(
        [],
        paths,
        {
          root,
          env: { SUPERPOWERS_PI: "selected-pi", TMPDIR: root },
        },
        async (argv) => {
          assert.equal(argv[0], "selected-pi");
          return exited("");
        },
      );
      assert.equal(bare.outcome.ok, true);
    },
  );
});

void test("readPiRuntimeVersion admits only the supported released runtime", async (t) => {
  const { root, paths } = sandbox(t);
  const [major, minor, patch] =
    SUPPORTED_PI_RUNTIME_VERSION.split(".").map(Number);
  assert.equal([major, minor, patch].every(Number.isSafeInteger), true);
  const older = `${major}.${minor}.${patch - 1}`;
  const newer = `${major}.${minor}.${patch + 1}`;
  const cases: readonly [string, ValidatorRun, boolean][] = [
    ["exact", exited(`  ${SUPPORTED_PI_RUNTIME_VERSION}\n`), true],
    ["older", exited(older), false],
    ["newer", exited(newer), false],
    ["malformed", exited("version unknown"), false],
    ["multiline", exited(`${SUPPORTED_PI_RUNTIME_VERSION}\nextra`), false],
    ["nonzero", exited("", { code: 2, stderr: "native failure\n" }), false],
    [
      "timeout",
      {
        kind: "timedOut",
        afterMs: 30_000,
        stdout: { text: "", droppedBytes: 0 },
        stderr: { text: "late\n", droppedBytes: 0 },
      },
      false,
    ],
    [
      "launch failure",
      { kind: "launchFailed", errno: "ENOENT", cause: new Error("private") },
      false,
    ],
  ];

  for (const [name, run, accepted] of cases)
    await t.test(name, async () => {
      const result = await readPiRuntimeVersion(
        paths,
        { root },
        async () => run,
      );
      assert.equal(result.outcome.ok, accepted);
      if (accepted) {
        assert.equal(
          result.outcome.ok && result.outcome.result,
          SUPPORTED_PI_RUNTIME_VERSION,
        );
      } else {
        assert.equal(result.status, 1);
      }
    });
});

void test("runPi preserves bounded diagnostics without trusting subordinate text", async (t) => {
  const { root, paths } = sandbox(t);
  const result = await runPi(
    ["remove", paths.installedRoot, "--no-approve"],
    paths,
    { root },
    async (argv) => {
      assert.deepEqual(argv, [
        "pi",
        "remove",
        paths.installedRoot,
        "--no-approve",
      ]);
      return exited("unsafe\u001b[2J\n", {
        code: 7,
        stderr: "reason\r\n",
      });
    },
  );
  assert.equal(result.outcome.ok, false);
  if (result.outcome.ok) assert.fail("expected native command failure");
  assert.equal(result.outcome.error.message, "Pi command exited with status 7");
  assert.deepEqual(result.outcome.messages, [
    { channel: "stdout", text: "unsafe\\x1b[2J" },
    { channel: "stderr", text: "reason\\r" },
  ]);
});

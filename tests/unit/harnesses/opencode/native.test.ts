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

import { expectFailureCode } from "../../../lib/command-doubles.ts";

import {
  normalizeOpenCodeRuntimeVersion,
  runOpenCode,
} from "../../../../src/harnesses/opencode/native.ts";
import { openCodePaths } from "../../../../src/harnesses/opencode/paths.ts";
import {
  BOUNDED_EXECUTABLE,
  type ValidatorRun,
} from "../../../../src/validator.ts";

function sandbox(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "spw-opencode-native-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "selected-home");
  const config = join(root, "selected-config");
  mkdirSync(home, { recursive: true });
  return {
    root,
    paths: openCodePaths({ HOME: home, XDG_CONFIG_HOME: config }, root),
  };
}

function exited(
  stdout: string,
  options: { readonly code?: number | null; readonly stderr?: string } = {},
): ValidatorRun {
  return {
    kind: "exited",
    code: options.code ?? 0,
    stdout: { text: stdout, droppedBytes: 0 },
    stderr: { text: options.stderr ?? "", droppedBytes: 0 },
  };
}

void test("runOpenCode binds one bounded global invocation to the selected XDG home", async (t) => {
  const { root, paths } = sandbox(t);
  const invocationCwd = process.cwd();
  let workspace = "";
  const result = await runOpenCode(
    ["plugin", paths.installedRoot, "--global"],
    paths,
    {
      root,
      env: {
        HOME: "/ambient-home",
        XDG_CONFIG_HOME: "/ambient-config",
        OPENCODE_DISABLE_AUTOUPDATE: "0",
        OPENCODE_DISABLE_MODELS_FETCH: "0",
        OPENCODE_CONFIG: join(root, "explicit.json"),
        OPENCODE_CONFIG_DIR: join(root, "override"),
        OPENCODE_CONFIG_CONTENT: '{"theme":"ambient"}',
        OPENCODE_DB: join(root, "ambient.db"),
        OPENCODE_TEST_HOME: join(root, "test-home"),
        OPENCODE_TEST_MANAGED_CONFIG_DIR: join(root, "ambient-managed"),
        PATH: "/selected/path",
        SUPERPOWERS_OPENCODE: "./tooling/opencode",
        TMPDIR: root,
      },
    },
    async (argv, policy, env, receivedWorkspace, cwd) => {
      workspace = receivedWorkspace;
      assert.deepEqual(argv, [
        join(invocationCwd, "tooling/opencode"),
        "plugin",
        paths.installedRoot,
        "--global",
      ]);
      assert.deepEqual(policy, {
        ...BOUNDED_EXECUTABLE,
        inheritEnvironment: false,
      });
      assert.equal(env.PATH, "/selected/path");
      assert.equal(env.HOME, join(cwd!, "home"));
      assert.equal(env.XDG_CONFIG_HOME, join(paths.configRoot, ".."));
      assert.equal(env.XDG_DATA_HOME, join(cwd!, "data"));
      assert.equal(env.XDG_CACHE_HOME, join(cwd!, "cache"));
      assert.equal(env.XDG_STATE_HOME, join(cwd!, "state"));
      assert.equal(env.TMPDIR, receivedWorkspace);
      assert.equal(env.OPENCODE_DISABLE_AUTOUPDATE, "1");
      assert.equal(env.OPENCODE_DISABLE_MODELS_FETCH, "1");
      assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
      assert.equal(env.OPENCODE_PURE, "1");
      assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
      assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
      assert.equal(env.OPENCODE_TEST_MANAGED_CONFIG_DIR, join(cwd!, "managed"));
      for (const name of [
        "OPENCODE_CONFIG",
        "OPENCODE_CONFIG_DIR",
        "OPENCODE_CONFIG_CONTENT",
        "OPENCODE_DB",
        "OPENCODE_TEST_HOME",
        "SUPERPOWERS_OPENCODE",
      ])
        assert.equal(env[name], undefined, name);
      assert.equal(receivedWorkspace, join(cwd!, "tmp"));
      assert.equal(isAbsolute(receivedWorkspace), true);
      assert.deepEqual(readdirSync(cwd!).sort(), [
        "cache",
        "data",
        "home",
        "managed",
        "state",
        "tmp",
      ]);
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

  for (const [configured, expected] of [
    ["selected-opencode", "selected-opencode"],
    [join(root, "absolute-opencode"), join(root, "absolute-opencode")],
  ] as const) {
    const selected = await runOpenCode(
      [],
      paths,
      { root, env: { SUPERPOWERS_OPENCODE: configured, TMPDIR: root } },
      async (argv) => {
        assert.equal(argv[0], expected);
        return exited("");
      },
    );
    assert.equal(selected.outcome.ok, true);
  }
});

void test("runOpenCode excludes ambient configuration from an actual bounded child", async (t) => {
  const { root, paths } = sandbox(t);
  const forbidden = [
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_DB",
    "OPENCODE_AUTH_CONTENT",
    "OPENCODE_TEST_HOME",
  ] as const;
  const saved = forbidden.map((name) => [name, process.env[name]] as const);
  for (const name of forbidden) process.env[name] = `ambient-${name}`;
  try {
    const result = await runOpenCode(
      [
        "-e",
        `process.stdout.write(JSON.stringify(${JSON.stringify(forbidden)}.map((name)=>[name,process.env[name]??null])))`,
      ],
      paths,
      {
        root,
        env: {
          PATH: process.env.PATH,
          SUPERPOWERS_OPENCODE: process.execPath,
          TMPDIR: root,
        },
      },
    );
    assert.equal(result.status, 0);
    if (!result.outcome.ok) assert.fail(result.outcome.error.message);
    assert.deepEqual(
      JSON.parse(result.outcome.result.stdout),
      forbidden.map((name) => [name, null]),
    );
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

void test("OpenCode runtime normalization accepts one semantic version only", () => {
  for (const [stdout, accepted] of [
    ["  0.1.0\n", true],
    ["99.2.3", true],
    ["", false],
    ["version unknown", false],
    ["99.2.3\nextra", false],
  ] as const) {
    const result = normalizeOpenCodeRuntimeVersion({
      status: 0,
      outcome: {
        operation: "opencode-command",
        ok: true,
        result: { stdout },
        error: null,
        messages: [],
      },
    });
    assert.equal(result.outcome.ok, accepted, JSON.stringify(stdout));
    if (result.outcome.ok) assert.equal(result.outcome.result, stdout.trim());
  }
  assert.equal(
    normalizeOpenCodeRuntimeVersion({
      status: 1,
      outcome: {
        operation: "opencode-command",
        ok: true,
        result: { stdout: "99.2.3" },
        error: null,
        messages: [],
      },
    }).outcome.ok,
    false,
  );
});

void test("runOpenCode returns controlled failures for native runner outcomes", async (t) => {
  const { root, paths } = sandbox(t);
  const cases: readonly [string, ValidatorRun, string][] = [
    ["launch", { kind: "launchFailed", errno: "bad\nerrno" }, "launch-failed"],
    [
      "timeout",
      {
        kind: "timedOut",
        afterMs: 30_000,
        stdout: { text: "late\u001b\n", droppedBytes: 0 },
        stderr: { text: "reason\r\n", droppedBytes: 0 },
      },
      "timeout",
    ],
    ["nonzero", exited("unsafe\u001b[2J\n", { code: 7 }), "nonzero-exit"],
    [
      "truncated",
      {
        kind: "exited",
        code: 0,
        stdout: { text: "99.2.3", droppedBytes: 1 },
        stderr: { text: "", droppedBytes: 0 },
      },
      "output-limit",
    ],
  ];
  for (const [name, run, code] of cases)
    await t.test(name, async () => {
      const result = await runOpenCode(
        ["--version"],
        paths,
        { root, env: { TMPDIR: root } },
        async () => run,
      );
      expectFailureCode(result, code);
      for (const message of result.outcome.messages) {
        assert.equal(message.text.includes("\u001b"), false);
        assert.equal(message.text.includes("\r"), false);
      }
    });
});

void test("runOpenCode reports isolated workspace creation and callback failures", async (t) => {
  const { root, paths } = sandbox(t);
  const callback = await runOpenCode(
    [],
    paths,
    { root, env: { TMPDIR: root } },
    async () => {
      throw new Error("unsafe native cause\u001b");
    },
  );
  assert.equal(callback.outcome.ok, false);
  if (!callback.outcome.ok)
    assert.equal(
      callback.outcome.error.message,
      "cannot complete OpenCode command in its isolated workspace",
    );

  const file = join(root, "not-a-directory");
  mkdirSync(file);
  const creation = await runOpenCode([], paths, {
    root,
    env: { TMPDIR: join(file, "missing", "child") },
  });
  assert.equal(creation.outcome.ok, false);
  if (!creation.outcome.ok)
    assert.equal(
      creation.outcome.error.message,
      "cannot create an isolated OpenCode command workspace",
    );
});

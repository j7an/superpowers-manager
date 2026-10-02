import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runHermes } from "../../../../src/harnesses/hermes/native.ts";
import { readHermesStatus } from "../../../../src/harnesses/hermes/observe.ts";
import { BOUNDED_EXECUTABLE } from "../../../../src/validator.ts";
import { fakeHermes } from "../../../lib/harnesses/hermes/fake-hermes.ts";
import { hermesSandbox } from "../../../lib/harnesses/hermes/package-fixture.ts";

void test("runHermes bounds the invocation, preserves the caller cwd, and pins HERMES_HOME", async (t) => {
  const s = hermesSandbox(t);
  const cwd = process.cwd();
  for (const configured of ["relative-hermes", undefined]) {
    let workspace = "";
    const result = await runHermes(
      ["plugins", "enable", "superpowers"],
      {
        root: s.root,
        env: {
          ...s.env,
          HERMES_HOME: configured,
          SUPERPOWERS_HERMES: "./tools/hermes",
        },
      },
      async (argv, policy, env, receivedWorkspace, receivedCwd) => {
        workspace = receivedWorkspace;
        assert.deepEqual(argv, [
          join(cwd, "tools/hermes"),
          "plugins",
          "enable",
          "superpowers",
        ]);
        assert.equal(policy, BOUNDED_EXECUTABLE);
        assert.equal(
          env.HERMES_HOME,
          configured === undefined
            ? join(s.env.HOME!, ".hermes")
            : join(cwd, "relative-hermes"),
        );
        assert.equal(receivedCwd, cwd);
        assert.equal(existsSync(workspace), true);
        return {
          kind: "exited",
          code: 0,
          stdout: { text: "ok", droppedBytes: 0 },
          stderr: { text: "", droppedBytes: 0 },
        };
      },
    );
    assert.equal(existsSync(workspace), false);
    assert.equal(result.outcome.ok, true);
    assert.equal(result.outcome.result?.stdout, "ok");
    assert.equal(result.outcome.operation, "hermes-command");
  }
});

void test("runHermes reports isolated workspace failures", async (t) => {
  const s = hermesSandbox(t);
  const callback = await runHermes([], s.ctx, async () => {
    throw new Error("unsafe cause\u001b");
  });
  assert.equal(callback.outcome.ok, false);
  if (!callback.outcome.ok) {
    assert.equal(callback.outcome.error.code, "workspace-failed");
    assert.equal(
      callback.outcome.error.message,
      "cannot complete Hermes command in its isolated workspace",
    );
  }
  const parent = join(s.root, "parent");
  mkdirSync(parent);
  const creation = await runHermes([], {
    root: s.root,
    env: { ...s.env, TMPDIR: join(parent, "missing", "child") },
  });
  assert.equal(creation.outcome.ok, false);
  if (!creation.outcome.ok)
    assert.equal(
      creation.outcome.error.message,
      "cannot create an isolated Hermes command workspace",
    );
});

void test("fakeHermes mutations are visible to the file observer and failures preserve state", async (t) => {
  const s = hermesSandbox(t);
  const fake = fakeHermes(s.paths);
  const system = join(s.root, "system");
  mkdirSync(s.paths.pluginRoot, { recursive: true });
  for (const [command, expected] of [
    ["enable", "enabled"],
    ["disable", "disabled"],
  ] as const) {
    const result = await fake.run(["plugins", command, "superpowers"], s.ctx);
    assert.equal(result.outcome.ok, true);
    assert.equal(await readHermesStatus(s.paths, s.env, system), expected);
  }
  fake.failOn = "plugins enable";
  const failed = await fake.run(["plugins", "enable", "superpowers"], s.ctx);
  assert.equal(failed.outcome.ok, false);
  if (!failed.outcome.ok)
    assert.equal(
      failed.outcome.error.message,
      "Hermes command exited with status 1",
    );
  assert.equal(await readHermesStatus(s.paths, s.env, system), "disabled");
  assert.equal((await fake.run(["plugins", "list"], s.ctx)).outcome.ok, false);
  assert.equal(
    (await fake.run(["plugins", "remove", "superpowers"], s.ctx)).outcome.ok,
    true,
  );
  assert.equal(existsSync(s.paths.pluginRoot), false);
  assert.equal(await readHermesStatus(s.paths, s.env, system), "not enabled");
  assert.deepEqual(fake.calls, [
    "plugins enable superpowers",
    "plugins disable superpowers",
    "plugins enable superpowers",
    "plugins list",
    "plugins remove superpowers",
  ]);
});

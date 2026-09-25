import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  failureResult,
  successResult,
} from "../../../../src/adapter-result.ts";
import {
  parseMarketplaceList,
  parsePluginList,
  readClaudeCodeState,
  runClaude,
} from "../../../../src/harnesses/claude-code/native.ts";
import {
  BOUNDED_EXECUTABLE,
  type ValidatorRun,
} from "../../../../src/validator.ts";
import { claudeCodeSandbox } from "../../../lib/harnesses/claude-code/package-fixture.ts";

function exited(stdout: string, code = 0): ValidatorRun {
  return {
    kind: "exited",
    code,
    stdout: { text: stdout, droppedBytes: 0 },
    stderr: { text: "", droppedBytes: 0 },
  };
}

void test("runClaude bounds the invocation and preserves the caller cwd", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const cwd = process.cwd();
  let workspace = "";
  const result = await runClaude(
    ["plugin", "list", "--json"],
    {
      root: sandbox.root,
      env: { ...sandbox.env, SUPERPOWERS_CLAUDE_CODE: "./tools/claude" },
    },
    async (argv, policy, env, receivedWorkspace, receivedCwd) => {
      workspace = receivedWorkspace;
      assert.deepEqual(argv, [
        join(cwd, "tools/claude"),
        "plugin",
        "list",
        "--json",
      ]);
      assert.equal(policy, BOUNDED_EXECUTABLE);
      assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
      assert.equal(env.CLAUDE_CONFIG_DIR, sandbox.env.CLAUDE_CONFIG_DIR);
      assert.equal(receivedCwd, cwd);
      assert.equal(existsSync(receivedWorkspace), true);
      return exited("[]\n");
    },
  );
  assert.equal(existsSync(workspace), false);
  assert.equal(result.outcome.ok, true);
  assert.equal(result.outcome.result?.stdout, "[]\n");
  assert.equal(result.outcome.operation, "claude-code-command");
});

void test("parsePluginList keeps documented fields and counts load errors", () => {
  assert.deepEqual(
    parsePluginList(
      JSON.stringify([
        {
          id: "superpowers@superpowers-manager",
          version: "6.4.1+manager.abc1234",
          scope: "user",
          enabled: true,
          installPath: "/c/p",
          errors: ["one", "two"],
          future: 1,
        },
        {
          id: "other@market",
          version: "1.0.0",
          scope: "project",
          enabled: false,
          installPath: "/c/q",
        },
      ]),
    ),
    [
      {
        id: "superpowers@superpowers-manager",
        version: "6.4.1+manager.abc1234",
        scope: "user",
        enabled: true,
        installPath: "/c/p",
        errorCount: 2,
      },
      {
        id: "other@market",
        version: "1.0.0",
        scope: "project",
        enabled: false,
        installPath: "/c/q",
        errorCount: 0,
      },
    ],
  );
});

for (const [name, stdout] of [
  ["non-array output", '{"plugins":[]}'],
  ["banner before the array", "Checking plugins...\n[]"],
  ["duplicate key", '[{"id":"a@b","id":"c@d"}]'],
  ["non-object entry", "[null]"],
  [
    "missing installPath",
    '[{"id":"x@y","version":"1.0.0","scope":"user","enabled":true}]',
  ],
  [
    "string enabled",
    '[{"id":"x@y","version":"1.0.0","scope":"user","enabled":"true","installPath":"/p"}]',
  ],
  [
    "non-array errors",
    '[{"id":"x@y","version":"1.0.0","scope":"user","enabled":true,"installPath":"/p","errors":1}]',
  ],
] as const) {
  void test(`parsePluginList fails closed on ${name}`, () => {
    assert.throws(() => parsePluginList(stdout), /Claude Code plugin list/);
  });
}

void test("parseMarketplaceList maps absent path to null", () => {
  assert.deepEqual(
    parseMarketplaceList(
      '[{"name":"a","source":"directory","path":"/m"},{"name":"b","source":"github","repo":"o/r"}]',
    ),
    [
      { name: "a", source: "directory", path: "/m" },
      { name: "b", source: "github", path: null },
    ],
  );
});

for (const stdout of [
  '[{"name":1,"source":"directory"}]',
  '[{"name":"a","source":"directory","path":null}]',
  '[{"name":"a","source":"directory","path":"/one","path":"/two"}]',
]) {
  void test(`parseMarketplaceList rejects malformed entry ${stdout}`, () => {
    assert.throws(
      () => parseMarketplaceList(stdout),
      /Claude Code marketplace list/,
    );
  });
}

void test("readClaudeCodeState uses both native list commands", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const seen: string[] = [];
  const result = await readClaudeCodeState(sandbox.ctx, async (args) => {
    seen.push(args.join(" "));
    return successResult("claude-code-command", { stdout: "[]" }, []);
  });
  assert.deepEqual(result, { plugins: [], marketplaces: [] });
  assert.deepEqual(seen, [
    "plugin list --json",
    "plugin marketplace list --json",
  ]);
});

void test("readClaudeCodeState fails closed when either list command fails", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  for (const failedCommand of ["list", "marketplace"])
    await assert.rejects(
      readClaudeCodeState(sandbox.ctx, async (args) =>
        args[1] === failedCommand
          ? failureResult(
              "claude-code-command",
              "nonzero-exit",
              "Claude Code command exited with status 1",
              [],
              [],
            )
          : successResult("claude-code-command", { stdout: "[]" }, []),
      ),
      /cannot inspect Claude Code plugin state/,
    );
});

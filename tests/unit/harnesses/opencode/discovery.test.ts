import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { once } from "node:events";
import { inspectOpenCodeDiscovery } from "../../../../src/harnesses/opencode/discovery.ts";
import {
  nativeOpenCodeFixture,
  openCodeSandbox,
} from "../../../lib/harnesses/opencode/package-fixture.ts";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function writeSkill(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    "---\nname: using-superpowers\ndescription: fixture\n---\n",
  );
}

void test("discovery retains origins and separates the Manager alias from exact unmanaged identities", async (t) => {
  const state = openCodeSandbox(t);
  const local = nativeOpenCodeFixture(t);
  const unrelated = join(state.root, "superpowers-extra");
  writeJson(join(unrelated, "package.json"), { name: "superpowers-extra" });
  const config = join(state.paths.configRoot, "opencode.json");
  mkdirSync(state.paths.installedRoot, { recursive: true });
  writeJson(config, {
    plugin: [
      state.paths.installedRoot,
      "superpowers@git+https://github.com/obra/superpowers.git",
      local,
      unrelated,
    ],
  });

  const result = await inspectOpenCodeDiscovery(
    state.paths,
    state.env,
    state.root,
  );
  assert.deepEqual(
    result.documents.map((item) => item.document.path),
    [config],
  );
  assert.equal(result.managedEntries.length, 1);
  assert.equal(
    result.managedEntries[0]?.canonicalRoot.endsWith(
      "/config/opencode/superpowers-manager/installed",
    ),
    true,
  );
  assert.deepEqual(result.conflicts, [
    "registered OpenCode package for obra/superpowers",
    "registered local OpenCode package named superpowers",
  ]);
});

void test("plugin paths resolve from their origin while configured skill paths resolve from invocation cwd", async (t) => {
  const state = openCodeSandbox(t);
  const customDir = join(state.root, "custom");
  const plugin = join(customDir, "relative-plugin");
  const skill = join(
    state.root,
    "relative-skills",
    "using-superpowers",
    "SKILL.md",
  );
  writeJson(join(plugin, "package.json"), { name: "superpowers" });
  writeSkill(skill);
  const explicit = join(customDir, "extra.jsonc");
  writeJson(explicit, {
    plugin: ["./relative-plugin"],
    skills: { paths: ["relative-skills"] },
  });
  const result = await inspectOpenCodeDiscovery(
    state.paths,
    { ...state.env, OPENCODE_CONFIG: explicit },
    state.root,
  );
  assert.equal(
    result.conflicts.includes(
      "registered local OpenCode package named superpowers",
    ),
    true,
  );
  assert.equal(
    result.conflicts.includes(
      `configured OpenCode skill using-superpowers at ${skill}`,
    ),
    true,
  );
});

void test("qualified native and shared skill routes follow the released disable flags", async (t) => {
  const state = openCodeSandbox(t);
  const legacy = join(state.paths.configRoot, "plugins", "superpowers.js");
  mkdirSync(dirname(legacy), { recursive: true });
  symlinkSync(
    join(nativeOpenCodeFixture(t), ".opencode/plugins/superpowers.js"),
    legacy,
  );
  writeSkill(join(state.env.HOME!, ".agents/skills/superpowers/SKILL.md"));
  writeSkill(join(state.env.HOME!, ".claude/skills/superpowers/SKILL.md"));

  const active = await inspectOpenCodeDiscovery(
    state.paths,
    state.env,
    state.root,
  );
  assert.equal(active.conflicts.length, 3);
  const disabled = await inspectOpenCodeDiscovery(
    state.paths,
    {
      ...state.env,
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    },
    state.root,
  );
  assert.deepEqual(disabled.conflicts, [
    `native OpenCode plugin plugins at ${legacy}`,
  ]);
});

void test("unresolved ownership-bearing inline, remote, account, and managed inputs are blocked", async (t) => {
  const state = openCodeSandbox(t);
  writeJson(join(state.env.XDG_DATA_HOME!, "opencode/auth.json"), {
    "https://console.example": { type: "wellknown", key: "k", token: "secret" },
  });
  writeJson(
    join(state.env.OPENCODE_TEST_MANAGED_CONFIG_DIR!, "opencode.json"),
    {
      skills: { urls: ["https://example.test/skills"] },
    },
  );
  const result = await inspectOpenCodeDiscovery(
    state.paths,
    {
      ...state.env,
      OPENCODE_CONFIG_CONTENT:
        '{"plugin":["{env:UNKNOWN_PLUGIN}"],"provider":{"x":{"apiKey":"{env:UNRELATED}"}}}',
      OPENCODE_AUTH_CONTENT: '{"x":{"type":"wellknown","key":"k","token":"t"}}',
    },
    state.root,
  );
  assert.deepEqual(result.blockedInputs, [
    "OPENCODE_AUTH_CONTENT",
    "OPENCODE_CONFIG_CONTENT plugin[0]",
    "OpenCode auth well-known configuration",
    "OpenCode remote skill configuration",
  ]);
});

void test("WAL-only active organization evidence is detected without changing the native database files", async (t) => {
  const state = openCodeSandbox(t);
  const data = join(state.env.XDG_DATA_HOME!, "opencode");
  mkdirSync(data, { recursive: true });
  const path = join(data, "opencode.db");
  const writer = new DatabaseSync(path);
  t.after(() => writer.close());
  writer.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;" +
      "CREATE TABLE account(id TEXT PRIMARY KEY, email TEXT NOT NULL, url TEXT NOT NULL, access_token TEXT NOT NULL, refresh_token TEXT NOT NULL, token_expiry INTEGER);" +
      "CREATE TABLE account_state(id INTEGER PRIMARY KEY, active_account_id TEXT, active_org_id TEXT);" +
      "PRAGMA wal_checkpoint(TRUNCATE);",
  );
  writer.exec(
    "INSERT INTO account VALUES('acct','e','https://example.test','secret','refresh',NULL);" +
      "INSERT INTO account_state VALUES(1,'acct','org');",
  );
  const snapshot = () =>
    Object.fromEntries(
      readdirSync(data)
        .sort()
        .map((name) => {
          const file = join(data, name);
          const stat = statSync(file);
          return [
            name,
            {
              mode: stat.mode,
              size: stat.size,
              hash: createHash("sha256")
                .update(readFileSync(file))
                .digest("hex"),
            },
          ];
        }),
    );
  const before = snapshot();
  const result = await inspectOpenCodeDiscovery(
    state.paths,
    state.env,
    state.root,
  );
  assert.equal(
    result.blockedInputs.includes(
      "OpenCode active account remote configuration",
    ),
    true,
  );
  assert.deepEqual(snapshot(), before);
});

void test("an unrelated auth key named plugin and provider substitution do not block ownership", async (t) => {
  const state = openCodeSandbox(t);
  writeJson(join(state.env.XDG_DATA_HOME!, "opencode/auth.json"), {
    plugin: { type: "api", key: "secret" },
  });
  const result = await inspectOpenCodeDiscovery(
    state.paths,
    {
      ...state.env,
      UNRELATED_PLUGIN: "superpowers-extra",
      OPENCODE_CONFIG_CONTENT:
        '{"plugin":["{env:UNRELATED_PLUGIN}"],"provider":{"fixture":{"apiKey":"{env:UNRELATED}"}}}',
    },
    state.root,
  );
  assert.deepEqual(result.blockedInputs, []);
});

void test("raw environment expansion cannot inject an unmanaged Superpowers registration unnoticed", async (t) => {
  const state = openCodeSandbox(t);
  const result = await inspectOpenCodeDiscovery(
    state.paths,
    {
      ...state.env,
      INJECT: '"}},"plugin":["superpowers"],"tail":{"x":{"y":"',
      OPENCODE_CONFIG_CONTENT:
        '{"provider":{"fixture":{"apiKey":"{env:INJECT}"}}}',
    },
    state.root,
  );
  assert.equal(
    result.conflicts.includes(
      "registered OpenCode package for obra/superpowers",
    ),
    true,
  );
});

void test("account database movement during bounded capture is reported as unknown", async (t) => {
  const state = openCodeSandbox(t);
  const data = join(state.env.XDG_DATA_HOME!, "opencode");
  mkdirSync(data, { recursive: true });
  const path = join(data, "opencode.db");
  const writer = new DatabaseSync(path);
  writer.exec(
    "CREATE TABLE account(id TEXT PRIMARY KEY, email TEXT NOT NULL, url TEXT NOT NULL, access_token TEXT NOT NULL, refresh_token TEXT NOT NULL, token_expiry INTEGER);" +
      "CREATE TABLE account_state(id INTEGER PRIMARY KEY, active_account_id TEXT, active_org_id TEXT);",
  );
  writer.close();
  const child = spawn(
    process.execPath,
    [
      "-e",
      "const fs=require('node:fs');const p=process.argv[1];process.stdout.write('ready\\n');for(;;)fs.appendFileSync(p,'x')",
      path,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  await new Promise<void>((resolveReady, rejectReady) => {
    child.stdout.once("data", () => resolveReady());
    child.once("error", rejectReady);
  });
  let result;
  try {
    result = await inspectOpenCodeDiscovery(state.paths, state.env, state.root);
  } finally {
    child.kill("SIGKILL");
    await once(child, "close");
  }
  assert.equal(
    result.blockedInputs.some((item) =>
      item.startsWith("OpenCode account database "),
    ),
    true,
  );
});

void test("project discovery stops at the qualified Git worktree boundary", async (t) => {
  const state = openCodeSandbox(t);
  const outside = join(state.root, "outside");
  const worktree = join(outside, "repository");
  const cwd = join(worktree, "nested");
  writeSkill(join(outside, ".agents/skills/superpowers/SKILL.md"));
  mkdirSync(cwd, { recursive: true });
  execFileSync("git", ["init", "--quiet", worktree]);

  const result = await inspectOpenCodeDiscovery(state.paths, state.env, cwd);
  assert.equal(
    result.conflicts.some((item) => item.includes(`${outside}/.agents`)),
    false,
    JSON.stringify(result.conflicts),
  );
});

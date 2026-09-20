import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { once } from "node:events";
import { inspectOpenCodeDiscovery } from "../../../../src/harnesses/opencode/discovery.ts";
import { inspectOpenCodeOwnership } from "../../../../src/harnesses/opencode/state.ts";
import {
  nativeOpenCodeFixture,
  openCodeSandbox,
  writeOpenCodeArtifact,
} from "../../../lib/harnesses/opencode/package-fixture.ts";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function snapshotDirectory(directory: string) {
  return Object.fromEntries(
    readdirSync(directory)
      .sort()
      .map((name) => {
        const file = join(directory, name);
        const stat = statSync(file);
        return [
          name,
          {
            mode: stat.mode,
            size: stat.size,
            hash: createHash("sha256").update(readFileSync(file)).digest("hex"),
          },
        ];
      }),
  );
}

function writeSkill(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    "---\nname: using-superpowers\ndescription: fixture\n---\n",
  );
}

void test("duplicate routes to one global config retain one owned registration", async (t) => {
  const state = openCodeSandbox(t);
  const config = join(state.paths.configRoot, "opencode.json");
  mkdirSync(state.paths.installedRoot, { recursive: true });
  writeJson(config, { plugin: [state.paths.installedRoot] });

  const result = await inspectOpenCodeDiscovery(
    state.paths,
    {
      ...state.env,
      OPENCODE_CONFIG: config,
      OPENCODE_CONFIG_DIR: state.paths.configRoot,
    },
    state.root,
  );

  assert.deepEqual(
    result.documents.map((item) => item.document.path),
    [config],
  );
  assert.equal(result.managedEntries.length, 1);
  assert.deepEqual(result.blockedInputs, []);
});

void test("recognizes an owned plugins entry beside an unrelated plugin entry", async (t) => {
  const state = openCodeSandbox(t);
  const config = join(state.paths.configRoot, "opencode.json");
  mkdirSync(state.paths.installedRoot, { recursive: true });
  writeJson(config, {
    plugin: ["unrelated"],
    plugins: [state.paths.installedRoot],
  });

  const observed = await inspectOpenCodeDiscovery(
    state.paths,
    state.env,
    state.root,
  );
  assert.equal(observed.managedEntries.length, 1);
  assert.equal(observed.managedEntries[0]?.entry.key, "plugins");
  assert.deepEqual(observed.blockedInputs, []);
});

void test("a canonical config-directory alias retains native-writer ownership", async (t) => {
  const state = openCodeSandbox(t);
  const config = join(state.paths.configRoot, "opencode.json");
  await writeOpenCodeArtifact(t, state.paths.installedRoot);
  writeJson(config, { plugin: [state.paths.installedRoot] });
  const alias = join(state.root, "config-alias");
  symlinkSync(state.paths.configRoot, alias, "dir");
  const ctx = {
    ...state.ctx,
    env: { ...state.env, OPENCODE_CONFIG_DIR: alias },
  };

  const ownership = await inspectOpenCodeOwnership(ctx);

  assert.equal(ownership.outcome.ok, true);
  if (!ownership.outcome.ok) assert.fail("expected inspectable ownership");
  assert.equal(ownership.outcome.result.installEligibility.kind, "allowed");
  assert.equal(
    ownership.outcome.result.removalInput.registration?.observation.document
      .path,
    config,
  );
});

void test("a hard-linked custom config remains an unowned origin", async (t) => {
  const state = openCodeSandbox(t);
  const config = join(state.paths.configRoot, "opencode.json");
  const custom = join(state.root, "custom.json");
  mkdirSync(state.paths.installedRoot, { recursive: true });
  writeJson(config, { plugin: [state.paths.installedRoot] });
  linkSync(config, custom);

  const result = await inspectOpenCodeDiscovery(
    state.paths,
    { ...state.env, OPENCODE_CONFIG: custom },
    state.root,
  );

  assert.equal(result.managedEntries.length, 1);
  assert.deepEqual(result.blockedInputs, [
    `OpenCode Manager registration outside native global writer: ${custom}`,
  ]);
});

void test("duplicate reads refuse changed config observations", async (t) => {
  for (const change of ["bytes", "mode", "identity"] as const) {
    await t.test(change, async (t) => {
      const state = openCodeSandbox(t);
      const config = join(state.paths.configRoot, "opencode.json");
      const replaced = join(state.root, "replaced.json");
      mkdirSync(state.paths.installedRoot, { recursive: true });
      writeJson(config, { plugin: [state.paths.installedRoot] });
      const env = { ...state.env };
      Object.defineProperty(env, "OPENCODE_CONFIG", {
        enumerable: true,
        get() {
          if (change === "bytes") {
            writeJson(config, {
              plugin: [state.paths.installedRoot],
              theme: "changed",
            });
          } else if (change === "mode") {
            chmodSync(config, 0o600);
          } else {
            renameSync(config, replaced);
            writeJson(config, { plugin: [state.paths.installedRoot] });
          }
          return config;
        },
      });

      await assert.rejects(
        inspectOpenCodeDiscovery(state.paths, env, state.root),
        /OpenCode configuration changed during discovery/u,
      );
    });
  }
});

void test("duplicate registrations within one document remain ambiguous", async (t) => {
  const state = openCodeSandbox(t);
  const config = join(state.paths.configRoot, "opencode.json");
  mkdirSync(state.paths.installedRoot, { recursive: true });
  writeJson(config, {
    plugin: [state.paths.installedRoot, state.paths.installedRoot],
  });

  const result = await inspectOpenCodeDiscovery(
    state.paths,
    state.env,
    state.root,
  );

  assert.equal(result.documents.length, 1);
  assert.equal(result.managedEntries.length, 2);
});

void test("known upstream package forms are conflicts in files and inline config", async (t) => {
  const forms = [
    "superpowers@github:obra/superpowers",
    "github:obra/superpowers",
    "superpowers@https://GitHub.com/Obra/Superpowers/",
    "https://GitHub.com/Obra/Superpowers.git/#v1.2.3",
    "git@GitHub.com:Obra/Superpowers.git#main",
  ];
  for (const form of forms) {
    await t.test(form, async (t) => {
      const state = openCodeSandbox(t);
      writeJson(join(state.paths.configRoot, "opencode.json"), {
        plugin: [form],
      });
      const file = await inspectOpenCodeDiscovery(
        state.paths,
        state.env,
        state.root,
      );
      assert.deepEqual(file.conflicts, [
        "registered OpenCode package for obra/superpowers",
      ]);

      writeFileSync(join(state.paths.configRoot, "opencode.json"), "{}");
      const inline = await inspectOpenCodeDiscovery(
        state.paths,
        {
          ...state.env,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [form] }),
        },
        state.root,
      );
      assert.deepEqual(inline.conflicts, [
        "registered OpenCode package for obra/superpowers",
      ]);
    });
  }
});

void test("unknown exact superpowers package forms remain conflicts on both config routes", async (t) => {
  for (const spec of [
    "superpowers@unknown:source",
    "superpowers@1.2.3",
    "superpowers@latest",
    "npm:superpowers",
    "npm:superpowers@1.2.3",
  ]) {
    await t.test(spec, async (t) => {
      const state = openCodeSandbox(t);
      const config = join(state.paths.configRoot, "opencode.json");
      writeJson(config, { plugin: [spec] });
      const file = await inspectOpenCodeDiscovery(
        state.paths,
        state.env,
        state.root,
      );
      assert.deepEqual(file.conflicts, [
        `unresolved OpenCode package named superpowers at ${config} plugin[0]`,
      ]);
      assert.deepEqual(file.blockedInputs, []);
      assert.equal(file.registrationUncertain, false);
      writeFileSync(config, "{}");
      const inline = await inspectOpenCodeDiscovery(
        state.paths,
        {
          ...state.env,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [spec] }),
        },
        state.root,
      );
      assert.deepEqual(inline.conflicts, [
        "unresolved OpenCode package named superpowers at OPENCODE_CONFIG_CONTENT plugin[0]",
      ]);
      assert.deepEqual(inline.blockedInputs, []);
      assert.equal(inline.registrationUncertain, false);
    });
  }
});

void test("unrelated package names and pure-mode package specs remain inactive", async (t) => {
  const state = openCodeSandbox(t);
  const config = join(state.paths.configRoot, "opencode.json");
  writeJson(config, {
    plugin: [
      "superpowers-extra@github:obra/superpowers",
      "npm:superpowers-extra@1.2.3",
    ],
  });
  const unrelated = await inspectOpenCodeDiscovery(
    state.paths,
    state.env,
    state.root,
  );
  assert.deepEqual(unrelated.conflicts, []);
  assert.deepEqual(unrelated.blockedInputs, []);

  writeJson(config, { plugin: ["superpowers@unknown:source"] });
  const pure = await inspectOpenCodeDiscovery(
    state.paths,
    { ...state.env, OPENCODE_PURE: "1" },
    state.root,
  );
  assert.deepEqual(pure.conflicts, []);
  assert.deepEqual(pure.blockedInputs, [
    "OPENCODE_PURE disables OpenCode plugin activation",
  ]);
});

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

void test("discovery records canonical owned skill aliases without prefix matches", async (t) => {
  const state = openCodeSandbox(t);
  const ownedSkill = join(
    state.paths.installedRoot,
    "skills/using-superpowers/SKILL.md",
  );
  writeSkill(ownedSkill);
  const alias = join(state.root, "aliased-skills");
  symlinkSync(join(state.paths.installedRoot, "skills"), alias, "dir");
  writeJson(join(state.paths.configRoot, "opencode.json"), {
    skills: { paths: [alias] },
  });
  const owned = await inspectOpenCodeDiscovery(
    state.paths,
    state.env,
    state.root,
  );
  assert.deepEqual(owned.ownedActivationAliases, [realpathSync(ownedSkill)]);

  const directAlias = join(state.root, "direct-skill");
  symlinkSync(dirname(ownedSkill), directAlias, "dir");
  writeJson(join(state.paths.configRoot, "opencode.json"), {
    skills: { paths: [directAlias] },
  });
  const direct = await inspectOpenCodeDiscovery(
    state.paths,
    state.env,
    state.root,
  );
  assert.deepEqual(direct.ownedActivationAliases, [realpathSync(ownedSkill)]);

  const unrelatedRoot = `${state.paths.installedRoot}-copy`;
  const unrelatedSkill = join(
    unrelatedRoot,
    "skills/using-superpowers/SKILL.md",
  );
  writeSkill(unrelatedSkill);
  writeJson(join(state.paths.configRoot, "opencode.json"), {
    skills: { paths: [join(unrelatedRoot, "skills")] },
  });
  const unrelated = await inspectOpenCodeDiscovery(
    state.paths,
    state.env,
    state.root,
  );
  assert.deepEqual(unrelated.ownedActivationAliases, []);
  assert.equal(
    unrelated.conflicts.includes(
      `configured OpenCode skill using-superpowers at ${unrelatedSkill}`,
    ),
    true,
  );

  const arbitrary = join(state.root, "ordinary-custom-skill");
  writeSkill(join(arbitrary, "SKILL.md"));
  writeJson(join(state.paths.configRoot, "opencode.json"), {
    skills: { paths: [arbitrary] },
  });
  const ordinary = await inspectOpenCodeDiscovery(
    state.paths,
    state.env,
    state.root,
  );
  assert.deepEqual(ordinary.ownedActivationAliases, []);
  assert.deepEqual(ordinary.conflicts, []);
});

void test("discovery records native plugin symlinks by canonical owned target", async (t) => {
  const state = openCodeSandbox(t);
  const ownedPlugin = join(
    state.paths.installedRoot,
    ".opencode/plugins/superpowers.js",
  );
  mkdirSync(dirname(ownedPlugin), { recursive: true });
  writeFileSync(ownedPlugin, "export default {}\n");
  const alias = join(state.paths.homeDir, ".opencode/plugin/superpowers.js");
  mkdirSync(dirname(alias), { recursive: true });
  symlinkSync(ownedPlugin, alias);

  const result = await inspectOpenCodeDiscovery(
    state.paths,
    state.env,
    state.root,
  );
  assert.deepEqual(result.ownedActivationAliases, [realpathSync(ownedPlugin)]);
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
  const before = snapshotDirectory(data);
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
  assert.deepEqual(snapshotDirectory(data), before);
});

void test("a short write while copying the WAL still detects WAL-only active account state", async (t) => {
  const state = openCodeSandbox(t);
  const data = join(state.env.XDG_DATA_HOME!, "opencode");
  mkdirSync(data, { recursive: true });
  const writer = new DatabaseSync(join(data, "opencode.db"));
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
  const probe = await open(join(data, "opencode.db"), "r");
  const fileHandle = Object.getPrototypeOf(probe) as {
    write: (
      this: unknown,
      buffer: Buffer,
      ...rest: unknown[]
    ) => Promise<unknown>;
  };
  await probe.close();
  const write = fileHandle.write;
  let shortened = false;
  t.mock.method(
    fileHandle,
    "write",
    function (this: unknown, buffer: Buffer, ...rest: unknown[]) {
      // Shorten the first WAL-copy write once; the WAL header magic is 0x377f068x.
      if (
        !shortened &&
        (rest[0] ?? 0) === 0 &&
        buffer.length > 1 &&
        buffer.readUInt32BE(0) >>> 1 === 0x377f0682 >>> 1
      ) {
        shortened = true;
        return write.call(this, buffer, 0, buffer.length >> 1);
      }
      return write.call(this, buffer, ...rest);
    },
  );
  const result = await inspectOpenCodeDiscovery(
    state.paths,
    state.env,
    state.root,
  );
  assert.equal(shortened, true);
  assert.deepEqual(result.blockedInputs, [
    "OpenCode active account remote configuration",
  ]);
});

void test("a database and WAL larger than 16 MiB with inactive account state do not block", async (t) => {
  const state = openCodeSandbox(t);
  const data = join(state.env.XDG_DATA_HOME!, "opencode");
  mkdirSync(data, { recursive: true });
  const writer = new DatabaseSync(join(data, "opencode.db"));
  t.after(() => writer.close());
  const junkRows = (count: number) =>
    `INSERT INTO junk SELECT randomblob(1048576) FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<${count}) SELECT x FROM c);`;
  writer.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;" +
      "CREATE TABLE account(id TEXT PRIMARY KEY, email TEXT NOT NULL, url TEXT NOT NULL, access_token TEXT NOT NULL, refresh_token TEXT NOT NULL, token_expiry INTEGER);" +
      "CREATE TABLE account_state(id INTEGER PRIMARY KEY, active_account_id TEXT, active_org_id TEXT);" +
      "CREATE TABLE junk(b BLOB);" +
      junkRows(20) +
      "PRAGMA wal_checkpoint(TRUNCATE);",
  );
  writer.exec("INSERT INTO account_state VALUES(1,NULL,NULL);" + junkRows(4));
  assert.ok(statSync(join(data, "opencode.db")).size > 16 * 1024 * 1024);
  assert.ok(statSync(join(data, "opencode.db-wal")).size > 1024 * 1024);
  const before = snapshotDirectory(data);
  const result = await inspectOpenCodeDiscovery(
    state.paths,
    state.env,
    state.root,
  );
  assert.deepEqual(result.blockedInputs, []);
  assert.deepEqual(snapshotDirectory(data), before);
});

void test("an account database that is not SQLite is reported as unknown", async (t) => {
  const state = openCodeSandbox(t);
  const data = join(state.env.XDG_DATA_HOME!, "opencode");
  mkdirSync(data, { recursive: true });
  const path = join(data, "opencode.db");
  writeFileSync(path, "not a database");
  const result = await inspectOpenCodeDiscovery(
    state.paths,
    state.env,
    state.root,
  );
  assert.deepEqual(result.blockedInputs, [`OpenCode account database ${path}`]);
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

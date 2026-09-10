import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { codexPaths } from "../../../../src/harnesses/codex/paths.ts";
import { readCodexMarketplace } from "../../../../src/harnesses/codex/marketplace.ts";
import { beginCodexRecovery } from "../../../../src/harnesses/codex/recovery.ts";
import { caseEnvVars } from "../../../bin/command-context.ts";
import {
  createCase,
  readLog,
  runScript,
  type CaseEnv,
} from "../../../bin/lifecycle-fixture.ts";

const EMPTY_PLUGINS = '{"installed":[],"available":[]}\n';
const EMPTY_MARKETPLACES = '{"marketplaces":[]}\n';
const DURABLE_ENV = { SUPERPOWERS_PLUGIN_ROOT: "" };

function lifecycleCase(): CaseEnv {
  const c = createCase({ fakes: "install" });
  writeFileSync(join(c.state, "plugin_list.json"), EMPTY_PLUGINS);
  writeFileSync(join(c.state, "marketplace_list.json"), EMPTY_MARKETPLACES);
  return c;
}

function paths(c: CaseEnv) {
  return codexPaths({ HOME: c.home }, process.cwd());
}

function preparedCommit(c: CaseEnv): string {
  const value = JSON.parse(
    readFileSync(
      join(paths(c).preparedRoot, ".superpowers-upstream.json"),
      "utf8",
    ),
  ) as { commit: string };
  return value.commit;
}

async function runDurable(
  c: CaseEnv,
  command: "install" | "update" | "prepare" | "probe",
  args: string[] = [],
) {
  return await runScript(c, command, {
    args,
    env: DURABLE_ENV,
  });
}

async function installCurrent(c: CaseEnv): Promise<void> {
  const result = await runDurable(c, "install");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    new RegExp(`^installed_commit=${preparedCommit(c)}$`, "m"),
  );
  assert.ok(await readCodexMarketplace(paths(c).marketplaceRoot));
}

function makeLegacy(c: CaseEnv, empty = false): void {
  const p = paths(c);
  const source = join(c.pkg, "plugins", "superpowers");
  rmSync(source, { recursive: true, force: true });
  if (empty) mkdirSync(source, { recursive: true });
  else cpSync(p.publishedPluginRoot, source, { recursive: true });
  writeFileSync(join(c.pkg, "legacy-source-marker"), "preserve\n");
  writeFileSync(
    join(c.state, "marketplace_list.json"),
    `${JSON.stringify({
      marketplaces: [{ name: "superpowers-manager", root: c.pkg }],
    })}\n`,
  );
  rmSync(p.marketplaceRoot, { recursive: true, force: true });
  writeFileSync(c.codexLog, "");
}

type TreeEntry = {
  readonly kind: "directory" | "file" | "symlink";
  readonly bytes?: string;
  readonly target?: string;
};

function treeSnapshot(root: string): Record<string, TreeEntry> {
  const result: Record<string, TreeEntry> = {};
  const visit = (path: string): void => {
    const key = relative(root, path) || ".";
    const info = lstatSync(path);
    if (info.isSymbolicLink()) {
      result[key] = { kind: "symlink", target: readFileSync(path, "utf8") };
      return;
    }
    if (info.isDirectory()) {
      result[key] = { kind: "directory" };
      for (const name of readdirSync(path).sort()) visit(join(path, name));
      return;
    }
    result[key] = {
      kind: "file",
      bytes: readFileSync(path).toString("base64"),
    };
  };
  visit(root);
  return result;
}

void test("unchanged-commit legacy source invokes durable installation and preserves the source", async () => {
  const c = lifecycleCase();
  await installCurrent(c);
  makeLegacy(c);
  const result = await runDurable(c, "install");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const log = readLog(c.codexLog);
  assert.ok(log.includes("plugin marketplace remove superpowers-manager"));
  assert.ok(log.includes(`plugin marketplace add ${paths(c).marketplaceRoot}`));
  assert.ok(log.includes("plugin add superpowers@superpowers-manager"));
  assert.equal(
    readFileSync(join(c.pkg, "legacy-source-marker"), "utf8"),
    "preserve\n",
  );
});

void test("an empty legacy source reaches repair instead of a fingerprint dead end", async () => {
  const c = lifecycleCase();
  await installCurrent(c);
  makeLegacy(c, true);
  const result = await runDurable(c, "update");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(
    readLog(c.codexLog).includes(
      `plugin marketplace add ${paths(c).marketplaceRoot}`,
    ),
  );
  assert.ok(await readCodexMarketplace(paths(c).marketplaceRoot));
  assert.equal(existsSync(join(c.pkg, "plugins", "superpowers")), true);
});

void test("no-subcommand CLI invocation takes the same legacy migration path", async () => {
  const c = lifecycleCase();
  await installCurrent(c);
  makeLegacy(c);
  const env = caseEnvVars(c, DURABLE_ENV) as Record<string, string>;
  const child = spawn(process.execPath, [join(c.pkg, "src", "cli.ts")], {
    env,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const [code, signal] = (await once(child, "close")) as [
    number | null,
    NodeJS.Signals | null,
  ];
  assert.equal(signal, null);
  assert.equal(code, 0, stdout + stderr);
  assert.ok(
    readLog(c.codexLog).includes(
      `plugin marketplace add ${paths(c).marketplaceRoot}`,
    ),
  );
});

void test("probe is byte-for-byte read-only and keeps porcelain keys stable", async () => {
  const c = lifecycleCase();
  await installCurrent(c);
  const before = treeSnapshot(c.home);
  const result = await runDurable(c, "probe", ["--porcelain"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(treeSnapshot(c.home), before);
  assert.deepEqual(
    result.stdout
      .trimEnd()
      .split("\n")
      .map((line) => line.slice(0, line.indexOf("="))),
    [
      "harness",
      "requested_ref",
      "resolved_ref",
      "desired_commit",
      "generated_commit",
      "installed_commit",
      "identity_state",
      "status",
      "selection_origin",
      "selection_mode",
      "upstream_source_origin",
      "effective_source",
      "saved_mode",
      "saved_source",
      "saved_requested_ref",
      "saved_resolved_ref",
      "saved_commit",
      "update_control",
      "installation_state",
      "resource_state",
      "compatibility",
      "compatibility_reason",
    ],
  );
  assert.match(
    result.stdout,
    new RegExp(`^installed_commit=${preparedCommit(c)}$`, "m"),
  );
  assert.doesNotMatch(
    result.stdout,
    /^installed_commit=(?:[a-f0-9]{64}|.*Codex marketplace.*)$/m,
  );
});

void test("prepare leaves published and native state untouched", async () => {
  const c = lifecycleCase();
  await installCurrent(c);
  const p = paths(c);
  const beforeMarketplace = treeSnapshot(p.marketplaceRoot);
  const beforeActive = treeSnapshot(join(c.state, "codex-home"));
  const beforePluginList = readFileSync(join(c.state, "plugin_list.json"));
  const beforeMarketplaceList = readFileSync(
    join(c.state, "marketplace_list.json"),
  );
  const result = await runDurable(c, "prepare");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(treeSnapshot(p.marketplaceRoot), beforeMarketplace);
  assert.deepEqual(treeSnapshot(join(c.state, "codex-home")), beforeActive);
  assert.deepEqual(
    readFileSync(join(c.state, "plugin_list.json")),
    beforePluginList,
  );
  assert.deepEqual(
    readFileSync(join(c.state, "marketplace_list.json")),
    beforeMarketplaceList,
  );
});

void test("invalid saved selection fails before native access", async () => {
  const c = lifecycleCase();
  const config = join(c.home, ".config", "superpowers-manager");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "selection.json"), "{\n");
  const result = await runDurable(c, "install");
  assert.equal(result.status, 1);
  assert.deepEqual(readLog(c.codexLog), []);
});

void test("unresolved recovery blocks prepare, install, and update", async () => {
  const c = lifecycleCase();
  await installCurrent(c);
  const p = paths(c);
  const old = await readCodexMarketplace(p.marketplaceRoot);
  assert.ok(old);
  await beginCodexRecovery(p, {
    marketplaceRoot: p.marketplaceRoot,
    priorNative: {
      marketplaceRoot: p.marketplaceRoot,
      pluginPresent: true,
      pluginEnabled: true,
      activeVersion: "1.0.0",
      activeRoot: join(
        c.state,
        "codex-home/plugins/cache/superpowers-manager/superpowers/1.0.0",
      ),
    },
    oldDigest: old.digest,
    oldIdentity: { dev: old.dev, ino: old.ino },
  });
  for (const command of ["prepare", "install", "update"] as const) {
    writeFileSync(c.codexLog, "");
    const result = await runDurable(c, command);
    assert.equal(
      result.status,
      1,
      `${command}: ${result.stdout}${result.stderr}`,
    );
    assert.match(result.stdout + result.stderr, /recovery/i);
    const native = readLog(c.codexLog);
    if (command === "prepare") assert.deepEqual(native, []);
    else
      assert.equal(
        native.every((line) => line.endsWith("list --json")),
        true,
        `${command} must stop before native mutation: ${native.join("\n")}`,
      );
  }
});

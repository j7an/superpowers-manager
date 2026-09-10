import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { successResult } from "../../../../src/adapter-result.ts";
import {
  codexInspect,
  codexInstall,
  codexReadNativeState,
  type CodexNativeState,
} from "../../../../src/harnesses/codex/adapter.ts";
import { codexPaths } from "../../../../src/harnesses/codex/paths.ts";
import { stageCodexMarketplace } from "../../../../src/harnesses/codex/marketplace.ts";
import { inspectCodexInstallation } from "../../../../src/harnesses/codex/state.ts";
import { writeQualifiedCodexFixture } from "../../../lib/harnesses/codex/prepared-fixture.ts";
import { nativeSelection } from "../../../lib/harnesses/pi/package-fixture.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const FAKE_CODEX = fileURLToPath(
  new URL("../../helpers/harnesses/codex/fake.sh", import.meta.url),
);
const COMMIT = "d884ae04edebef577e82ff7c4e143debd0bbec99";
const SOURCE = "https://example.invalid/superpowers.git";

async function sandbox(t: import("node:test").TestContext) {
  const root = await mkdtemp(join(tmpdir(), "spw-codex-durable-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = join(root, "commands.log");
  await writeFile(log, "");
  return { root, log };
}

async function adapterSandbox(t: import("node:test").TestContext) {
  const fixture = await sandbox(t);
  const codexHome = join(fixture.root, "codex");
  const packageRoot = join(fixture.root, "package");
  await Promise.all([mkdir(codexHome), mkdir(packageRoot)]);
  return {
    ...fixture,
    codexHome,
    packageRoot,
    async commands(): Promise<string[]> {
      return (await readFile(fixture.log, "utf8")).split("\n").filter(Boolean);
    },
    env(extra: Record<string, string>) {
      return {
        SUPERPOWERS_CODEX: FAKE_CODEX,
        FAKE_CODEX_LOG: fixture.log,
        ...extra,
      };
    },
  };
}

async function seedMissingStoredState(
  fixture: Awaited<ReturnType<typeof adapterSandbox>>,
  extra = "",
): Promise<string> {
  const missingSource = join(fixture.root, "missing-manager-source");
  await writeFile(
    join(fixture.codexHome, "config.toml"),
    [
      '[marketplaces."superpowers-manager"]',
      'source_type = "local"',
      `source = ${JSON.stringify(missingSource)}`,
      '[plugins."superpowers@superpowers-manager"]',
      "enabled = true",
      extra,
      "",
    ].join("\n"),
  );
  return missingSource;
}

function listings(version = "1.0.0") {
  return {
    FAKE_CODEX_PLUGIN_LIST: JSON.stringify({
      installed: [
        {
          pluginId: "superpowers@superpowers-manager",
          installed: true,
          enabled: true,
          version,
        },
      ],
    }),
    FAKE_CODEX_MARKETPLACE_LIST: JSON.stringify({
      marketplaces: [{ name: "superpowers-manager", root: "/marketplace" }],
    }),
  };
}

void test("native observation uses CODEX_HOME for its active cache root", async (t) => {
  const fixture = await sandbox(t);
  const codexHome = join(fixture.root, "codex-home");
  const result = await codexReadNativeState({
    root: PACKAGE_ROOT,
    env: {
      SUPERPOWERS_CODEX: FAKE_CODEX,
      CODEX_HOME: codexHome,
      FAKE_CODEX_LOG: fixture.log,
      ...listings("1.2.3"),
    },
  });
  assert.equal(result.outcome.ok, true, JSON.stringify(result));
  if (!result.outcome.ok) assert.fail("expected native observation");
  assert.deepEqual(result.outcome.result, {
    marketplaceRoot: "/marketplace",
    pluginPresent: true,
    pluginEnabled: true,
    activeVersion: "1.2.3",
    activeRoot: join(
      codexHome,
      "plugins/cache/superpowers-manager/superpowers/1.2.3",
    ),
  });
});

void test("native observation preserves explicit inspection-root precedence", async (t) => {
  const fixture = await sandbox(t);
  const inspectionRoot = join(fixture.root, "inspection-root");
  const result = await codexReadNativeState({
    root: PACKAGE_ROOT,
    env: {
      SUPERPOWERS_CODEX: FAKE_CODEX,
      CODEX_HOME: join(fixture.root, "codex-home"),
      SUPERPOWERS_INSTALLED_SEARCH_ROOT: inspectionRoot,
      FAKE_CODEX_LOG: fixture.log,
      ...listings(),
    },
  });
  assert.equal(result.outcome.ok, true, JSON.stringify(result));
  if (!result.outcome.ok) assert.fail("expected native observation");
  assert.equal(
    result.outcome.result.activeRoot,
    join(inspectionRoot, "plugins/cache/superpowers-manager/superpowers/1.0.0"),
  );
});

void test("native observation resolves a relative CODEX_HOME from the invocation cwd", async (t) => {
  const fixture = await sandbox(t);
  const relativeHome = join(
    "relative-codex-homes",
    fixture.root.slice(fixture.root.lastIndexOf("/") + 1),
  );
  const result = await codexReadNativeState({
    root: join(fixture.root, "package-root"),
    env: {
      SUPERPOWERS_CODEX: FAKE_CODEX,
      CODEX_HOME: relativeHome,
      FAKE_CODEX_LOG: fixture.log,
      ...listings("1.2.3"),
    },
  });
  assert.equal(result.outcome.ok, true, JSON.stringify(result));
  if (!result.outcome.ok) assert.fail("expected native observation");
  assert.equal(
    result.outcome.result.activeRoot,
    join(
      process.cwd(),
      relativeHome,
      "plugins/cache/superpowers-manager/superpowers/1.2.3",
    ),
  );
});

void test("native observation fails closed for malformed, ambiguous, and failed listings", async (t) => {
  const fixture = await sandbox(t);
  const cases = [
    {
      name: "malformed plugin listing",
      env: { ...listings(), FAKE_CODEX_PLUGIN_LIST: "{" },
      message: "cannot parse output",
    },
    {
      name: "duplicate manager marketplace",
      env: {
        ...listings(),
        FAKE_CODEX_MARKETPLACE_LIST: JSON.stringify({
          marketplaces: [
            { name: "superpowers-manager", root: "/one" },
            { name: "superpowers-manager", root: "/two" },
          ],
        }),
      },
      message: "cannot parse output",
    },
    {
      name: "duplicate manager plugin",
      env: {
        ...listings(),
        FAKE_CODEX_PLUGIN_LIST: JSON.stringify({
          installed: [
            {
              pluginId: "superpowers@superpowers-manager",
              installed: true,
              enabled: true,
              version: "1.0.0",
            },
            {
              pluginId: "superpowers@superpowers-manager",
              installed: true,
              enabled: true,
              version: "1.0.1",
            },
          ],
        }),
      },
      message: "manager plugin appears more than once",
    },
    {
      name: "listing command failure",
      env: { SUPERPOWERS_CODEX: "/usr/bin/false" },
      message: "cannot list Codex plugins",
    },
    {
      name: "marketplace listing command failure",
      env: { ...listings(), FAKE_CODEX_FAIL_MARKETPLACE_LIST: "1" },
      message: "cannot list Codex marketplaces",
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const result = await codexReadNativeState({
        root: PACKAGE_ROOT,
        env: {
          SUPERPOWERS_CODEX: FAKE_CODEX,
          FAKE_CODEX_LOG: fixture.log,
          ...entry.env,
        },
      });
      assert.equal(result.outcome.ok, false);
      assert.match(
        result.outcome.error?.message ?? "",
        new RegExp(entry.message),
      );
    });
  }
});

void test("native observation names the plugin listing when its typed parse fails", async (t) => {
  const fixture = await sandbox(t);
  const result = await codexReadNativeState({
    root: PACKAGE_ROOT,
    env: {
      SUPERPOWERS_CODEX: FAKE_CODEX,
      FAKE_CODEX_LOG: fixture.log,
      ...listings(),
      FAKE_CODEX_PLUGIN_LIST: "{",
    },
  });
  assert.equal(result.outcome.ok, false, JSON.stringify(result));
  assert.equal(
    result.outcome.error?.message,
    `cannot parse output of '${FAKE_CODEX} plugin list --json'`,
  );
});

void test("native observation falls back to stored configured and cache presence after a native listing failure", async (t) => {
  const fixture = await sandbox(t);
  const codexHome = join(fixture.root, "codex-home");
  const missingSource = join(fixture.root, "missing-source");
  await mkdir(
    join(codexHome, "plugins/cache/superpowers-manager/superpowers/1.2.3"),
    { recursive: true },
  );
  await writeFile(
    join(codexHome, "config.toml"),
    [
      '[marketplaces."superpowers-manager"]',
      'source_type = "local"',
      `source = ${JSON.stringify(missingSource)}`,
      '[plugins."superpowers@superpowers-manager"]',
      "enabled = true",
      "",
    ].join("\n"),
  );
  const before = await import("node:fs/promises").then(({ readFile }) =>
    readFile(join(codexHome, "config.toml")),
  );
  const result = await codexReadNativeState({
    root: PACKAGE_ROOT,
    env: {
      SUPERPOWERS_CODEX: FAKE_CODEX,
      CODEX_HOME: codexHome,
      FAKE_CODEX_LOG: fixture.log,
      FAKE_CODEX_FAIL_PLUGIN_LIST: "1",
      FAKE_CODEX_PLUGIN_LIST: "unused",
      FAKE_CODEX_MARKETPLACE_LIST: "unused",
    },
  });
  assert.equal(result.outcome.ok, true, JSON.stringify(result));
  assert.deepEqual(result.outcome.result, {
    marketplaceRoot: missingSource,
    pluginPresent: true,
    pluginEnabled: true,
    activeVersion: null,
    activeRoot: null,
  });
  assert.deepEqual(
    await import("node:fs/promises").then(({ readFile }) =>
      readFile(join(codexHome, "config.toml")),
    ),
    before,
  );
});

void test("native observation validates successful plugin output before a later marketplace failure can fall back", async (t) => {
  for (const [name, pluginList, message] of [
    ["malformed", "{", "cannot parse output"],
    [
      "duplicate manager",
      JSON.stringify({
        installed: [
          {
            pluginId: "superpowers@superpowers-manager",
            installed: true,
            enabled: true,
            version: "1.0.0",
          },
          {
            pluginId: "superpowers@superpowers-manager",
            installed: true,
            enabled: true,
            version: "1.0.1",
          },
        ],
      }),
      "Codex manager plugin appears more than once",
    ],
  ] as const) {
    await t.test(name, async () => {
      const fixture = await sandbox(t);
      const codexHome = join(fixture.root, "codex-home");
      await mkdir(codexHome);
      await writeFile(
        join(codexHome, "config.toml"),
        [
          '[marketplaces."superpowers-manager"]',
          'source_type = "local"',
          `source = ${JSON.stringify(join(fixture.root, "missing-source"))}`,
          "",
        ].join("\n"),
      );
      const result = await codexReadNativeState({
        root: PACKAGE_ROOT,
        env: {
          SUPERPOWERS_CODEX: FAKE_CODEX,
          CODEX_HOME: codexHome,
          FAKE_CODEX_LOG: fixture.log,
          FAKE_CODEX_PLUGIN_LIST: pluginList,
          FAKE_CODEX_MARKETPLACE_LIST: "unused",
          FAKE_CODEX_FAIL_MARKETPLACE_LIST: "1",
        },
      });
      assert.equal(result.outcome.ok, false, JSON.stringify(result));
      assert.match(result.outcome.error?.message ?? "", new RegExp(message));
    });
  }
});

void test("ownership inspection falls back after native failure and preserves stored legacy and unmanaged conflicts", async (t) => {
  const fixture = await adapterSandbox(t);
  const legacySource = join(fixture.root, "missing-legacy-source");
  await seedMissingStoredState(
    fixture,
    [
      '[marketplaces."superpowers-wrapper"]',
      'source_type = "local"',
      `source = ${JSON.stringify(legacySource)}`,
      '[plugins."superpowers@superpowers-wrapper"]',
      "enabled = true",
      '[plugins."superpowers@another-provider"]',
      "enabled = true",
    ].join("\n"),
  );
  await mkdir(
    join(
      fixture.codexHome,
      "plugins/cache/superpowers-manager/superpowers/1.0.0",
    ),
    { recursive: true },
  );
  const result = await codexInspect("ownership", {
    root: PACKAGE_ROOT,
    env: fixture.env({
      CODEX_HOME: fixture.codexHome,
      HOME: fixture.root,
      FAKE_CODEX_FAIL_PLUGIN_LIST: "1",
      FAKE_CODEX_PLUGIN_LIST: "unused",
      FAKE_CODEX_MARKETPLACE_LIST: "unused",
    }),
  });
  assert.equal(result.outcome.ok, true, JSON.stringify(result.outcome));
  assert.deepEqual(result.outcome.result, {
    view: "ownership",
    resources: { plugin: true, marketplace: true },
    legacy_resources: { plugin: false, marketplace: true },
    identity_state: "both",
    conflicts: [
      "Codex plugin superpowers@another-provider has indeterminate activity",
    ],
  });
  assert.deepEqual(await fixture.commands(), ["plugin list --json"]);
});

void test("ownership validates successful malformed plugin output before a later marketplace failure can fall back", async (t) => {
  const fixture = await adapterSandbox(t);
  await seedMissingStoredState(fixture);
  const result = await codexInspect("ownership", {
    root: PACKAGE_ROOT,
    env: fixture.env({
      CODEX_HOME: fixture.codexHome,
      HOME: fixture.root,
      FAKE_CODEX_PLUGIN_LIST: "{",
      FAKE_CODEX_MARKETPLACE_LIST: "unused",
      FAKE_CODEX_FAIL_MARKETPLACE_LIST: "1",
    }),
  });
  assert.equal(result.outcome.ok, false, JSON.stringify(result.outcome));
  assert.equal(
    result.outcome.error?.message,
    `cannot parse output of '${FAKE_CODEX} plugin list --json'`,
  );
  assert.deepEqual(await fixture.commands(), ["plugin list --json"]);
});

void test("install uses missing-source stored registration after its native marketplace listing fails", async (t) => {
  const fixture = await adapterSandbox(t);
  await seedMissingStoredState(fixture);
  const result = await codexInstall(fixture.packageRoot, {
    root: PACKAGE_ROOT,
    env: fixture.env({
      CODEX_HOME: fixture.codexHome,
      HOME: fixture.root,
      FAKE_CODEX_FAIL_MARKETPLACE_LIST: "1",
      FAKE_CODEX_PLUGIN_LIST: "unused",
      FAKE_CODEX_MARKETPLACE_LIST: "unused",
    }),
  });
  assert.equal(result.outcome.ok, true, JSON.stringify(result.outcome));
  assert.deepEqual(await fixture.commands(), [
    "plugin marketplace list --json",
    "plugin marketplace remove superpowers-manager",
    `plugin marketplace add ${fixture.packageRoot}`,
    "plugin add superpowers@superpowers-manager",
  ]);
});

async function durableFixture(t: import("node:test").TestContext) {
  const fixture = await sandbox(t);
  const paths = codexPaths(
    { CODEX_HOME: join(fixture.root, "codex") },
    fixture.root,
  );
  const packageRoot = join(fixture.root, "package");
  await mkdir(join(packageRoot, ".agents", "plugins"), { recursive: true });
  await writeFile(
    join(packageRoot, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({
      plugins: [
        {
          name: "superpowers",
          source: { source: "local", path: "./plugins/superpowers" },
        },
      ],
    }),
  );
  const preparedRoot = join(fixture.root, "prepared");
  const artifact = await writeQualifiedCodexFixture(
    preparedRoot,
    COMMIT,
    SOURCE,
  );
  await mkdir(paths.managerRoot, { recursive: true });
  await stageCodexMarketplace(artifact, packageRoot, paths.marketplaceRoot);
  return { ...fixture, paths, selection: nativeSelection(COMMIT, SOURCE) };
}

function native(
  paths: ReturnType<typeof codexPaths>,
  overrides: Partial<CodexNativeState> = {},
): CodexNativeState {
  return {
    marketplaceRoot: paths.marketplaceRoot,
    pluginPresent: true,
    pluginEnabled: true,
    activeVersion: "1.0.0",
    activeRoot: join(
      paths.codexHome,
      "plugins/cache/superpowers-manager/superpowers/1.0.0",
    ),
    ...overrides,
  };
}

async function nativeResult(value: CodexNativeState) {
  return successResult("native-state", value, []);
}

void test("inspection classifies an inspectable legacy source as mismatch without reading its cache", async (t) => {
  const fixture = await durableFixture(t);
  const active = native(fixture.paths);
  await mkdir(join(active.activeRoot!, ".."), { recursive: true });
  await cp(fixture.paths.publishedPluginRoot, active.activeRoot!, {
    recursive: true,
  });
  await rm(fixture.paths.marketplaceRoot, { recursive: true });
  const legacy = native(fixture.paths, {
    marketplaceRoot: join(fixture.root, "missing-old-extraction"),
    activeRoot: active.activeRoot,
  });
  const result = await inspectCodexInstallation(
    fixture.selection,
    { root: fixture.root, env: { CODEX_HOME: fixture.paths.codexHome } },
    () => nativeResult(legacy),
  );
  assert.equal(result.outcome.ok, true, JSON.stringify(result));
  if (!result.outcome.ok) assert.fail("expected inspectable migration state");
  assert.deepEqual(result.outcome.result, {
    kind: "mismatch",
    observedIdentity: COMMIT,
  });
  assert.match(
    result.outcome.messages.at(-1)?.text ?? "",
    /legacy Codex marketplace source/,
  );
});

void test("inspection reports absence when neither native manager resource exists", async (t) => {
  const fixture = await durableFixture(t);
  const absent = native(fixture.paths, {
    marketplaceRoot: null,
    pluginPresent: false,
    pluginEnabled: false,
    activeVersion: null,
    activeRoot: null,
  });
  for (const [name, removeDurable] of [
    ["valid durable marketplace remains", false],
    ["durable marketplace is missing", true],
  ] as const) {
    await t.test(name, async () => {
      if (removeDurable)
        await rm(fixture.paths.marketplaceRoot, { recursive: true });
      const result = await inspectCodexInstallation(
        fixture.selection,
        { root: fixture.root, env: { CODEX_HOME: fixture.paths.codexHome } },
        () => nativeResult(absent),
      );
      assert.equal(result.outcome.ok, true, JSON.stringify(result));
      if (!result.outcome.ok) assert.fail("expected absent inspection");
      assert.deepEqual(result.outcome.result, {
        kind: "absent",
        observedIdentity: "",
      });
    });
  }
});

void test("native absence and legacy migration outrank a stale durable selection", async (t) => {
  const fixture = await durableFixture(t);
  const stale = nativeSelection(
    "a".repeat(40),
    "https://example.invalid/stale-selection.git",
  );
  const absent = native(fixture.paths, {
    marketplaceRoot: null,
    pluginPresent: false,
    pluginEnabled: false,
    activeVersion: null,
    activeRoot: null,
  });
  const absentResult = await inspectCodexInstallation(
    stale,
    { root: fixture.root, env: { CODEX_HOME: fixture.paths.codexHome } },
    () => nativeResult(absent),
  );
  assert.equal(absentResult.outcome.ok, true, JSON.stringify(absentResult));
  if (!absentResult.outcome.ok) assert.fail("expected absent inspection");
  assert.deepEqual(absentResult.outcome.result, {
    kind: "absent",
    observedIdentity: "",
  });

  const legacy = native(fixture.paths, {
    marketplaceRoot: join(fixture.root, "legacy-marketplace"),
    activeRoot: join(fixture.root, "legacy-cache"),
  });
  const legacyResult = await inspectCodexInstallation(
    stale,
    { root: fixture.root, env: { CODEX_HOME: fixture.paths.codexHome } },
    () => nativeResult(legacy),
  );
  assert.equal(legacyResult.outcome.ok, true, JSON.stringify(legacyResult));
  if (!legacyResult.outcome.ok) assert.fail("expected migration inspection");
  assert.deepEqual(legacyResult.outcome.result, {
    kind: "mismatch",
    observedIdentity: "",
  });
});

void test("inspection classifies disabled and missing active manager payloads as repairable mismatches", async (t) => {
  const fixture = await durableFixture(t);
  for (const [name, observed] of [
    ["disabled plugin", native(fixture.paths, { pluginEnabled: false })],
    ["missing active cache", native(fixture.paths)],
  ] as const) {
    await t.test(name, async () => {
      const result = await inspectCodexInstallation(
        fixture.selection,
        { root: fixture.root, env: { CODEX_HOME: fixture.paths.codexHome } },
        () => nativeResult(observed),
      );
      assert.equal(result.outcome.ok, true, JSON.stringify(result));
      if (!result.outcome.ok) assert.fail("expected repairable inspection");
      assert.equal(result.outcome.result.kind, "mismatch");
    });
  }
});

void test("inspection fails for an uninspectable active payload", async (t) => {
  const fixture = await durableFixture(t);
  const active = native(fixture.paths, { activeRoot: "/dev/null" });
  const result = await inspectCodexInstallation(
    fixture.selection,
    { root: fixture.root, env: { CODEX_HOME: fixture.paths.codexHome } },
    () => nativeResult(active),
  );
  assert.equal(result.outcome.ok, false);
  assert.match(
    result.outcome.error?.message ?? "",
    /active Codex plugin payload/,
  );
});

void test("inspection requires durable and active assessed payloads before current", async (t) => {
  const fixture = await durableFixture(t);
  const active = native(fixture.paths);
  await mkdir(join(active.activeRoot!, ".."), { recursive: true });
  await cp(fixture.paths.publishedPluginRoot, active.activeRoot!, {
    recursive: true,
  });

  const current = await inspectCodexInstallation(
    fixture.selection,
    { root: fixture.root, env: { CODEX_HOME: fixture.paths.codexHome } },
    () => nativeResult(active),
  );
  assert.equal(current.outcome.ok, true, JSON.stringify(current));
  if (!current.outcome.ok) assert.fail("expected current inspection");
  assert.equal(current.outcome.result.kind, "current");
  assert.equal(current.outcome.result.observedIdentity, COMMIT);

  const wrongSource = await inspectCodexInstallation(
    nativeSelection(COMMIT, "https://example.invalid/other.git"),
    { root: fixture.root, env: { CODEX_HOME: fixture.paths.codexHome } },
    () => nativeResult(active),
  );
  assert.equal(wrongSource.outcome.ok, true, JSON.stringify(wrongSource));
  if (!wrongSource.outcome.ok) assert.fail("expected source inspection");
  assert.equal(wrongSource.outcome.result.kind, "mismatch");

  await writeFile(
    join(active.activeRoot!, "skills", "using-superpowers", "SKILL.md"),
    "damaged\n",
  );
  const damaged = await inspectCodexInstallation(
    fixture.selection,
    { root: fixture.root, env: { CODEX_HOME: fixture.paths.codexHome } },
    () => nativeResult(active),
  );
  assert.equal(damaged.outcome.ok, true, JSON.stringify(damaged));
  if (!damaged.outcome.ok) assert.fail("expected damaged inspection");
  assert.equal(damaged.outcome.result.kind, "mismatch");
  assert.equal(damaged.outcome.result.observedIdentity, COMMIT);
});

void test("inspection fails when an owned durable marketplace is invalid", async (t) => {
  const fixture = await durableFixture(t);
  await writeFile(
    join(fixture.paths.marketplaceRoot, ".superpowers-manager.json"),
    "{",
  );
  const result = await inspectCodexInstallation(
    fixture.selection,
    { root: fixture.root, env: { CODEX_HOME: fixture.paths.codexHome } },
    () =>
      nativeResult(
        native(fixture.paths, {
          pluginPresent: false,
          pluginEnabled: false,
          activeVersion: null,
          activeRoot: null,
        }),
      ),
  );
  assert.equal(result.outcome.ok, false);
  assert.match(result.outcome.error?.message ?? "", /owned Codex marketplace/);
});

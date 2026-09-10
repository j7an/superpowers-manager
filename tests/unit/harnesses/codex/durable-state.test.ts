import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { successResult } from "../../../../src/adapter-result.ts";
import type { EffectiveSelection } from "../../../../src/effective-selection.ts";
import {
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
      name: "listing command failure",
      env: { SUPERPOWERS_CODEX: "/usr/bin/false" },
      message: "cannot list Codex plugins",
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
  const legacy = native(fixture.paths, {
    marketplaceRoot: join(fixture.root, "missing-old-extraction"),
    activeRoot: join(fixture.root, "empty-cache"),
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
    observedIdentity: "legacy Codex marketplace source",
  });
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

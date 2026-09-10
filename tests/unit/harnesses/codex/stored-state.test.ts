import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readCodexStoredState } from "../../../../src/harnesses/codex/stored-state.ts";

async function fixture(t: import("node:test").TestContext) {
  const root = await mkdtemp(join(tmpdir(), "spw-codex-stored-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, "codex");
  await mkdir(codexHome);
  return { root, codexHome, missingSource: join(root, "missing-source") };
}

function config(source: string, plugin = true): string {
  return [
    '[marketplaces."superpowers-manager"]',
    'source_type = "local"',
    `source = ${JSON.stringify(source)}`,
    ...(plugin
      ? ['[plugins."superpowers@superpowers-manager"]', "enabled = true"]
      : []),
    "",
  ].join("\n");
}

async function treeSnapshot(root: string, relative = ""): Promise<string[]> {
  const current = join(root, relative);
  const entries = (await readdir(current)).sort();
  const snapshot: string[] = [];
  for (const name of entries) {
    const childRelative = join(relative, name);
    const child = join(root, childRelative);
    const details = await lstat(child);
    if (details.isDirectory()) {
      snapshot.push(`d ${childRelative}`);
      snapshot.push(...(await treeSnapshot(root, childRelative)));
    } else if (details.isSymbolicLink()) {
      snapshot.push(`l ${childRelative} ${await readlink(child)}`);
    } else {
      snapshot.push(
        `f ${childRelative} ${(await readFile(child)).toString("base64")}`,
      );
    }
  }
  return snapshot;
}

void test("stored state recognizes quoted and dotted manager configuration only when a valid cache version directory exists", async (t) => {
  const state = await fixture(t);
  await writeFile(
    join(state.codexHome, "config.toml"),
    [
      'marketplaces."superpowers-manager".source_type = "local"',
      `marketplaces."superpowers-manager".source = ${JSON.stringify(state.missingSource)}`,
      'marketplaces."superpowers-manager".note = """a',
      'multiline value"""',
      '[plugins."superpowers@superpowers-manager"]',
      "enabled = true",
      "large_unknown_integer = 9223372036854775807",
      "",
    ].join("\n"),
  );
  await mkdir(
    join(
      state.codexHome,
      "plugins/cache/superpowers-manager/superpowers/1.2.3+manager.abc",
    ),
    { recursive: true },
  );

  const before = await treeSnapshot(state.codexHome);
  const observed = await readCodexStoredState(
    { CODEX_HOME: state.codexHome },
    state.root,
  );

  assert.deepEqual(observed, {
    managerMarketplaceRoot: state.missingSource,
    legacyMarketplaceRoot: null,
    managerPluginPresent: true,
    managerPluginEnabled: true,
    legacyPluginPresent: false,
    legacyPluginEnabled: false,
    installedListingJson: JSON.stringify({
      installed: [
        {
          pluginId: "superpowers@superpowers-manager",
          installed: true,
          enabled: true,
        },
      ],
    }),
  });
  assert.deepEqual(await treeSnapshot(state.codexHome), before);
});

void test("stored plugin presence requires both configuration and a valid cache version directory", async (t) => {
  for (const [name, configured, cached, expected] of [
    ["configured only", true, false, false],
    ["cache only", false, true, false],
    ["configured and cached", true, true, true],
  ] as const) {
    await t.test(name, async () => {
      const state = await fixture(t);
      await writeFile(
        join(state.codexHome, "config.toml"),
        config(state.missingSource, configured),
      );
      if (cached) {
        await mkdir(
          join(
            state.codexHome,
            "plugins/cache/superpowers-manager/superpowers/1.0.0",
          ),
          { recursive: true },
        );
      }
      const observed = await readCodexStoredState(
        { CODEX_HOME: state.codexHome },
        state.root,
      );
      assert.equal(observed.managerPluginPresent, expected);
      assert.equal(observed.managerPluginEnabled, configured);
    });
  }
});

void test("stored state rejects malformed, duplicate, over-depth, and invalid UTF-8 configuration", async (t) => {
  const cases: readonly [string, string | Uint8Array][] = [
    ["malformed", "[marketplaces\n"],
    [
      "duplicate",
      `${config("/missing")}[marketplaces."superpowers-manager"]\nsource_type = "local"\n`,
    ],
    [
      "over-depth",
      `${config("/missing")}deep = ${"[".repeat(65)}0${"]".repeat(65)}\n`,
    ],
    ["invalid UTF-8", Uint8Array.from([0xff])],
  ];
  for (const [name, contents] of cases) {
    await t.test(name, async () => {
      const state = await fixture(t);
      await writeFile(join(state.codexHome, "config.toml"), contents);
      await assert.rejects(
        () => readCodexStoredState({ CODEX_HOME: state.codexHome }, state.root),
        /Codex configuration/u,
      );
    });
  }
});

void test("stored state rejects an invalid unrelated plugin entry before deriving manager evidence", async (t) => {
  const state = await fixture(t);
  await writeFile(
    join(state.codexHome, "config.toml"),
    `${config(state.missingSource)}[plugins.unrelated]\nname = "missing enabled"\n`,
  );
  await assert.rejects(
    () => readCodexStoredState({ CODEX_HOME: state.codexHome }, state.root),
    /Codex plugin unrelated has invalid enabled state/u,
  );
});

void test("stored state permits only an ENOENT manager source and no-follow configuration/cache evidence", async (t) => {
  await t.test("existing source", async () => {
    const state = await fixture(t);
    await mkdir(state.missingSource);
    await writeFile(
      join(state.codexHome, "config.toml"),
      config(state.missingSource),
    );
    await assert.rejects(
      () => readCodexStoredState({ CODEX_HOME: state.codexHome }, state.root),
      /marketplace source is not missing/u,
    );
  });
  await t.test("source symlink", async () => {
    const state = await fixture(t);
    await symlink(join(state.root, "absent-target"), state.missingSource);
    await writeFile(
      join(state.codexHome, "config.toml"),
      config(state.missingSource),
    );
    await assert.rejects(
      () => readCodexStoredState({ CODEX_HOME: state.codexHome }, state.root),
      /marketplace source is not missing/u,
    );
  });
  await t.test("config symlink", async () => {
    const state = await fixture(t);
    const target = join(state.root, "actual.toml");
    await writeFile(target, config(state.missingSource));
    await symlink(target, join(state.codexHome, "config.toml"));
    await assert.rejects(
      () => readCodexStoredState({ CODEX_HOME: state.codexHome }, state.root),
      /Codex configuration must be a regular file/u,
    );
  });
  await t.test("cache symlink", async () => {
    const state = await fixture(t);
    await writeFile(
      join(state.codexHome, "config.toml"),
      config(state.missingSource),
    );
    const actual = join(state.root, "actual-cache");
    await mkdir(join(actual, "1.0.0"), { recursive: true });
    const cache = join(
      state.codexHome,
      "plugins/cache/superpowers-manager/superpowers",
    );
    await mkdir(join(cache, ".."), { recursive: true });
    await symlink(actual, cache);
    await assert.rejects(
      () => readCodexStoredState({ CODEX_HOME: state.codexHome }, state.root),
      /plugin cache must be a directory/u,
    );
  });
});

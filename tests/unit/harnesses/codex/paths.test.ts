import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertCodexPreparationSeparate,
  codexHome,
  codexPaths,
} from "../../../../src/harnesses/codex/paths.ts";

async function sandbox(t: import("node:test").TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "spw-codex-paths-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

void test("Codex home selects durable storage independently of package location", () => {
  const paths = codexPaths(
    { HOME: "/fixture/home", CODEX_HOME: "profiles/a" },
    "/fixture",
  );
  assert.equal(paths.codexHome, "/fixture/profiles/a");
  assert.equal(
    paths.preparedRoot,
    "/fixture/profiles/a/superpowers-manager/prepared",
  );
  assert.equal(
    paths.publishedPluginRoot,
    "/fixture/profiles/a/superpowers-manager/marketplace/plugins/superpowers",
  );
  assert.throws(
    () => codexHome({}, "/fixture"),
    /cannot determine Codex state root without HOME/,
  );
});

void test("Codex home falls back only from an empty CODEX_HOME", () => {
  assert.equal(
    codexHome({ HOME: "/fixture/home", CODEX_HOME: "" }, "/fixture"),
    "/fixture/home/.codex",
  );
  assert.equal(
    codexPaths({ HOME: "/fixture/home" }, "/fixture").codexHome,
    "/fixture/home/.codex",
  );
});

void test("Codex preparation rejects only paths that overlap published or recovery storage", async (t) => {
  const root = await sandbox(t);
  const paths = codexPaths({ CODEX_HOME: join(root, "codex-home") }, root);
  const prefixSibling = `${paths.publishedPluginRoot}-scratch`;
  const alias = join(root, "prepared-alias");
  await symlink(paths.publishedPluginRoot, alias);

  const cases: readonly [string, string, boolean][] = [
    ["the published root itself", paths.publishedPluginRoot, true],
    ["a published ancestor", paths.managerRoot, true],
    [
      "a descendant of recovery storage",
      join(paths.recoveryRoot, "staged"),
      true,
    ],
    ["a symlink alias to published storage", alias, true],
    ["a missing future preparation leaf", paths.preparedRoot, false],
    [
      "a root from another Codex home",
      join(root, "other-home", "prepared"),
      false,
    ],
    ["a prefix-only published sibling", prefixSibling, false],
  ];

  for (const [name, preparedRoot, rejected] of cases) {
    await t.test(name, async () => {
      if (rejected) {
        await assert.rejects(
          assertCodexPreparationSeparate(preparedRoot, paths),
          /preparation overlaps Codex published or recovery storage/,
        );
      } else {
        await assert.doesNotReject(
          assertCodexPreparationSeparate(preparedRoot, paths),
        );
      }
      assert.deepEqual(await readdir(root), ["prepared-alias"]);
    });
  }
});

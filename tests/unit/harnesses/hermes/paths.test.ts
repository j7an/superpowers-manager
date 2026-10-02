import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  assertHermesStorageAncestorsSafe,
  assertHermesStorageSafe,
  hermesPaths,
} from "../../../../src/harnesses/hermes/paths.ts";
import { scratch } from "../../../lib/scratch.ts";

void test("HERMES_HOME wins over HOME and owns the manager tree", () => {
  assert.deepEqual(
    hermesPaths({ HOME: "/home/user", HERMES_HOME: "/custom/hermes" }, "/work"),
    {
      hermesHome: "/custom/hermes",
      managerRoot: "/custom/hermes/superpowers-manager",
      preparedRoot: "/custom/hermes/superpowers-manager/prepared",
      pluginsRoot: "/custom/hermes/plugins",
      pluginRoot: "/custom/hermes/plugins/superpowers",
    },
  );
});
void test("a relative HERMES_HOME resolves against the cwd", () => {
  assert.equal(
    hermesPaths({ HERMES_HOME: "relative" }, "/work").hermesHome,
    "/work/relative",
  );
});
void test("an empty HERMES_HOME falls back to HOME/.hermes", () => {
  assert.equal(
    hermesPaths({ HERMES_HOME: "", HOME: "/home/user" }, "/work").hermesHome,
    "/home/user/.hermes",
  );
});
void test("storage safety refuses a symlinked manager root", async (t) => {
  const root = scratch(t, "spw-hermes-paths-");
  const paths = hermesPaths({ HERMES_HOME: join(root, "hermes") }, root);
  mkdirSync(paths.hermesHome);
  mkdirSync(join(root, "elsewhere"));
  symlinkSync(join(root, "elsewhere"), paths.managerRoot);
  await assert.rejects(
    assertHermesStorageSafe(paths),
    /disallowed type symlink/,
  );
});

void test("storage ancestor safety permits a foreign published leaf while full storage safety refuses it", async (t) => {
  const root = scratch(t, "spw-hermes-paths-");
  const paths = hermesPaths({ HERMES_HOME: join(root, "hermes") }, root);
  mkdirSync(paths.pluginsRoot, { recursive: true });
  const target = join(root, "elsewhere");
  mkdirSync(target);
  symlinkSync(target, paths.pluginRoot);
  await assertHermesStorageAncestorsSafe(paths);
  await assert.rejects(
    assertHermesStorageSafe(paths),
    /disallowed type symlink/,
  );
});

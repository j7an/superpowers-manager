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
for (const [configured, expected] of [
  [" \t\n", "/home/user/.hermes"],
  [" /custom/hermes \t", "/custom/hermes"],
  [" relative ", "/work/relative"],
  ["~", "/home/user"],
  ["~/hermes", "/home/user/hermes"],
  ["$SELECTED_HOME/hermes", "/selected/hermes"],
  ["${SELECTED_HOME}/hermes", "/selected/hermes"],
  ["$EMPTY", "/work"],
  ["$UNKNOWN/hermes", "/work/$UNKNOWN/hermes"],
  ["$constructor/hermes", "/work/$constructor/hermes"],
  ["${__proto__}/hermes", "/work/${__proto__}/hermes"],
  ["/custom/hermes\u0085", "/custom/hermes"],
  ["\u001c\u0085/custom/hermes\u00a0\u001f", "/custom/hermes"],
  ["/custom/hermes\ufeff", "/custom/hermes\ufeff"],
] as const) {
  void test(`Hermes home resolves ${JSON.stringify(configured)} before publication`, () => {
    assert.equal(
      hermesPaths(
        {
          HOME: "/home/user",
          SELECTED_HOME: "/selected",
          EMPTY: "",
          HERMES_HOME: configured,
        },
        "/work",
      ).hermesHome,
      expected,
    );
  });
}

for (const configured of ["~someone/hermes", "$NESTED/hermes", "$PADDED"]) {
  void test(`Hermes home refuses unsafe expansion ${JSON.stringify(configured)}`, () => {
    assert.throws(
      () =>
        hermesPaths(
          {
            HERMES_HOME: configured,
            NESTED: "$SELECTED_HOME",
            SELECTED_HOME: "/selected",
            PADDED: "/selected ",
          },
          "/work",
        ),
      /cannot resolve HERMES_HOME/,
    );
  });
}
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

import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { scratch } from "../../../lib/scratch.ts";
import {
  assertOpenCodePreparationSeparate,
  openCodePaths,
} from "../../../../src/harnesses/opencode/paths.ts";

void test("uses the native XDG config root for durable OpenCode artifacts", () => {
  assert.deepEqual(
    openCodePaths({ HOME: "/home/test", XDG_CONFIG_HOME: "/config" }, "/cwd"),
    {
      homeDir: "/home/test",
      configRoot: "/config/opencode",
      managerRoot: "/config/opencode/superpowers-manager",
      preparedRoot: "/config/opencode/superpowers-manager/prepared",
      installedRoot: "/config/opencode/superpowers-manager/installed",
      recoveryRoot: "/config/opencode/superpowers-manager/recovery",
    },
  );
});

void test("rejects a relative XDG config root before artifact writes", () => {
  assert.throws(
    () =>
      openCodePaths(
        { HOME: "/home/test", XDG_CONFIG_HOME: "relative" },
        "/cwd",
      ),
    /XDG_CONFIG_HOME must be absolute/,
  );
});

void test("storage validation rejects symlinked config and manager parents", async (t) => {
  for (const parent of ["config", "manager"] as const)
    await t.test(parent, async (t) => {
      const root = scratch(t, "spw-opencode-paths-");
      const paths = openCodePaths(
        { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "xdg") },
        root,
      );
      const target = join(root, "outside");
      mkdirSync(target);
      if (parent === "config") {
        mkdirSync(dirname(paths.configRoot), { recursive: true });
        symlinkSync(target, paths.configRoot, "dir");
      } else {
        mkdirSync(paths.configRoot, { recursive: true });
        symlinkSync(target, paths.managerRoot, "dir");
      }
      await assert.rejects(
        assertOpenCodePreparationSeparate(paths),
        /path has disallowed type symlink/,
      );
    });
});

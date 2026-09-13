import assert from "node:assert/strict";
import test from "node:test";
import { openCodePaths } from "../../../../src/harnesses/opencode/paths.ts";

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

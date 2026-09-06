import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { piPaths } from "../../src/pi-paths.ts";

void test("Pi paths follow native agent-directory selection", async (t) => {
  await t.test("defaults to the Pi directory under HOME", () => {
    assert.deepEqual(piPaths({ HOME: "/users/pi" }, "/work/project"), {
      homeDir: "/users/pi",
      agentDir: "/users/pi/.pi/agent",
      settingsFile: "/users/pi/.pi/agent/settings.json",
      managerRoot: "/users/pi/.pi/agent/superpowers-manager",
      preparedRoot: "/users/pi/.pi/agent/superpowers-manager/prepared",
      installedRoot: "/users/pi/.pi/agent/superpowers-manager/installed",
      recoveryRoot: "/users/pi/.pi/agent/superpowers-manager/recovery",
    });
  });

  await t.test("resolves a relative PI_CODING_AGENT_DIR from cwd", () => {
    assert.equal(
      piPaths(
        { HOME: "/users/pi", PI_CODING_AGENT_DIR: "state/../pi-agent" },
        "/work/project",
      ).agentDir,
      "/work/project/pi-agent",
    );
  });

  await t.test("expands a leading tilde with the supplied HOME", () => {
    const paths = piPaths(
      { HOME: "/isolated/home", PI_CODING_AGENT_DIR: "~/custom-agent" },
      "/ignored/cwd",
    );
    assert.equal(paths.homeDir, "/isolated/home");
    assert.equal(
      paths.settingsFile,
      "/isolated/home/custom-agent/settings.json",
    );
    assert.equal(
      piPaths({ HOME: "/users/pi", PI_CODING_AGENT_DIR: "~" }, "/ignored/cwd")
        .agentDir,
      "/users/pi",
    );
  });

  await t.test("treats an empty override as absent", () => {
    assert.equal(
      piPaths({ HOME: "/users/pi", PI_CODING_AGENT_DIR: "" }, "/work/project")
        .agentDir,
      join("/users/pi", ".pi", "agent"),
    );
  });
});

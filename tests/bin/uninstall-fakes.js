// @ts-check
// Executable, never imported. A two-line sh wrapper written by
// lifecycle-fixture.js execs this as either `codex` or `adapter`.
// Replaces the shell fake codex at tests/test_uninstall_commands.sh:28-84 and
// the recording adapter at :87-98, including their two python3 heredocs.
//
// PR 11.5 slice 2 extracted only the read side (config load + the two
// listings) into lifecycle-fakes.js. Slice 4 converted the mutation branches
// below to process.exitCode too; see tests/migration-inventory/probe.md.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  loadFixtureConfig,
  logLine,
  respondToListing,
} from "./lifecycle-fakes.js";

if (!process.env.SPW_FIXTURE_STATE) {
  process.stderr.write("fixture: SPW_FIXTURE_STATE is unset\n");
  process.exitCode = 90;
} else {
  const STATE = /** @type {string} */ (process.env.SPW_FIXTURE_STATE);
  const CONFIG = loadFixtureConfig("uninstall", STATE);
  const ROLE = process.argv[2];
  const ARGS = process.argv.slice(3);

  /**
   * @param {string} name
   * @param {string} line
   */
  function log(name, line) {
    logLine(STATE, name, line);
  }

  /**
   * @param {string} file
   * @returns {any}
   */
  function readJson(file) {
    return JSON.parse(readFileSync(join(STATE, file), "utf8"));
  }

  /**
   * @param {string} file
   * @param {unknown} value
   */
  function writeJson(file, value) {
    writeFileSync(join(STATE, file), JSON.stringify(value));
  }

  function runCodex() {
    log("codex.log", ARGS.join(" "));

    // Decision 5 injection toggle: the fake commits the forbidden act so every
    // guard that is load-bearing turns RED. A guard that stays GREEN under this
    // is a boundary guard and must be adjudicated in the inventory, never
    // "proved" by breaking its own text.
    if (CONFIG.spuriousMutation) {
      log("codex.log", "plugin remove superpowers@spurious");
    }

    const [a, b, c] = ARGS;
    if (
      respondToListing({
        args: ARGS,
        state: STATE,
        pluginListRc: /** @type {number} */ (CONFIG.pluginListRc),
        marketplaceListRc: /** @type {number} */ (CONFIG.marketplaceListRc),
      })
    ) {
      return;
    }
    if (a === "plugin" && b === "remove") {
      if (!CONFIG.removesMutateState) {
        process.exitCode = 0;
        return;
      }
      if (CONFIG.pluginRemove === "missing-installed") {
        writeJson("plugin_list.json", { available: [] });
        process.exitCode = 0;
        return;
      }
      const data = readJson("plugin_list.json");
      data.installed = data.installed.filter(
        (/** @type {{pluginId?: string}} */ item) => item.pluginId !== c,
      );
      writeJson("plugin_list.json", data);
      process.exitCode = 0;
      return;
    }
    if (a === "plugin" && b === "marketplace" && c === "remove") {
      if (CONFIG.marketplaceRemove === "fail") {
        process.stderr.write("marketplace remove exploded\n");
        process.exitCode = 1;
        return;
      }
      if (CONFIG.removesMutateState) {
        const data = readJson("marketplace_list.json");
        data.marketplaces = data.marketplaces.filter(
          (/** @type {{name?: string}} */ item) => item.name !== ARGS[3],
        );
        writeJson("marketplace_list.json", data);
      }
      process.exitCode = 0;
      return;
    }
    process.exitCode = 0;
  }

  function runAdapter() {
    const SEAM = process.env.SPW_FIXTURE_ADAPTER_SEAM ?? "delegate";
    log("adapter.log", ARGS.join(" "));
    if (SEAM === "tripwire") {
      // The command is dispatched in-process, so runAdapter is a function call
      // and this executable must never be reached. Same shape as
      // tests/bin/probe-fakes.js:23-29, shipped in slice 2.
      process.stderr.write(
        "fixture: this command must not spawn the adapter\n",
      );
      process.exitCode = 94;
      return;
    }
    if (
      SEAM === "intercept" &&
      ARGS.join(" ") === "inspect --view update-control"
    ) {
      process.stdout.write(
        `${JSON.stringify({
          protocol: 1,
          operation: "inspect",
          ok: true,
          messages: [],
          result: {
            view: "update-control",
            update_control: CONFIG.updateControl,
          },
          error: null,
        })}\n`,
      );
      process.exitCode = 0;
      return;
    }
    // Everything else runs the REAL adapter, exactly as the shell fixture did
    // (tests/test_uninstall_commands.sh:97). build, install, uninstall, and
    // ownership inspection are production code in every case.
    const pkgRoot = process.env.SPW_TEST_PKG_ROOT;
    if (!pkgRoot) {
      process.stderr.write("fixture: SPW_TEST_PKG_ROOT is unset\n");
      process.exitCode = 95;
      return;
    }
    const real = join(pkgRoot, "scripts", "adapters", "codex", "adapter");
    if (!existsSync(real)) {
      process.stderr.write(`fixture: real adapter is missing at ${real}\n`);
      process.exitCode = 96;
      return;
    }
    const result = spawnSync(real, ARGS, {
      stdio: "inherit",
      env: process.env,
    });
    process.exitCode = result.status ?? 97;
    return;
  }

  if (CONFIG.__failed) {
    // loadFixtureConfig already set the exit code and wrote the diagnostic.
    // Reaching runCodex/runAdapter here would run fake logic against defaults
    // instead of the config the case actually asked for, so this replicates
    // the hard-exit-before-any-mutation behaviour the old loadConfig() had.
  } else if (ROLE === "codex") runCodex();
  else if (ROLE === "adapter") runAdapter();
  else {
    process.stderr.write(`fixture: unknown role: ${String(ROLE)}\n`);
    process.exitCode = 98;
  }
}

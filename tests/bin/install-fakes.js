// @ts-check
// Executable, never imported. A two-line sh wrapper written by
// lifecycle-fixture.js execs this as either `codex` or `adapter`.
// Replaces the shell fake codex at tests/test_install_commands.sh:101-169 and
// the recording adapter at :171-221.
//
// PR 11.5 slice 2 extracted only the read side (config load + the two
// listings) into lifecycle-fakes.js. Slice 4 converted the mutation branches
// below to process.exitCode too; see tests/migration-inventory/probe.md.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  const CONFIG = loadFixtureConfig("install", STATE);
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
      log("codex.log", "plugin add superpowers@spurious");
    }

    const pkgRoot = process.env.SPW_TEST_PKG_ROOT;
    const [a, b, c, d] = ARGS;

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
    if (
      ARGS.length === 4 &&
      a === "plugin" &&
      b === "marketplace" &&
      c === "add" &&
      d === pkgRoot
    ) {
      if (CONFIG.marketplaceAdd === "fail") {
        process.exitCode = 1;
        return;
      }
      const data = readJson("marketplace_list.json");
      data.marketplaces = data.marketplaces.filter(
        (/** @type {{name?: string}} */ item) =>
          item.name !== "superpowers-manager",
      );
      data.marketplaces.push({ name: "superpowers-manager", root: d });
      writeJson("marketplace_list.json", data);
      process.exitCode = 0;
      return;
    }
    if (
      ARGS.length === 4 &&
      a === "plugin" &&
      b === "marketplace" &&
      c === "remove" &&
      d === "superpowers-manager"
    ) {
      const data = readJson("marketplace_list.json");
      data.marketplaces = data.marketplaces.filter(
        (/** @type {{name?: string}} */ item) =>
          item.name !== "superpowers-manager",
      );
      writeJson("marketplace_list.json", data);
      process.exitCode = 0;
      return;
    }
    if (
      ARGS.length === 3 &&
      a === "plugin" &&
      b === "add" &&
      c === "superpowers@superpowers-manager"
    ) {
      if (CONFIG.pluginAdd === "fail") {
        process.exitCode = 1;
        return;
      }
      if (CONFIG.pluginAdd === "noop") {
        process.exitCode = 0;
        return;
      }
      if (CONFIG.pluginAdd === "orphan") {
        // Codex reports the plugin installed at 1.0.0, but no cached tree is
        // ever written for it. The real adapter's fingerprint handler then
        // resolves an active version, builds the installed root for it, and
        // finds nothing to read there — src/adapter.ts:815-828 — so it returns a
        // controlled inspect-failed envelope. No adapter interception needed.
        writeJson("plugin_list.json", {
          installed: [
            { pluginId: "superpowers@superpowers-manager", version: "1.0.0" },
          ],
          available: [],
        });
        process.exitCode = 0;
        return;
      }
      const dest = join(
        STATE,
        "codex-home",
        "plugins",
        "cache",
        "superpowers-manager",
        "superpowers",
        "1.0.0",
      );
      mkdirSync(dest, { recursive: true });
      cpSync(
        join(
          /** @type {string} */ (pkgRoot),
          "plugins",
          "superpowers",
          ".superpowers-upstream.json",
        ),
        join(dest, ".superpowers-upstream.json"),
      );
      writeJson("plugin_list.json", {
        installed: [
          { pluginId: "superpowers@superpowers-manager", version: "1.0.0" },
        ],
        available: [],
      });
      if (CONFIG.pluginAdd === "stale") {
        const upstreamJson = join(dest, ".superpowers-upstream.json");
        const data = JSON.parse(readFileSync(upstreamJson, "utf8"));
        data.commit = "0".repeat(40);
        writeFileSync(upstreamJson, JSON.stringify(data));
      }
      process.exitCode = 0;
      return;
    }
    if (
      ARGS.length === 3 &&
      a === "plugin" &&
      b === "remove" &&
      c === "superpowers@superpowers-manager"
    ) {
      rmSync(
        join(STATE, "codex-home", "plugins", "cache", "superpowers-manager"),
        {
          recursive: true,
          force: true,
        },
      );
      process.exitCode = 0;
      return;
    }
    process.stderr.write(`unexpected fake Codex command: ${ARGS.join(" ")}\n`);
    process.exitCode = 99;
    return;
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
    const joined = ARGS.join(" ");

    if (SEAM === "intercept" && joined === "inspect --view update-control") {
      const countFile = join(STATE, "update-control-count");
      let count = 0;
      try {
        count = Number(readFileSync(countFile, "utf8").trim());
      } catch {
        count = 0;
      }
      count += 1;
      writeFileSync(countFile, `${count}\n`);

      let updateControl = /** @type {string} */ (CONFIG.updateControl);
      if (updateControl === "managed-then-unsupported") {
        updateControl = count === 1 ? "managed" : "unsupported";
      }

      if (updateControl === "managed" || updateControl === "unsupported") {
        process.stdout.write(
          `${JSON.stringify({
            protocol: 1,
            operation: "inspect",
            ok: true,
            messages: [],
            result: {
              view: "update-control",
              update_control: updateControl,
            },
            error: null,
          })}\n`,
        );
        process.exitCode = 0;
        return;
      }
      if (updateControl === "malformed") {
        process.stdout.write("{");
        process.exitCode = 0;
        return;
      }
      if (updateControl === "failure") {
        process.stdout.write(
          `${JSON.stringify({
            protocol: 1,
            operation: "inspect",
            ok: false,
            messages: [],
            result: null,
            error: {
              code: "inspect-failed",
              message: "update-control inspection failed",
              hints: [],
            },
          })}\n`,
        );
        process.exitCode = 1;
        return;
      }

      // Fail closed, restoring the shell fake's `*) unknown update-control
      // fixture; exit 99` branch (test_install_commands.sh:203-206 at
      // 81c2de1a). Without it an unhandled updateControl value falls through to
      // the real adapter at the delegation below, so a fixture misconfiguration
      // reads as a subject result instead of a fixture fault. The schema
      // enumeration is not a substitute: it is a list, not a structure.
      process.stderr.write(
        `fixture: unknown update-control value: ${updateControl}\n`,
      );
      process.exitCode = 99;
      return;
    }

    // The fingerprint intercept is conditioned on the plugin cache existing.
    // Without that condition it fires before the cache exists (fresh install,
    // legacy-state cases) and silently changes what several later
    // verification cases mean.
    if (
      SEAM === "intercept" &&
      joined === "inspect --view fingerprint" &&
      existsSync(
        join(STATE, "codex-home", "plugins", "cache", "superpowers-manager"),
      )
    ) {
      // Only `malformed` remains. The `fail` branch was retired with its single
      // consumer: that case is now driven from the fake Codex through
      // `pluginAdd: "orphan"`, so the REAL adapter produces the failure.
      if (CONFIG.fingerprintInspect === "malformed") {
        process.stdout.write("{");
        process.exitCode = 0;
        return;
      }
    }

    // Everything else runs the REAL adapter, exactly as the shell fixture did
    // (tests/test_install_commands.sh:220). build, install, ownership
    // inspection, and an "ok" fingerprint inspection are production code in
    // every case.
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

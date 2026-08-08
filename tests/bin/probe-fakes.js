// @ts-check
// Executable, never imported. A two-line sh wrapper written by
// lifecycle-fixture.js execs this as either `codex` or `adapter`.
// Replaces the shell fake codex at tests/test_probe.sh:234-247.

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
  const CONFIG = loadFixtureConfig("probe", STATE);
  const ROLE = process.argv[2];
  const ARGS = process.argv.slice(3);

  if (CONFIG.__failed) {
    // loadFixtureConfig already set the exit code and wrote the diagnostic.
  } else if (ROLE === "adapter") {
    // In-process probe calls runAdapter as a function. Reaching the adapter
    // executable means the port regressed to spawning, so this fails loudly
    // rather than quietly succeeding.
    logLine(STATE, "adapter.log", ARGS.join(" "));
    process.stderr.write("fixture: probe must not spawn the adapter\n");
    process.exitCode = 94;
  } else if (ROLE === "codex") {
    logLine(STATE, "codex.log", ARGS.join(" "));
    const handled = respondToListing({
      args: ARGS,
      state: STATE,
      pluginListRc: /** @type {number} */ (CONFIG.pluginListRc),
      marketplaceListRc: /** @type {number} */ (CONFIG.marketplaceListRc),
      // Probe issues `plugin list --json` twice per run with different
      // required answers -- see nextPluginList in lifecycle-fakes.js. Only
      // this fake opts in; install and uninstall keep the single file.
      sequencePluginList: true,
    });
    if (!handled) {
      // Probe's own exhaustiveness trap. The shared responder deliberately
      // does not own this — see lifecycle-fakes.js's respondToListing.
      process.stderr.write(
        `fixture: unexpected probe Codex command: ${ARGS.join(" ")}\n`,
      );
      process.exitCode = 99;
    }
  } else {
    process.stderr.write(`fixture: unknown role: ${String(ROLE)}\n`);
    process.exitCode = 98;
  }
}

// @ts-check
// Executable, never imported. A two-line sh wrapper written by
// lifecycle-fixture.js execs this as either `codex` or `adapter`.
// Replaces the shell fake codex at tests/test_probe.sh:234-247.
//
// PR 11.5 slice 4b's Task 9 (matrix row 20) retires the duplicated outer
// shell — the SPW_FIXTURE_STATE guard, the config load, the role dispatch,
// and the unknown-role trap — in favour of the shared `runFake` that
// install-fakes.js and uninstall-fakes.js already used. What stays here is
// exactly what must NOT be shared: probe's own command branches and its own
// exhaustiveness trap.

import {
  respondToListing,
  runFake,
  tripwireTriggered,
} from "./lifecycle-fakes.js";

/**
 * @param {import("./lifecycle-fakes.js").FakeContext} ctx
 * @returns {void}
 */
function runCodex(ctx) {
  ctx.log("codex.log", ctx.args.join(" "));
  const handled = respondToListing({
    args: ctx.args,
    state: ctx.state,
    pluginListRc: /** @type {number} */ (ctx.config.pluginListRc),
    marketplaceListRc: /** @type {number} */ (ctx.config.marketplaceListRc),
    // Probe issues `plugin list --json` twice per run with different
    // required answers -- see nextPluginList in lifecycle-fakes.js. Only
    // this fake opts in; install and uninstall keep the single file.
    sequencePluginList: true,
  });
  if (!handled) {
    // Probe's own exhaustiveness trap. The shared responder deliberately
    // does not own this — see lifecycle-fakes.js's respondToListing.
    process.stderr.write(
      `fixture: unexpected probe Codex command: ${ctx.args.join(" ")}\n`,
    );
    process.exitCode = 99;
  }
}

/**
 * @param {import("./lifecycle-fakes.js").FakeContext} ctx
 * @returns {void}
 */
function runAdapter(ctx) {
  ctx.log("adapter.log", ctx.args.join(" "));
  // In-process probe calls runAdapter as a function. Reaching the adapter
  // executable means the port regressed to spawning, so the tripwire fails
  // loudly rather than quietly succeeding.
  //
  // The return value is discarded because this call is the last statement in
  // the function, so there is nothing here to fall through into. Add any
  // statement below it and the `if (…) return;` guard has to come back before
  // that statement can be trusted not to run after a trip.
  tripwireTriggered(ctx, {
    message: "fixture: probe must not spawn the adapter",
  });
}

runFake({ kind: "probe", codex: runCodex, adapter: runAdapter });

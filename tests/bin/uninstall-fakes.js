// @ts-check
// Executable, never imported. A two-line sh wrapper written by
// lifecycle-fixture.js execs this as either `codex` or `adapter`.
// Replaces the shell fake codex at tests/test_uninstall_commands.sh:28-84 and
// the recording adapter at :87-98, including their two python3 heredocs.
//
// PR 11.5 slice 2 extracted only the read side (config load + the two
// listings) into lifecycle-fakes.js. Slice 4 converted the mutation branches
// below to process.exitCode too; see tests/migration-inventory/probe.md.
//
// Slice 4a also moved the outer shell — state guard, config load, role
// dispatch, tripwire, delegation — into runFake. What stays here is exactly
// what must NOT be shared: this fake's own command branches.

import {
  delegateToRealAdapter,
  injectSpuriousMutation,
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
  injectSpuriousMutation(ctx, "plugin remove superpowers@spurious");

  const [a, b, c] = ctx.args;
  if (
    respondToListing({
      args: ctx.args,
      state: ctx.state,
      pluginListRc: /** @type {number} */ (ctx.config.pluginListRc),
      marketplaceListRc: /** @type {number} */ (ctx.config.marketplaceListRc),
    })
  ) {
    return;
  }
  if (a === "plugin" && b === "remove") {
    if (!ctx.config.removesMutateState) {
      process.exitCode = 0;
      return;
    }
    if (ctx.config.pluginRemove === "missing-installed") {
      ctx.writeJson("plugin_list.json", { available: [] });
      process.exitCode = 0;
      return;
    }
    const data = ctx.readJson("plugin_list.json");
    data.installed = data.installed.filter(
      (/** @type {{pluginId?: string}} */ item) => item.pluginId !== c,
    );
    ctx.writeJson("plugin_list.json", data);
    process.exitCode = 0;
    return;
  }
  if (a === "plugin" && b === "marketplace" && c === "remove") {
    if (ctx.config.marketplaceRemove === "fail") {
      process.stderr.write("marketplace remove exploded\n");
      process.exitCode = 1;
      return;
    }
    if (ctx.config.removesMutateState) {
      const data = ctx.readJson("marketplace_list.json");
      data.marketplaces = data.marketplaces.filter(
        (/** @type {{name?: string}} */ item) => item.name !== ctx.args[3],
      );
      ctx.writeJson("marketplace_list.json", data);
    }
    process.exitCode = 0;
    return;
  }
  process.exitCode = 0;
}

/**
 * @param {import("./lifecycle-fakes.js").FakeContext} ctx
 * @returns {void}
 */
function runAdapter(ctx) {
  ctx.log("adapter.log", ctx.args.join(" "));
  // Post-flip, uninstall dispatches in-process: `ctx.adapter` is a direct
  // call into src/adapter.ts's runAdapter, never a spawn of this executable,
  // so no seam value makes reaching it legitimate any more. `always: true`
  // refuses unconditionally, matching probe-fakes.js's own adapter role. The
  // return is still load-bearing: process.exitCode does not halt execution,
  // so falling through here would reach delegateToRealAdapter below and spawn
  // the very adapter the tripwire exists to forbid.
  if (
    tripwireTriggered(ctx, {
      always: true,
      message: "fixture: uninstall must not spawn the adapter",
    })
  ) {
    return;
  }
  if (
    ctx.seam === "intercept" &&
    ctx.args.join(" ") === "inspect --view update-control"
  ) {
    process.stdout.write(
      `${JSON.stringify({
        protocol: 1,
        operation: "inspect",
        ok: true,
        messages: [],
        result: {
          view: "update-control",
          update_control: ctx.config.updateControl,
        },
        error: null,
      })}\n`,
    );
    process.exitCode = 0;
    return;
  }
  delegateToRealAdapter(ctx);
  return;
}

runFake({ kind: "uninstall", codex: runCodex, adapter: runAdapter });

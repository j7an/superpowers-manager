// @ts-check
// Executable, never imported. A two-line sh wrapper written by
// lifecycle-fixture.js execs this as either `codex` or `adapter`.
// Replaces the shell fake codex at `git show 81c2de1a9a71699ea340dc8235f9779140f7b3f6:tests/test_install_commands.sh:101-169::cat > "$fake_codex` and
// the recording adapter at :171-221.
//
// PR 11.5 slice 2 extracted only the read side (config load + the two
// listings) into lifecycle-fakes.js. Slice 4 converted the mutation branches
// below to process.exitCode too; see tests/migration-inventory/probe.md.
//
// Slice 4a also moved the outer shell — state guard, config load, role
// dispatch and tripwire — into runFake. What stays here is exactly
// what must NOT be shared: this fake's own command branches and its
// exhaustiveness trap.

import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
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
  injectSpuriousMutation(ctx, "plugin add superpowers@spurious");

  const pkgRoot = process.env.SPW_TEST_PKG_ROOT;
  const [a, b, c, d] = ctx.args;

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
  if (
    ctx.args.length === 4 &&
    a === "plugin" &&
    b === "marketplace" &&
    c === "add" &&
    d === pkgRoot
  ) {
    if (ctx.config.marketplaceAdd === "fail") {
      process.exitCode = 1;
      return;
    }
    const data = ctx.readJson("marketplace_list.json");
    data.marketplaces = data.marketplaces.filter(
      (/** @type {{name?: string}} */ item) =>
        item.name !== "superpowers-manager",
    );
    data.marketplaces.push({ name: "superpowers-manager", root: d });
    ctx.writeJson("marketplace_list.json", data);
    process.exitCode = 0;
    return;
  }
  if (
    ctx.args.length === 4 &&
    a === "plugin" &&
    b === "marketplace" &&
    c === "remove" &&
    d === "superpowers-manager"
  ) {
    const data = ctx.readJson("marketplace_list.json");
    data.marketplaces = data.marketplaces.filter(
      (/** @type {{name?: string}} */ item) =>
        item.name !== "superpowers-manager",
    );
    ctx.writeJson("marketplace_list.json", data);
    process.exitCode = 0;
    return;
  }
  if (
    ctx.args.length === 3 &&
    a === "plugin" &&
    b === "add" &&
    c === "superpowers@superpowers-manager"
  ) {
    if (ctx.config.pluginAdd === "fail") {
      process.exitCode = 1;
      return;
    }
    if (ctx.config.pluginAdd === "noop") {
      process.exitCode = 0;
      return;
    }
    if (ctx.config.pluginAdd === "orphan") {
      // Codex reports the plugin installed at 1.0.0, but no cached tree is
      // ever written for it. The real adapter's fingerprint handler then
      // resolves an active version, builds the installed root for it, and
      // finds nothing to read there — `src/adapter.ts:831-844::const activeRoot` — so it returns a
      // controlled inspect-failed outcome. No adapter interception needed.
      ctx.writeJson("plugin_list.json", {
        installed: [
          { pluginId: "superpowers@superpowers-manager", version: "1.0.0" },
        ],
        available: [],
      });
      process.exitCode = 0;
      return;
    }
    const dest = join(
      ctx.state,
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
    ctx.writeJson("plugin_list.json", {
      installed: [
        { pluginId: "superpowers@superpowers-manager", version: "1.0.0" },
      ],
      available: [],
    });
    if (ctx.config.pluginAdd === "stale") {
      const upstreamJson = join(dest, ".superpowers-upstream.json");
      const data = JSON.parse(readFileSync(upstreamJson, "utf8"));
      data.commit = "0".repeat(40);
      writeFileSync(upstreamJson, JSON.stringify(data));
    }
    process.exitCode = 0;
    return;
  }
  if (
    ctx.args.length === 3 &&
    a === "plugin" &&
    b === "remove" &&
    c === "superpowers@superpowers-manager"
  ) {
    rmSync(
      join(ctx.state, "codex-home", "plugins", "cache", "superpowers-manager"),
      {
        recursive: true,
        force: true,
      },
    );
    process.exitCode = 0;
    return;
  }
  process.stderr.write(
    `unexpected fake Codex command: ${ctx.args.join(" ")}\n`,
  );
  process.exitCode = 99;
  return;
}

/**
 * @param {import("./lifecycle-fakes.js").FakeContext} ctx
 * @returns {void}
 */
function runAdapter(ctx) {
  ctx.log("adapter.log", ctx.args.join(" "));
  // Post-flip, install dispatches in-process: `ctx.adapter` is a direct call
  // into src/adapter.ts's runAdapter, never a spawn of this executable, so
  // reaching it is never legitimate. The tripwire refuses unconditionally,
  // matching probe-fakes.js's own adapter role.
  //
  // The return value is discarded because this call is the last statement in
  // the function, so there is nothing here to fall through into. Add any
  // statement below it and the `if (…) return;` guard has to come back before
  // that statement can be trusted not to run after a trip.
  tripwireTriggered(ctx, {
    message: "fixture: install must not spawn the adapter",
  });
}

runFake({ kind: "install", codex: runCodex, adapter: runAdapter });

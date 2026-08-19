// @ts-check
// Executable, never imported. A two-line sh wrapper written by
// lifecycle-fixture.js execs this as either `codex` or `adapter`.
// Replaces the shell fake codex at tests/test_install_commands.sh:101-169 and
// the recording adapter at :171-221.
//
// PR 11.5 slice 2 extracted only the read side (config load + the two
// listings) into lifecycle-fakes.js. Slice 4 converted the mutation branches
// below to process.exitCode too; see tests/migration-inventory/probe.md.
//
// Slice 4a also moved the outer shell — state guard, config load, role
// dispatch and tripwire — into runFake. What stays here is exactly
// what must NOT be shared: this fake's own command branches and both of its
// exhaustiveness traps.

import {
  cpSync,
  existsSync,
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
      // finds nothing to read there — src/adapter.ts:831-844 — so it returns a
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
  // into src/adapter.ts's runAdapter, never a spawn of this executable, so no
  // seam value makes reaching it legitimate any more. `always: true` refuses
  // unconditionally, matching probe-fakes.js's own adapter role. The return
  // is still load-bearing: process.exitCode does not halt execution, so
  // falling through would continue into obsolete adapter-role fixture logic.
  if (
    tripwireTriggered(ctx, {
      always: true,
      message: "fixture: install must not spawn the adapter",
    })
  ) {
    return;
  }
  const joined = ctx.args.join(" ");

  if (ctx.seam === "intercept" && joined === "inspect --view update-control") {
    const countFile = join(ctx.state, "update-control-count");
    let count = 0;
    try {
      count = Number(readFileSync(countFile, "utf8").trim());
    } catch {
      count = 0;
    }
    count += 1;
    writeFileSync(countFile, `${count}\n`);

    let updateControl = /** @type {string} */ (ctx.config.updateControl);
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
    // obsolete adapter-role logic below, so a fixture misconfiguration reads
    // as a subject result instead of a fixture fault. The schema
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
    ctx.seam === "intercept" &&
    joined === "inspect --view fingerprint" &&
    existsSync(
      join(ctx.state, "codex-home", "plugins", "cache", "superpowers-manager"),
    )
  ) {
    // Only `malformed` remains. The `fail` branch was retired with its single
    // consumer: that case is now driven from the fake Codex through
    // `pluginAdd: "orphan"`, so the REAL adapter produces the failure.
    if (ctx.config.fingerprintInspect === "malformed") {
      process.stdout.write("{");
      process.exitCode = 0;
      return;
    }
  }
}

runFake({ kind: "install", codex: runCodex, adapter: runAdapter });

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
// dispatch and tripwire — into runFake. What stays here is exactly
// what must NOT be shared: this fake's own command branches.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  injectSpuriousMutation,
  respondToListing,
  runFake,
  tripwireTriggered,
} from "./lifecycle-fakes.js";

// Each participant marks itself present, then waits until it sees `expect`
// live markers or the arrival bound elapses. Arrival quorum is acknowledged by
// a persistent `.ready` marker. A participant keeps its `.here` marker live
// until it sees `expect` ready markers or a distinct release bound elapses, so
// the first observer cannot make quorum disappear before peers observe it.
// Each participant records the highest live count it observed, how many
// blocking waits it made, and why it left. Both phases are bounded.
function rendezvous() {
  const dir = process.env.SPW_RENDEZVOUS_DIR;
  const expect = Number(process.env.SPW_RENDEZVOUS_EXPECT);
  if (!dir || !Number.isInteger(expect) || expect < 1) return true;
  // ONCE PER PARTICIPANT, not once per codex call. A successful `uninstall`
  // invokes the fake SIX times (tests/bin/uninstall-commands.test.js:434-439:
  // plugin list, marketplace list, plugin remove, marketplace remove, then both
  // listings again). Each call is a separate process, so a module-level flag
  // cannot carry the fact -- the identity has to live on disk, keyed on the
  // case. Without this the four-participant case produces TWENTY-FOUR peak
  // files, and with an unreachable quorum each of the twenty-four waits out the
  // full bound.
  const caseId = process.env.SPW_FIXTURE_STATE;
  if (!caseId) return true;
  const tag = createHash("sha256").update(caseId).digest("hex").slice(0, 16);
  const claimed = join(dir, `${tag}.claimed`);
  if (existsSync(claimed)) return true;
  writeFileSync(claimed, "");
  const pidDelayRaw = process.env.SPW_RENDEZVOUS_PID_DELAY_MS;
  if (pidDelayRaw !== undefined) {
    if (!/^[1-9][0-9]*$/.test(pidDelayRaw)) {
      process.stderr.write(
        "fixture: SPW_RENDEZVOUS_PID_DELAY_MS must be an integer from 1 to 5000\n",
      );
      process.exitCode = 90;
      return false;
    }
    const pidDelayMs = Number(pidDelayRaw);
    if (!Number.isSafeInteger(pidDelayMs) || pidDelayMs > 5000) {
      process.stderr.write(
        "fixture: SPW_RENDEZVOUS_PID_DELAY_MS must be an integer from 1 to 5000\n",
      );
      process.exitCode = 90;
      return false;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pidDelayMs);
  }
  // Durable descendant identity for the watchdog acceptance case. The file is
  // evidence only; it is removed with the rendezvous scratch directory.
  writeFileSync(join(dir, `${tag}.pid`), `${process.pid}\n`);
  const me = join(dir, `${tag}.here`);
  writeFileSync(me, "");
  // Opt-in watchdog fixture only. Default overlap/bound behavior never enters
  // this branch. PID and live-marker readiness are durable before the hold.
  if (process.env.SPW_RENDEZVOUS_HOLD_AFTER_PID === "1") {
    const hold = new Int32Array(new SharedArrayBuffer(4));
    for (;;) Atomics.wait(hold, 0, 0);
  }
  const deadline = Date.now() + 10000;
  let peak = 0;
  let waitCalls = 0;
  let reason = "expired";
  for (;;) {
    const seen = readdirSync(dir).filter((f) => f.endsWith(".here")).length;
    if (seen > peak) peak = seen;
    if (peak >= expect) {
      // ACKNOWLEDGE before releasing the live marker. `.ready` deliberately
      // survives until the test's scratch-directory cleanup.
      writeFileSync(join(dir, `${tag}.ready`), "");
      // Distinct name on purpose: M2 mutates the unique arrival-deadline line
      // above and must not also collapse this release barrier.
      const releaseDeadline = Date.now() + 10000;
      for (;;) {
        const ready = readdirSync(dir).filter((f) =>
          f.endsWith(".ready"),
        ).length;
        if (ready >= expect) {
          reason = "quorum";
          break;
        }
        if (Date.now() >= releaseDeadline) {
          reason = "release-expired";
          break;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        waitCalls += 1;
      }
      break;
    }
    if (Date.now() >= deadline) {
      reason = "expired";
      break;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    waitCalls += 1;
  }
  writeFileSync(join(dir, `${tag}.peak`), `${peak}\n`);
  writeFileSync(join(dir, `${tag}.waits`), `${waitCalls}\n`);
  writeFileSync(join(dir, `${tag}.reason`), `${reason}\n`);
  rmSync(me, { force: true });
  return true;
}

/**
 * @param {import("./lifecycle-fakes.js").FakeContext} ctx
 * @returns {void}
 */
function runCodex(ctx) {
  if (!rendezvous()) return;
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
  // so reaching it is never legitimate. The tripwire refuses unconditionally,
  // matching probe-fakes.js's own adapter role.
  //
  // The return value is discarded because this call is the last statement in
  // the function, so there is nothing here to fall through into. Add any
  // statement below it and the `if (…) return;` guard has to come back before
  // that statement can be trusted not to run after a trip.
  tripwireTriggered(ctx, {
    message: "fixture: uninstall must not spawn the adapter",
  });
}

runFake({ kind: "uninstall", codex: runCodex, adapter: runAdapter });

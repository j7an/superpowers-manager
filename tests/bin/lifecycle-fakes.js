// @ts-check
// Shared behaviour for the three lifecycle fake executables
// (install-fakes.js, uninstall-fakes.js, probe-fakes.js). PR 11.5 slice 2
// extracted the read side — loadFixtureConfig, respondToListing, logLine —
// from the fake `codex` for probe, the "third lifecycle fake" the parent spec
// named as this extraction's trigger. Slice 4a added the outer shell the two
// mutating fakes also duplicated: runFake, its FakeContext, the Decision 5
// injection toggle and the adapter tripwire.
// Slice 4b's Task 9 gives probe-fakes.js the same outer shell (matrix row 20)
// and widens the adapter tripwire so install and uninstall can trip
// unconditionally too (row 18), matching the guard probe already carried.
//
// Every response-then-exit site here uses `process.exitCode` plus a normal
// return, never `process.exit()`. `process.exit()` truncates a pending write
// to a pipe; the carried row :2041 exists because all three fakes would
// otherwise have inherited that defect.

import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { schemaFor, validateConfig } from "./lifecycle-config.js";

/**
 * Loads and re-validates the per-case config. `createCase` already validated
 * it eagerly; this is defence in depth, and it is what makes a hand-written
 * config.json fail closed too.
 * @param {"install" | "uninstall" | "probe"} kind
 * @param {string} state
 * @returns {Record<string, unknown>}
 */
export function loadFixtureConfig(kind, state) {
  const { defaults } = schemaFor(kind);
  const path = join(state, "config.json");
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    process.stderr.write(`fixture: cannot read ${path}\n`);
    process.exitCode = 91;
    return { ...defaults, __failed: true };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write("fixture: config.json is not valid JSON\n");
    process.exitCode = 92;
    return { ...defaults, __failed: true };
  }
  try {
    validateConfig(kind, parsed);
  } catch (error) {
    process.stderr.write(`fixture: ${/** @type {Error} */ (error).message}\n`);
    process.exitCode = 93;
    return { ...defaults, __failed: true };
  }
  return { ...defaults, ...parsed };
}

/**
 * Answers `plugin list --json` and `plugin marketplace list --json` from
 * per-case JSON files. Returns true when it handled the call.
 *
 * It deliberately does NOT own the unhandled case: each fake keeps its own
 * trap for a command none of its branches matched. A shared helper that
 * became the sole gatekeeper could let an unhandled configured value fall
 * past every branch into the real adapter — the defect PR 11.2b patched by
 * hand, which the parent spec warns this extraction must not reintroduce.
 *
 * @param {{
 *   args: string[],
 *   state: string,
 *   pluginListRc: number,
 *   marketplaceListRc: number,
 *   sequencePluginList?: boolean,
 * }} request
 * @returns {boolean}
 */
export function respondToListing(request) {
  const { args, state, pluginListRc, marketplaceListRc } = request;
  const [a, b, c, d] = args;
  if (args.length === 3 && a === "plugin" && b === "list" && c === "--json") {
    /** @type {{ ok: true, path: string } | { ok: false, message: string }} */
    const resolved = request.sequencePluginList
      ? nextPluginList(state)
      : { ok: true, path: join(state, "plugin_list.json") };
    if (!resolved.ok) {
      process.stderr.write(`${resolved.message}\n`);
      process.exitCode = 1;
      return true;
    }
    process.stdout.write(readFileSync(resolved.path, "utf8"));
    process.exitCode = pluginListRc;
    return true;
  }
  if (
    args.length === 4 &&
    a === "plugin" &&
    b === "marketplace" &&
    c === "list" &&
    d === "--json"
  ) {
    process.stdout.write(
      readFileSync(join(state, "marketplace_list.json"), "utf8"),
    );
    process.exitCode = marketplaceListRc;
    return true;
  }
  return false;
}

/**
 * Added 2026-08-07 after adjudication finding 3.
 *
 * Probe issues `codex plugin list --json` TWICE per run, from two different
 * inspections that need different answers:
 *
 *   inspect --view fingerprint -> plugin list --json          (src/adapter.ts:797)
 *   inspect --view ownership   -> plugin list --json,         (src/adapter.ts:871)
 *                                 plugin marketplace list --json  (:883)
 *
 * They are separate runAdapter calls, so this fake is a fresh PROCESS each
 * time and the argv is byte-identical -- there is nothing to branch on. A
 * single fixed plugin_list.json therefore makes whole scenarios
 * unconstructible: a listing carrying a manager version to populate
 * installed_commit also forces identity_state to `manager`, so
 * `identity_state=neither` with a non-empty installed_commit cannot be
 * expressed. The shell driver did not hit this because it stubbed the
 * ADAPTER, giving fingerprint and ownership independent inputs.
 *
 * The counter therefore lives on disk, not in memory. Read-increment-write is
 * safe without locking: probe awaits each runAdapter before starting the
 * next, so invocations are strictly sequential.
 *
 * Exhausting the sequence FAILS CLOSED rather than repeating the last entry.
 * Repeating would let a fixture that miscounted its invocations pass while
 * asserting something other than what it meant -- the silent-pass class this
 * slice exists to remove.
 *
 * @param {string} state
 * @returns {{ ok: true, path: string } | { ok: false, message: string }}
 */
function nextPluginList(state) {
  const counterPath = join(state, "plugin_list.counter");
  let index = 0;
  if (existsSync(counterPath)) {
    const raw = readFileSync(counterPath, "utf8").trim();
    index = Number.parseInt(raw, 10);
    if (!Number.isInteger(index) || index < 0) {
      return {
        ok: false,
        message: `fake codex: unreadable plugin listing counter at ${counterPath}`,
      };
    }
  }
  writeFileSync(counterPath, `${index + 1}`, "utf8");
  const path = join(state, `plugin_list.${index}.json`);
  if (!existsSync(path)) {
    return {
      ok: false,
      message: `fake codex: no plugin listing configured for invocation ${index}`,
    };
  }
  return { ok: true, path };
}

/**
 * @param {string} state
 * @param {string} name
 * @param {string} line
 */
export function logLine(state, name, line) {
  appendFileSync(join(state, name), `${line}\n`);
}

/**
 * @typedef {{
 *   state: string,
 *   config: Record<string, unknown>,
 *   args: string[],
 *   log: (name: string, line: string) => void,
 *   readJson: (file: string) => any,
 *   writeJson: (file: string, value: unknown) => void,
 * }} FakeContext
 */

/**
 * @param {string} state
 * @param {Record<string, unknown>} config
 * @returns {FakeContext}
 */
function makeContext(state, config) {
  return {
    state,
    config,
    args: process.argv.slice(3),
    log: (name, line) => logLine(state, name, line),
    readJson: (file) => JSON.parse(readFileSync(join(state, file), "utf8")),
    writeJson: (file, value) =>
      writeFileSync(join(state, file), JSON.stringify(value)),
  };
}

/**
 * The whole outer shell of a lifecycle fake: state guard, config load, role
 * dispatch, and the unknown-role trap. Each fake supplies only its two role
 * bodies, so the branch structure cannot drift between them.
 *
 * It deliberately does NOT own either role's unmatched-command trap. A shared
 * gatekeeper could let an unhandled configured value fall past every branch
 * into the real adapter — the defect PR 11.2b patched by hand, and the reason
 * respondToListing above returns a boolean instead of exiting.
 *
 * @param {{
 *   kind: "install" | "uninstall" | "probe",
 *   codex: (ctx: FakeContext) => void,
 *   adapter: (ctx: FakeContext) => void,
 * }} fake
 * @returns {void}
 */
export function runFake(fake) {
  const state = process.env.SPW_FIXTURE_STATE;
  if (!state) {
    process.stderr.write("fixture: SPW_FIXTURE_STATE is unset\n");
    process.exitCode = 90;
    return;
  }
  const config = loadFixtureConfig(fake.kind, state);
  if (config.__failed) {
    // loadFixtureConfig already set the exit code and wrote the diagnostic.
    // Running a role body here would execute fake logic against defaults
    // rather than the config the case asked for.
    return;
  }
  const ctx = makeContext(state, config);
  const role = process.argv[2];
  if (role === "codex") {
    fake.codex(ctx);
    return;
  }
  if (role === "adapter") {
    fake.adapter(ctx);
    return;
  }
  process.stderr.write(`fixture: unknown role: ${String(role)}\n`);
  process.exitCode = 98;
}

/**
 * Decision 5 injection toggle: the fake commits the forbidden act so every
 * guard that is load-bearing turns RED. A guard that stays GREEN under this is
 * a boundary guard and must be adjudicated in the inventory, never "proved" by
 * breaking its own text.
 *
 * The forbidden line is a PARAMETER, not a constant: install injects a spurious
 * `plugin add` and uninstall a spurious `plugin remove`, and a shared constant
 * would quietly disarm one of them.
 *
 * @param {FakeContext} ctx
 * @param {string} forbiddenLine
 * @returns {void}
 */
export function injectSpuriousMutation(ctx, forbiddenLine) {
  if (ctx.config.spuriousMutation) ctx.log("codex.log", forbiddenLine);
}

/**
 * The adapter role's tripwire. Slice 4b is its first genuine consumer (matrix
 * row 18): once install/update/uninstall dispatch in-process, runAdapter is a
 * function call and this executable must never be reached.
 *
 * It fires unconditionally, and there is no mode that switches it off.
 * Post-flip every command dispatches in-process, so `runAdapter` is a plain
 * function call and no role — install, uninstall or probe — can legitimately
 * reach this executable. Nothing is left for a gate to select on, which is why
 * all three adapter-role fakes call this the same way.
 *
 * A caller with anything after this call MUST `return` on true. Setting
 * `process.exitCode` does not halt execution, so a missing return falls
 * through into whatever follows. No caller has anything following today — all
 * three adapter roles end with this call and discard the result — so the rule
 * binds the next statement anyone adds, not any code that exists.
 *
 * @param {FakeContext} ctx
 * @param {{ message?: string }} [options]
 * @returns {boolean} true when the caller must stop
 */
export function tripwireTriggered(ctx, options = {}) {
  const { message } = options;
  process.stderr.write(
    `${message ?? "fixture: this command must not spawn the adapter"}\n`,
  );
  process.exitCode = 94;
  return true;
}

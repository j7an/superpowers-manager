// @ts-check
// Shared read-side behaviour for the three lifecycle fake executables
// (install-fakes.js, uninstall-fakes.js, probe-fakes.js). Extracted in PR 11.5
// slice 2, whose fake `codex` for probe is the "third lifecycle fake" the
// parent spec named as this extraction's trigger.
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
 *   inspect --view fingerprint -> plugin list --json          (src/adapter.ts:781)
 *   inspect --view ownership   -> plugin list --json,         (src/adapter.ts:855)
 *                                 plugin marketplace list --json  (:867)
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

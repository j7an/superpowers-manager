// @ts-check
// Executable, never imported. A two-line sh wrapper written by
// lifecycle-fixture.js execs this as either `codex` or `adapter`.
// Replaces the shell fake codex at tests/test_uninstall_commands.sh:28-84 and
// the recording adapter at :87-98, including their two python3 heredocs.

import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { schemaFor, validateConfig } from "./lifecycle-config.js";

if (!process.env.SPW_FIXTURE_STATE) {
  process.stderr.write("fixture: SPW_FIXTURE_STATE is unset\n");
  process.exit(90);
}
const STATE = /** @type {string} */ (process.env.SPW_FIXTURE_STATE);

/**
 * Loads and re-validates the per-case config. `createCase` already validated
 * it eagerly; this is defence in depth, and it is what makes a hand-written
 * config.json (as the defence-in-depth self-test writes) fail closed too.
 * The schema lives in lifecycle-config.js so exactly one definition governs
 * both the eager check and this one.
 * @returns {Record<string, unknown>}
 */
function loadConfig() {
  const { defaults } = schemaFor("uninstall");
  let raw;
  try {
    raw = readFileSync(join(STATE, "config.json"), "utf8");
  } catch {
    process.stderr.write(
      `fixture: cannot read ${join(STATE, "config.json")}\n`,
    );
    process.exit(91);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write("fixture: config.json is not valid JSON\n");
    process.exit(92);
  }
  try {
    validateConfig("uninstall", parsed);
  } catch (error) {
    process.stderr.write(`fixture: ${/** @type {Error} */ (error).message}\n`);
    process.exit(93);
  }
  return { ...defaults, ...parsed };
}

const CONFIG = loadConfig();
const ROLE = process.argv[2];
const ARGS = process.argv.slice(3);

/**
 * @param {string} name
 * @param {string} line
 */
function log(name, line) {
  appendFileSync(join(STATE, name), `${line}\n`);
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
  if (a === "plugin" && b === "list") {
    process.stdout.write(readFileSync(join(STATE, "plugin_list.json"), "utf8"));
    process.exit(/** @type {number} */ (CONFIG.pluginListRc));
  }
  if (a === "plugin" && b === "marketplace" && c === "list") {
    process.stdout.write(
      readFileSync(join(STATE, "marketplace_list.json"), "utf8"),
    );
    process.exit(/** @type {number} */ (CONFIG.marketplaceListRc));
  }
  if (a === "plugin" && b === "remove") {
    if (!CONFIG.removesMutateState) process.exit(0);
    if (CONFIG.pluginRemove === "missing-installed") {
      writeJson("plugin_list.json", { available: [] });
      process.exit(0);
    }
    const data = readJson("plugin_list.json");
    data.installed = data.installed.filter(
      (/** @type {{pluginId?: string}} */ item) => item.pluginId !== c,
    );
    writeJson("plugin_list.json", data);
    process.exit(0);
  }
  if (a === "plugin" && b === "marketplace" && c === "remove") {
    if (CONFIG.marketplaceRemove === "fail") {
      process.stderr.write("marketplace remove exploded\n");
      process.exit(1);
    }
    if (CONFIG.removesMutateState) {
      const data = readJson("marketplace_list.json");
      data.marketplaces = data.marketplaces.filter(
        (/** @type {{name?: string}} */ item) => item.name !== ARGS[3],
      );
      writeJson("marketplace_list.json", data);
    }
    process.exit(0);
  }
  process.exit(0);
}

function runAdapter() {
  log("adapter.log", ARGS.join(" "));
  if (ARGS.join(" ") === "inspect --view update-control") {
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
    process.exit(0);
  }
  // Everything else runs the REAL adapter, exactly as the shell fixture did
  // (tests/test_uninstall_commands.sh:97). build, install, uninstall, and
  // ownership inspection are production code in every case.
  const pkgRoot = process.env.SPW_TEST_PKG_ROOT;
  if (!pkgRoot) {
    process.stderr.write("fixture: SPW_TEST_PKG_ROOT is unset\n");
    process.exit(95);
  }
  const real = join(pkgRoot, "scripts", "adapters", "codex", "adapter");
  if (!existsSync(real)) {
    process.stderr.write(`fixture: real adapter is missing at ${real}\n`);
    process.exit(96);
  }
  const result = spawnSync(real, ARGS, { stdio: "inherit", env: process.env });
  process.exit(result.status ?? 97);
}

if (ROLE === "codex") runCodex();
else if (ROLE === "adapter") runAdapter();
else {
  process.stderr.write(`fixture: unknown role: ${String(ROLE)}\n`);
  process.exit(98);
}

// @ts-check
// Executable, never imported. A two-line sh wrapper written by
// lifecycle-fixture.js execs this as either `codex` or `adapter`.
// Replaces the shell fake codex at tests/test_install_commands.sh:101-169 and
// the recording adapter at :171-221.

import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
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
 * config.json (as tests/bin/lifecycle-fixture.test.js writes) fail closed too.
 * The schema lives in lifecycle-config.js so exactly one definition governs
 * both the eager check and this one.
 * @returns {Record<string, unknown>}
 */
function loadConfig() {
  const { defaults } = schemaFor("install");
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
    validateConfig("install", parsed);
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
    log("codex.log", "plugin add superpowers@spurious");
  }

  const pkgRoot = process.env.SPW_TEST_PKG_ROOT;
  const [a, b, c, d] = ARGS;

  if (ARGS.length === 3 && a === "plugin" && b === "list" && c === "--json") {
    process.stdout.write(readFileSync(join(STATE, "plugin_list.json"), "utf8"));
    process.exit(/** @type {number} */ (CONFIG.pluginListRc));
  }
  if (
    ARGS.length === 4 &&
    a === "plugin" &&
    b === "marketplace" &&
    c === "list" &&
    d === "--json"
  ) {
    process.stdout.write(
      readFileSync(join(STATE, "marketplace_list.json"), "utf8"),
    );
    process.exit(/** @type {number} */ (CONFIG.marketplaceListRc));
  }
  if (
    ARGS.length === 4 &&
    a === "plugin" &&
    b === "marketplace" &&
    c === "add" &&
    d === pkgRoot
  ) {
    if (CONFIG.marketplaceAdd === "fail") process.exit(1);
    const data = readJson("marketplace_list.json");
    data.marketplaces = data.marketplaces.filter(
      (/** @type {{name?: string}} */ item) =>
        item.name !== "superpowers-manager",
    );
    data.marketplaces.push({ name: "superpowers-manager", root: d });
    writeJson("marketplace_list.json", data);
    process.exit(0);
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
    process.exit(0);
  }
  if (
    ARGS.length === 3 &&
    a === "plugin" &&
    b === "add" &&
    c === "superpowers@superpowers-manager"
  ) {
    if (CONFIG.pluginAdd === "fail") process.exit(1);
    if (CONFIG.pluginAdd === "noop") process.exit(0);
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
    process.exit(0);
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
    process.exit(0);
  }
  process.stderr.write(`unexpected fake Codex command: ${ARGS.join(" ")}\n`);
  process.exit(99);
}

function runAdapter() {
  log("adapter.log", ARGS.join(" "));
  const joined = ARGS.join(" ");

  if (joined === "inspect --view update-control") {
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
      process.exit(0);
    }
    if (updateControl === "malformed") {
      process.stdout.write("{");
      process.exit(0);
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
      process.exit(1);
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
    process.exit(99);
  }

  // The fingerprint intercept is conditioned on the plugin cache existing.
  // Without that condition it fires before the cache exists (fresh install,
  // legacy-state cases) and silently changes what several later
  // verification cases mean.
  if (
    joined === "inspect --view fingerprint" &&
    existsSync(
      join(STATE, "codex-home", "plugins", "cache", "superpowers-manager"),
    )
  ) {
    if (CONFIG.fingerprintInspect === "fail") {
      process.stderr.write(
        "fingerprint inspection failed in adapter fixture\n",
      );
      process.exit(99);
    }
    if (CONFIG.fingerprintInspect === "malformed") {
      process.stdout.write("{");
      process.exit(0);
    }
  }

  // Everything else runs the REAL adapter, exactly as the shell fixture did
  // (tests/test_install_commands.sh:220). build, install, ownership
  // inspection, and an "ok" fingerprint inspection are production code in
  // every case.
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

// @ts-check
// Non-test helper. Shared by tests/baseline/probe.test.js and, from Task 6,
// by tests/baseline/cli-parity.test.js's PROBE-READONLY-01 rewrite.
//
// This is NOT a *.test.js file, deliberately: tests/run-node-suites.js:15
// registers every top-level *.test.js under tests/{bin,unit,baseline}, so a
// suite imported as a helper re-executes and re-registers its own tests
// inside the importer. tests/baseline/support.js and
// tests/bin/lifecycle-fixture.js are the same shape for the same reason.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capture } from "../unit/helpers/command-harness.js";
import { UPSTREAM } from "../bin/lifecycle-fixture.js";

/**
 * `createCase`'s return type, referenced as a type only. Naming the typedef
 * rather than importing `createCase` for a `ReturnType<>` keeps this module
 * free of a value import it never calls.
 * @typedef {import("../bin/lifecycle-fixture.js").CaseEnv} CaseEnv
 */

/**
 * Every environment name runProbe's dependencies read. Declared, never
 * derived: a predicate would also accept an env that lost a name.
 * runAdapter merges process.env (src/adapter.ts:977) and runGit spreads it
 * (src/git.ts:31), so an unset name here leaks the developer's shell into a
 * supposedly hermetic case.
 */
export const REQUIRED_ENV = [
  "HOME",
  "TMPDIR",
  "PATH",
  "SUPERPOWERS_CONFIG_DIR",
  "SUPERPOWERS_CODEX",
  "SUPERPOWERS_INSTALLED_SEARCH_ROOT",
];

/**
 * Task 6's PROBE-READONLY-01 rewrite reuses this rather than writing a second
 * copy that could drift from the hermeticity requirement.
 * @param {CaseEnv} c
 * @param {Record<string, string>} [extra]
 * @returns {NodeJS.ProcessEnv}
 */
export function caseEnv(c, extra = {}) {
  return {
    HOME: c.home,
    TMPDIR: c.tmp,
    PATH: process.env.PATH ?? "",
    SUPERPOWERS_CONFIG_DIR: join(c.home, ".config", "superpowers-manager"),
    SUPERPOWERS_CODEX: c.codexBin,
    SUPERPOWERS_INSTALLED_SEARCH_ROOT: join(c.home, ".codex"),
    // Fixture plumbing, not a production name, so it is deliberately absent
    // from REQUIRED_ENV: the fake codex reads it to find its per-case JSON
    // (tests/bin/probe-fakes.js:12-16) exactly as runScript supplies it for
    // the spawned lifecycle ports (tests/bin/lifecycle-fixture.js:254).
    // runAdapter execs the fake with `{...process.env, ...ctx.env}`
    // (src/adapter.ts:977), so this is the only channel that reaches it.
    // Omitting it is loud, not silent -- the fake exits 90 with
    // `fixture: SPW_FIXTURE_STATE is unset` -- which is why the declared
    // hermeticity guard does not need to cover it.
    SPW_FIXTURE_STATE: c.state,
    ...extra,
  };
}

// The fixture upstream's annotated `v1.0.0` tag commit, read from the fixture
// itself rather than hardcoded: the repository is rebuilt on every run, so a
// literal SHA would be a claim about state this file does not own.
export const DESIRED = /** @type {string} */ (
  (() => {
    const rev = spawnSync(
      "git",
      ["-C", UPSTREAM, "rev-list", "-n", "1", "v1.0.0"],
      { encoding: "utf8" },
    );
    assert.equal(
      rev.status,
      0,
      `cannot read the fixture tag commit: ${rev.stderr}`,
    );
    return rev.stdout.trim();
  })()
);
export const SHORT = DESIRED.slice(0, 7);

/**
 * Seeds a case's Codex listings and its installed plugin tree.
 *
 * `pluginListings` is an ARRAY, one entry per `codex plugin list --json`
 * invocation, in order (amended 2026-08-07 after adjudication finding 3).
 * Probe issues that command twice per run and the two calls need different
 * answers -- `inspect --view fingerprint` (src/adapter.ts:797) then
 * `inspect --view ownership` (:871). With a single listing, a manager version
 * present for `installed_commit` also forces `identity_state=manager`, so
 * scenario 1 and the four-state identity matrix could not be written at all.
 * The fake fails closed if a run asks for more listings than are configured,
 * so a miscounted fixture is loud rather than silently wrong -- see
 * `nextPluginList` in `tests/bin/lifecycle-fakes.js`.
 *
 * @param {CaseEnv} c
 * @param {{
 *   pluginListings?: string[],
 *   marketplaces?: string,
 *   manifestVersion?: string | null,
 *   installedProvenance?: string | null,
 * }} [state]
 */
export function seedCodex(c, state = {}) {
  const listings = state.pluginListings ?? [
    '{"installed":[]}',
    '{"installed":[]}',
  ];
  listings.forEach((body, index) => {
    writeFileSync(join(c.state, `plugin_list.${index}.json`), body, "utf8");
  });
  writeFileSync(
    join(c.state, "marketplace_list.json"),
    state.marketplaces ?? '{"marketplaces":[]}',
    "utf8",
  );
  if (state.manifestVersion !== undefined && state.manifestVersion !== null) {
    const root = join(
      c.home,
      ".codex",
      "plugins",
      "cache",
      "superpowers-manager",
      "superpowers",
      state.manifestVersion,
    );
    mkdirSync(join(root, ".codex-plugin"), { recursive: true });
    writeFileSync(
      join(root, ".codex-plugin", "plugin.json"),
      `{"name":"superpowers","version":"${state.manifestVersion}"}`,
      "utf8",
    );
    if (
      state.installedProvenance !== undefined &&
      state.installedProvenance !== null
    ) {
      writeFileSync(
        join(root, ".superpowers-upstream.json"),
        state.installedProvenance,
        "utf8",
      );
    }
  }
}

/**
 * Writes the generated tree's provenance under a case's package root.
 * @param {CaseEnv} c
 * @param {string} body
 */
export function seedGenerated(c, body) {
  const dir = join(c.pkg, "plugins", "superpowers");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".superpowers-upstream.json"), body, "utf8");
}

/**
 * probe-fixture.js loads runProbe from dist/ itself rather than taking it as
 * a parameter, so both importing suites drive the same entry point.
 * @type {typeof import("../../src/commands/probe.js")}
 */
const { runProbe } = await import(
  new URL("../../dist/commands/probe.js", import.meta.url).href
);
/** @type {typeof import("../../src/adapter.js")} */
const { runAdapter } = await import(
  new URL("../../dist/adapter.js", import.meta.url).href
);

/**
 * @typedef {{ status: number, stdout: string, stderr: string }} ProbeRun
 */

/**
 * @param {CaseEnv} c
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<ProbeRun>}
 */
async function invoke(c, argv, env) {
  const out = capture();
  const err = capture();
  const status = await runProbe(argv, {
    root: c.pkg,
    env,
    stdout: out.stream,
    stderr: err.stream,
    // Real, not a double: this fixture's cases carry their own fake `codex`
    // on PATH (via `env`), and runProbe must reach it exactly as it did
    // before ctx.adapter existed.
    adapter: runAdapter,
  });
  return { status, stdout: out.text(), stderr: err.text() };
}

/**
 * An environment-selected run: SUPERPOWERS_REF is the fixture tag's commit and
 * SUPERPOWERS_UPSTREAM_URL is the fixture upstream. A 40-hex requested ref is
 * a `raw-commit` resolution (src/upstream.ts:160-162), so this shape reaches
 * no Git process at all.
 * @param {CaseEnv} c
 * @param {string[]} argv
 * @param {Record<string, string>} [extra]
 * @returns {Promise<ProbeRun>}
 */
export async function probe(c, argv, extra = {}) {
  return invoke(
    c,
    argv,
    caseEnv(c, {
      SUPERPOWERS_REF: DESIRED,
      SUPERPOWERS_UPSTREAM_URL: UPSTREAM,
      ...extra,
    }),
  );
}

/**
 * A saved-selection run: neither SUPERPOWERS_REF nor SUPERPOWERS_UPSTREAM_URL
 * is set, so selection comes from `selection.json` or the package default.
 * The hermeticity contract is "both names or neither" -- a run with only one
 * of them set would take a precedence branch no scenario here means to test.
 * @param {CaseEnv} c
 * @param {string[]} argv
 * @param {Record<string, string>} [extra]
 * @returns {Promise<ProbeRun>}
 */
export async function probeSaved(c, argv, extra = {}) {
  return invoke(c, argv, caseEnv(c, extra));
}

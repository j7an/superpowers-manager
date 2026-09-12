// Non-test helper. Shared by tests/baseline/probe.test.js and, from Task 6,
// by tests/baseline/cli-parity.test.js's PROBE-READONLY-01 rewrite.
//
// This is NOT a *.test.js file, deliberately: `tests/run-node-suites.ts:14::const SUITE_DIRS = ["tests/bin", "tests/unit", "tests/baseline"]`
// registers every top-level *.test.js under tests/{bin,unit,baseline}, so a
// suite imported as a helper re-executes and re-registers its own tests
// inside the importer. tests/baseline/support.js and
// tests/bin/lifecycle-fixture.js are the same shape for the same reason.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  capture,
  observingCoordinator,
} from "../unit/helpers/command-harness.ts";
import { UPSTREAM } from "../bin/lifecycle-fixture.ts";
import { writeQualifiedCodexFixture } from "../lib/harnesses/codex/prepared-fixture.ts";
import { stageCodexMarketplace } from "../../src/harnesses/codex/marketplace.ts";
import { codexPaths } from "../../src/harnesses/codex/paths.ts";

/**
 * `createCase`'s return type, referenced as a type only. Naming the typedef
 * rather than importing `createCase` for a `ReturnType<>` keeps this module
 * free of a value import it never calls.
 */
export type CaseEnv = import("../bin/lifecycle-fixture.ts").CaseEnv;

/**
 * Every environment name runProbe's dependencies read. Declared, never
 * derived: a predicate would also accept an env that lost a name.
 * runCodexOperation merges process.env (`src/harnesses/codex/adapter.ts:1049::const env = { ...process.env, ...context.env };`) and runGit spreads it
 * (`src/git.ts:32::env: { ...process.env`), so an unset name here leaks the developer's shell into a
 * supposedly hermetic case.
 */
export const REQUIRED_ENV = [
  "HOME",
  "TMPDIR",
  "PATH",
  "CODEX_HOME",
  "SUPERPOWERS_CONFIG_DIR",
  "SUPERPOWERS_CODEX",
  "SUPERPOWERS_INSTALLED_SEARCH_ROOT",
  "SUPERPOWERS_PLUGIN_ROOT",
];

/**
 * Task 6's PROBE-READONLY-01 rewrite reuses this rather than writing a second
 * copy that could drift from the hermeticity requirement.
 */
export function caseEnv(
  c: CaseEnv,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    HOME: c.home,
    TMPDIR: c.tmp,
    PATH: process.env.PATH ?? "",
    CODEX_HOME: join(c.home, ".codex"),
    SUPERPOWERS_CONFIG_DIR: join(c.home, ".config", "superpowers-manager"),
    SUPERPOWERS_CODEX: c.codexBin,
    SUPERPOWERS_INSTALLED_SEARCH_ROOT: join(c.home, ".codex"),
    SUPERPOWERS_PLUGIN_ROOT: join(c.pkg, "plugins", "superpowers"),
    // Fixture plumbing, not a production name, so it is deliberately absent
    // from REQUIRED_ENV: the fake codex reads it to find its per-case JSON
    // (`tests/bin/lifecycle-fakes.ts:238::const state = process.env.SPW_FIXTURE_STATE`) exactly as runScript supplies it for
    // the spawned lifecycle ports (`tests/bin/lifecycle-fixture.ts:492::const env = {`).
    // runCodexOperation execs the fake with `{...process.env, ...ctx.env}`
    // (`src/harnesses/codex/adapter.ts:1049::const env = { ...process.env, ...context.env };`), so this is the only channel that reaches it.
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
export const DESIRED = (() => {
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
})() as string;
export const SHORT = DESIRED.slice(0, 7);

/**
 * Seeds a case's Codex listings and its installed plugin tree.
 *
 * `pluginListings` is an ARRAY, one entry per `codex plugin list --json`
 * invocation, in order (amended 2026-08-07 after adjudication finding 3).
 * Probe now issues that command for installed inspection, ownership, and the
 * installed coherence recheck. A two-entry fixture is expanded to repeat its
 * first installed response after ownership. With a single listing, a manager
 * version present for `installed_commit` also forces
 * `identity_state=manager`, so scenario 1 and the four-state identity matrix
 * could not be written at all.
 *
 * `marketplaceListings`, when present, is the corresponding explicit sequence
 * for `codex plugin marketplace list --json`. Without it the fake retains its
 * historical static `marketplaces` response.
 * The fake fails closed if a run asks for more listings than are configured,
 * so a miscounted fixture is loud rather than silently wrong -- see
 * `nextPluginList` in `tests/bin/lifecycle-fakes.js`.
 *
 */
export function seedCodex(
  c: CaseEnv,
  state: {
    pluginListings?: string[];
    marketplaceListings?: string[];
    marketplaces?: string;
    manifestVersion?: string | null;
    installedProvenance?: string | null;
  } = {},
) {
  const initialListings = state.pluginListings ?? [
    '{"installed":[]}',
    '{"installed":[]}',
  ];
  const listings =
    initialListings.length === 2
      ? [...initialListings, initialListings[0]!]
      : initialListings;
  listings.forEach((body, index) => {
    writeFileSync(join(c.state, `plugin_list.${index}.json`), body, "utf8");
  });
  state.marketplaceListings?.forEach((body, index) => {
    writeFileSync(
      join(c.state, `marketplace_list.${index}.json`),
      qualifyMarketplaceListing(c, body),
      "utf8",
    );
  });
  writeFileSync(
    join(c.state, "marketplace_list.json"),
    qualifyMarketplaceListing(c, state.marketplaces ?? '{"marketplaces":[]}'),
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
    const published = codexPaths(caseEnv(c), c.pkg).publishedPluginRoot;
    if (existsSync(published)) {
      cpSync(published, root, { recursive: true });
    } else {
      mkdirSync(join(root, ".codex-plugin"), { recursive: true });
      writeFileSync(
        join(root, ".codex-plugin", "plugin.json"),
        `{"name":"superpowers","version":"${state.manifestVersion}"}`,
        "utf8",
      );
    }
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

function qualifyMarketplaceListing(c: CaseEnv, body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { marketplaces?: unknown }).marketplaces)
  ) {
    return body;
  }
  const marketplaces = (parsed as { marketplaces: unknown[] }).marketplaces;
  return JSON.stringify({
    ...(parsed as Record<string, unknown>),
    marketplaces: marketplaces.map((entry) =>
      entry !== null &&
      typeof entry === "object" &&
      (entry as { name?: unknown }).name === "superpowers-manager"
        ? {
            ...(entry as Record<string, unknown>),
            root: codexPaths(caseEnv(c), c.pkg).marketplaceRoot,
          }
        : entry,
    ),
  });
}

/**
 * Writes the generated tree's provenance under a case's package root.
 */
export function seedGenerated(c: CaseEnv, body: string) {
  const dir = join(c.pkg, "plugins", "superpowers");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".superpowers-upstream.json"), body, "utf8");
}

/**
 * Writes a supported, receipt-bearing generated tree for status preconditions.
 * Raw provenance-only seeding remains separate for missing/malformed evidence.
 */
export async function seedQualifiedGenerated(
  c: CaseEnv,
  commit = DESIRED,
  source = UPSTREAM,
): Promise<void> {
  const artifact = await writeQualifiedCodexFixture(
    join(c.pkg, "plugins", "superpowers"),
    commit,
    source,
  );
  const paths = codexPaths(caseEnv(c), c.pkg);
  mkdirSync(paths.managerRoot, { recursive: true });
  await stageCodexMarketplace(artifact, c.pkg, paths.marketplaceRoot);
}

import { runProbe } from "../../src/commands/probe.ts";

import { codexHarness } from "../../src/harnesses/codex/harness.ts";

export type ProbeRun = { status: number; stdout: string; stderr: string };

async function invoke(
  c: CaseEnv,
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<ProbeRun> {
  const out = capture();
  const err = capture();
  const status = await runProbe(argv, {
    root: c.pkg,
    env,
    stdout: out.stream,
    stderr: err.stream,
    options: { harness: "codex", allowExperimental: false },
    coordination: observingCoordinator(),
    // Real, not a double: this fixture's cases carry their own fake `codex`
    // on PATH (via `env`), and runProbe must reach it exactly as it did
    // before ctx.adapter existed.
    adapter: codexHarness,
  });
  return { status, stdout: out.text(), stderr: err.text() };
}

/**
 * An environment-selected run: SUPERPOWERS_REF is the fixture tag's commit and
 * SUPERPOWERS_UPSTREAM_URL is the fixture upstream. A 40-hex requested ref is
 * a `raw-commit` resolution (`src/upstream.ts:162-163::if (COMMIT_INPUT_RE.test(requestedRef))`), so this shape reaches
 * no Git process at all.
 */
export async function probe(
  c: CaseEnv,
  argv: string[],
  extra: Record<string, string> = {},
): Promise<ProbeRun> {
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
 */
export async function probeSaved(
  c: CaseEnv,
  argv: string[],
  extra: Record<string, string> = {},
): Promise<ProbeRun> {
  return invoke(c, argv, caseEnv(c, extra));
}

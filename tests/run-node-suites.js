#!/usr/bin/env node
// @ts-check
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeBuildId } from "./build-id.js";

// The contract suite drives this runner against isolated fixture roots.
// Production callers never set this.
const ROOT = process.env.SPW_RUNNER_ROOT
  ? resolve(process.env.SPW_RUNNER_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, "tests", "suites.json");
const SUITE_DIRS = ["tests/bin", "tests/unit", "tests/baseline"];

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

// The suites execute dist/*.js while typechecking against src/*.ts, so a
// missing build produces misleading results rather than an obvious failure.
// Report, do not build: an implicit build hides staleness.
if (!existsSync(join(ROOT, "dist", "cli.js"))) {
  fail(
    "dist/cli.js is missing — run pnpm install --frozen-lockfile && pnpm run build",
  );
}

// Fixture roots have no dist/ built from these sources — the contract suite
// drives the runner against them via SPW_RUNNER_ROOT. Treat a fixture root as
// fresh by default, or every existing contract case fails for a reason
// unrelated to what it tests. A fixture opts in by writing dist/.build-id.
const buildIdPath = join(ROOT, "dist", ".build-id");
const isFixtureRoot = process.env.SPW_RUNNER_ROOT !== undefined;
if (!isFixtureRoot || existsSync(buildIdPath)) {
  let recorded;
  let expected;
  try {
    recorded = readFileSync(buildIdPath, "utf8");
    // Every hash input can fail — an unreadable source, a missing
    // tsconfig.json, a permission error. All of them fail closed with the
    // frozen line; none of them throws raw.
    expected = computeBuildId(ROOT);
  } catch {
    fail("dist/ is stale — run pnpm run build");
  }
  if (recorded !== expected) {
    fail("dist/ is stale — run pnpm run build");
  }
}

/** @type {unknown} */
let parsed;
try {
  parsed = JSON.parse(readFileSync(MANIFEST, "utf8"));
} catch {
  fail("tests/suites.json is missing or is not valid JSON");
}

if (
  typeof parsed !== "object" ||
  parsed === null ||
  !Array.isArray(/** @type {{suites?: unknown}} */ (parsed).suites)
) {
  fail("tests/suites.json must be an object with a `suites` array");
}
const declared = /** @type {{suites: unknown[]}} */ (parsed).suites;
if (!declared.every((entry) => typeof entry === "string")) {
  fail("every tests/suites.json entry must be a string");
}
const expected = /** @type {string[]} */ (declared);

const seen = new Set();
const repeated = [];
for (const name of expected) {
  if (seen.has(name)) repeated.push(name);
  seen.add(name);
}
if (repeated.length > 0) {
  fail(
    `tests/suites.json lists a suite more than once: ${[...new Set(repeated)].sort().join(", ")}`,
  );
}

const discovered = [];
for (const dir of SUITE_DIRS) {
  const absolute = join(ROOT, dir);
  if (!existsSync(absolute)) fail(`suite directory is missing: ${dir}`);
  /** @type {import("node:fs").Dirent[]} */
  let entries;
  try {
    entries = readdirSync(absolute, { withFileTypes: true });
  } catch {
    fail(`suite directory could not be read: ${dir}`);
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      fail(`suite entries may not be symlinks: ${dir}/${entry.name}`);
    }
    if (entry.isDirectory()) {
      // Nested test files typecheck but never run: the runners are
      // single-level and traceability.test.js only accepts flat Node
      // selectors. Nested non-test helpers are supported.
      /** @type {string[]} */
      let nested;
      try {
        nested = readdirSync(join(absolute, entry.name), {
          recursive: true,
        }).map((name) => String(name));
      } catch {
        // Unguarded, an unreadable subdirectory throws here and puts the raw
        // EACCES text plus a stack on stderr — the same leak the sibling
        // readdirSync above is wrapped to prevent.
        fail(`suite subdirectory could not be read: ${dir}/${entry.name}`);
      }
      const offenders = nested
        .filter((name) => name.endsWith(".test.js"))
        .map((name) => `${dir}/${entry.name}/${name}`)
        .sort();
      if (offenders.length > 0) {
        fail(
          `test files must be flat; move these up one level: ${offenders.join(", ")}`,
        );
      }
      continue;
    }
    if (entry.name.endsWith(".test.js"))
      discovered.push(`${dir}/${entry.name}`);
  }
}

const expectedSet = new Set(expected);
const discoveredSet = new Set(discovered);
const missing = expected.filter((s) => !discoveredSet.has(s)).sort();
const unregistered = discovered.filter((s) => !expectedSet.has(s)).sort();

if (missing.length > 0 || unregistered.length > 0) {
  const lines = [];
  if (missing.length > 0) {
    lines.push(
      `declared in tests/suites.json but absent from disk: ${missing.join(", ")}`,
    );
  }
  if (unregistered.length > 0) {
    lines.push(
      `present on disk but absent from tests/suites.json: ${unregistered.join(", ")}`,
    );
  }
  fail(`suite manifest does not match the test tree — ${lines.join("; ")}`);
}

// A manifest-registered suite that is a broken symlink is returned by
// readdirSync with isDirectory() === false and passes the set comparison
// above, so an unguarded lstatSync here throws a raw ENOENT with a stack —
// verified. No errno and no stack frame may reach either stream.
for (const suite of expected) {
  const absolute = join(ROOT, suite);
  let stats;
  try {
    stats = lstatSync(absolute);
  } catch {
    fail(`suite could not be inspected: ${suite}`);
  }
  // Unreachable by construction, not dead: `expected` here is filtered
  // through `discovered`, which the directory walk above populates only
  // after rejecting every symlink at the entry level. No symlink can reach
  // this loop today. Kept as a backstop in case discovery is ever reordered
  // so a declared suite could bypass the walk.
  if (stats.isSymbolicLink()) {
    fail(`suite entries may not be symlinks: ${suite}`);
  }
  if (!stats.isFile()) fail(`suite is not a regular file: ${suite}`);
}

if (expected.length === 0) fail("tests/suites.json declares no suites");

const ordered = [...expected].sort();

// A caller that itself runs under `node --test` (this runner is one such
// caller, since it is registered in its own manifest) has NODE_TEST_CONTEXT
// / NODE_TEST_WORKER_ID set in its process.env. Left in the child's env, the
// inner `node --test` invocation below misreads itself as a nested recursive
// test run and silently skips executing every file — exit 0 having run
// nothing, the exact silent pass this runner exists to prevent. Verified by
// reproduction. Strip both before spawning.
const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;
delete childEnv.NODE_TEST_WORKER_ID;
const result = spawnSync(process.execPath, ["--test", ...ordered], {
  cwd: ROOT,
  stdio: "inherit",
  env: childEnv,
});
if (result.error) fail("could not start the Node test runner");
process.exit(result.status ?? 1);

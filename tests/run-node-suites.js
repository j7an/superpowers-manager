#!/usr/bin/env node
// @ts-check
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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
  try {
    recorded = readFileSync(buildIdPath, "utf8");
  } catch {
    // dist/.build-id is absent or unreadable: dist/ was never built, or was
    // built by a postbuild predating the digest. `pnpm run build` is the
    // correct remedy here.
    fail("dist/ is stale — run pnpm run build");
  }
  let expected;
  try {
    expected = computeBuildId(ROOT);
  } catch {
    // NOT staleness, and `pnpm run build` cannot fix it. Six causes reach
    // here (tests/build-id.js:70, :76, :78, :38, :47, :55) — an unreadable
    // src/, an unreadable source file, a missing tsconfig.json, and an
    // unresolvable TypeScript install — and only the last is fixed by
    // `pnpm install --frozen-lockfile`. Naming any single remedy would
    // reintroduce the wrong-cause defect this split exists to fix, so name
    // the candidate inputs and prescribe nothing. Do not merge this back
    // into the readFileSync try above.
    fail(
      "cannot compute the expected build id for dist/ — one of src/, tsconfig.json, or node_modules/typescript could not be read or is malformed",
    );
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
      const nestedRoot = join(absolute, entry.name);
      /** @type {import("node:fs").Dirent[]} */
      let nested;
      try {
        nested = readdirSync(nestedRoot, {
          recursive: true,
          withFileTypes: true,
        });
      } catch {
        // Unguarded, an unreadable subdirectory throws here and puts the raw
        // EACCES text plus a stack on stderr — the same leak the sibling
        // readdirSync above is wrapped to prevent.
        fail(`suite subdirectory could not be read: ${dir}/${entry.name}`);
      }
      // Name-independent: a nested symlink is rejected regardless of what
      // it is named, not only when it happens to end in .test.js. Node does
      // not recurse *through* a symlinked directory when walking
      // recursively, so the symlink itself always surfaces here as its own
      // entry with isSymbolicLink() true.
      for (const nestedEntry of nested) {
        if (nestedEntry.isSymbolicLink()) {
          const fullPath = join(nestedEntry.parentPath, nestedEntry.name);
          fail(
            `suite entries may not be symlinks: ${relative(ROOT, fullPath)}`,
          );
        }
      }
      const offenders = nested
        .filter((nestedEntry) => nestedEntry.name.endsWith(".test.js"))
        .map((nestedEntry) =>
          relative(ROOT, join(nestedEntry.parentPath, nestedEntry.name)),
        )
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

// Resolved as a sibling of this file, never against ROOT: SPW_RUNNER_ROOT
// redirects ROOT into a fixture's temp directory, where no gate exists.
const gateUrl = new URL("./assert-matcher-gate.js", import.meta.url);
try {
  // A caught import, not an existence probe. Absent, unreadable, and
  // syntactically broken are three different failures and all three must
  // reach the same controlled diagnostic — an existence probe passes the last
  // two through to the child, which dies with a raw errno and a stack. Loading
  // it here is harmless: this process makes no assertions.
  await import(gateUrl.href);
} catch {
  // A silently absent gate is the exact failure mode this gate exists to
  // detect. Report it as its own diagnostic; never re-emit the caught error,
  // whose text carries errno and a stack.
  fail(
    "the assert matcher gate could not be loaded — tests/assert-matcher-gate.js must sit beside this runner, be readable, and evaluate cleanly",
  );
}

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
const result = spawnSync(
  process.execPath,
  ["--import", gateUrl.href, "--test", ...ordered],
  {
    cwd: ROOT,
    stdio: "inherit",
    env: childEnv,
  },
);
if (result.error) fail("could not start the Node test runner");
process.exit(result.status ?? 1);

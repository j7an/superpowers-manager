// @ts-check
// Guards the four hand-maintained tooling-path enumerations: the `lint`,
// `format`, and `format:check` path lists in package.json, and the `include`
// array in tests/tsconfig.json. Each leg asks the real tool what it covers
// rather than restating the enumeration — a canonical list in this file would
// be a fifth hand-maintained enumeration and would stay green for a directory
// nobody listed anywhere.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TOOL_BIN = join(ROOT, "node_modules", ".bin");

// SOURCE_EXTENSIONS is itself a hand-maintained enumeration — the fifth this
// file's header comment disclaims. A file that is both in a new, unlisted
// directory AND has an extension outside this list (e.g. tools/x.mts,
// tools/x.jsx) is invisible to all four legs; either condition alone is
// caught. Known, accepted gap — not fixed here.
const SOURCE_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts"];
const JAVASCRIPT_EXTENSIONS = [".js", ".mjs", ".cjs"];

// Layer 4 (tests/container.sh) runs this suite inside an image built with
// `COPY . .`, and .dockerignore deliberately excludes `.git`. The three legs
// below that ask git which files are version-controlled have no answer there:
// a container image is a copy of a checkout, not a checkout. The path-list
// identity leg reads package.json only and runs everywhere.
//
// This is a DECLARED scope, not a silent skip. The harness asserts the
// container by setting SPW_CONTAINER=1, and the declaration is verified below
// before it is honored — on a real checkout `.git` exists, so setting the
// variable there fails loudly instead of disabling the guard.
const DECLARED_CONTAINER = process.env.SPW_CONTAINER === "1";
const HOST_ONLY = DECLARED_CONTAINER
  ? "host-only: needs a git checkout; .git is excluded from the container image"
  : false;

void test("the container declaration matches the actual environment", () => {
  if (DECLARED_CONTAINER) {
    assert.ok(
      !existsSync(join(ROOT, ".git")),
      "SPW_CONTAINER=1 but .git is present — the container declaration is false, so the version-controlled legs must not be skipped",
    );
    return;
  }
  assert.ok(
    existsSync(join(ROOT, ".git")),
    "SPW_CONTAINER is unset but .git is absent — the version-controlled legs would fail for the wrong reason",
  );
});

/**
 * Run a tool and return its stdout. Never re-emit the caught error: it carries
 * errno and a stack, and this suite's whole point is controlled diagnostics.
 * @param {string} command
 * @param {string[]} args
 * @param {string} what
 * @returns {string}
 */
function capture(command, args, what) {
  try {
    return execFileSync(command, args, {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return assert.fail(
      `${what} could not be run — tooling coverage cannot be established`,
    );
  }
}

/**
 * Every tracked source file, repo-relative and sorted. Tracked files are the
 * right universe precisely because they need no exclusion list; a directory
 * walk would reintroduce the hand-maintained enumeration this guards against.
 * @returns {string[]}
 */
function universe() {
  // --cached --others --exclude-standard, never a plain `ls-files`: oxlint and
  // tsc reach every file their globs match, staged or not, so a universe of
  // tracked-only files disagrees with them for any unstaged new source file —
  // including this suite on its own first run.
  const output = capture(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    "git ls-files",
  );
  const files = output
    .split("\0")
    .filter(Boolean)
    .filter((path) => SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext)));
  // Without this, an empty universe would make every equality below pass
  // against an empty tool result — the vacuity this suite exists to prevent.
  assert.ok(
    files.length > 0,
    "git ls-files reported no source files — the coverage universe is empty",
  );
  return files.sort();
}

/** @type {{ scripts: Record<string, string> }} */
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/**
 * The trailing path list of a script command line: drop the program, then drop
 * leading flags. Everything after that must be a path.
 * @param {string} name
 * @returns {string[]}
 */
function pathListOf(name) {
  const script = manifest.scripts[name];
  assert.ok(typeof script === "string", `package.json has no ${name} script`);
  const afterProgram = script.trim().split(/\s+/).slice(1);
  let index = 0;
  while (index < afterProgram.length && afterProgram[index].startsWith("-")) {
    index += 1;
  }
  const paths = afterProgram.slice(index);
  assert.ok(paths.length > 0, `no path list found in the ${name} script`);
  for (const entry of paths) {
    assert.ok(
      !entry.startsWith("-"),
      `flag ${entry} appears after the ${name} path list began`,
    );
  }
  return paths;
}

/**
 * A tsconfig project's resolved file set, repo-relative and sorted.
 * `--showConfig` expands `include` globs into an explicit `files` array and
 * does not typecheck, so this is cheap and exact.
 * @param {string} project repo-relative path to the tsconfig
 * @param {string} projectDir repo-relative directory the entries resolve against
 * @returns {string[]}
 */
function resolvedProjectFiles(project, projectDir) {
  const raw = capture(
    join(TOOL_BIN, "tsc"),
    ["-p", project, "--showConfig"],
    `tsc --showConfig for ${project}`,
  );
  /** @type {{ files?: string[] }} */
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    return assert.fail(`tsc --showConfig for ${project} did not emit JSON`);
  }
  const files = config.files;
  assert.ok(
    Array.isArray(files) && files.length > 0,
    `tsc --showConfig for ${project} reported no resolved files`,
  );
  return files
    .map((entry) => relative(ROOT, resolve(join(ROOT, projectDir), entry)))
    .sort();
}

void test("every tracked source file is linted", { skip: HOST_ONLY }, () => {
  const reported = capture(
    join(TOOL_BIN, "oxlint"),
    ["--debug=files", ...pathListOf("lint")],
    "oxlint --debug=files",
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
  assert.deepEqual(reported, universe());
});

void test(
  "every tracked JavaScript file is typechecked by the tests project",
  { skip: HOST_ONLY },
  () => {
    const expected = universe().filter((path) =>
      JAVASCRIPT_EXTENSIONS.some((ext) => path.endsWith(ext)),
    );
    assert.deepEqual(
      resolvedProjectFiles("tests/tsconfig.json", "tests"),
      expected,
    );
  },
);

void test(
  "every tracked TypeScript file is typechecked by the build project",
  { skip: HOST_ONLY },
  () => {
    const expected = universe().filter((path) => path.endsWith(".ts"));
    assert.deepEqual(resolvedProjectFiles("tsconfig.json", "."), expected);
  },
);

// Prettier cannot enumerate its own file set — verified 2026-08-02 against
// prettier 3.9.6: `--list-different` prints only differing files and
// `--file-info` takes a single path. Identity to the lint list is therefore
// the strongest available binding, and it is weaker than the three legs above.
// A future change that legitimately wants prettier to cover .md or .json will
// break this and must relax it deliberately.
void test("lint, format, and format:check operate on the identical path list", () => {
  const lint = pathListOf("lint");
  assert.deepEqual(pathListOf("format"), lint);
  assert.deepEqual(pathListOf("format:check"), lint);
});

// The `prebuild` clean step is a behavior of `pnpm run build`, not a path list,
// and nothing else in the suite observes it: npm-pack-contents can only see a
// stale artifact if one already exists, which is never true of the clean
// checkout CI builds. So this leg reads the configured command from
// package.json — the source of truth, never a copy of it — and runs it against
// a throwaway tree. It never touches the repository's own dist/.
void test("the configured prebuild command removes dist/ before the build runs", () => {
  const prebuild = manifest.scripts.prebuild;
  assert.ok(
    typeof prebuild === "string" && prebuild.length > 0,
    "package.json declares no prebuild script, so `pnpm run build` no longer clears stale artifacts",
  );
  const dir = mkdtempSync(join(tmpdir(), "spw-prebuild-"));
  try {
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "stale-artifact.js"), "");
    const run = spawnSync(prebuild, {
      cwd: dir,
      shell: true,
      encoding: "utf8",
    });
    assert.equal(run.status, 0, `prebuild exited ${run.status}: ${run.stderr}`);
    assert.ok(
      !existsSync(join(dir, "dist")),
      "the prebuild command left dist/ in place, so a stale artifact would survive the build",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

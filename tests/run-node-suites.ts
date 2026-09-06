#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// The contract suite drives this runner against isolated fixture roots.
// Production callers never set this.
const ROOT = process.env.SPW_RUNNER_ROOT
  ? resolve(process.env.SPW_RUNNER_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, "tests", "suites.json");
const SUITE_DIRS = ["tests/bin", "tests/unit", "tests/baseline"];

type SuiteGroup = "unit" | "integration" | "repository";

interface SuiteEntry {
  path: string;
  group: SuiteGroup;
}

const groups = new Set<SuiteGroup>(["unit", "integration", "repository"]);

// Emitted on EVERY exit path, including failure. Absence of this line means the
// process was killed, which is the one thing a non-zero status cannot tell you.

function announce(status: number) {
  process.stdout.write(`run-node-suites: complete status=${status}\n`);
}

// `fail()` must not return, but it also must not call process.exit(), which
// would skip the announce above on some paths. A module-local sentinel error
// gives it a never-returns contract that the top level converts into a quiet
// exit -- the status is already on process.exitCode.
class RunnerExit extends Error {}

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  announce(1);
  process.exitCode = 1;
  throw new RunnerExit();
}

async function main() {
  let selectedGroup: string;
  let concurrency: string | undefined;
  let requirePackageNode = false;
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      strict: true,
      allowPositionals: false,
      options: {
        group: { type: "string", default: "all" },
        concurrency: { type: "string" },
        "require-package-node": { type: "boolean", default: false },
      },
    });
    selectedGroup = values.group ?? "all";
    concurrency = values.concurrency;
    requirePackageNode = values["require-package-node"] ?? false;
  } catch {
    fail(
      "usage: tests/run-node-suites.ts [--group unit|integration|repository|all] [--concurrency N] [--require-package-node]",
    );
  }
  if (
    concurrency !== undefined &&
    (!/^[1-9][0-9]*$/.test(concurrency) ||
      !Number.isSafeInteger(Number(concurrency)))
  ) {
    fail("test concurrency must be a positive safe integer");
  }
  const concurrencyArgs =
    concurrency === undefined ? [] : ["--test-concurrency", concurrency];
  if (selectedGroup !== "all" && !groups.has(selectedGroup as SuiteGroup)) {
    fail("unknown suite group; expected unit, integration, repository, or all");
  }
  if (requirePackageNode && selectedGroup !== "all") {
    fail("--require-package-node requires --group all");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(MANIFEST, "utf8"));
  } catch {
    fail("tests/suites.json is missing or is not valid JSON");
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { suites?: unknown }).suites)
  ) {
    fail("tests/suites.json must be an object with a `suites` array");
  }
  const declared = (parsed as { suites: unknown[] }).suites;
  const entries: SuiteEntry[] = [];
  for (const entry of declared) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      Object.keys(entry).length !== 2 ||
      !("path" in entry) ||
      !("group" in entry)
    ) {
      fail(
        "every tests/suites.json entry must be an object with exactly `path` and `group`",
      );
    }
    if (typeof entry.path !== "string" || entry.path.length === 0) {
      fail("every tests/suites.json entry path must be a nonempty string");
    }
    if (
      typeof entry.group !== "string" ||
      !groups.has(entry.group as SuiteGroup)
    ) {
      fail(
        "every tests/suites.json entry group must be unit, integration, or repository",
      );
    }
    entries.push(entry as SuiteEntry);
  }
  const expected = entries.map((entry) => entry.path);

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

    let entries: import("node:fs").Dirent[];
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

        let nested: import("node:fs").Dirent[];
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
          .filter((nestedEntry) => nestedEntry.name.endsWith(".test.ts"))
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
      if (entry.name.endsWith(".test.ts"))
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

  const ordered = entries
    .filter((entry) => selectedGroup === "all" || entry.group === selectedGroup)
    .map((entry) => entry.path)
    .sort();
  if (ordered.length === 0) fail("requested suite group declares no suites");

  // Resolved as a sibling of this file, never against ROOT: SPW_RUNNER_ROOT
  // redirects ROOT into a fixture's temp directory, where no gate exists.
  const gateUrl = new URL("./assert-matcher-gate.ts", import.meta.url);
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
      "the assert matcher gate could not be loaded — tests/assert-matcher-gate.ts must sit beside this runner, be readable, and evaluate cleanly",
    );
  }

  if (requirePackageNode) {
    if (!ordered.includes("tests/baseline/packaged-cli.test.ts")) {
      fail(
        "--require-package-node requires tests/baseline/packaged-cli.test.ts in the selected suites",
      );
    }

    let resolver: typeof import("./lib/package-runtime.ts").resolvePackageNode;
    try {
      resolver = (await import("./lib/package-runtime.ts")).resolvePackageNode;
    } catch {
      fail("package runtime helper could not be loaded");
    }

    let rootManifest: unknown;
    try {
      rootManifest = JSON.parse(
        readFileSync(join(ROOT, "package.json"), "utf8"),
      );
    } catch {
      fail("package.json could not be read as valid JSON");
    }
    const packageEngine =
      typeof rootManifest === "object" &&
      rootManifest !== null &&
      "engines" in rootManifest &&
      typeof rootManifest.engines === "object" &&
      rootManifest.engines !== null &&
      "node" in rootManifest.engines &&
      typeof rootManifest.engines.node === "string"
        ? rootManifest.engines.node
        : undefined;
    if (packageEngine === undefined) {
      fail("package.json engines.node is missing or invalid");
    }

    const resolverDiagnostics = new Set([
      "SPW_PACKAGE_NODE and SPW_PACKAGE_NODE_VERSION are required together",
      "SPW_PACKAGE_NODE must be an absolute executable path",
      "package.json engines.node does not declare a supported package minimum",
      "SPW_PACKAGE_NODE_VERSION must match the declared package minimum",
      "SPW_PACKAGE_NODE could not be verified",
      "SPW_PACKAGE_NODE does not report the declared package minimum",
    ]);
    try {
      resolver(process.env, true, packageEngine);
    } catch (error) {
      if (error instanceof Error && resolverDiagnostics.has(error.message)) {
        fail(error.message);
      }
      fail("package runtime validation failed");
    }
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
    ["--import", gateUrl.href, "--test", ...concurrencyArgs, ...ordered],
    {
      cwd: ROOT,
      stdio: "inherit",
      env: childEnv,
    },
  );
  if (result.error) fail("could not start the Node test runner");
  const status = result.status ?? 1;
  announce(status);
  process.exitCode = status;
}

try {
  await main();
} catch (error) {
  // `fail()` throws RunnerExit after announcing and setting process.exitCode.
  if (error instanceof RunnerExit) {
    // already announced
  } else {
    // BACKSTOP, not a covered branch. Every parent-side failure above is
    // funnelled through fail(), so nothing this module can be fed reaches here
    // today -- the same standing as the symlink check at :201-205. Kept because
    // an unexpected defect is still a run that REACHED ITS END: announce before
    // rethrowing, or the sentinel's absence -- which the whole plan defines as
    // "this process was killed" -- would also mean "the runner threw", and the
    // two would be indistinguishable again. The stack still propagates. No test
    // asserts this branch; a case that entered a different path and read the
    // tail's sentinel would be a control that cannot fail.
    process.exitCode = 1;
    announce(1);
    throw error;
  }
}

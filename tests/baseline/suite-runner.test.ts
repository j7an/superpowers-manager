import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { shQuote } from "../lib/git-egress.ts";

const RUNNER = fileURLToPath(new URL("../run-node-suites.ts", import.meta.url));
const RUN_SH = fileURLToPath(new URL("../run.sh", import.meta.url));

const PASSING_SUITE = 'import test from "node:test";\ntest("ok", () => {});\n';
const FAILING_SUITE =
  'import test from "node:test";\ntest("no", () => { throw new Error("x"); });\n';
const EXECUTED_SUITE =
  'import test from "node:test";\ntest("executed", () => console.log("EXECUTED:fixture"));\n';

type SuiteGroup = "unit" | "integration" | "repository";

interface SuiteEntry {
  path: string;
  group: SuiteGroup;
}

/**
 * Build an isolated fake repository root.
 */
function fakeRoot(
  t: import("node:test").TestContext,
  shape: {
    suites: Array<string | SuiteEntry>;
    files: Record<string, string>;
  },
) {
  const root = mkdtempSync(join(tmpdir(), "spw-runner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, "package.json"),
    '{"type":"module","engines":{"node":">=24"}}\n',
  );
  for (const dir of ["tests/bin", "tests/unit", "tests/baseline"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  for (const [relative, contents] of Object.entries(shape.files)) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, "utf8");
  }
  const suites = shape.suites.map((entry) =>
    typeof entry === "string" ? { path: entry, group: "unit" } : entry,
  );
  writeFileSync(
    join(root, "tests", "suites.json"),
    JSON.stringify({ suites }, null, 2),
    "utf8",
  );
  return root;
}

function runIn(
  root: string,
  extraEnv: Record<string, string> = {},
  args: string[] = [],
) {
  const env = { ...process.env };
  delete env.SPW_PACKAGE_NODE;
  delete env.SPW_PACKAGE_NODE_VERSION;
  const result = spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...env, ...extraEnv, SPW_RUNNER_ROOT: root },
    // A harness with no bound cannot assert prompt termination, and every case
    // in this file that asserts a status would read a kill as that status.
    timeout: 30000,
  });
  return {
    status: result.status ?? 1,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function assertNoRawFailure(r: { stdout: string; stderr: string }) {
  for (const stream of [r.stdout, r.stderr]) {
    assert.doesNotMatch(stream, /ENOENT|EACCES|ENOTDIR|errno/);
    assert.doesNotMatch(stream, /\n\s+at /);
    assert.doesNotMatch(stream, /Traceback/);
  }
}

function writeManifest(root: string, suites: unknown[]) {
  writeFileSync(
    join(root, "tests", "suites.json"),
    JSON.stringify({ suites }, null, 2),
    "utf8",
  );
}

function assertRejectedWithoutExecution(
  result: ReturnType<typeof runIn>,
  diagnostic: RegExp,
) {
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.match(result.stderr, diagnostic);
  assert.doesNotMatch(result.stdout + result.stderr, /EXECUTED:/);
  assertNoRawFailure(result);
}

function packageNodeEvidence(
  root: string,
  observedVersion = "24.0.0",
): Record<string, string> {
  const binary = join(root, "package-node");
  writeFileSync(
    binary,
    `#!/bin/sh\nprintf '%s\\n' ${shQuote(`v${observedVersion}`)}\n`,
    { mode: 0o755 },
  );
  return {
    SPW_PACKAGE_NODE: binary,
    SPW_PACKAGE_NODE_VERSION: "24.0.0",
  };
}

void test("group selection executes only members and all executes the union once", (t) => {
  const entries = [
    { path: "tests/unit/a.test.ts", group: "unit" },
    { path: "tests/baseline/b.test.ts", group: "integration" },
    { path: "tests/bin/c.test.ts", group: "repository" },
  ] satisfies SuiteEntry[];
  const files = Object.fromEntries(
    entries.map((entry) => [
      entry.path,
      `import test from "node:test"; test(${JSON.stringify(entry.group)}, () => console.log(${JSON.stringify(`EXECUTED:${entry.group}`)}));`,
    ]),
  );
  const root = fakeRoot(t, { suites: entries, files });
  for (const group of ["unit", "integration", "repository", "all"]) {
    const result = runIn(root, {}, ["--group", group]);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    for (const entry of entries) {
      const count = result.stdout.split(`EXECUTED:${entry.group}`).length - 1;
      assert.equal(count, group === "all" || entry.group === group ? 1 : 0);
    }
  }
});

void test("registered nested suites execute in their declared group", (t) => {
  const selected = "tests/unit/harnesses/codex/nested.test.ts";
  const excluded = "tests/unit/harnesses/pi/excluded.test.ts";
  const root = fakeRoot(t, {
    suites: [
      { path: selected, group: "integration" },
      { path: excluded, group: "unit" },
    ],
    files: {
      [selected]: EXECUTED_SUITE,
      [excluded]: FAILING_SUITE,
    },
  });
  const result = runIn(root, {}, ["--group", "integration"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /EXECUTED:fixture/);
  assert.match(result.stdout, /run-node-suites: complete status=0/);
  assertNoRawFailure(result);
});

void test("run.sh forwards group selection to the Node suite runner", (t) => {
  const entries = [
    { path: "tests/unit/a.test.ts", group: "unit" },
    { path: "tests/baseline/b.test.ts", group: "integration" },
  ] satisfies SuiteEntry[];
  const root = fakeRoot(t, {
    suites: entries,
    files: Object.fromEntries(
      entries.map((entry) => [
        entry.path,
        `import test from "node:test"; test(${JSON.stringify(entry.group)}, () => console.log(${JSON.stringify(`EXECUTED:${entry.group}`)}));`,
      ]),
    ),
  });
  const env = { ...process.env };
  delete env.SPW_PACKAGE_NODE;
  delete env.SPW_PACKAGE_NODE_VERSION;
  const result = spawnSync("sh", [RUN_SH, "--group", "unit"], {
    cwd: root,
    encoding: "utf8",
    env: { ...env, SPW_RUNNER_ROOT: root },
    timeout: 30000,
  });
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.split("EXECUTED:unit").length - 1, 1);
  assert.doesNotMatch(result.stdout, /EXECUTED:integration/);
});

void test("required package evidence rejects absence before suite execution", (t) => {
  const root = fakeRoot(t, {
    suites: [
      {
        path: "tests/baseline/packaged-cli.test.ts",
        group: "integration",
      },
    ],
    files: { "tests/baseline/packaged-cli.test.ts": EXECUTED_SUITE },
  });
  assertRejectedWithoutExecution(
    runIn(root, {}, ["--require-package-node"]),
    /SPW_PACKAGE_NODE and SPW_PACKAGE_NODE_VERSION are required together/,
  );
});

void test("required package evidence rejects a wrong advertised version", (t) => {
  const root = fakeRoot(t, {
    suites: [
      {
        path: "tests/baseline/packaged-cli.test.ts",
        group: "integration",
      },
    ],
    files: { "tests/baseline/packaged-cli.test.ts": EXECUTED_SUITE },
  });
  const env = packageNodeEvidence(root);
  env.SPW_PACKAGE_NODE_VERSION = "24.1.0";
  assertRejectedWithoutExecution(
    runIn(root, env, ["--require-package-node"]),
    /SPW_PACKAGE_NODE_VERSION must match the declared package minimum/,
  );
});

void test("required package evidence rejects a manifest without the package suite", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.ts"],
    files: { "tests/unit/a.test.ts": EXECUTED_SUITE },
  });
  assertRejectedWithoutExecution(
    runIn(root, packageNodeEvidence(root), ["--require-package-node"]),
    /--require-package-node requires tests\/baseline\/packaged-cli\.test\.ts in the selected suites/,
  );
});

void test("required package evidence rejects narrowed group selection", (t) => {
  const root = fakeRoot(t, {
    suites: [
      { path: "tests/unit/a.test.ts", group: "unit" },
      {
        path: "tests/baseline/packaged-cli.test.ts",
        group: "integration",
      },
    ],
    files: {
      "tests/unit/a.test.ts": EXECUTED_SUITE,
      "tests/baseline/packaged-cli.test.ts": EXECUTED_SUITE,
    },
  });
  assertRejectedWithoutExecution(
    runIn(root, packageNodeEvidence(root), [
      "--require-package-node",
      "--group",
      "integration",
    ]),
    /--require-package-node requires --group all/,
  );
});

void test("valid required package evidence runs the package suite", (t) => {
  const root = fakeRoot(t, {
    suites: [
      {
        path: "tests/baseline/packaged-cli.test.ts",
        group: "integration",
      },
    ],
    files: { "tests/baseline/packaged-cli.test.ts": EXECUTED_SUITE },
  });
  const result = runIn(root, packageNodeEvidence(root), [
    "--require-package-node",
  ]);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.split("EXECUTED:fixture").length - 1, 1);
  assert.equal(
    result.stdout.trimEnd().split("\n").at(-1),
    "run-node-suites: complete status=0",
  );
});

void test("invalid concurrency values are rejected before fixture execution", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.ts"],
    files: { "tests/unit/a.test.ts": EXECUTED_SUITE },
  });
  for (const concurrency of [
    "0",
    "-1",
    "1.5",
    "",
    "many",
    "9007199254740992",
  ]) {
    const result = runIn(root, {}, [`--concurrency=${concurrency}`]);
    assertRejectedWithoutExecution(
      result,
      /test concurrency must be a positive safe integer/,
    );
    const lines = result.stdout.trimEnd().split("\n");
    assert.equal(lines[lines.length - 1], "run-node-suites: complete status=1");
  }
});

void test("concurrency two lets separate suite processes make simultaneous progress", (t) => {
  const firstSuite = "tests/unit/first.test.ts";
  const secondSuite = "tests/unit/second.test.ts";
  const root = fakeRoot(t, {
    suites: [firstSuite, secondSuite],
    files: { [firstSuite]: PASSING_SUITE, [secondSuite]: PASSING_SUITE },
  });
  const scratch = join(root, "scratch");
  mkdirSync(scratch);
  const firstMarker = join(scratch, "first.pid");
  const secondMarker = join(scratch, "second.pid");
  const body = (own: string, peer: string) => `
import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
test("workers overlap in different processes", async () => {
  writeFileSync(${JSON.stringify(`${own}.tmp`)}, String(process.pid));
  renameSync(${JSON.stringify(`${own}.tmp`)}, ${JSON.stringify(own)});
  const deadline = Date.now() + 10000;
  while (!existsSync(${JSON.stringify(peer)}) && Date.now() < deadline) await delay(10);
  assert.ok(existsSync(${JSON.stringify(peer)}), "peer worker did not start");
  assert.notEqual(readFileSync(${JSON.stringify(peer)}, "utf8"), String(process.pid));
});`;
  writeFileSync(join(root, firstSuite), body(firstMarker, secondMarker));
  writeFileSync(join(root, secondSuite), body(secondMarker, firstMarker));

  const result = runIn(root, {}, ["--concurrency", "2"]);

  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.split("workers overlap in different processes").length - 1,
    2,
  );
  assert.match(result.stdout, /pass 2/);
});

void test("concurrency one is forwarded to the real Node test process", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/pass.test.ts"],
    files: { "tests/unit/pass.test.ts": PASSING_SUITE },
  });
  const preloadPath = join(root, "record-spawn.mjs");
  const recordPath = join(root, "spawn-record.json");
  writeFileSync(
    preloadPath,
    `import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { writeFileSync } from "node:fs";
const original = childProcess.spawnSync;
childProcess.spawnSync = function(command, args, options) {
  writeFileSync(process.env.SPW_TEST_SPAWN_RECORD, JSON.stringify({ command, args }));
  return original(command, args, options);
};
syncBuiltinESMExports();
`,
  );
  const env = { ...process.env };
  delete env.SPW_PACKAGE_NODE;
  delete env.SPW_PACKAGE_NODE_VERSION;
  const result = spawnSync(
    process.execPath,
    ["--import", preloadPath, RUNNER, "--concurrency", "1"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...env,
        SPW_RUNNER_ROOT: root,
        SPW_TEST_SPAWN_RECORD: recordPath,
      },
      timeout: 30000,
    },
  );

  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pass 1/);
  const recorded = JSON.parse(readFileSync(recordPath, "utf8")) as {
    command: string;
    args: string[];
  };
  assert.equal(recorded.command, process.execPath);
  const concurrencyIndex = recorded.args.indexOf("--test-concurrency");
  assert.notEqual(concurrencyIndex, -1);
  assert.deepEqual(
    recorded.args.slice(concurrencyIndex, concurrencyIndex + 2),
    ["--test-concurrency", "1"],
  );
});

void test("clean tree passes", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.ts"],
    files: { "tests/unit/a.test.ts": PASSING_SUITE },
  });
  const r = runIn(root);
  assert.equal(r.status, 0);
  assertNoRawFailure(r);
});

void test("the runner announces completion on a passing run", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/pass.test.ts"],
    files: { "tests/unit/pass.test.ts": PASSING_SUITE },
  });
  const r = runIn(root);
  assert.equal(r.status, 0);
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines[lines.length - 1], "run-node-suites: complete status=0");
});

// This fails if the runner only announces successful completion: a failed run
// would then remain indistinguishable from one killed before it could finish.
void test("the runner announces completion on a FAILING run", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/fail.test.ts"],
    files: { "tests/unit/fail.test.ts": FAILING_SUITE },
  });
  const r = runIn(root);
  assert.notEqual(r.status, 0);
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(
    lines[lines.length - 1],
    `run-node-suites: complete status=${r.status}`,
  );
});

void test("both sentinels reach a piped capture", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/fail.test.ts"],
    files: { "tests/unit/fail.test.ts": FAILING_SUITE },
  });
  const r = spawnSync("sh", [RUN_SH, "--concurrency", "2"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, SPW_RUNNER_ROOT: root },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
  });
  assert.equal(
    r.signal,
    null,
    "tests/run.sh was killed at the harness bound before both sentinels arrived",
  );
  assert.equal(r.status, 1);
  const lines = r.stdout.trimEnd().split("\n");
  assert.deepEqual(lines.slice(-2), [
    "run-node-suites: complete status=1",
    "tests/run.sh: complete failed=1",
  ]);
});

// This fails if early fail() paths omit the completion signal; no child summary
// exists when the runner fails before it can spawn node --test.
void test("the runner announces completion when it fails before spawning", (t) => {
  const root = fakeRoot(t, { suites: [], files: {} });
  const r = runIn(root);
  assert.equal(r.status, 1);
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines[lines.length - 1], "run-node-suites: complete status=1");
});

// This fails if an ordinary non-zero child result does not reach the runner's
// completion signal.
void test("a suite that throws on import still ends with the sentinel", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/throws-on-import.test.ts"],
    files: {
      "tests/unit/throws-on-import.test.ts": 'throw new Error("boom");\n',
    },
  });
  const r = runIn(root);
  assert.notEqual(r.status, 0);
  assert.equal(r.signal, null);
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(
    lines[lines.length - 1],
    `run-node-suites: complete status=${r.status}`,
  );
});

// This fails if the runner is changed to leave a handle alive after setting its
// completion status: runIn's timeout kills that regression and exposes a signal.
void test("the runner exits promptly rather than lingering on a live handle", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/pass.test.ts"],
    files: { "tests/unit/pass.test.ts": PASSING_SUITE },
  });
  const r = runIn(root);
  assert.equal(
    r.signal,
    null,
    "the runner was killed at the harness bound; a pending handle is keeping it alive",
  );
  assert.equal(r.status, 0);
});

void test("declared but absent", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.ts", "tests/unit/missing.test.ts"],
    files: { "tests/unit/a.test.ts": PASSING_SUITE },
  });
  const r = runIn(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tests\/unit\/missing\.test\.ts/);
  assertNoRawFailure(r);
});

void test("present but unregistered", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.ts"],
    files: {
      "tests/unit/a.test.ts": PASSING_SUITE,
      "tests/unit/extra.test.ts": PASSING_SUITE,
    },
  });
  const r = runIn(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tests\/unit\/extra\.test\.ts/);
  assertNoRawFailure(r);
});

void test("empty manifest", (t) => {
  const root = fakeRoot(t, {
    suites: [],
    files: {},
  });
  const r = runIn(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tests\/suites\.json declares no suites/);
  assertNoRawFailure(r);
});

void test("malformed manifest: not JSON", (t) => {
  const root = fakeRoot(t, {
    suites: [],
    files: {},
  });
  writeFileSync(join(root, "tests", "suites.json"), "not json", "utf8");
  const r = runIn(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tests\/suites\.json is missing or is not valid JSON/);
  assertNoRawFailure(r);
});

void test("malformed manifest: suites is not an array", (t) => {
  const root = fakeRoot(t, {
    suites: [],
    files: {},
  });
  writeFileSync(
    join(root, "tests", "suites.json"),
    JSON.stringify({ suites: "x" }),
    "utf8",
  );
  const r = runIn(root);
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /tests\/suites\.json must be an object with a `suites` array/,
  );
  assertNoRawFailure(r);
});

void test("a legacy string manifest entry is rejected before execution", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.ts"],
    files: { "tests/unit/a.test.ts": EXECUTED_SUITE },
  });
  writeManifest(root, ["tests/unit/a.test.ts"]);
  assertRejectedWithoutExecution(
    runIn(root),
    /entry must be an object with exactly `path` and `group`/,
  );
});

void test("an unknown manifest group is rejected before execution", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.ts"],
    files: { "tests/unit/a.test.ts": EXECUTED_SUITE },
  });
  writeManifest(root, [{ path: "tests/unit/a.test.ts", group: "smoke" }]);
  assertRejectedWithoutExecution(
    runIn(root),
    /entry group must be unit, integration, or repository/,
  );
});

void test("a non-string manifest path is rejected before execution", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.ts"],
    files: { "tests/unit/a.test.ts": EXECUTED_SUITE },
  });
  writeManifest(root, [{ path: 7, group: "unit" }]);
  assertRejectedWithoutExecution(
    runIn(root),
    /entry path must be a nonempty string/,
  );
});

void test("an empty manifest path is rejected before execution", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.ts"],
    files: { "tests/unit/a.test.ts": EXECUTED_SUITE },
  });
  writeManifest(root, [{ path: "", group: "unit" }]);
  assertRejectedWithoutExecution(
    runIn(root),
    /entry path must be a nonempty string/,
  );
});

void test("an extra manifest record key is rejected before execution", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.ts"],
    files: { "tests/unit/a.test.ts": EXECUTED_SUITE },
  });
  writeManifest(root, [
    { path: "tests/unit/a.test.ts", group: "unit", enabled: true },
  ]);
  assertRejectedWithoutExecution(
    runIn(root),
    /entry must be an object with exactly `path` and `group`/,
  );
});

void test("an unknown requested group is rejected before execution", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.ts"],
    files: { "tests/unit/a.test.ts": EXECUTED_SUITE },
  });
  assertRejectedWithoutExecution(
    runIn(root, {}, ["--group", "smoke"]),
    /unknown suite group; expected unit, integration, repository, or all/,
  );
});

void test("a requested group with no suites is rejected before execution", (t) => {
  const root = fakeRoot(t, {
    suites: [{ path: "tests/baseline/a.test.ts", group: "integration" }],
    files: { "tests/baseline/a.test.ts": EXECUTED_SUITE },
  });
  assertRejectedWithoutExecution(
    runIn(root, {}, ["--group", "unit"]),
    /requested suite group declares no suites/,
  );
});

void test("unit selection still rejects a missing integration suite", (t) => {
  const root = fakeRoot(t, {
    suites: [
      { path: "tests/unit/a.test.ts", group: "unit" },
      { path: "tests/baseline/missing.test.ts", group: "integration" },
    ],
    files: { "tests/unit/a.test.ts": EXECUTED_SUITE },
  });
  assertRejectedWithoutExecution(
    runIn(root, {}, ["--group", "unit"]),
    /declared.*absent from disk.*missing\.test\.ts/,
  );
});

void test("unit selection still rejects an unregistered integration suite", (t) => {
  const root = fakeRoot(t, {
    suites: [{ path: "tests/unit/a.test.ts", group: "unit" }],
    files: {
      "tests/unit/a.test.ts": EXECUTED_SUITE,
      "tests/baseline/unregistered.test.ts": EXECUTED_SUITE,
    },
  });
  assertRejectedWithoutExecution(
    runIn(root, {}, ["--group", "unit"]),
    /present on disk.*absent from tests\/suites\.json.*unregistered\.test\.ts/,
  );
});

void test("broken symlink suite", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/broken.test.ts"],
    files: {},
  });
  symlinkSync("/nonexistent/target", join(root, "tests/unit/broken.test.ts"));
  const r = runIn(root);
  assert.equal(r.status, 1);
  // Without the stderr match this case is vacuously satisfiable: a runner
  // killed by a signal reports status null, which `runIn` maps to 1, and
  // leaves both streams empty — passing the status check and
  // assertNoRawFailure alike. The frozen diagnostic is what proves the
  // directory-walk symlink guard (`tests/run-node-suites.ts:152::entry.isSymbolicLink()`)
  // ran rather than a
  // follow-the-link stat throwing a raw ENOENT: lstatSync succeeds on a
  // broken symlink (it inspects the link itself, not its target), so this is
  // now rejected as a symlink rather than reported as uninspectable. This
  // suite is declared via suites.json, but it is still the directory walk
  // that catches it first — not the declared-suites branch — since the
  // symlink appears as a directory entry before the manifest comparison ever
  // runs.
  assert.match(
    r.stderr,
    /suite entries may not be symlinks: tests\/unit\/broken\.test\.ts/,
  );
  assertNoRawFailure(r);
});

void test("failing child suite propagates", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.ts"],
    files: { "tests/unit/a.test.ts": FAILING_SUITE },
  });
  const r = runIn(root);
  assert.notEqual(r.status, 0);
  // Not assertNoRawFailure here: node:test's own failure reporter legitimately
  // prints the thrown Error's stack for the failing child test — that is
  // expected test output, not a leak from this runner's own error-handling
  // paths, and the two are indistinguishable by the generic `/\n\s+at /`
  // pattern.
});

void test("concurrent passing files do not hide one failing file", (t) => {
  const root = fakeRoot(t, {
    suites: [
      "tests/unit/first-pass.test.ts",
      "tests/unit/fail.test.ts",
      "tests/unit/second-pass.test.ts",
    ],
    files: {
      "tests/unit/first-pass.test.ts": PASSING_SUITE,
      "tests/unit/fail.test.ts": FAILING_SUITE,
      "tests/unit/second-pass.test.ts": PASSING_SUITE,
    },
  });
  const result = runIn(root, {}, ["--concurrency", "2"]);

  assert.equal(result.signal, null);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /pass 2/);
  assert.match(result.stdout, /fail 1/);
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(
    lines[lines.length - 1],
    `run-node-suites: complete status=${result.status}`,
  );
  assert.doesNotMatch(result.stdout, /run-node-suites: complete status=0/);
});

void test("a concurrent suite terminated by SIGTERM fails without killing the runner", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/pass.test.ts", "tests/unit/terminated.test.ts"],
    files: {
      "tests/unit/pass.test.ts": PASSING_SUITE,
      "tests/unit/terminated.test.ts":
        'import test from "node:test";\ntest("terminated", () => process.kill(process.pid, "SIGTERM"));\n',
    },
  });
  const result = runIn(root, {}, ["--concurrency", "2"]);

  assert.equal(result.signal, null);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /pass 1/);
  assert.match(result.stdout, /fail 1/);
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(
    lines[lines.length - 1],
    `run-node-suites: complete status=${result.status}`,
  );
  assert.doesNotMatch(result.stdout, /run-node-suites: complete status=0/);
});

void test("failing child suite propagates even when the caller's own NODE_TEST_CONTEXT leaks into the child env", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.ts"],
    files: { "tests/unit/a.test.ts": FAILING_SUITE },
  });
  // Simulates this contract suite's own invocation context: a caller that is
  // itself running under `node --test` has NODE_TEST_CONTEXT set. Without the
  // runner stripping it before its own inner `node --test` spawn, the inner
  // invocation misreads itself as a nested recursive run, skips executing
  // every suite file, and exits 0 — a silent pass in the exact gate meant to
  // prevent silent passes.
  const r = runIn(root, { NODE_TEST_CONTEXT: "child-v8" });
  assert.notEqual(r.status, 0);
  // Not assertNoRawFailure here either, for the same reason as the previous
  // case: the failing child test's own stack is expected node:test output.
});

void test("nested test file rejected", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.ts"],
    files: {
      "tests/unit/a.test.ts": PASSING_SUITE,
      "tests/unit/nested/buried.test.ts": EXECUTED_SUITE,
    },
  });
  const r = runIn(root);
  assertRejectedWithoutExecution(
    r,
    /present on disk but absent from tests\/suites\.json/,
  );
  assert.match(r.stderr, /present on disk but absent from tests\/suites\.json/);
  assert.match(r.stderr, /tests\/unit\/nested\/buried\.test\.ts/);
});

void test("nested non-test helper accepted", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.ts"],
    files: {
      "tests/unit/a.test.ts": PASSING_SUITE,
      "tests/unit/helpers/child.js": "module.exports = {};\n",
    },
  });
  const r = runIn(root);
  assert.equal(r.status, 0);
  assertNoRawFailure(r);
});

void test("a duplicate same-group manifest path is rejected before execution", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.ts", "tests/unit/a.test.ts"],
    files: { "tests/unit/a.test.ts": EXECUTED_SUITE },
  });
  assertRejectedWithoutExecution(
    runIn(root),
    /tests\/suites\.json lists a suite more than once: tests\/unit\/a\.test\.ts/,
  );
});

void test("a duplicate cross-group manifest path is rejected before execution", (t) => {
  const root = fakeRoot(t, {
    suites: [
      { path: "tests/unit/a.test.ts", group: "unit" },
      { path: "tests/unit/a.test.ts", group: "integration" },
    ],
    files: { "tests/unit/a.test.ts": EXECUTED_SUITE },
  });
  assertRejectedWithoutExecution(
    runIn(root),
    /tests\/suites\.json lists a suite more than once: tests\/unit\/a\.test\.ts/,
  );
});

void test("a symlinked suite file is rejected", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/linked.test.ts"],
    files: { "tests/unit/real.js": PASSING_SUITE },
  });
  symlinkSync(
    join(root, "tests/unit/real.js"),
    join(root, "tests/unit/linked.test.ts"),
  );
  const r = runIn(root);
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /suite entries may not be symlinks: tests\/unit\/linked\.test\.ts/,
  );
  assertNoRawFailure(r);
});

void test("a registered nested symlinked suite file is rejected", (t) => {
  const path = "tests/unit/harnesses/codex/linked.test.ts";
  const root = fakeRoot(t, {
    suites: [path],
    files: { "tests/unit/real.js": EXECUTED_SUITE },
  });
  mkdirSync(dirname(join(root, path)), { recursive: true });
  symlinkSync(join(root, "tests/unit/real.js"), join(root, path));
  assertRejectedWithoutExecution(
    runIn(root),
    /suite entries may not be symlinks: tests\/unit\/harnesses\/codex\/linked\.test\.ts/,
  );
});

void test("a registered nested directory cannot masquerade as a suite", (t) => {
  const path = "tests/unit/harnesses/codex/bad.test.ts";
  const root = fakeRoot(t, { suites: [path], files: {} });
  mkdirSync(join(root, path), { recursive: true });
  assertRejectedWithoutExecution(runIn(root), /suite is not a regular file/);
});

void test("a symlinked suite directory is rejected rather than skipped", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.ts"],
    files: {
      "tests/unit/a.test.ts": PASSING_SUITE,
      "elsewhere/hidden.test.ts": PASSING_SUITE,
    },
  });
  symlinkSync(join(root, "elsewhere"), join(root, "tests/unit/linked"));
  const r = runIn(root);
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /suite entries may not be symlinks: tests\/unit\/linked/,
  );
  assertNoRawFailure(r);
});

void test("a symlink nested inside a suite subdirectory is rejected even when its name does not end in .test.js", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.ts"],
    files: {
      "tests/unit/a.test.ts": EXECUTED_SUITE,
      "tests/unit/helpers/keep.js": "module.exports = {};\n",
    },
  });
  const outside = mkdtempSync(join(tmpdir(), "spw-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "linked.js"), EXECUTED_SUITE, "utf8");
  symlinkSync(
    join(outside, "linked.js"),
    join(root, "tests/unit/helpers/linked.js"),
  );
  assertRejectedWithoutExecution(
    runIn(root),
    /suite entries may not be symlinks: tests\/unit\/helpers\/linked\.js/,
  );
});

void test("a symlink nested inside a suite subdirectory pointing at a directory is rejected", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.ts"],
    files: {
      "tests/unit/a.test.ts": PASSING_SUITE,
      "tests/unit/helpers/keep.js": "module.exports = {};\n",
    },
  });
  const outside = mkdtempSync(join(tmpdir(), "spw-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  mkdirSync(join(outside, "sub"), { recursive: true });
  writeFileSync(join(outside, "sub", "hidden.js"), "", "utf8");
  symlinkSync(
    join(outside, "sub"),
    join(root, "tests/unit/helpers/linked-dir"),
  );
  const r = runIn(root);
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /suite entries may not be symlinks: tests\/unit\/helpers\/linked-dir/,
  );
  assertNoRawFailure(r);
});

void test("unreadable nested directory fails closed without leaking errno", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.ts"],
    files: {
      "tests/unit/a.test.ts": PASSING_SUITE,
      "tests/unit/locked/keep.js": "",
    },
  });
  const locked = join(root, "tests", "unit", "locked");
  chmodSync(locked, 0o000);
  // Restore inside the test body, not in a t.after hook: fakeRoot registers
  // its rmSync hook first and hooks run in registration order, so an
  // unreadable directory would still be unreadable at removal time and the
  // cleanup would fail with ENOTEMPTY.
  try {
    // Root ignores the mode bits, so the directory stays readable and this
    // case would pass without exercising the guard at all. Skip rather than
    // assert a condition the environment cannot produce.
    let revoked = false;
    try {
      readdirSync(locked);
    } catch {
      revoked = true;
    }
    if (!revoked) {
      t.skip("cannot revoke directory read access as this user");
      return;
    }
    const r = runIn(root);
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /suite subdirectory could not be read: tests\/unit\/locked/,
    );
    assertNoRawFailure(r);
  } finally {
    chmodSync(locked, 0o755);
  }
});

// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { computeBuildId } from "../build-id.js";

const RUNNER = fileURLToPath(new URL("../run-node-suites.js", import.meta.url));

const PASSING_SUITE = 'import test from "node:test";\ntest("ok", () => {});\n';
const FAILING_SUITE =
  'import test from "node:test";\ntest("no", () => { throw new Error("x"); });\n';

/**
 * Build an isolated fake repository root.
 * @param {import("node:test").TestContext} t
 * @param {{suites: string[], files: Record<string, string>, withDist?: boolean}} shape
 */
function fakeRoot(t, shape) {
  const root = mkdtempSync(join(tmpdir(), "spw-runner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (shape.withDist !== false) {
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "cli.js"), "", "utf8");
  }
  for (const dir of ["tests/bin", "tests/unit", "tests/baseline"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  for (const [relative, contents] of Object.entries(shape.files)) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, "utf8");
  }
  if (
    Object.keys(shape.files).some((relative) => relative.startsWith("src/"))
  ) {
    writeFileSync(
      join(root, "tsconfig.json"),
      '{"compilerOptions":{"rootDir":"./src","outDir":"./dist"}}\n',
      "utf8",
    );
    // computeBuildId folds the resolved compiler version into the digest,
    // so any fixture root it is called against needs a resolvable
    // node_modules/typescript/package.json. The version value itself is a
    // fixture literal this test defines for itself, not a claim about the
    // real installed compiler.
    mkdirSync(join(root, "node_modules", "typescript"), { recursive: true });
    writeFileSync(
      join(root, "node_modules", "typescript", "package.json"),
      JSON.stringify({ name: "typescript", version: "0.0.0-fixture" }),
      "utf8",
    );
  }
  writeFileSync(
    join(root, "tests", "suites.json"),
    JSON.stringify({ suites: shape.suites }, null, 2),
    "utf8",
  );
  return root;
}

/**
 * @param {string} root
 * @param {Record<string, string>} [extraEnv]
 */
function runIn(root, extraEnv) {
  const result = spawnSync(process.execPath, [RUNNER], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, SPW_RUNNER_ROOT: root, ...extraEnv },
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

/** @param {{stdout: string, stderr: string}} r */
function assertNoRawFailure(r) {
  for (const stream of [r.stdout, r.stderr]) {
    assert.doesNotMatch(stream, /ENOENT|EACCES|ENOTDIR|errno/);
    assert.doesNotMatch(stream, /\n\s+at /);
    assert.doesNotMatch(stream, /Traceback/);
  }
}

void test("clean tree passes", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.js"],
    files: { "tests/unit/a.test.js": PASSING_SUITE },
  });
  const r = runIn(root);
  assert.equal(r.status, 0);
  assertNoRawFailure(r);
});

void test("the runner announces completion on a passing run", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/pass.test.js"],
    files: { "tests/unit/pass.test.js": PASSING_SUITE },
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
    suites: ["tests/unit/fail.test.js"],
    files: { "tests/unit/fail.test.js": FAILING_SUITE },
  });
  const r = runIn(root);
  assert.notEqual(r.status, 0);
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(
    lines[lines.length - 1],
    `run-node-suites: complete status=${r.status}`,
  );
});

// This fails if early fail() paths omit the completion signal; no child summary
// exists when the runner fails before it can spawn node --test.
void test("the runner announces completion when it fails before spawning", (t) => {
  const root = fakeRoot(t, { suites: [], files: {}, withDist: false });
  const r = runIn(root);
  assert.equal(r.status, 1);
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines[lines.length - 1], "run-node-suites: complete status=1");
});

// This fails if an ordinary non-zero child result does not reach the runner's
// completion signal.
void test("a suite that throws on import still ends with the sentinel", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/throws-on-import.test.js"],
    files: {
      "tests/unit/throws-on-import.test.js": 'throw new Error("boom");\n',
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
    suites: ["tests/unit/pass.test.js"],
    files: { "tests/unit/pass.test.js": PASSING_SUITE },
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
    suites: ["tests/unit/a.test.js", "tests/unit/missing.test.js"],
    files: { "tests/unit/a.test.js": PASSING_SUITE },
  });
  const r = runIn(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tests\/unit\/missing\.test\.js/);
  assertNoRawFailure(r);
});

void test("present but unregistered", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.js"],
    files: {
      "tests/unit/a.test.js": PASSING_SUITE,
      "tests/unit/extra.test.js": PASSING_SUITE,
    },
  });
  const r = runIn(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tests\/unit\/extra\.test\.js/);
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

void test("missing dist/cli.js", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.js"],
    files: { "tests/unit/a.test.js": PASSING_SUITE },
    withDist: false,
  });
  const r = runIn(root);
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /dist\/cli\.js is missing — run pnpm install --frozen-lockfile && pnpm run build/,
  );
  assertNoRawFailure(r);
});

void test("a stale build is rejected", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.js"],
    files: {
      "tests/unit/a.test.js": PASSING_SUITE,
      "src/thing.ts": "export const a = 1;\n",
    },
  });
  writeFileSync(join(root, "dist", ".build-id"), "stale\n", "utf8");
  const r = runIn(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /dist\/ is stale — run pnpm run build/);
  assertNoRawFailure(r);
});

void test("a matching build id passes", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.js"],
    files: {
      "tests/unit/a.test.js": PASSING_SUITE,
      "src/thing.ts": "export const a = 1;\n",
    },
  });
  writeFileSync(join(root, "dist", ".build-id"), computeBuildId(root), "utf8");
  const r = runIn(root);
  assert.equal(r.status, 0);
  assertNoRawFailure(r);
});

void test("a build id that cannot be computed is not reported as staleness", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.js"],
    files: {
      "tests/unit/a.test.js": PASSING_SUITE,
      "src/thing.ts": "export const a = 1;\n",
    },
  });
  writeFileSync(join(root, "dist", ".build-id"), "irrelevant\n", "utf8");
  // `root` is fakeRoot's mkdtempSync temp directory (:31) and nothing else.
  // Never derive this path from ROOT, process.cwd(), or import.meta — this
  // rmSync would then delete the repository's own node_modules.
  rmSync(join(root, "node_modules"), { recursive: true, force: true });

  const r = runIn(root);

  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot compute the expected build id/);
  assert.doesNotMatch(r.stderr, /dist\/ is stale/);
  assertNoRawFailure(r);
});

/**
 * Build a minimal root for exercising computeBuildId directly, independent
 * of the full run-node-suites.js contract that fakeRoot() sets up.
 * @param {import("node:test").TestContext} t
 * @param {{files: Record<string, string>, tsconfig?: string, typescriptVersion?: string}} shape
 */
function buildIdRoot(t, shape) {
  const root = mkdtempSync(join(tmpdir(), "spw-build-id-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [relative, contents] of Object.entries(shape.files)) {
    const target = join(root, "src", relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, "utf8");
  }
  writeFileSync(
    join(root, "tsconfig.json"),
    shape.tsconfig ?? '{"compilerOptions":{}}\n',
    "utf8",
  );
  mkdirSync(join(root, "node_modules", "typescript"), { recursive: true });
  writeFileSync(
    join(root, "node_modules", "typescript", "package.json"),
    JSON.stringify({
      name: "typescript",
      version: shape.typescriptVersion ?? "0.0.0-fixture",
    }),
    "utf8",
  );
  return root;
}

void test("distinct source trees never collide to the same build id", (t) => {
  // Tree A: a single file whose contents happen to be another file's name.
  // Tree B: two empty files named after both sides of that same string.
  // Unframed concatenation of (name, contents) pairs folds these to the
  // same byte stream; framing each record with its length must keep them
  // apart.
  const treeA = buildIdRoot(t, { files: { "a.ts": "b.ts" } });
  const treeB = buildIdRoot(t, { files: { "a.ts": "", "b.ts": "" } });
  assert.notEqual(computeBuildId(treeA), computeBuildId(treeB));
});

void test("a different resolved compiler version changes the build id", (t) => {
  const files = { "a.ts": "export const a = 1;\n" };
  const rootV1 = buildIdRoot(t, { files, typescriptVersion: "1.2.3" });
  const rootV2 = buildIdRoot(t, { files, typescriptVersion: "9.9.9" });
  assert.notEqual(computeBuildId(rootV1), computeBuildId(rootV2));
});

void test("broken symlink suite", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/broken.test.js"],
    files: {},
  });
  symlinkSync("/nonexistent/target", join(root, "tests/unit/broken.test.js"));
  const r = runIn(root);
  assert.equal(r.status, 1);
  // Without the stderr match this case is vacuously satisfiable: a runner
  // killed by a signal reports status null, which `runIn` maps to 1, and
  // leaves both streams empty — passing the status check and
  // assertNoRawFailure alike. The frozen diagnostic is what proves the
  // directory-walk symlink guard (run-node-suites.js:67-69) ran rather than a
  // follow-the-link stat throwing a raw ENOENT: lstatSync succeeds on a
  // broken symlink (it inspects the link itself, not its target), so this is
  // now rejected as a symlink rather than reported as uninspectable. This
  // suite is declared via suites.json, but it is still the directory walk
  // that catches it first — not the declared-suites branch — since the
  // symlink appears as a directory entry before the manifest comparison ever
  // runs.
  assert.match(
    r.stderr,
    /suite entries may not be symlinks: tests\/unit\/broken\.test\.js/,
  );
  assertNoRawFailure(r);
});

void test("failing child suite propagates", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.js"],
    files: { "tests/unit/a.test.js": FAILING_SUITE },
  });
  const r = runIn(root);
  assert.notEqual(r.status, 0);
  // Not assertNoRawFailure here: node:test's own failure reporter legitimately
  // prints the thrown Error's stack for the failing child test — that is
  // expected test output, not a leak from this runner's own error-handling
  // paths, and the two are indistinguishable by the generic `/\n\s+at /`
  // pattern.
});

void test("failing child suite propagates even when the caller's own NODE_TEST_CONTEXT leaks into the child env", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.js"],
    files: { "tests/unit/a.test.js": FAILING_SUITE },
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
    suites: ["tests/unit/a.test.js"],
    files: {
      "tests/unit/a.test.js": PASSING_SUITE,
      "tests/unit/nested/buried.test.js": PASSING_SUITE,
    },
  });
  const r = runIn(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tests\/unit\/nested\/buried\.test\.js/);
  assertNoRawFailure(r);
});

void test("nested non-test helper accepted", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.js"],
    files: {
      "tests/unit/a.test.js": PASSING_SUITE,
      "tests/unit/helpers/child.js": "module.exports = {};\n",
    },
  });
  const r = runIn(root);
  assert.equal(r.status, 0);
  assertNoRawFailure(r);
});

void test("a duplicate manifest entry is rejected", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.js", "tests/unit/a.test.js"],
    files: { "tests/unit/a.test.js": PASSING_SUITE },
  });
  const r = runIn(root);
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /tests\/suites\.json lists a suite more than once: tests\/unit\/a\.test\.js/,
  );
  assertNoRawFailure(r);
});

void test("a symlinked suite file is rejected", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/linked.test.js"],
    files: { "tests/unit/real.js": PASSING_SUITE },
  });
  symlinkSync(
    join(root, "tests/unit/real.js"),
    join(root, "tests/unit/linked.test.js"),
  );
  const r = runIn(root);
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /suite entries may not be symlinks: tests\/unit\/linked\.test\.js/,
  );
  assertNoRawFailure(r);
});

void test("a symlinked suite directory is rejected rather than skipped", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.js"],
    files: {
      "tests/unit/a.test.js": PASSING_SUITE,
      "elsewhere/hidden.test.js": PASSING_SUITE,
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
    suites: ["tests/unit/a.test.js"],
    files: {
      "tests/unit/a.test.js": PASSING_SUITE,
      "tests/unit/helpers/keep.js": "module.exports = {};\n",
    },
  });
  const outside = mkdtempSync(join(tmpdir(), "spw-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(
    join(outside, "linked.js"),
    "OUT-OF-TREE CODE EXECUTED\n",
    "utf8",
  );
  symlinkSync(
    join(outside, "linked.js"),
    join(root, "tests/unit/helpers/linked.js"),
  );
  const r = runIn(root);
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /suite entries may not be symlinks: tests\/unit\/helpers\/linked\.js/,
  );
  assertNoRawFailure(r);
});

void test("a symlink nested inside a suite subdirectory pointing at a directory is rejected", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.js"],
    files: {
      "tests/unit/a.test.js": PASSING_SUITE,
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
    suites: ["tests/unit/a.test.js"],
    files: {
      "tests/unit/a.test.js": PASSING_SUITE,
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

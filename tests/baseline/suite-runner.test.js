// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const RUNNER = fileURLToPath(
  new URL("../run-node-suites.js", import.meta.url),
);

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
  });
  return {
    status: result.status ?? 1,
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

test("clean tree passes", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.js"],
    files: { "tests/unit/a.test.js": PASSING_SUITE },
  });
  const r = runIn(root);
  assert.equal(r.status, 0);
  assertNoRawFailure(r);
});

test("declared but absent", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.js", "tests/unit/missing.test.js"],
    files: { "tests/unit/a.test.js": PASSING_SUITE },
  });
  const r = runIn(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tests\/unit\/missing\.test\.js/);
  assertNoRawFailure(r);
});

test("present but unregistered", (t) => {
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

test("empty manifest", (t) => {
  const root = fakeRoot(t, {
    suites: [],
    files: {},
  });
  const r = runIn(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tests\/suites\.json declares no suites/);
  assertNoRawFailure(r);
});

test("malformed manifest: not JSON", (t) => {
  const root = fakeRoot(t, {
    suites: [],
    files: {},
  });
  writeFileSync(join(root, "tests", "suites.json"), "not json", "utf8");
  const r = runIn(root);
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /tests\/suites\.json is missing or is not valid JSON/,
  );
  assertNoRawFailure(r);
});

test("malformed manifest: suites is not an array", (t) => {
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

test("missing dist/cli.js", (t) => {
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

test("broken symlink suite", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/broken.test.js"],
    files: {},
  });
  symlinkSync("/nonexistent/target", join(root, "tests/unit/broken.test.js"));
  const r = runIn(root);
  assert.equal(r.status, 1);
  assertNoRawFailure(r);
});

test("failing child suite propagates", (t) => {
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

test("failing child suite propagates even when the caller's own NODE_TEST_CONTEXT leaks into the child env", (t) => {
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

test("nested test file rejected", (t) => {
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

test("nested non-test helper accepted", (t) => {
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

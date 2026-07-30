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
import { join } from "node:path";
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
    writeFileSync(join(root, relative), contents, "utf8");
  }
  writeFileSync(
    join(root, "tests", "suites.json"),
    JSON.stringify({ suites: shape.suites }, null, 2),
    "utf8",
  );
  return root;
}

/** @param {string} root */
function runIn(root) {
  // This suite itself runs under `node --test`, which sets NODE_TEST_CONTEXT
  // / NODE_TEST_WORKER_ID in its own process.env. Left in the child's env,
  // the runner's inner `node --test` invocation misreads itself as a nested
  // recursive test run and silently skips executing every file (exit 0
  // regardless of suite content) — verified by reproduction. Strip them so
  // the child actually executes its suites.
  const env = { ...process.env, SPW_RUNNER_ROOT: root };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  const result = spawnSync(process.execPath, [RUNNER], {
    cwd: root,
    encoding: "utf8",
    env,
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
});

test("declared but absent", (t) => {
  const root = fakeRoot(t, {
    suites: ["tests/unit/a.test.js", "tests/unit/missing.test.js"],
    files: { "tests/unit/a.test.js": PASSING_SUITE },
  });
  const r = runIn(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tests\/unit\/missing\.test\.js/);
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
});

test("empty manifest", (t) => {
  const root = fakeRoot(t, {
    suites: [],
    files: {},
  });
  const r = runIn(root);
  assert.equal(r.status, 1);
});

test("malformed manifest: not JSON", (t) => {
  const root = fakeRoot(t, {
    suites: [],
    files: {},
  });
  writeFileSync(join(root, "tests", "suites.json"), "not json", "utf8");
  const r = runIn(root);
  assert.equal(r.status, 1);
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
});

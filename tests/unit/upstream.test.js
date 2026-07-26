// @ts-check
import assert from "node:assert/strict";
import test from "node:test";

/** @type {typeof import("../../src/domain/refs.js")} */
const { parseStableTag, compareStable, TAG_RE, SEMVER_BASE_RE } = await import(
  new URL("../../dist/domain/refs.js", import.meta.url).href
);

import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** @type {typeof import("../../src/git.js")} */
const { runGit } = await import(
  new URL("../../dist/git.js", import.meta.url).href
);

void test("parseStableTag accepts three-component stable tags only", () => {
  assert.deepEqual(parseStableTag("v6.0.10"), {
    major: 6n,
    minor: 0n,
    patch: 10n,
  });
  assert.equal(parseStableTag("v6.1.0-beta.1"), null, "prerelease rejected");
  assert.equal(parseStableTag("v7.0"), null, "two components rejected");
  assert.equal(parseStableTag("v8.0.0+build"), null, "build metadata rejected");
  assert.equal(parseStableTag("6.0.3"), null, "missing v prefix rejected");
  assert.equal(parseStableTag("v01.2.3"), null, "leading zero rejected");
});

void test("compareStable orders components numerically at arbitrary width", () => {
  const a = parseStableTag("v6.0.2");
  const b = parseStableTag("v6.0.10");
  if (a === null || b === null) throw new Error("fixture failed to parse");
  assert.ok(compareStable(a, b) < 0);
  assert.ok(compareStable(b, a) > 0);
  assert.equal(compareStable(a, a), 0);

  const wide = parseStableTag("v99999999999999999999.0.0");
  const narrow = parseStableTag("v9999999999.0.0");
  if (wide === null || narrow === null) throw new Error("wide fixture failed");
  assert.ok(
    compareStable(narrow, wide) < 0,
    "twenty-digit major must exceed ten-digit major",
  );
});

void test("the SemVer grammar has one source", () => {
  assert.equal(SEMVER_BASE_RE.test("6.1.0-beta.1"), true);
  assert.equal(SEMVER_BASE_RE.test("01.2.3"), false);
  assert.equal(TAG_RE.test("v6.1.0-beta.1"), true);
  assert.equal(TAG_RE.test("6.1.0-beta.1"), false);
});

/**
 * Writes an executable named `git` into a fresh directory and returns it.
 * @param {import("node:test").TestContext} t
 * @param {string} body POSIX sh source, without the shebang
 */
async function fakeGitDir(t, body) {
  const directory = await mkdtemp(join(tmpdir(), "spw-fake-git-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "git");
  await writeFile(path, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(path, 0o755);
  return directory;
}

/** @param {import("node:test").TestContext} t */
async function sandboxDir(t) {
  const directory = await mkdtemp(join(tmpdir(), "spw-upstream-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * Runs `fn` with PATH replaced, restoring it afterwards.
 * @param {string} value
 * @param {() => Promise<unknown>} fn
 */
async function withPath(value, fn) {
  const original = process.env.PATH;
  process.env.PATH = value;
  try {
    return await fn();
  } finally {
    process.env.PATH = original;
  }
}

void test("runGit reports a zero exit with captured output", async (t) => {
  const bin = await fakeGitDir(
    t,
    'printf "out\\n"; printf "err\\n" >&2; exit 0',
  );
  const result = await withPath(bin, () => runGit(["anything"]));
  assert.deepEqual(result, {
    status: 0,
    signal: null,
    stdout: "out\n",
    stderr: "err\n",
  });
});

void test("runGit reports a non-zero exit rather than throwing", async (t) => {
  const bin = await fakeGitDir(
    t,
    'printf "fatal: not our ref\\n" >&2; exit 128',
  );
  const result = await withPath(bin, () => runGit(["fetch"]));
  assert.equal(result.status, 128);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /not our ref/);
});

void test("runGit reports signal termination as the null-status variant", async (t) => {
  const bin = await fakeGitDir(t, "kill -TERM $$; sleep 5");
  const result = await withPath(bin, () => runGit(["fetch"]));
  assert.equal(result.status, null);
  assert.equal(result.signal, "SIGTERM");
});

void test("runGit throws the frozen message when git is absent", async () => {
  await assert.rejects(
    withPath("", () => runGit(["--version"])),
    (error) =>
      error instanceof Error &&
      error.message === "required command not found: git",
  );
});

void test("runGit pins the child environment", async (t) => {
  const bin = await fakeGitDir(
    t,
    'printf "LC_ALL=%s\\n" "${LC_ALL-unset}"\n' +
      'printf "GIT_TERMINAL_PROMPT=%s\\n" "${GIT_TERMINAL_PROMPT-unset}"',
  );
  const result = await withPath(bin, () => runGit(["env"]));
  assert.equal(result.stdout.includes("LC_ALL=C\n"), true);
  assert.equal(result.stdout.includes("GIT_TERMINAL_PROMPT=0\n"), true);
});

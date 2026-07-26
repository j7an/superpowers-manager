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
 * @template T
 * @param {string} value
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
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

/** @type {typeof import("../../src/upstream-version.js")} */
const { manifestVersionForRef, sanitizeRefForVersion, shortCommit } =
  await import(new URL("../../dist/upstream-version.js", import.meta.url).href);

void test("manifestVersionForRef reproduces the shell derivation table", () => {
  const commit = "896224c4b1879920ab573417e68fd51d2ccc9072";
  assert.equal(shortCommit(commit), "896224c");

  assert.equal(
    manifestVersionForRef({
      requestedRef: "latest-release",
      resolutionKind: "latest-release",
      resolvedRef: "v6.0.3",
      commit,
    }),
    "6.0.3+manager.896224c",
  );
  assert.equal(
    manifestVersionForRef({
      requestedRef: "v6.1.0-beta.1",
      resolutionKind: "tag",
      resolvedRef: "v6.1.0-beta.1",
      commit: "abc1234abc1234abc1234abc1234abc1234abc12",
    }),
    "6.1.0-beta.1+manager.abc1234",
  );
  assert.equal(
    manifestVersionForRef({
      requestedRef: "main",
      resolutionKind: "ref",
      resolvedRef: "main",
      commit: "def5678def5678def5678def5678def5678def56",
    }),
    "0.0.0-main+manager.def5678",
  );
  assert.equal(
    manifestVersionForRef({
      requestedRef: "feature/foo",
      resolutionKind: "ref",
      resolvedRef: "feature/foo",
      commit: "fedcba9fedcba9fedcba9fedcba9fedcba9fedc",
    }),
    "0.0.0-ref-feature-foo+manager.fedcba9",
  );
  assert.equal(
    manifestVersionForRef({
      requestedRef: "042",
      resolutionKind: "ref",
      resolvedRef: "042",
      commit: "0123abc0123abc0123abc0123abc0123abc0123",
    }),
    "0.0.0-ref-042+manager.0123abc",
  );
  assert.equal(
    manifestVersionForRef({
      requestedRef: commit,
      resolutionKind: "raw-commit",
      resolvedRef: commit,
      commit,
    }),
    "0.0.0+manager.896224c",
  );
  assert.equal(
    manifestVersionForRef({
      requestedRef: "v1.2.3",
      resolutionKind: "ref",
      resolvedRef: "v1.2.3",
      commit,
    }),
    "0.0.0-ref-v1-2-3+manager.896224c",
  );
  assert.equal(
    manifestVersionForRef({
      requestedRef: "!!!",
      resolutionKind: "ref",
      resolvedRef: "!!!",
      commit,
    }),
    "0.0.0-ref-unknown+manager.896224c",
  );
  assert.equal(
    manifestVersionForRef({
      requestedRef: "v1.2.3-042",
      resolutionKind: "tag",
      resolvedRef: "v1.2.3-042",
      commit,
    }),
    "0.0.0+manager.896224c",
    "an invalid prerelease falls through to the 0.0.0 form",
  );

  const longRef =
    "feature/abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz";
  assert.equal(
    manifestVersionForRef({
      requestedRef: longRef,
      resolutionKind: "ref",
      resolvedRef: longRef,
      commit,
    }),
    "0.0.0-ref-feature-abcdefghijklmnopqrstuvwxyzabcdefghijklmn+manager.896224c",
  );
});

void test("sanitizeRefForVersion collapses, trims, and truncates", () => {
  assert.equal(
    sanitizeRefForVersion(
      "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstu/tail",
    ),
    "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstu",
  );
  assert.equal(sanitizeRefForVersion("!!!"), "unknown");
  assert.equal(sanitizeRefForVersion("---"), "unknown");
  assert.equal(sanitizeRefForVersion("a//b"), "a-b");
});

/** @type {typeof import("../../src/upstream.js")} */
const {
  parseLsRemote,
  selectLatestRelease,
  gitSafeSource,
  verifyRawCommit,
  fetchExactCommit,
} = await import(new URL("../../dist/upstream.js", import.meta.url).href);

const LS_REMOTE_FIXTURE = [
  "1111111111111111111111111111111111111111\trefs/tags/v6.0.2",
  "2222222222222222222222222222222222222222\trefs/tags/v6.0.2^{}",
  "3333333333333333333333333333333333333333\trefs/tags/v6.0.10",
  "4444444444444444444444444444444444444444\trefs/tags/v6.0.10^{}",
  "5555555555555555555555555555555555555555\trefs/tags/v6.1.0-beta.1",
  "6666666666666666666666666666666666666666\trefs/tags/v7.0",
  "7777777777777777777777777777777777777777\trefs/tags/v8.0.0+build",
  "",
].join("\n");

void test("selectLatestRelease picks the greatest stable tag and prefers peeled shas", () => {
  assert.deepEqual(selectLatestRelease(parseLsRemote(LS_REMOTE_FIXTURE)), {
    tag: "v6.0.10",
    sha: "4444444444444444444444444444444444444444",
  });
});

void test("selectLatestRelease ignores malformed leading-zero tags", () => {
  const entries = parseLsRemote(
    [
      "1111111111111111111111111111111111111111\trefs/tags/v1.2.3",
      "2222222222222222222222222222222222222222\trefs/tags/v01.2.3",
      "3333333333333333333333333333333333333333\trefs/tags/v099.0.0",
      "",
    ].join("\n"),
  );
  assert.deepEqual(selectLatestRelease(entries), {
    tag: "v1.2.3",
    sha: "1111111111111111111111111111111111111111",
  });
});

void test("selectLatestRelease orders components beyond ten digits numerically", () => {
  const entries = parseLsRemote(
    [
      "1111111111111111111111111111111111111111\trefs/tags/v99999999999999999999.0.0",
      "2222222222222222222222222222222222222222\trefs/tags/v9999999999.0.0",
      "",
    ].join("\n"),
  );
  assert.deepEqual(selectLatestRelease(entries), {
    tag: "v99999999999999999999.0.0",
    sha: "1111111111111111111111111111111111111111",
  });
});

void test("selectLatestRelease returns null when no stable tag exists", () => {
  assert.equal(selectLatestRelease(parseLsRemote("")), null);
  assert.equal(
    selectLatestRelease(
      parseLsRemote(
        "1111111111111111111111111111111111111111\trefs/tags/v6.1.0-beta.1\n",
      ),
    ),
    null,
  );
});

void test("gitSafeSource anchors bare relative paths and leaves others alone", () => {
  assert.equal(
    gitSafeSource("https://github.com/obra/superpowers"),
    "https://github.com/obra/superpowers",
  );
  assert.equal(gitSafeSource("/tmp/repo"), "/tmp/repo");
  assert.equal(gitSafeSource("git@host:repo.git"), "git@host:repo.git");
  assert.equal(gitSafeSource("~/repo"), "~/repo");
  assert.equal(gitSafeSource("relative"), `${process.cwd()}/relative`);
});

const COMMIT = "1234567890123456789012345678901234567890";

/**
 * A fake git whose `fetch` behavior is caller-supplied; `init` and `cat-file`
 * succeed, with `cat-file` reporting a commit.
 * @param {import("node:test").TestContext} t
 * @param {string} fetchBody
 */
async function fakeGitFetch(t, fetchBody) {
  return fakeGitDir(
    t,
    [
      'for arg in "$@"; do',
      '  case "$arg" in',
      `    fetch) ${fetchBody} ;;`,
      "    init) exit 0 ;;",
      '    cat-file) printf "commit\\n"; exit 0 ;;',
      "  esac",
      "done",
      "exit 0",
    ].join("\n"),
  );
}

void test("verifyRawCommit classifies an unavailable object", async (t) => {
  const parent = await sandboxDir(t);
  for (const marker of [
    "not our ref",
    "unadvertised object",
    "couldn't find remote ref",
  ]) {
    const bin = await fakeGitFetch(
      t,
      `printf "fatal: ${marker} xyz\\n" >&2; exit 128`,
    );
    await assert.rejects(
      withPath(bin, () => verifyRawCommit("/srv/repo", COMMIT, parent)),
      (error) =>
        error instanceof Error &&
        error.message === `source cannot supply requested commit: ${COMMIT}`,
      `marker: ${marker}`,
    );
  }
});

void test("verifyRawCommit reports other fetch failures as transport failures", async (t) => {
  const parent = await sandboxDir(t);
  const bin = await fakeGitFetch(t, "printf 'fatal: boom\\n' >&2; exit 128");
  await assert.rejects(
    withPath(bin, () => verifyRawCommit("/srv/repo", COMMIT, parent)),
    (error) =>
      error instanceof Error &&
      error.message === "cannot fetch requested commit from /srv/repo",
  );
});

void test("verifyRawCommit rejects a non-commit object and lowercases input", async (t) => {
  const parent = await sandboxDir(t);
  const upper = "ABCDEF1234567890ABCDEF1234567890ABCDEF12";
  const bin = await fakeGitDir(
    t,
    [
      'for arg in "$@"; do',
      '  case "$arg" in',
      '    cat-file) printf "blob\\n"; exit 0 ;;',
      "  esac",
      "done",
      "exit 0",
    ].join("\n"),
  );
  await assert.rejects(
    withPath(bin, () => verifyRawCommit("/srv/repo", upper, parent)),
    (error) =>
      error instanceof Error &&
      error.message ===
        `requested object is not a commit: ${upper.toLowerCase()}`,
  );
});

void test("fetchExactCommit re-initializes a cache whose .git is a file", async (t) => {
  const parent = await sandboxDir(t);
  const repository = join(parent, "cache");
  await mkdir(repository);
  await writeFile(join(repository, ".git"), "gitdir: /elsewhere\n", "utf8");
  const log = join(parent, "argv.log");
  const bin = await fakeGitDir(
    t,
    [
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      'for arg in "$@"; do',
      '  case "$arg" in',
      "    init) exit 0 ;;",
      '    cat-file) printf "commit\\n"; exit 0 ;;',
      "  esac",
      "done",
      "exit 0",
    ].join("\n"),
  );
  await withPath(bin, () =>
    fetchExactCommit("/srv/repo", COMMIT, repository, parent),
  );
  const argv = await readFile(log, "utf8");
  assert.ok(
    argv.includes(`init ${repository}`),
    `expected a cache init, got:\n${argv}`,
  );
});

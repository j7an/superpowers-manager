import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  parseStableTag,
  compareStable,
  TAG_RE,
  SEMVER_BASE_RE,
} from "../../src/domain/refs.ts";

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

import { runGit } from "../../src/git.ts";

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
 */
async function fakeGitDir(t: import("node:test").TestContext, body: string) {
  const directory = await mkdtemp(join(tmpdir(), "spw-fake-git-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "git");
  await writeFile(path, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(path, 0o755);
  return directory;
}

async function sandboxDir(t: import("node:test").TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "spw-upstream-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * Runs `fn` with PATH replaced, restoring it afterwards.
 */
async function withPath<T>(value: string, fn: () => Promise<T>): Promise<T> {
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

import {
  manifestVersionForRef,
  sanitizeRefForVersion,
  shortCommit,
} from "../../src/upstream-version.ts";

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

import {
  parseLsRemote,
  selectLatestRelease,
  gitSafeSource,
  verifyRawCommit,
  fetchExactCommit,
  resolveRef,
  resolveExactTag,
} from "../../src/upstream.ts";

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
 */
async function fakeGitFetch(
  t: import("node:test").TestContext,
  fetchBody: string,
) {
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

void test("resolveRef reports a query failure for latest-release", async (t) => {
  const bin = await fakeGitDir(t, 'printf "fatal: boom\\n" >&2; exit 128');
  const url = "https://example.invalid/repo.git";
  await assert.rejects(
    withPath(bin, () => resolveRef(url, "latest-release")),
    (error) =>
      error instanceof Error &&
      error.message === `cannot query upstream tags from ${url}: fatal: boom`,
  );
});

void test("resolveRef reports a query failure for a tag lookup", async (t) => {
  const bin = await fakeGitDir(t, 'printf "fatal: nope\\n" >&2; exit 128');
  const url = "https://example.invalid/repo.git";
  await assert.rejects(
    withPath(bin, () => resolveRef(url, "v1.2.3")),
    (error) =>
      error instanceof Error &&
      error.message ===
        `cannot query upstream tag v1.2.3 from ${url}: fatal: nope`,
  );
});

void test("resolveRef reports a query failure for the generic ref lookup", async (t) => {
  const bin = await fakeGitDir(
    t,
    [
      'case "$*" in',
      "  *--tags*) exit 0 ;;",
      '  *) printf "fatal: unreachable\\n" >&2; exit 1 ;;',
      "esac",
    ].join("\n"),
  );
  const url = "https://example.invalid/repo.git";
  await assert.rejects(
    withPath(bin, () => resolveRef(url, "topic-branch")),
    (error) =>
      error instanceof Error &&
      error.message ===
        `cannot query upstream ref topic-branch from ${url}: fatal: unreachable`,
  );
});

void test("resolveRef fails closed when every rung misses", async (t) => {
  const bin = await fakeGitDir(t, "exit 0");
  const url = "https://example.invalid/repo.git";
  await assert.rejects(
    withPath(bin, () => resolveRef(url, "nowhere")),
    (error) =>
      error instanceof Error &&
      error.message === "cannot resolve upstream ref: nowhere",
  );
});

void test("resolveRef selects the greatest stable tag for latest-release", async (t) => {
  const bin = await fakeGitDir(t, `printf '%s' '${LS_REMOTE_FIXTURE}'`);
  const url = "https://example.invalid/repo.git";
  const resolution = await withPath(bin, () =>
    resolveRef(url, "latest-release"),
  );
  assert.deepEqual(resolution, {
    kind: "latest-release",
    ref: "v6.0.10",
    commit: "4444444444444444444444444444444444444444",
  });
});

void test("resolveRef treats a 40-hex ref as a raw commit without querying", async (t) => {
  const bin = await fakeGitDir(
    t,
    'printf "fatal: must not run\\n" >&2; exit 1',
  );
  const url = "https://example.invalid/repo.git";
  const resolution = await withPath(bin, () => resolveRef(url, COMMIT));
  assert.deepEqual(resolution, {
    kind: "raw-commit",
    ref: COMMIT,
    commit: COMMIT,
  });
});

void test("resolveRef prefers the peeled tag entry over the direct one", async (t) => {
  const bin = await fakeGitDir(
    t,
    [
      'printf "%s\\n" "1111111111111111111111111111111111111111\trefs/tags/v6.0.10"',
      'printf "%s\\n" "2222222222222222222222222222222222222222\trefs/tags/v6.0.10^{}"',
      "exit 0",
    ].join("\n"),
  );
  const url = "https://example.invalid/repo.git";
  const resolution = await withPath(bin, () => resolveRef(url, "v6.0.10"));
  assert.deepEqual(resolution, {
    kind: "tag",
    ref: "v6.0.10",
    commit: "2222222222222222222222222222222222222222",
  });
});

void test("resolveRef falls through to the first generic ls-remote entry", async (t) => {
  const bin = await fakeGitDir(
    t,
    [
      'case "$*" in',
      "  *--tags*) exit 0 ;;",
      "  *)",
      '    printf "%s\\n" "3333333333333333333333333333333333333333\trefs/heads/topic-branch"',
      '    printf "%s\\n" "4444444444444444444444444444444444444444\trefs/heads/topic-branch-other"',
      "    exit 0",
      "    ;;",
      "esac",
    ].join("\n"),
  );
  const url = "https://example.invalid/repo.git";
  const resolution = await withPath(bin, () => resolveRef(url, "topic-branch"));
  assert.deepEqual(resolution, {
    kind: "ref",
    ref: "topic-branch",
    commit: "3333333333333333333333333333333333333333",
  });
});

void test("resolveExactTag reports a query failure", async (t) => {
  const bin = await fakeGitDir(t, 'printf "fatal: boom\\n" >&2; exit 128');
  await assert.rejects(
    withPath(bin, () => resolveExactTag("/srv/repo", "v1.2.3")),
    (error) =>
      error instanceof Error &&
      error.message ===
        "cannot query exact upstream tag v1.2.3 from /srv/repo: fatal: boom",
  );
});

void test("resolveExactTag reports the tag as not found when absent from otherwise-valid output", async (t) => {
  const bin = await fakeGitDir(
    t,
    'printf "%s\\n" "1111111111111111111111111111111111111111\trefs/tags/v9.9.9"',
  );
  await assert.rejects(
    withPath(bin, () => resolveExactTag("/srv/repo", "v1.2.3")),
    (error) =>
      error instanceof Error &&
      error.message === "upstream tag not found: v1.2.3",
  );
});

void test("resolveExactTag prefers the peeled entry over the direct one", async (t) => {
  const bin = await fakeGitDir(
    t,
    [
      'printf "%s\\n" "1111111111111111111111111111111111111111\trefs/tags/v1.2.3"',
      'printf "%s\\n" "2222222222222222222222222222222222222222\trefs/tags/v1.2.3^{}"',
      "exit 0",
    ].join("\n"),
  );
  const commit = await withPath(bin, () =>
    resolveExactTag("/srv/repo", "v1.2.3"),
  );
  assert.equal(commit, "2222222222222222222222222222222222222222");
});

const execFileAsync = promisify(execFile);
const UPSTREAM_CLI = new URL("../../src/upstream-cli.ts", import.meta.url)
  .pathname;

async function runCli(args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      UPSTREAM_CLI,
      ...args,
    ]);
    return { status: 0, stdout, stderr };
  } catch (error) {
    const failure = error as any;
    return {
      status: failure.code,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

void test("pin-kind classifies without normalizing", async () => {
  assert.equal((await runCli(["pin-kind", "--ref=v6.0.3"])).stdout, "tag\n");
  const upper = "ABCDEF1234567890abcdef1234567890ABCDEF12";
  assert.equal(
    (await runCli(["pin-kind", `--ref=${upper}`])).stdout,
    "raw-commit\n",
  );
  assert.equal((await runCli(["pin-kind", "--ref=main"])).stdout, "none\n");
  assert.equal((await runCli(["pin-kind", "--ref=v6.0"])).stdout, "none\n");
});

void test("manifest-version rejects an unknown resolution kind with usage status", async () => {
  const result = await runCli([
    "manifest-version",
    "--requested-ref=main",
    "--resolution-kind=bogus",
    "--resolved-ref=main",
    "--commit=896224c4b1879920ab573417e68fd51d2ccc9072",
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown resolution kind: bogus/);
});

void test("an unknown subcommand exits 2", async () => {
  const result = await runCli(["nope"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown subcommand: nope/);
});

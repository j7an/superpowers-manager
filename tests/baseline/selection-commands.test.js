// @ts-check
// Migrated from tests/test_selection_commands.sh (506 lines), a shell driver
// over scripts/pin, scripts/unpin, and scripts/track-latest.
//
// PR 11.5's earlier tasks already flipped all three commands to in-process
// TypeScript (src/cli.ts's DISPATCH, src/commands/pin.ts, unpin.ts,
// track-latest.ts), so this port calls those handlers directly instead of
// spawning the shell scripts, which were still live (not yet deleted — that
// happened in Task 10b) when this port was made. Three clusters have no
// port here, each for a different reason:
//   - Public argument-shape checks (no args / extra args) and the
//     malformed-single-argument early guard (:72-112) exercise
//     src/cli.ts's parseArgs — the TAG_RE/COMMIT_INPUT_RE gate that now runs
//     strictly before any handler, tool lookup, or Git access (main() exits
//     on a "usage-error" result before preflight/dispatch — src/cli.ts
//     :322-326). tests/baseline/cli-parity.test.js's CLI-USAGE-01 (:594-628)
//     and CLI-PIN-REF-01 (:630-716) already exercise this exact boundary
//     with far more inputs than this driver's three malformed refs,
//     including the numeric-component grammar (v01.2.3 etc.) that makes the
//     CR/LF-embedded shapes here redundant: TAG_RE/COMMIT_INPUT_RE are
//     whole-string anchored with no `m` flag, so an embedded CR or LF simply
//     cannot match either regex, the same structural guarantee that already
//     retired ref-resolution.md's spw_config_ref items.
//   - The malformed-ref usage-failure loop (:187-189) exercises the same
//     parseArgs boundary for six more argv shapes, all already covered by
//     CLI-PIN-REF-01's `refused` array.
//   - track-latest's "needs no Git" fixture (:418-431, a PATH stocked with
//     only dirname/mktemp/rm/python3/node) proved a shell property that
//     no longer exists to prove: runTrackLatest (src/commands/track-latest.ts)
//     never spawns a child process at all, so "needs no Git" is now a
//     structural fact about the absence of any child_process import, not a
//     runtime PATH-starvation property.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SIGNAL_CHILD = fileURLToPath(
  new URL("./selection-commands-signal-child.js", import.meta.url),
);

// A static import from `dist/` fails the `typecheck:js` gate the same way
// tests/baseline/selection-location.test.js:53-57 documents: dist output has
// no accompanying .d.ts, so checkJs treats every parameter along the chain as
// implicit `any`. Load the built modules dynamically while typing them
// against their `src/` sources instead.
/** @type {typeof import("../../src/commands/pin.js")} */
const { runPin } = await import(
  new URL("../../dist/commands/pin.js", import.meta.url).href
);
/** @type {typeof import("../../src/commands/unpin.js")} */
const { runUnpin } = await import(
  new URL("../../dist/commands/unpin.js", import.meta.url).href
);
/** @type {typeof import("../../src/commands/track-latest.js")} */
const { runTrackLatest } = await import(
  new URL("../../dist/commands/track-latest.js", import.meta.url).href
);
/** @type {typeof import("../../src/selection-store.js")} */
const { readSelectionState } = await import(
  new URL("../../dist/selection-store.js", import.meta.url).href
);
/** @type {typeof import("../../src/upstream.js")} */
const { verifyRawCommit, readConfigRef } = await import(
  new URL("../../dist/upstream.js", import.meta.url).href
);
/** @type {typeof import("../../src/effective-selection.js")} */
const { UPSTREAM_URL_DEFAULT } = await import(
  new URL("../../dist/effective-selection.js", import.meta.url).href
);

const SCRATCH = mkdtempSync(join(tmpdir(), "spw-selection-commands-"));
process.on("exit", () => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

// Per-invocation identity flags only. These write no git config at any scope
// and mirror tests/lib/harness.sh's spw_git_commit/spw_git_tag, the same
// convention tests/baseline/ref-resolution.test.js:78-83 documents — a
// deliberate departure from tests/test_selection_commands.sh:20-21's own
// `git config user.email`/`user.name` (repo-scoped, but still a config
// write this port avoids on principle).
const IDENTITY = [
  "-c",
  "user.email=superpowers-manager@example.invalid",
  "-c",
  "user.name=superpowers-manager",
];

/**
 * @param {string} repo
 * @param {readonly string[]} args
 * @returns {string}
 */
function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `fixture git ${args.join(" ")} failed in ${repo}: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

/**
 * The real `git` binary's absolute path, resolved before any fake `git` is
 * ever placed on PATH — mirroring tests/baseline/ref-resolution.test.js's
 * realGitPath, for the same reason: once a fake `git` shadows PATH, there is
 * no other way back to the real one.
 * @returns {string}
 */
function realGitPath() {
  const found = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" });
  const path = found.stdout.trim();
  if (found.status !== 0 || path === "") {
    throw new Error("fixture cannot locate a real git binary on PATH");
  }
  return path;
}

// Every fake-git fixture below reaches its runtime-varying values (the real
// git path, a log path, a conflicting state path and payload) only through
// these environment variables at run time, never through string
// interpolation into the generated shell — the same convention
// FAKE_GIT_PIN_SIGNAL_MARKER_VAR/FAKE_GIT_PIN_SIGNAL_REAL_VAR already follow
// for the signal fixture further down.
const FAKE_GIT_REAL_VAR = "SPW_FAKE_GIT_REAL";

// Falls through to the real `git` for everything except a `fetch`
// invocation, which it fails with a fixed diagnostic. Shared by the
// raw-commit transport-failure case (:239-260) and the redacted-display
// direct-call case (:262-281) — both need the exact same fixture.
const FAKE_GIT_TRANSPORT_FAILURE_BODY = [
  "#!/bin/sh",
  'case " $* " in',
  "  *' fetch '*) echo 'simulated transport failure' >&2; exit 1 ;;",
  `  *) exec "$${FAKE_GIT_REAL_VAR}" "$@" ;;`,
  "esac",
  "",
].join("\n");

const FAKE_GIT_LOG_VAR = "SPW_FAKE_GIT_LOG";

// Logs every invocation's argv, then always falls through to the real git.
// Shared by both pre-Git fail-closed guards (malformed/newer existing state
// via attemptWithExistingState, and the credential-bearing-source case) to
// prove zero Git invocations occurred.
const FAKE_GIT_LOG_AND_FORWARD_BODY = [
  "#!/bin/sh",
  `printf '%s\\n' "$*" >> "$${FAKE_GIT_LOG_VAR}"`,
  `exec "$${FAKE_GIT_REAL_VAR}" "$@"`,
  "",
].join("\n");

const FAKE_GIT_RACE_STATE_PATH_VAR = "SPW_FAKE_GIT_RACE_STATE_PATH";
const FAKE_GIT_RACE_BYTES_VAR = "SPW_FAKE_GIT_RACE_BYTES";

// Injects a conflicting write into the saved-state path the instant
// `ls-remote` runs — strictly before src/commands/pin.ts's attemptPin
// reaches its own write — then falls through to the real git. The payload
// travels as an env var, not as a JSON-escaped shell literal: an env var
// value needs no shell quoting at all (execFile never invokes a shell —
// src/git.ts's runGit passes `shell: false`), where a JSON escaper used in a
// quoting position is only safe for as long as nobody adds a `$`, backtick,
// or backslash to the payload.
const FAKE_GIT_RACE_BODY = [
  "#!/bin/sh",
  'case " $* " in',
  "  *' ls-remote '*)",
  `    printf '%s' "$${FAKE_GIT_RACE_BYTES_VAR}" > "$${FAKE_GIT_RACE_STATE_PATH_VAR}"`,
  "    ;;",
  "esac",
  `exec "$${FAKE_GIT_REAL_VAR}" "$@"`,
  "",
].join("\n");

/**
 * Writes a fake `git` executable at `dir/git` with the given POSIX sh body.
 * @param {string} dir
 * @param {string} body
 * @returns {string} the fake git's path
 */
function installFakeGit(dir, body) {
  const gitPath = join(dir, "git");
  writeFileSync(gitPath, body, "utf8");
  chmodSync(gitPath, 0o755);
  return gitPath;
}

/**
 * Runs `fn` with `dir` prepended to PATH and each entry of `envVars` set on
 * `process.env`, restoring every mutated variable (PATH included) afterward.
 * @template T
 * @param {string} dir
 * @param {Record<string, string>} envVars
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withFakeGitPath(dir, envVars, fn) {
  const keys = ["PATH", ...Object.keys(envVars)];
  /** @type {Record<string, string | undefined>} */
  const previous = {};
  for (const key of keys) previous[key] = process.env[key];
  process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
  for (const [key, value] of Object.entries(envVars)) {
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

/**
 * A real upstream repository shaped exactly like
 * tests/test_selection_commands.sh:19-34's inline setup: a lightweight
 * release tag (v1.0.0), a second commit carrying an annotated pre-release tag
 * (v1.1.0-rc.1), a branch named like a tag (v9.9.9) at the same commit, and
 * that commit's own blob object — enough to exercise every pin/unpin
 * resolution shape this file's REF-PIN-SOURCE-01 cluster needs. Built once at
 * module scope and shared read-mostly across every test below, which this
 * file runs sequentially (no `{ concurrency: true }`), the same assumption
 * tests/baseline/ref-resolution.test.js's shared UPSTREAM fixture relies on.
 * @returns {{
 *   repo: string,
 *   v1Commit: string,
 *   headCommit: string,
 *   annotatedTagObject: string,
 *   blobCommit: string,
 * }}
 */
function buildUpstreamRepo() {
  const repo = join(SCRATCH, "upstream");
  const init = spawnSync("git", ["init", repo], { encoding: "utf8" });
  if (init.status !== 0) {
    throw new Error(`fixture git init failed: ${init.stderr}`);
  }
  writeFileSync(join(repo, "file.txt"), "first\n", "utf8");
  git(repo, ["add", "file.txt"]);
  git(repo, [
    ...IDENTITY,
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "first",
  ]);
  const v1Commit = git(repo, ["rev-parse", "HEAD"]).trim();
  git(repo, ["tag", "v1.0.0"]); // lightweight, :26

  writeFileSync(join(repo, "file.txt"), "second\n", "utf8");
  git(repo, ["add", "file.txt"]);
  git(repo, [
    ...IDENTITY,
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "second",
  ]);
  const headCommit = git(repo, ["rev-parse", "HEAD"]).trim();
  git(repo, [
    ...IDENTITY,
    "-c",
    "tag.gpgsign=false",
    "tag",
    "-a",
    "v1.1.0-rc.1",
    "-m",
    "candidate",
  ]); // annotated, :31
  const annotatedTagObject = git(repo, [
    "rev-parse",
    "v1.1.0-rc.1^{tag}",
  ]).trim();
  git(repo, ["branch", "v9.9.9"]); // :33, a branch named like a tag
  const blobCommit = git(repo, ["rev-parse", "HEAD:file.txt"]).trim();
  return { repo, v1Commit, headCommit, annotatedTagObject, blobCommit };
}

const UPSTREAM = buildUpstreamRepo();

/**
 * Runs `fn` with `process.env.TMPDIR` pinned to `dir` and restores whatever
 * was there afterward. `verifyRawCommit`'s caller (src/commands/pin.ts's
 * attemptPin) calls `tmpdir()` from `node:os` with no argument, which reads
 * `process.env.TMPDIR` at call time — unlike `SUPERPOWERS_CONFIG_DIR`/
 * `SUPERPOWERS_UPSTREAM_URL`, which travel through `ctx.env` and never touch
 * the real process environment, the raw-commit verification workspace's
 * *parent* directory has no such per-call seam, so this is the only way to
 * point it at a caller-controlled directory the same way
 * tests/test_selection_commands.sh:132's `TMPDIR="$raw_tmp" run_pin ...` did.
 * Safe only because this file runs its tests sequentially.
 * @template T
 * @param {string} dir
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withTmpdir(dir, fn) {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
}

/**
 * Runs `fn` with the process's cwd pinned to `dir`, restoring it afterward.
 * `src/upstream.ts`'s `gitSafeSource` resolves a relative or dash-prefixed
 * source against `process.cwd()`, the same seam
 * tests/test_selection_commands.sh:141-145/151-157/166-170/177-181 exercises
 * by `cd`-ing into `$tmpdir` before invoking `pin` with a relative
 * `SUPERPOWERS_UPSTREAM_URL`. Safe only because this file runs sequentially.
 * @template T
 * @param {string} dir
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withCwd(dir, fn) {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

/**
 * Asserts `dir` holds nothing at all — the port of
 * tests/test_selection_commands.sh:58-65's `assert_path_empty`, used at every
 * point in REF-PIN-SOURCE-01 where the raw-commit verification workspace's
 * *parent* is expected to be left with none of its own temporary content
 * (unlike REF-PIN-CLEANUP-01's `assertOnlySiblingKept`, whose workspace
 * parent always keeps one caller-planted sibling).
 * @param {string} dir
 */
function assertWorkspaceParentEmpty(dir) {
  assert.deepEqual(readdirSync(dir), []);
}

/**
 * Asserts a workspace-parent directory holds exactly the one sibling file
 * this suite seeds it with, byte-for-byte — the pairing
 * tests/test_selection_commands.sh:338-339 checks twice (content, then
 * count), and the same helper shape
 * tests/baseline/ref-resolution.test.js:190-193 already uses for
 * fetchExactCommit's cleanup proofs.
 * @param {string} workspace
 */
function assertOnlySiblingKept(workspace) {
  assert.deepEqual(readdirSync(workspace), ["sibling"]);
  assert.equal(readFileSync(join(workspace, "sibling"), "utf8"), "keep\n");
}

/**
 * A fresh `SUPERPOWERS_CONFIG_DIR`, plus a `CommandContext` bound to it and
 * to a given `SUPERPOWERS_UPSTREAM_URL`. `root` is `ROOT` throughout this
 * file: none of pin/unpin/track-latest's TypeScript handlers read
 * `ctx.root` for anything except unpin's/track-latest's package-default
 * fallback lookup (`readConfigRef`), which this repository's own
 * `config/upstream-ref` (currently `latest-release`) can answer directly —
 * see `packagedFallback` below for why that value is read, not hardcoded.
 * @param {string} label
 * @param {NodeJS.ProcessEnv} envOverrides
 * @returns {{ configDir: string, statePath: string, ctx: import("../../src/commands/context.js").CommandContext, stdout: { text: () => string }, stderr: { text: () => string } }}
 */
function freshContext(label, envOverrides) {
  const configDir = mkdtempSync(join(SCRATCH, `${label}-config-`));
  const statePath = join(configDir, "selection.json");
  const outChunks = /** @type {string[]} */ ([]);
  const errChunks = /** @type {string[]} */ ([]);
  const ctx = {
    root: ROOT,
    env: { SUPERPOWERS_CONFIG_DIR: configDir, ...envOverrides },
    stdout: /** @type {any} */ ({
      write: (/** @type {string} */ s) => {
        outChunks.push(s);
        return true;
      },
    }),
    stderr: /** @type {any} */ ({
      write: (/** @type {string} */ s) => {
        errChunks.push(s);
        return true;
      },
    }),
  };
  return {
    configDir,
    statePath,
    ctx,
    stdout: { text: () => outChunks.join("") },
    stderr: { text: () => errChunks.join("") },
  };
}

/**
 * The packaged fallback ref this repository's own `config/upstream-ref`
 * currently names. Read once, dynamically, rather than hardcoded: that file
 * is a project release pin whose value is not this test's to assert as a
 * literal (AGENTS.md's "never assert a hardcoded value whose source of truth
 * lives outside the test").
 * @returns {Promise<string>}
 */
async function packagedFallback() {
  return readConfigRef(ROOT, {});
}

void test("REF-PIN-SOURCE-01 exact tag and raw commit pins prove selected source", async () => {
  const { repo, v1Commit, headCommit, annotatedTagObject, blobCommit } =
    UPSTREAM;

  // Lightweight and annotated tags resolve through the exact tag namespace,
  // with peeling. :114-127
  {
    const { statePath, ctx, stdout } = freshContext("tag", {
      SUPERPOWERS_UPSTREAM_URL: repo,
    });
    const status = await runPin(["v1.0.0"], ctx);
    assert.equal(status, 0);
    assert.equal(
      stdout.text(),
      `pinned upstream selection to v1.0.0 at ${v1Commit}\n`,
    ); // :117
    const saved = await readSelectionState(statePath);
    if (saved === null || saved.mode !== "pinned") {
      throw new Error(
        `expected a pinned record, got: ${JSON.stringify(saved)}`,
      );
    }
    // Merged: five separate `assert_saved_string` calls (:118-122) into one
    // exact-shape comparison, strictly stronger — it also proves no
    // unexpected field survived, which the shell's per-field checks never
    // asserted.
    assert.deepEqual(saved, {
      schema_version: 1,
      mode: "pinned",
      source: repo,
      requested_ref: "v1.0.0",
      resolved_ref: "v1.0.0",
      commit: v1Commit,
    }); // :118-122

    const preRelease = await runPin(["v1.1.0-rc.1"], ctx);
    assert.equal(preRelease, 0);
    const savedPreRelease = await readSelectionState(statePath);
    if (savedPreRelease === null || savedPreRelease.mode !== "pinned") {
      throw new Error("expected a pinned record for the annotated tag");
    }
    assert.equal(savedPreRelease.requested_ref, "v1.1.0-rc.1"); // :125
    assert.equal(savedPreRelease.resolved_ref, "v1.1.0-rc.1"); // :126
    assert.equal(savedPreRelease.commit, headCommit); // :127, peeled past the tag object
  }

  // Full commit input is normalized (case-folded) before verification and
  // persistence, and the verification workspace leaves its parent exactly
  // as it found it. :129-136
  {
    const { statePath, ctx } = freshContext("raw-success", {
      SUPERPOWERS_UPSTREAM_URL: repo,
    });
    const rawTmp = mkdtempSync(join(SCRATCH, "raw-success-tmp-"));
    const status = await withTmpdir(rawTmp, () =>
      runPin([headCommit.toUpperCase()], ctx),
    );
    assert.equal(status, 0);
    const saved = await readSelectionState(statePath);
    if (saved === null || saved.mode !== "pinned") {
      throw new Error("expected a pinned record for the raw commit");
    }
    assert.equal(saved.requested_ref, headCommit); // :133, lowercased
    assert.equal(saved.resolved_ref, headCommit); // :134
    assert.equal(saved.commit, headCommit); // :135
    assertWorkspaceParentEmpty(rawTmp); // :136
  }

  // Raw verification retains the caller's context for relative and
  // dash-prefixed local sources while using an option terminator before the
  // repository argument. Exact-tag verification supports the same two
  // source shapes. :138-185
  {
    // `UPSTREAM.repo` already lives at `${SCRATCH}/upstream` (see
    // buildUpstreamRepo above), so "upstream" is already a valid relative
    // source once cwd is SCRATCH — no fixture copy needed. The dash-prefixed
    // name is a symlink to it, mirroring
    // tests/test_selection_commands.sh:151's `ln -s upstream
    // "$tmpdir/-upstream"`.
    const relativeName = "upstream";
    const dashName = "-upstream";
    symlinkSync(relativeName, join(SCRATCH, dashName));

    for (const sourceName of [relativeName, dashName]) {
      const { statePath, ctx } = freshContext(`raw-${sourceName}`, {
        SUPERPOWERS_UPSTREAM_URL: sourceName,
      });
      const status = await withCwd(SCRATCH, () => runPin([headCommit], ctx));
      assert.equal(status, 0);
      const saved = await readSelectionState(statePath);
      if (saved === null || saved.mode !== "pinned") {
        throw new Error(`expected a pinned record for source ${sourceName}`);
      }
      assert.equal(saved.source, sourceName); // :148/160, the raw env value, not the resolved absolute path
      assert.equal(saved.commit, headCommit); // :149/161
    }

    for (const sourceName of [relativeName, dashName]) {
      const { statePath, ctx } = freshContext(`tag-${sourceName}`, {
        SUPERPOWERS_UPSTREAM_URL: sourceName,
      });
      const status = await withCwd(SCRATCH, () => runPin(["v1.0.0"], ctx));
      assert.equal(status, 0);
      const saved = await readSelectionState(statePath);
      if (saved === null || saved.mode !== "pinned") {
        throw new Error(`expected a pinned record for source ${sourceName}`);
      }
      assert.equal(saved.source, sourceName); // :173/184
      assert.equal(saved.commit, v1Commit); // :174/185
    }
  }

  // A branch named like a tag cannot satisfy an exact persistent tag pin:
  // the exact-tag namespace query never matches it, so resolution fails and
  // state is left untouched. :191-198
  {
    const { statePath, ctx } = freshContext("branch-like-tag", {
      SUPERPOWERS_UPSTREAM_URL: repo,
    });
    await runPin(["v1.0.0"], ctx); // establish a "before" state
    const before = readFileSync(statePath, "utf8");
    const errCtx = { ...ctx, stderr: makeCapture() };
    const status = await runPin(["v9.9.9"], errCtx);
    assert.equal(status, 1); // :196
    assert.match(errCtx.stderr.text(), /upstream tag not found: v9\.9\.9/); // :197
    assert.equal(readFileSync(statePath, "utf8"), before); // :198
  }

  // Transport, unavailable-object, and non-commit failures occur before
  // writing, in every case leaving the raw-commit verification workspace's
  // parent exactly as found. :200-260
  {
    const { statePath, ctx } = freshContext("failure-baseline", {
      SUPERPOWERS_UPSTREAM_URL: repo,
    });
    await runPin(["v1.0.0"], ctx);
    const before = readFileSync(statePath, "utf8");

    // Exact-tag transport failure. :200-206
    {
      const missingUpstream = join(SCRATCH, "missing-upstream");
      const failCtx = {
        ...ctx,
        env: { ...ctx.env, SUPERPOWERS_UPSTREAM_URL: missingUpstream },
        stderr: makeCapture(),
      };
      const status = await runPin(["v1.0.0"], failCtx);
      assert.equal(status, 1); // :204
      assert.match(
        failCtx.stderr.text(),
        /cannot query exact upstream tag v1\.0\.0/,
      ); // :205
      assert.equal(readFileSync(statePath, "utf8"), before); // :206
    }

    // Raw-commit unavailable-object failure. :208-217
    {
      const missingCommit = "a".repeat(40);
      const rawTmp = mkdtempSync(join(SCRATCH, "raw-missing-"));
      const failCtx = { ...ctx, stderr: makeCapture() };
      const status = await withTmpdir(rawTmp, () =>
        runPin([missingCommit], failCtx),
      );
      assert.equal(status, 1); // :214
      assert.match(
        failCtx.stderr.text(),
        /source cannot supply requested commit/,
      ); // :215
      assert.equal(readFileSync(statePath, "utf8"), before); // :216
      assertWorkspaceParentEmpty(rawTmp); // :217
    }

    // Raw-commit blob-object rejection. :219-227
    {
      const rawTmp = mkdtempSync(join(SCRATCH, "raw-blob-"));
      const failCtx = { ...ctx, stderr: makeCapture() };
      const status = await withTmpdir(rawTmp, () =>
        runPin([blobCommit], failCtx),
      );
      assert.equal(status, 1); // :224
      assert.match(failCtx.stderr.text(), /requested object is not a commit/); // :225
      assert.equal(readFileSync(statePath, "utf8"), before); // :226
      assertWorkspaceParentEmpty(rawTmp); // :227
    }

    // Raw-commit annotated-tag-object rejection. :229-237
    {
      const rawTmp = mkdtempSync(join(SCRATCH, "raw-tag-object-"));
      const failCtx = { ...ctx, stderr: makeCapture() };
      const status = await withTmpdir(rawTmp, () =>
        runPin([annotatedTagObject], failCtx),
      );
      assert.equal(status, 1); // :234
      assert.match(failCtx.stderr.text(), /requested object is not a commit/); // :235
      assert.equal(readFileSync(statePath, "utf8"), before); // :236
      assertWorkspaceParentEmpty(rawTmp); // :237
    }

    // Raw-commit transport (fetch) failure. :239-260
    {
      const fakeBin = mkdtempSync(join(SCRATCH, "fetch-failure-bin-"));
      installFakeGit(fakeBin, FAKE_GIT_TRANSPORT_FAILURE_BODY);
      const rawTmp = mkdtempSync(join(SCRATCH, "raw-transport-"));
      const failCtx = { ...ctx, stderr: makeCapture() };
      const status = await withFakeGitPath(
        fakeBin,
        { [FAKE_GIT_REAL_VAR]: realGitPath() },
        () => withTmpdir(rawTmp, () => runPin([headCommit], failCtx)),
      );
      assert.equal(status, 1); // :257
      assert.ok(
        failCtx.stderr
          .text()
          .includes(`cannot fetch requested commit from ${repo}`),
        failCtx.stderr.text(),
      ); // :258
      assert.equal(readFileSync(statePath, "utf8"), before); // :259
      assertWorkspaceParentEmpty(rawTmp); // :260
    }
  }

  // The raw verifier redacts an unsafe display even when called directly,
  // below pin's own public source validation — and never leaks the
  // credential it redacted. :262-281 (the shell's :265-271 `set -x`
  // save/restore around this call is test-harness bookkeeping about its own
  // debug trace, not a check of pin/unpin behavior, so it has no port here.)
  {
    const fakeBin = mkdtempSync(join(SCRATCH, "redact-bin-"));
    installFakeGit(fakeBin, FAKE_GIT_TRANSPORT_FAILURE_BODY);
    await withFakeGitPath(
      fakeBin,
      { [FAKE_GIT_REAL_VAR]: realGitPath() },
      async () => {
        await assert.rejects(
          verifyRawCommit(
            "https://token@example.invalid/repo",
            headCommit,
            SCRATCH,
          ),
          (/** @type {unknown} */ error) => {
            assert.ok(error instanceof Error);
            assert.equal(
              error.message,
              "cannot fetch requested commit from <redacted-source>",
            ); // :272-277
            assert.equal(
              error.message.includes("token@example.invalid"),
              false,
            ); // :278-281
            return true;
          },
        );
      },
    );
  }
});

/**
 * A minimal writable-stream stand-in that records every chunk written to it.
 * Typed `any` at the boundary (the same convention
 * tests/unit/helpers/command-harness.js's `capture` uses): it is deliberately
 * not shaped like the full `NodeJS.WritableStream` interface `ctx.stdout`/
 * `ctx.stderr` declare, only like the `write` method every handler in
 * src/commands/*.ts actually calls.
 * @returns {any}
 */
function makeCapture() {
  /** @type {string[]} */
  const chunks = [];
  return {
    write: (/** @type {string} */ s) => {
      chunks.push(s);
      return true;
    },
    text: () => chunks.join(""),
  };
}

// A fixed script body, containing no test-controlled value: the log/marker
// paths and the real git binary reach it only through the
// FAKE_GIT_PIN_SIGNAL_*_VAR environment variables at run time, mirroring
// tests/baseline/ref-resolution.test.js's FAKE_GIT_SIGNAL_BODY convention.
// Ports tests/test_selection_commands.sh:287-296's fixture: every `fetch`
// invocation hangs instead of completing, so the parent can interrupt it
// mid-flight — matching the shell fixture's own broader `*' fetch '*` match
// (verifyRawCommit's only fetch call is `fetch --no-tags --`, so there is no
// other invocation shape this could accidentally catch instead).
const FAKE_GIT_PIN_SIGNAL_MARKER_VAR = "SPW_FAKE_GIT_PIN_SIGNAL_MARKER";
const FAKE_GIT_PIN_SIGNAL_REAL_VAR = "SPW_FAKE_GIT_PIN_SIGNAL_REAL";
const FAKE_GIT_PIN_SIGNAL_BODY = [
  "#!/bin/sh",
  'case " $* " in',
  "  *' fetch '*)",
  `    : > "$${FAKE_GIT_PIN_SIGNAL_MARKER_VAR}"`,
  "    /bin/sleep 30 &",
  "    wait $!",
  "    ;;",
  "  *)",
  `    "$${FAKE_GIT_PIN_SIGNAL_REAL_VAR}" "$@"`,
  "    ;;",
  "esac",
  "",
].join("\n");

/**
 * Polls for `path` to exist, returning `false` on timeout rather than
 * throwing, so the caller can attach its own diagnostic. Mirrors
 * tests/baseline/ref-resolution.test.js's waitForMarker, itself a port of
 * tests/test_selection_commands.sh:322-324's Python marker wait.
 * @param {string} path
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitForMarker(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

void test("REF-PIN-CLEANUP-01 interrupted pin proof cleans only its workspace", async (t) => {
  const { repo, headCommit } = UPSTREAM;
  const base = mkdtempSync(join(SCRATCH, "pin-cleanup-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const rawTmp = join(base, "raw-signal");
  mkdirSync(rawTmp);
  writeFileSync(join(rawTmp, "sibling"), "keep\n", "utf8");

  const configDir = join(base, "config");
  mkdirSync(configDir);
  const statePath = join(configDir, "selection.json");
  // No pre-existing state: a successful pin WOULD create this file, so its
  // continued absence after interruption is a real, falsifiable proof that
  // the write step in src/commands/pin.ts's attemptPin (which runs only
  // after verifyRawCommit resolves) was never reached.

  const binDir = join(base, "fetch-signal-bin");
  mkdirSync(binDir);
  const gitPath = join(binDir, "git");
  writeFileSync(gitPath, FAKE_GIT_PIN_SIGNAL_BODY, "utf8");
  chmodSync(gitPath, 0o755);

  const marker = join(base, "fetch-started");

  // `detached: true` makes this child the leader of its own process group, so
  // signalling `-child.pid` below reaches both it and the `/bin/sleep`
  // descendant the fake `git` starts — the Node analogue of
  // tests/test_selection_commands.sh:301-330's Python fixture, which uses
  // `start_new_session=True` plus `os.killpg` for exactly this reason, the
  // same shape tests/baseline/ref-resolution.test.js's REF-CLEANUP-01 already
  // uses.
  const child = spawn(process.execPath, [SIGNAL_CHILD, ROOT, headCommit], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      TMPDIR: rawTmp,
      SUPERPOWERS_CONFIG_DIR: configDir,
      SUPERPOWERS_UPSTREAM_URL: repo,
      [FAKE_GIT_PIN_SIGNAL_MARKER_VAR]: marker,
      [FAKE_GIT_PIN_SIGNAL_REAL_VAR]: realGitPath(),
    },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const reached = await waitForMarker(marker, 5000); // :322-324/325-327
  if (!reached) {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    assert.fail(
      `raw-commit verification did not reach the signal fixture; stderr:\n${stderr}`,
    );
  }
  if (child.pid === undefined) throw new Error("signal child has no pid");
  process.kill(-child.pid, "SIGTERM");

  /** @type {{ code: number | null, signal: NodeJS.Signals | null }} */
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  // Task 4a's cleanupForSignal cleans synchronously, deregisters its own
  // listeners, then re-raises, so the process dies BY the signal rather than
  // exiting with a number — `128+N` is a shell convention, not a POSIX
  // guarantee, so this asserts the signal itself rather than 143. Strictly
  // stronger than, and so merges, tests/test_selection_commands.sh:332-337's
  // bare `test "$rc" -ne 143` check.
  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.code, null);

  // The interrupted verification workspace holds only the caller's sibling
  // afterward: nothing else leaked, and the sibling is untouched. :338-339
  assertOnlySiblingKept(rawTmp);

  // The one assertion unique to this case: interrupting mid-verification
  // must leave no saved selection at all — proving the interruption landed
  // before src/commands/pin.ts's attemptPin ever reached its write step.
  // :340 (assert_state_unchanged "$before", ported here against an absent
  // "before" rather than a populated one, since this fixture's config
  // directory starts empty)
  assert.equal(existsSync(statePath), false);
});

void test("pin's writer revalidates saved state after Git verification and rejects a race introduced during resolution", async () => {
  const { repo } = UPSTREAM;
  // The writer re-reads state immediately before writing (src/selection-store
  // .ts's writeSelectionState calls readSelectionState on the same path
  // before committing a proposed record — "Invalid existing state must block
  // overwrite"). This proves that re-read actually catches a change injected
  // *during* the Git verification window between src/commands/pin.ts's
  // attemptPin's initial loadSavedSelection and its final write — a fake
  // `git` mutates the state file the instant `ls-remote` runs, which is
  // strictly earlier than the write, so if the re-read did not exist, the
  // race would silently overwrite the conflicting state instead of failing
  // and preserving it. :342-374
  for (const conflict of /** @type {const} */ (["malformed", "newer"])) {
    const { statePath, ctx } = freshContext(`race-${conflict}`, {
      SUPERPOWERS_UPSTREAM_URL: repo,
    });
    const conflictBytes =
      conflict === "malformed"
        ? "{changed during verification"
        : '{"schema_version":2,"mode":"track-latest","source":"https://example.invalid/repo"}';
    const fakeBin = mkdtempSync(join(SCRATCH, `race-bin-${conflict}-`));
    installFakeGit(fakeBin, FAKE_GIT_RACE_BODY);
    const errCtx = { ...ctx, stderr: makeCapture() };
    const status = await withFakeGitPath(
      fakeBin,
      {
        [FAKE_GIT_REAL_VAR]: realGitPath(),
        [FAKE_GIT_RACE_STATE_PATH_VAR]: statePath,
        [FAKE_GIT_RACE_BYTES_VAR]: conflictBytes,
      },
      () => runPin(["v1.0.0"], errCtx),
    );
    assert.equal(status, 1); // :368
    assert.equal(readFileSync(statePath, "utf8"), conflictBytes); // :373 — the conflicting write survives untouched
  }
});

void test("pin fails closed on malformed or newer saved state and on a credential-bearing source before any Git process runs", async () => {
  const { repo } = UPSTREAM;

  /**
   * @param {string} existingBytes
   * @returns {Promise<{ status: number, gitLog: string, statePath: string }>}
   */
  async function attemptWithExistingState(existingBytes) {
    const { configDir, statePath, ctx } = freshContext("preflight", {
      SUPERPOWERS_UPSTREAM_URL: repo,
    });
    writeFileSync(statePath, existingBytes, "utf8");
    const gitLog = join(configDir, "git.log");
    const guardBin = mkdtempSync(join(SCRATCH, "state-guard-bin-"));
    installFakeGit(guardBin, FAKE_GIT_LOG_AND_FORWARD_BODY);
    const status = await withFakeGitPath(
      guardBin,
      { [FAKE_GIT_REAL_VAR]: realGitPath(), [FAKE_GIT_LOG_VAR]: gitLog },
      () => runPin(["v1.0.0"], { ...ctx, stderr: makeCapture() }),
    );
    return { status, gitLog, statePath };
  }

  // Malformed existing state. :376-395
  {
    const { status, gitLog, statePath } =
      await attemptWithExistingState("{bad json");
    assert.equal(status, 1); // :393
    assert.equal(existsSync(gitLog), false); // :394
    assert.equal(readFileSync(statePath, "utf8"), "{bad json"); // :395
  }

  // Newer/incompatible existing state (a schema_version this port does not
  // understand). :397-406
  {
    const newerBytes =
      '{"schema_version":2,"mode":"track-latest","source":"https://example.invalid/repo"}';
    const { status, gitLog, statePath } =
      await attemptWithExistingState(newerBytes);
    assert.equal(status, 1); // :404
    assert.equal(existsSync(gitLog), false); // :405
    assert.equal(readFileSync(statePath, "utf8"), newerBytes); // :406
  }

  // Source validation is also pre-Git and refuses HTTP(S) userinfo. :408-416
  {
    const { configDir, ctx } = freshContext("preflight-source", {
      SUPERPOWERS_UPSTREAM_URL: "https://token@example.invalid/repo",
    });
    const gitLog = join(configDir, "git.log");
    const guardBin = mkdtempSync(join(SCRATCH, "state-guard-bin-source-"));
    installFakeGit(guardBin, FAKE_GIT_LOG_AND_FORWARD_BODY);
    const errCtx = { ...ctx, stderr: makeCapture() };
    const status = await withFakeGitPath(
      guardBin,
      { [FAKE_GIT_REAL_VAR]: realGitPath(), [FAKE_GIT_LOG_VAR]: gitLog },
      () => runPin(["v1.0.0"], errCtx),
    );
    assert.equal(status, 1); // :414
    assert.match(
      errCtx.stderr.text(),
      /HTTP\(S\) source must not include userinfo/,
    ); // :415
    assert.equal(existsSync(gitLog), false); // :416
  }
});

void test("track-latest defaults its saved source to the official upstream, and fails closed on an existing record of an unrecognized schema", async () => {
  // tests/test_selection_commands.sh:437-441. The explicit-source write
  // (:429-435) and the extra-argument usage error (:452-455) are already
  // exercised by tests/unit/commands-track-latest.test.js's "track-latest
  // writes the record and prints one line" and "track-latest rejects extra
  // arguments with exit 2" — the same code paths this file's own retirement
  // note above already covers. The one behavior that unit suite does not
  // exercise is the true package-default source (SUPERPOWERS_UPSTREAM_URL
  // set to the empty string, matching runTrackLatest's `||` fallback — see
  // src/commands/track-latest.ts:31 — not the variable left absent, which
  // the shell's own `${VAR:-default}` treats identically but this project
  // otherwise treats presence-vs-emptiness as distinct, e.g.
  // src/effective-selection.ts:20-28), which this repository's shell driver
  // only reached by stripping PATH down to a Git-less stub (:420-428) — moot
  // now that runTrackLatest never spawns a process to begin with (see this
  // file's header comment).
  {
    const { statePath, ctx } = freshContext("track-official", {
      SUPERPOWERS_UPSTREAM_URL: "",
    });
    const status = await runTrackLatest([], ctx);
    assert.equal(status, 0);
    const saved = await readSelectionState(statePath);
    if (saved === null || saved.mode !== "track-latest") {
      throw new Error("expected a track-latest record");
    }
    assert.equal(saved.source, UPSTREAM_URL_DEFAULT); // :441
  }

  // An existing record of an unrecognized schema_version fails the
  // track-latest attempt with status 1 and leaves the bytes unchanged
  // (:443-450) — the same validateRecord/schema_version guard, and the same
  // fixture shape, already ported for pin at :909-919 above. Unlike pin's
  // guards, this one has no "no Git process ran" companion check: runTrackLatest
  // never invokes Git at all (see this file's header comment), so there is
  // no observable Git-invocation count for a fixture to prove absent. The
  // shell asserted no message either, so the status/bytes checks alone are
  // honest parity — but this `assert.match` earns its place anyway: it is
  // the empirical proof that this fixture actually reaches
  // `validateRecord`'s `schema_version must equal integer 1` branch
  // (src/selection.ts:198), not the JSON-parse-failure branch
  // tests/unit/commands-track-latest.test.js's "refuses to overwrite a
  // corrupt saved record" exercises — the exact distinction Important 1's
  // retirement citation got wrong, made self-evident here once
  // tests/test_selection_commands.sh itself is gone.
  {
    const newerBytes =
      '{"schema_version":2,"mode":"track-latest","source":"https://example.invalid/repo"}';
    const { statePath, ctx } = freshContext("track-newer", {});
    writeFileSync(statePath, newerBytes, "utf8");
    const errCtx = { ...ctx, stderr: makeCapture() };
    const status = await runTrackLatest([], errCtx);
    assert.equal(status, 1); // :449
    assert.match(errCtx.stderr.text(), /schema_version must equal integer 1/);
    assert.equal(readFileSync(statePath, "utf8"), newerBytes); // :450
  }
});

void test("FS-SELECTION-UNPIN-TYPES-01 unpin rejects unsafe path types", async () => {
  // unpin is parse-free and idempotent, removes only the exact regular file,
  // and names the packaged fallback plus active invocation overrides.
  // :457-505 (the extra-argument usage error at :501-504 is already
  // exercised by tests/baseline/cli-parity.test.js's CLI-USAGE-01
  // `["unpin", "extra"]` case, at the same src/cli.ts parseArgs boundary this
  // file's header comment already covers, so it has no port here.)
  const fallback = await packagedFallback();
  const { configDir, statePath, ctx } = freshContext("unpin", {
    SUPERPOWERS_REF: "main",
    SUPERPOWERS_UPSTREAM_URL: UPSTREAM.repo,
  });
  writeFileSync(statePath, "malformed", "utf8");
  const keep = join(configDir, "keep");
  writeFileSync(keep, "sibling", "utf8");

  {
    const outCtx = { ...ctx, stdout: makeCapture() };
    const status = await runUnpin([], outCtx);
    assert.equal(status, 0);
    assert.equal(
      outCtx.stdout.text(),
      `removed saved upstream selection; packaged fallback is ${fallback}\n` +
        "note: active SUPERPOWERS_REF override remains effective\n" +
        "note: active SUPERPOWERS_UPSTREAM_URL override remains effective\n",
    ); // :466-468, merged: exact-shape equality subsumes the shell's three
    // separate `grep -Fxq`/`grep -Fq` checks and is strictly stronger — it
    // also proves nothing else was printed.
    assert.equal(existsSync(statePath), false); // :469
    assert.equal(readFileSync(keep, "utf8"), "sibling"); // :470
  }

  {
    const outCtx = {
      ...ctx,
      env: { SUPERPOWERS_CONFIG_DIR: configDir },
      stdout: makeCapture(),
    };
    const status = await runUnpin([], outCtx);
    assert.equal(status, 0);
    assert.equal(
      outCtx.stdout.text(),
      `no saved upstream selection; packaged fallback is ${fallback}\n`,
    ); // :473
    assert.equal(readFileSync(keep, "utf8"), "sibling"); // :474
  }

  /**
   * @param {"symlink" | "directory" | "special"} kind
   */
  async function assertUnpinRefuses(kind) {
    const errCtx = {
      ...ctx,
      env: { SUPERPOWERS_CONFIG_DIR: configDir },
      stderr: makeCapture(),
    };
    const status = await runUnpin([], errCtx);
    assert.equal(status, 1); // :481
    assert.match(errCtx.stderr.text(), /remove it manually after inspecting/); // :482
    // lstatSync succeeding at all (rather than throwing ENOENT) is itself the
    // proof that the path still exists as some filesystem entry — strictly
    // stronger than tests/test_selection_commands.sh:483's
    // `test -e ... || test -L ...`, which exists only to also admit a broken
    // symlink that `-e` alone would call absent.
    const info = lstatSync(statePath);
    switch (kind) {
      case "symlink":
        assert.equal(info.isSymbolicLink(), true); // :485
        break;
      case "directory":
        assert.equal(info.isDirectory(), true); // :486
        break;
      case "special":
        assert.equal(info.isFIFO(), true); // :487
        break;
    }
  }

  symlinkSync(keep, statePath);
  await assertUnpinRefuses("symlink"); // :492
  rmSync(statePath);

  mkdirSync(statePath);
  await assertUnpinRefuses("directory"); // :495
  rmSync(statePath, { recursive: true });

  execFileSync("mkfifo", [statePath]);
  await assertUnpinRefuses("special"); // :498
  rmSync(statePath);
});

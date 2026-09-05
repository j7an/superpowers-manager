// Migrated from tests/test_ref_resolution.sh (242 lines), a shell driver over
// scripts/core/upstream.sh's spw_config_ref, spw_manifest_version_for_ref,
// spw_resolve_ref, and spw_fetch_exact_commit, plus scripts/core/common.sh's
// spw_node_cli.
//
// PR 11.5's earlier tasks already ported the resolution/fetch/version-derivation
// logic to TypeScript (src/upstream.ts's resolveRef/fetchExactCommit/
// readConfigRef, src/upstream-version.ts's manifestVersionForRef), so this
// port exercises those directly wherever doing so does not lose coverage.
//
// Four clusters have no TypeScript port here, each for a different reason:
//   - The two spw_manifest_version_for_ref call sites (shell :38-39) are
//     retired outright: tests/unit/upstream.test.js's "manifestVersionForRef
//     reproduces the shell derivation table" (:159-257) already exercises the
//     exact same (requestedRef, resolutionKind, resolvedRef, commit) tuples
//     with the exact same expected strings — see the retirement notes at
//     inventory items 6-7 in tests/migration-inventory/ref-resolution.md.
//   - Two spw_config_ref checks (shell :30-31) are retired: they exist only
//     because a POSIX shell function without an explicit `()` subshell would
//     leak/clobber its caller's `root`/`config_root` locals — which is why
//     `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/upstream.sh:6::spw_config_ref` wraps spw_config_ref in one. Calling a
//     TypeScript function (readConfigRef) cannot rebind a caller's local
//     bindings; that hazard class does not exist in the port, so there is no
//     runtime property left to assert. See inventory items 3-4.
//   - The former shell seam's Node-environment scrub is re-expressed by
//     tests/unit/adapter.test.js over src/adapter.ts's child process. The git
//     child diverges: src/git.ts pins LC_ALL and GIT_TERMINAL_PROMPT but does
//     not scrub NODE_OPTIONS/NODE_PATH. The inventory records that difference.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BASELINE_SCENARIO_SH = join(ROOT, "tests/builders/baseline-scenario.sh");
const SIGNAL_CHILD = fileURLToPath(
  new URL("./ref-resolution-signal-child.ts", import.meta.url),
);

import {
  resolveRef,
  fetchExactCommit,
  readConfigRef,
} from "../../src/upstream.ts";

const SCRATCH = mkdtempSync(join(tmpdir(), "spw-ref-resolution-"));
process.on("exit", () => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

// Per-invocation identity flags only. These write no git config at any scope
// and mirror tests/lib/harness.sh's spw_git_commit/spw_git_tag, the same
// convention `tests/bin/lifecycle-fixture.ts:77-79::spw_git_commit` documents.
const IDENTITY = [
  "-c",
  "user.email=superpowers-manager@example.invalid",
  "-c",
  "user.name=superpowers-manager",
];

function git(repo: string, args: readonly string[]): string {
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
 * ever placed on PATH — mirroring
 * `git show 349fe2ed405b371ec2de1347bb3fc50c6bc15dc4:tests/test_ref_resolution.sh:12::real_git=$(command -v git)`, captured up front for the same reason: once a
 * fake `git` shadows PATH, there would be no other way back to the real one.
 */
function realGitPath(): string {
  const found = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" });
  const path = found.stdout.trim();
  if (found.status !== 0 || path === "") {
    throw new Error("fixture cannot locate a real git binary on PATH");
  }
  return path;
}

/**
 * A real upstream repository shaped exactly like
 * `git show 349fe2ed405b371ec2de1347bb3fc50c6bc15dc4:tests/test_ref_resolution.sh:41-57::repo="$tmpdir/upstream"`'s inline setup: one annotated release
 * tag (v1.2.3), a lightweight tag (v1.2.2) at the branch tip, and a branch
 * (v9.9.9) named like a tag, to exercise the tag-lookup-then-generic-fallback
 * boundary. Built once at module scope and shared read-mostly across the
 * REF-LATEST-STABLE-01/REF-GENERIC-FALLBACK-01/REF-SOURCE-PROOF-01/
 * REF-CLEANUP-01 cases below, which this file runs sequentially (no
 * `{ concurrency: true }`), the same assumption
 * tests/baseline/selection-location.test.js's sequential `resetLog`/env
 * mutation already relies on.
 */
function buildUpstreamRepo(): {
  repo: string;
  releaseCommit: string;
  releaseTagObject: string;
  mainCommit: string;
  blobObject: string;
} {
  const repo = join(SCRATCH, "upstream");
  const init = spawnSync("git", ["init", repo], { encoding: "utf8" });
  if (init.status !== 0) {
    throw new Error(`fixture git init failed: ${init.stderr}`);
  }
  writeFileSync(join(repo, "file.txt"), "release\n", "utf8");
  git(repo, ["add", "file.txt"]);
  git(repo, [
    ...IDENTITY,
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "release",
  ]);
  git(repo, [
    ...IDENTITY,
    "-c",
    "tag.gpgsign=false",
    "tag",
    "-a",
    "v1.2.3",
    "-m",
    "release",
  ]);
  const releaseCommit = git(repo, ["rev-list", "-n1", "v1.2.3"]).trim();
  const releaseTagObject = git(repo, ["rev-parse", "v1.2.3^{tag}"]).trim();
  git(repo, ["branch", "-M", "main"]);
  writeFileSync(join(repo, "file.txt"), "branch\n", "utf8");
  git(repo, ["add", "file.txt"]);
  git(repo, [
    ...IDENTITY,
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "branch",
  ]);
  const mainCommit = git(repo, ["rev-parse", "HEAD"]).trim();
  git(repo, ["branch", "v9.9.9"]);
  git(repo, ["tag", "v1.2.2"]);
  const blobObject = git(repo, ["rev-parse", `${mainCommit}:file.txt`]).trim();
  return { repo, releaseCommit, releaseTagObject, mainCommit, blobObject };
}

const UPSTREAM = buildUpstreamRepo();

/**
 * Asserts a workspace directory holds exactly the one sibling file this
 * suite seeds it with, byte-for-byte — the same "nothing else survived, and
 * what did survive is untouched" pairing
 * `git show 349fe2ed405b371ec2de1347bb3fc50c6bc15dc4:tests/test_ref_resolution.sh:91-93::git -C "$exact_cache" cat-file -e`/106-107/192-193 each check twice.
 */
function assertOnlySiblingKept(workspace: string) {
  assert.deepEqual(readdirSync(workspace), ["sibling"]);
  assert.equal(readFileSync(join(workspace, "sibling"), "utf8"), "keep\n");
}

/**
 * Polls for `path` to exist, returning `false` on timeout rather than
 * throwing, so the caller can attach its own diagnostic. Mirrors
 * `git show 349fe2ed405b371ec2de1347bb3fc50c6bc15dc4:tests/test_ref_resolution.sh:173-178::while not marker.exists()`'s Python marker wait.
 */
async function waitForMarker(
  path: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

// BUILDER-GIT-01 is a builder marker, not a registered behavior ID (see
// `tests/baseline/traceability.test.js`'s `ID_PATTERN`), and mints no
// traceability row. It exercises tests/builders/baseline-scenario.sh's
// git-release-repo scenario, not scripts/core/upstream.sh.
void test("the git-release-repo builder produces a deterministic tagged repository", (t) => {
  const base = mkdtempSync(join(tmpdir(), "spw-ref-builder-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const destination = join(base, "upstream");
  const built = spawnSync(
    "sh",
    [BASELINE_SCENARIO_SH, "git-release-repo", destination],
    { encoding: "utf8" },
  );
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const repoMatch = built.stdout.match(/^REPO=(.*)$/m);
  const stableMatch = built.stdout.match(/^STABLE_COMMIT=(.*)$/m);
  assert.ok(repoMatch !== null && stableMatch !== null, built.stdout);
  const repo = (repoMatch as RegExpMatchArray)[1];
  const stableCommit = (stableMatch as RegExpMatchArray)[1];
  assert.equal(existsSync(join(repo, ".git")), true); // :21
  const peeled = spawnSync(
    "git",
    ["-C", repo, "rev-parse", "refs/tags/v1.1.0^{}"],
    { encoding: "utf8" },
  );
  assert.equal(peeled.status, 0, peeled.stderr);
  assert.equal(peeled.stdout.trim(), stableCommit); // :22
});

// Not a registered behavior ID either: `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/upstream.sh:6-13::spw_config_ref`'s
// spw_config_ref exists to read config/upstream-ref respecting a
// SUPERPOWERS_REF override, wrapped in an explicit `()` subshell so calling
// it cannot leak/clobber the caller's own `root`/`config_root` locals — see
// the file header comment for why that half has no port here.
void test("readConfigRef returns the packaged upstream ref when no override is set", async (t) => {
  const configRoot = mkdtempSync(join(tmpdir(), "spw-ref-config-"));
  t.after(() => rmSync(configRoot, { recursive: true, force: true }));
  mkdirSync(join(configRoot, "config"), { recursive: true });
  writeFileSync(join(configRoot, "config", "upstream-ref"), "v6.0.3\n", "utf8");
  assert.equal(await readConfigRef(configRoot, {}), "v6.0.3"); // :26,29,32
});

void test("REF-LATEST-STABLE-01 numeric stable release selection and peeling", async () => {
  const { repo, releaseCommit, mainCommit } = UPSTREAM;

  const latest = await resolveRef(repo, "latest-release");
  assert.deepEqual(latest, {
    kind: "latest-release",
    ref: "v1.2.3",
    commit: releaseCommit,
  }); // :59-60

  // A malformed leading-zero tag must not participate in selection. :62-66
  git(repo, ["tag", "v01.9.9"]);
  const leadingZero = await resolveRef(repo, "latest-release");
  assert.deepEqual(leadingZero, {
    kind: "latest-release",
    ref: "v1.2.3",
    commit: releaseCommit,
  });
  git(repo, ["tag", "-d", "v01.9.9"]);

  const tag = await resolveRef(repo, "v1.2.3");
  assert.deepEqual(tag, { kind: "tag", ref: "v1.2.3", commit: releaseCommit }); // :68-69

  const lightweight = await resolveRef(repo, "v1.2.2");
  assert.deepEqual(lightweight, {
    kind: "tag",
    ref: "v1.2.2",
    commit: mainCommit,
  }); // :71-72

  const raw = await resolveRef(repo, mainCommit);
  assert.deepEqual(raw, {
    kind: "raw-commit",
    ref: mainCommit,
    commit: mainCommit,
  }); // :74-75
});

void test("REF-GENERIC-FALLBACK-01 arbitrary refs fall back after tag lookup", async () => {
  const { repo, mainCommit } = UPSTREAM;
  const main = await resolveRef(repo, "main");
  assert.deepEqual(main, { kind: "ref", ref: "main", commit: mainCommit }); // :78-79
  const branchNamedLikeTag = await resolveRef(repo, "v9.9.9");
  assert.deepEqual(branchNamedLikeTag, {
    kind: "ref",
    ref: "v9.9.9",
    commit: mainCommit,
  }); // :80-81
});

void test("REF-SOURCE-PROOF-01 selected source must supply a commit object", async (t) => {
  const { repo, releaseCommit, releaseTagObject, blobObject } = UPSTREAM;
  const base = mkdtempSync(join(tmpdir(), "spw-ref-proof-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const exactCache = join(base, "exact-cache");
  const exactWorkspace = join(base, "exact-workspace");
  mkdirSync(exactWorkspace);
  writeFileSync(join(exactWorkspace, "sibling"), "keep\n", "utf8");

  await fetchExactCommit(repo, releaseCommit, exactCache, exactWorkspace); // :90
  // The persistent cache must actually hold the requested commit object.
  // Extends the bare-check-relied-on-by-set-e rule tests/migration-inventory
  // `tests/migration-inventory/bin-dispatch.md:19-21::contributes` already applies to `[ ... ]` and `grep -q` to a
  // third shape: a verification-only `git ... cat-file -e` invocation with no
  // other purpose. :91
  const catFile = spawnSync(
    "git",
    ["-C", exactCache, "cat-file", "-e", `${releaseCommit}^{commit}`],
    { encoding: "utf8" },
  );
  assert.equal(catFile.status, 0, catFile.stderr);
  assertOnlySiblingKept(exactWorkspace); // :92-93

  // Source proof must not be satisfiable by an object already present in the
  // persistent cache. :96-107
  const emptyRepo = join(base, "empty-upstream");
  const emptyInit = spawnSync("git", ["init", "--bare", emptyRepo], {
    encoding: "utf8",
  });
  assert.equal(emptyInit.status, 0, emptyInit.stderr);
  await assert.rejects(
    fetchExactCommit(emptyRepo, releaseCommit, exactCache, exactWorkspace),
    (error) =>
      error instanceof Error &&
      error.message ===
        `source cannot supply requested commit: ${releaseCommit}`,
  ); // :99-105
  assertOnlySiblingKept(exactWorkspace); // :106-107

  // A blob object must not be accepted. :109-115
  await assert.rejects(
    fetchExactCommit(
      repo,
      blobObject,
      join(base, "blob-cache"),
      exactWorkspace,
    ),
    (error) =>
      error instanceof Error &&
      error.message === `requested object is not a commit: ${blobObject}`,
  );

  // An annotated tag object must not be accepted either. :117-123
  await assert.rejects(
    fetchExactCommit(
      repo,
      releaseTagObject,
      join(base, "tag-object-cache"),
      exactWorkspace,
    ),
    (error) =>
      error instanceof Error &&
      error.message === `requested object is not a commit: ${releaseTagObject}`,
  );
});

// A fixed script body, containing no test-controlled value: the log path,
// the readiness marker path, and the real git binary reach it only through
// the FAKE_GIT_SIGNAL_*_VAR environment variables at run time, mirroring
// tests/baseline/selection-location.test.js's FAKE_GIT_BODY convention. Ports
// `git show 349fe2ed405b371ec2de1347bb3fc50c6bc15dc4:tests/test_ref_resolution.sh:132-142::cat > "$signal_bin/git"`'s fixture: every invocation is logged,
// and the one shape fetchExactCommit's own inner proof-workspace fetch takes
// (`fetch --no-tags --`) hangs instead of completing, so the parent can
// interrupt it mid-flight.
const FAKE_GIT_SIGNAL_LOG_VAR = "SPW_FAKE_GIT_SIGNAL_LOG";
const FAKE_GIT_SIGNAL_MARKER_VAR = "SPW_FAKE_GIT_SIGNAL_MARKER";
const FAKE_GIT_SIGNAL_REAL_VAR = "SPW_FAKE_GIT_SIGNAL_REAL";
const FAKE_GIT_SIGNAL_BODY = [
  "#!/bin/sh",
  `printf '%s\\n' "$*" >> "$${FAKE_GIT_SIGNAL_LOG_VAR}"`,
  'case " $* " in',
  "  *' fetch --no-tags -- '*)",
  `    : > "$${FAKE_GIT_SIGNAL_MARKER_VAR}"`,
  "    /bin/sleep 30 &",
  "    wait $!",
  "    ;;",
  "  *)",
  `    "$${FAKE_GIT_SIGNAL_REAL_VAR}" "$@"`,
  "    ;;",
  "esac",
  "",
].join("\n");

void test("REF-CLEANUP-01 interrupted source proof cleans only its workspace", async (t) => {
  const { repo, releaseCommit } = UPSTREAM;
  const base = mkdtempSync(join(tmpdir(), "spw-ref-cleanup-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const signalWorkspace = join(base, "signal-workspace");
  const signalCache = join(base, "signal-cache");
  mkdirSync(signalWorkspace);
  writeFileSync(join(signalWorkspace, "sibling"), "keep\n", "utf8");

  const binDir = join(base, "fetch-signal-bin");
  mkdirSync(binDir);
  const gitPath = join(binDir, "git");
  writeFileSync(gitPath, FAKE_GIT_SIGNAL_BODY, "utf8");
  chmodSync(gitPath, 0o755);

  const log = join(base, "signal-git.log");
  const marker = join(base, "fetch-started");

  // `detached: true` makes this child the leader of its own process group, so
  // signalling `-child.pid` below reaches both it and the `/bin/sleep`
  // descendant the fake `git` starts (still a member of the same process
  // group even though it is not this shell's own final process image) — the
  // Node analogue of `git show 349fe2ed405b371ec2de1347bb3fc50c6bc15dc4:tests/test_ref_resolution.sh:144-188::start_new_session=True`'s Python fixture,
  // which uses `start_new_session=True` plus `os.killpg` for exactly this
  // reason: a plain `child.kill()` would only signal the tracked pid,
  // orphaning a `sleep 30` that then lingers for up to 30 seconds.
  const child = spawn(
    process.execPath,
    [SIGNAL_CHILD, repo, releaseCommit, signalCache, signalWorkspace],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        [FAKE_GIT_SIGNAL_LOG_VAR]: log,
        [FAKE_GIT_SIGNAL_MARKER_VAR]: marker,
        [FAKE_GIT_SIGNAL_REAL_VAR]: realGitPath(),
      },
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const reached = await waitForMarker(marker, 5000); // :176-178
  if (!reached) {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    assert.fail(
      `exact fetch did not reach the signal fixture; stderr:\n${stderr}`,
    );
  }
  if (child.pid === undefined) throw new Error("signal child has no pid");
  process.kill(-child.pid, "SIGTERM");

  const result: { code: number | null; signal: NodeJS.Signals | null } =
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });

  // Task 4a's cleanupForSignal cleans synchronously, deregisters its own
  // listeners, then re-raises, so the process dies BY the signal rather than
  // exiting with a number — `128+N` is a shell convention, not a POSIX
  // guarantee, so this asserts the signal itself rather than 143. Strictly
  // stronger than, and so merges, `git show 349fe2ed405b371ec2de1347bb3fc50c6bc15dc4:tests/test_ref_resolution.sh:189::test "$(cat "$tmpdir/signal-rc")" -ne 0`'s bare
  // `test "$(cat signal-rc)" -ne 0`.
  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.code, null);

  // The interrupted invocation must be the resolver's own inner
  // proof-workspace fetch, not some other call. :190-191
  const logText = readFileSync(log, "utf8");
  const fetchLine = logText
    .split("\n")
    .find((line) => line.includes("fetch --no-tags --"));
  assert.ok(
    fetchLine !== undefined,
    `expected a logged fetch invocation, got:\n${logText}`,
  );
  assert.ok(
    (fetchLine ?? "").includes(
      `-C ${signalWorkspace}/superpowers-manager.fetch.`,
    ),
    `expected the interrupted fetch to target the resolver's own workspace, got: ${fetchLine}`,
  );

  // Task 4a's cleanup runs synchronously and re-raises only after removing
  // the workspace, so by the time `close` has already fired above, cleanup
  // is guaranteed complete: no retry loop is needed here, unlike
  // `git show 349fe2ed405b371ec2de1347bb3fc50c6bc15dc4:tests/test_ref_resolution.sh:182-186::interrupted exact fetch did not clean its proof repository`'s Python polling wait, which hedged
  // against exactly the asynchrony PR 11.4 removed from the signal path.
  assertOnlySiblingKept(signalWorkspace); // :192-193
});

// Not a registered behavior ID: no BASELINE CASE marker covers
// `git show 349fe2ed405b371ec2de1347bb3fc50c6bc15dc4:tests/test_ref_resolution.sh:195-207::no stable semver tag found for latest-release` either.
void test("an upstream with no stable tags still fails latest-release resolution", async () => {
  const tagless = join(SCRATCH, "tagless");
  const init = spawnSync("git", ["init", tagless], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  writeFileSync(join(tagless, "file.txt"), "x\n", "utf8");
  git(tagless, ["add", "file.txt"]);
  git(tagless, [
    ...IDENTITY,
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "x",
  ]);
  await assert.rejects(
    resolveRef(tagless, "latest-release"),
    (error) =>
      error instanceof Error &&
      error.message === "no stable semver tag found for latest-release",
  ); // :195-207
});

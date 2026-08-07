// @ts-check
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
//     scripts/core/upstream.sh:6 wraps spw_config_ref in one. Calling a
//     TypeScript function (readConfigRef) cannot rebind a caller's local
//     bindings; that hazard class does not exist in the port, so there is no
//     runtime property left to assert. See inventory items 3-4.
//   - scripts/core/common.sh's spw_node_cli (unsetting NODE_OPTIONS/NODE_PATH
//     before exec'ing node) remains live production code for every shell
//     wrapper in scripts/core/upstream.sh, untouched by this slice, and has
//     no TypeScript counterpart: resolveRef/fetchExactCommit simply inherit
//     whatever environment Node was given, and it is spw_node_cli's shell-only
//     job to scrub that environment before Node ever starts. This is ported
//     by running a small generated script against the still-live shell
//     source, the same technique tests/baseline/selection-location.test.js
//     uses for spw_selection_state. See "the upstream seam scrubs..." below.
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
const COMMON_SH = join(ROOT, "scripts/core/common.sh");
const UPSTREAM_SH = join(ROOT, "scripts/core/upstream.sh");
const BASELINE_SCENARIO_SH = join(ROOT, "tests/builders/baseline-scenario.sh");
const SIGNAL_CHILD = fileURLToPath(
  new URL("./ref-resolution-signal-child.js", import.meta.url),
);

// A static import from `dist/` fails the `typecheck:js` gate the same way
// tests/baseline/selection-location.test.js:53-57 documents: dist output has
// no accompanying .d.ts, so checkJs treats every parameter along the chain as
// implicit `any`. Load the built module dynamically while typing it against
// its `src/` source instead.
/** @type {typeof import("../../src/upstream.js")} */
const { resolveRef, fetchExactCommit, readConfigRef } = await import(
  new URL("../../dist/upstream.js", import.meta.url).href
);

const SCRATCH = mkdtempSync(join(tmpdir(), "spw-ref-resolution-"));
process.on("exit", () => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

// Per-invocation identity flags only. These write no git config at any scope
// and mirror tests/lib/harness.sh's spw_git_commit/spw_git_tag, the same
// convention tests/bin/lifecycle-fixture.js:76-79 documents.
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
 * ever placed on PATH — mirroring tests/test_ref_resolution.sh:12's
 * `real_git=$(command -v git)`, captured up front for the same reason: once a
 * fake `git` shadows PATH, there would be no other way back to the real one.
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

/**
 * A real upstream repository shaped exactly like
 * tests/test_ref_resolution.sh:41-57's inline setup: one annotated release
 * tag (v1.2.3), a lightweight tag (v1.2.2) at the branch tip, and a branch
 * (v9.9.9) named like a tag, to exercise the tag-lookup-then-generic-fallback
 * boundary. Built once at module scope and shared read-mostly across the
 * REF-LATEST-STABLE-01/REF-GENERIC-FALLBACK-01/REF-SOURCE-PROOF-01/
 * REF-CLEANUP-01 cases below, which this file runs sequentially (no
 * `{ concurrency: true }`), the same assumption
 * tests/baseline/selection-location.test.js's sequential `resetLog`/env
 * mutation already relies on.
 * @returns {{
 *   repo: string,
 *   releaseCommit: string,
 *   releaseTagObject: string,
 *   mainCommit: string,
 *   blobObject: string,
 * }}
 */
function buildUpstreamRepo() {
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
 * tests/test_ref_resolution.sh:92-93/106-107/192-193 each check twice.
 * @param {string} workspace
 */
function assertOnlySiblingKept(workspace) {
  assert.deepEqual(readdirSync(workspace), ["sibling"]);
  assert.equal(readFileSync(join(workspace, "sibling"), "utf8"), "keep\n");
}

/**
 * Sources each of `libraries` (asserted to exist first, by name, so a future
 * deletion of one of these still-live shell files fails loudly here instead
 * of surfacing as a confusing downstream diagnostic mismatch), then runs
 * `body` — a POSIX sh script fragment that sees `libraries` as `$1..$N` and
 * `args` as `$(N+1)..$(N+M)`. Everything this script's argv needs travels as a
 * positional parameter into the generated script, rather than through
 * string-interpolated shell source. Ports
 * tests/baseline/selection-location.test.js:154-175's helper of the same
 * name and shape.
 * @param {import("node:test").TestContext} t
 * @param {readonly string[]} libraries shell files to source, in order
 * @param {string} body
 * @param {readonly string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function runShellScript(t, libraries, body, args, env) {
  for (const library of libraries) {
    assert.ok(
      existsSync(library),
      `expected shell library to exist: ${library}`,
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "spw-ref-script-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scriptPath = join(dir, "script.sh");
  const sourceLines = libraries.map((_, index) => `. "$${index + 1}"`);
  writeFileSync(
    scriptPath,
    `#!/bin/sh\nset -eu\n${[...sourceLines, body].join("\n")}\n`,
    "utf8",
  );
  chmodSync(scriptPath, 0o755);
  return spawnSync("sh", [scriptPath, ...libraries, ...args], {
    encoding: "utf8",
    env: env ?? process.env,
  });
}

/**
 * Polls for `path` to exist, returning `false` on timeout rather than
 * throwing, so the caller can attach its own diagnostic. Mirrors
 * tests/test_ref_resolution.sh:173-178's Python marker wait.
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

// BUILDER-GIT-01 is a builder marker, not a registered behavior ID (see
// tests/baseline/traceability.test.js:15's ID_PATTERN), and mints no
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
  const repo = /** @type {RegExpMatchArray} */ (repoMatch)[1];
  const stableCommit = /** @type {RegExpMatchArray} */ (stableMatch)[1];
  assert.equal(existsSync(join(repo, ".git")), true); // :21
  const peeled = spawnSync(
    "git",
    ["-C", repo, "rev-parse", "refs/tags/v1.1.0^{}"],
    { encoding: "utf8" },
  );
  assert.equal(peeled.status, 0, peeled.stderr);
  assert.equal(peeled.stdout.trim(), stableCommit); // :22
});

// Not a registered behavior ID either: scripts/core/upstream.sh:6-13's
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
  // /bin-dispatch.md:19-21 already applies to `[ ... ]` and `grep -q` to a
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
// tests/test_ref_resolution.sh:132-142's fixture: every invocation is logged,
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
  // Node analogue of tests/test_ref_resolution.sh:144-188's Python fixture,
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

  /** @type {{ code: number | null, signal: NodeJS.Signals | null }} */
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  // Task 4a's cleanupForSignal cleans synchronously, deregisters its own
  // listeners, then re-raises, so the process dies BY the signal rather than
  // exiting with a number — `128+N` is a shell convention, not a POSIX
  // guarantee, so this asserts the signal itself rather than 143. Strictly
  // stronger than, and so merges, tests/test_ref_resolution.sh:189's bare
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
  // tests/test_ref_resolution.sh:182-186's Python polling wait, which hedged
  // against exactly the asynchrony PR 11.4 removed from the signal path.
  assertOnlySiblingKept(signalWorkspace); // :192-193
});

// Not a registered behavior ID: no BASELINE CASE marker covers
// tests/test_ref_resolution.sh:195-207 either.
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

const ENV_LOG_VAR = "SPW_FAKE_GIT_ENV_LOG";
const ENV_REAL_GIT_VAR = "SPW_FAKE_GIT_ENV_REAL";

// Not a registered behavior ID: scripts/core/common.sh's spw_node_cli
// (unset NODE_OPTIONS/NODE_PATH, then exec node) has no TypeScript
// counterpart — see the file header comment. Ported by running a small
// generated script against the still-live shell source, the same technique
// tests/baseline/selection-location.test.js:797-809 uses for
// spw_selection_state.
void test("the upstream seam scrubs ambient Node preload state, including for the pinned git child", (t) => {
  const { repo, mainCommit } = UPSTREAM;
  const preloadBase = mkdtempSync(join(tmpdir(), "spw-ref-preload-"));
  t.after(() => rmSync(preloadBase, { recursive: true, force: true }));
  const preloadScript = join(preloadBase, "upstream-preload.cjs");
  writeFileSync(preloadScript, 'console.error("INJECTED");\n', "utf8");

  // The upstream seam must route through spw_node_cli and scrub
  // NODE_OPTIONS/NODE_PATH before Node itself ever starts. :209-219
  const isolated = runShellScript(
    t,
    [COMMON_SH, UPSTREAM_SH],
    'spw_resolve_ref "$3" "$4"',
    [repo, "main"],
    {
      ...process.env,
      SPW_MANAGER_ROOT: ROOT,
      NODE_OPTIONS: `--require ${preloadScript}`,
      NODE_PATH: preloadBase,
    },
  );
  assert.equal(isolated.status, 0, isolated.stdout + isolated.stderr);
  assert.equal(isolated.stdout, `ref main ${mainCommit}\n`); // :215
  assert.equal(isolated.stderr.includes("INJECTED"), false); // :216-219, merged: a stronger equality on stdout plus this negative check together subsume the shell's own if-guard.

  // The pinned child environment must reach git, with NODE_* scrubbed and
  // git's own pins (LC_ALL, GIT_TERMINAL_PROMPT) intact. :221-240
  const envBinDir = mkdtempSync(join(tmpdir(), "spw-ref-envbin-"));
  t.after(() => rmSync(envBinDir, { recursive: true, force: true }));
  const envGitPath = join(envBinDir, "git");
  writeFileSync(
    envGitPath,
    [
      "#!/bin/sh",
      "{",
      "  printf 'LC_ALL=%s\\n' \"${LC_ALL-unset}\"",
      "  printf 'GIT_TERMINAL_PROMPT=%s\\n' \"${GIT_TERMINAL_PROMPT-unset}\"",
      "  printf 'NODE_OPTIONS=%s\\n' \"${NODE_OPTIONS-unset}\"",
      "  printf 'NODE_PATH=%s\\n' \"${NODE_PATH-unset}\"",
      `} >> "$${ENV_LOG_VAR}"`,
      `"$${ENV_REAL_GIT_VAR}" "$@"`,
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(envGitPath, 0o755);
  const envLog = join(preloadBase, "git-env.log");
  const envResult = runShellScript(
    t,
    [COMMON_SH, UPSTREAM_SH],
    'spw_resolve_ref "$3" "$4"',
    [repo, "main"],
    {
      ...process.env,
      SPW_MANAGER_ROOT: ROOT,
      NODE_OPTIONS: `--require ${preloadScript}`,
      NODE_PATH: preloadBase,
      PATH: `${envBinDir}:${process.env.PATH ?? ""}`,
      [ENV_LOG_VAR]: envLog,
      [ENV_REAL_GIT_VAR]: realGitPath(),
    },
  );
  assert.equal(envResult.status, 0, envResult.stdout + envResult.stderr);
  const envLines = readFileSync(envLog, "utf8").split("\n");
  assert.ok(envLines.includes("LC_ALL=C")); // :237
  assert.ok(envLines.includes("GIT_TERMINAL_PROMPT=0")); // :238
  assert.ok(envLines.includes("NODE_OPTIONS=unset")); // :239
  assert.ok(envLines.includes("NODE_PATH=unset")); // :240
});

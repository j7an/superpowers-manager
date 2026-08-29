// @ts-check
// Migrated from tests/test_selection_state.sh (335 lines), a shell driver
// over scripts/core/selection.sh's spw_selection_config_dir,
// spw_compute_effective_selection, spw_resolve_ref, spw_selection_state, and
// spw_display_source, plus the CLI usage-error contract now owned by src/cli.ts.
//
// PR 11.5 already ported the config-dir chain and the env > saved >
// package-default precedence ladder to TypeScript
// (src/effective-selection.ts's selectionConfigDir / computeEffectiveSelection,
// and src/selection.ts's validateSource / displaySource), so this port
// exercises those directly wherever a TypeScript counterpart exists.
//
// The former selection-state wrapper cluster closes structurally in slice 4c:
// src/selection-store.ts reads selection state in-process, so there is no
// child Node process for NODE_OPTIONS to reach and no helper file left to be
// missing. The inventory records the retirement of that shell-only shape.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BIN = join(ROOT, "bin", "superpowers-manager.js");
const BASELINE_SCENARIO_SH = join(ROOT, "tests/builders/baseline-scenario.sh");

// A static import from `dist/` fails the `typecheck:js` gate: dist output has
// no accompanying .d.ts, so checkJs treats every parameter along the chain as
// implicit `any`. Load the built module dynamically while typing it against
// its `src/` source instead. Convention documented at
// `tests/unit/manifest-overlay.test.js:5-7::typecheck`.
/** @type {typeof import("../../src/effective-selection.js")} */
const { selectionConfigDir, computeEffectiveSelection, UPSTREAM_URL_DEFAULT } =
  await import(
    new URL("../../dist/effective-selection.js", import.meta.url).href
  );
/** @type {typeof import("../../src/selection.js")} */
const { displaySource } = await import(
  new URL("../../dist/selection.js", import.meta.url).href
);

const SAVED_SOURCE = "ssh://git@github.com/example/saved.git";
const ENVIRONMENT_SOURCE = "/tmp/environment upstream";
const PINNED_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const RESOLVED_DEFAULT = "1".repeat(40);
const RESOLVED_ENVIRONMENT = "2".repeat(40);
const RESOLVED_LATEST = "9".repeat(40);
// Hoisted beside RESOLVED_LATEST (its paired commit) so the two ends of the
// distinct-values pairing this suite depends on — see assertEffective's
// doc comment — are self-evident from the constants alone, not just from
// the literals repeated at each call site.
const RESOLVED_LATEST_TAG = "v9.9.9";

// Environment variable names the generated fake `git` script (see
// fakeResolverGitDir) reads its canned answers and its invocation log path
// from. Threading these through the environment, rather than interpolating
// their values into the generated shell source, means the script body below
// is a fixed string: no test-controlled value is ever concatenated into
// shell source, so there is nothing for shell metacharacters in a path or
// value to corrupt.
const FAKE_GIT_LOG_VAR = "SPW_FAKE_GIT_LOG";
const FAKE_GIT_LATEST_COMMIT_VAR = "SPW_FAKE_GIT_LATEST_COMMIT";
const FAKE_GIT_DEFAULT_COMMIT_VAR = "SPW_FAKE_GIT_DEFAULT_COMMIT";
const FAKE_GIT_GENERIC_COMMIT_VAR = "SPW_FAKE_GIT_GENERIC_COMMIT";

const TRACK_LATEST_RECORD = {
  schema_version: 1,
  mode: "track-latest",
  source: SAVED_SOURCE,
};
const PINNED_RECORD = {
  schema_version: 1,
  mode: "pinned",
  source: SAVED_SOURCE,
  requested_ref: "v6.1.1",
  resolved_ref: "v6.1.1",
  commit: PINNED_COMMIT,
};

/**
 * A package root with a packaged `config/upstream-ref` of `v1.2.3`, for the
 * package-default branch's readConfigRef call.
 * @param {import("node:test").TestContext} t
 * @returns {string}
 */
function makePackageRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "spw-sel-pkg-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "upstream-ref"), "v1.2.3\n", "utf8");
  return root;
}

/**
 * A bare SUPERPOWERS_CONFIG_DIR, optionally pre-seeded with raw
 * `selection.json` bytes.
 * @param {import("node:test").TestContext} t
 * @param {string | null} raw
 * @returns {string}
 */
function makeConfigDir(t, raw) {
  const root = mkdtempSync(join(tmpdir(), "spw-sel-cfg-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "config");
  mkdirSync(dir, { recursive: true });
  if (raw !== null) {
    writeFileSync(join(dir, "selection.json"), raw, "utf8");
  }
  return dir;
}

// A fixed script body, containing no test-controlled value at all: every
// value it needs (the log path, the three canned commits) travels through
// the environment variables named above, read at run time by `sh` itself
// rather than substituted into this source by JS. See fakeResolverGitDir.
const FAKE_GIT_BODY = [
  "#!/bin/sh",
  `printf '%s\\n' "$*" >> "$${FAKE_GIT_LOG_VAR}"`,
  'case "$*" in',
  '  *"refs/tags/v*"*)',
  `    printf '%s\\trefs/tags/${RESOLVED_LATEST_TAG}\\n' "$${FAKE_GIT_LATEST_COMMIT_VAR}"`,
  "    ;;",
  '  *"refs/tags/v1.2.3"*)',
  `    printf '%s\\trefs/tags/v1.2.3\\n' "$${FAKE_GIT_DEFAULT_COMMIT_VAR}"`,
  "    ;;",
  "  *--tags*)",
  "    ;;",
  "  *)",
  `    printf '%s\\trefs/heads/generic\\n' "$${FAKE_GIT_GENERIC_COMMIT_VAR}"`,
  "    ;;",
  "esac",
  "exit 0",
  "",
].join("\n");

/**
 * A fake `git` on its own PATH entry that answers exactly the three
 * ls-remote shapes this suite's refs (`v1.2.3`, `main`, `*`,
 * `latest-release`) can provoke, and appends every invocation's argv to a
 * log file. Mirrors tests/test_selection_state.sh's `spw_resolve_ref`
 * override, which replaced the whole resolution step with one canned answer
 * per ref — the real resolveRef takes two ls-remote round trips for a
 * non-tag ref (a `--tags` probe that misses, then a generic fallback that
 * hits), so "the resolver ran exactly once" is ported as "exactly one
 * `--tags` probe was logged" (see resolutionCount below): every resolveRef
 * call issues exactly one `--tags` probe as its first step (including
 * latest-release and a direct tag hit, which need no second call), and a
 * raw-commit request short-circuits before any git call at all.
 *
 * The script itself (FAKE_GIT_BODY) is a fixed string; the log path and the
 * three canned commits reach it only through withResolverEnv's environment
 * variables at run time, never through string interpolation into this
 * script's source.
 * @param {import("node:test").TestContext} t
 * @returns {{ dir: string, log: string }}
 */
function fakeResolverGitDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "spw-fake-git-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "invocations.log");
  const gitPath = join(dir, "git");
  writeFileSync(gitPath, FAKE_GIT_BODY, "utf8");
  chmodSync(gitPath, 0o755);
  return { dir, log };
}

/** @param {string} log */
function resetLog(log) {
  writeFileSync(log, "", "utf8");
}

/** @param {string} log */
function logText(log) {
  return existsSync(log) ? readFileSync(log, "utf8") : "";
}

/** @param {string} log */
function resolutionCount(log) {
  return logText(log)
    .split("\n")
    .filter((line) => line.includes("--tags")).length;
}

/**
 * Runs `fn` with PATH replaced by `gitDir` alone (so the fake `git` written
 * there by fakeResolverGitDir is the only one resolveRef can find) and the
 * FAKE_GIT_*_VAR environment variables set so that fake `git`'s fixed script
 * body can read the log path and the three canned commits at run time,
 * restoring every mutated variable afterwards.
 * @template T
 * @param {string} gitDir
 * @param {string} log
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withResolverEnv(gitDir, log, fn) {
  /** @type {Record<string, string>} */
  const overrides = {
    PATH: gitDir,
    [FAKE_GIT_LOG_VAR]: log,
    [FAKE_GIT_LATEST_COMMIT_VAR]: RESOLVED_LATEST,
    [FAKE_GIT_DEFAULT_COMMIT_VAR]: RESOLVED_DEFAULT,
    [FAKE_GIT_GENERIC_COMMIT_VAR]: RESOLVED_ENVIRONMENT,
  };
  /** @type {Record<string, string | undefined>} */
  const original = {};
  for (const key of Object.keys(overrides)) {
    original[key] = process.env[key];
    process.env[key] = overrides[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

/**
 * The same eight-field comparison as tests/test_selection_state.sh's
 * `assert_effective` shell helper, one property per EffectiveSelection
 * field. `assert_effective` additionally called `assert_exported_selection`
 * (a bundled `: "$VAR" ...` existence check across all fourteen SPW_*
 * exports), which has no port here for thirteen of the fourteen: eight map
 * onto EffectiveSelection's own fields and five onto
 * NormalizedSavedSelection's (src/selection.ts), and both interfaces make
 * every field non-optional, so "these thirteen are populated" is a
 * structural compile-time guarantee rather than a runtime property to
 * assert. The fourteenth, SPW_SELECTION_STATE_PATH, comes from a separate
 * function (selectionStatePath) rather than either interface, has no
 * structural counterpart, and is not asserted anywhere in this port either.
 * @param {import("../../src/effective-selection.js").EffectiveSelection} selection
 * @param {{
 *   selectionOrigin: string,
 *   selectionMode: string,
 *   upstreamSourceOrigin: string,
 *   effectiveSource: string,
 *   requestedRef: string,
 *   resolvedRef: string,
 *   desiredCommit: string,
 *   resolutionKind: string,
 * }} expected
 */
function assertEffective(selection, expected) {
  assert.equal(selection.selectionOrigin, expected.selectionOrigin);
  assert.equal(selection.selectionMode, expected.selectionMode);
  assert.equal(selection.upstreamSourceOrigin, expected.upstreamSourceOrigin);
  assert.equal(selection.effectiveSource, expected.effectiveSource);
  assert.equal(selection.requestedRef, expected.requestedRef);
  // Distinct from desiredCommit below by construction (RESOLVED_* constants
  // never collide with the ref strings): computeEffectiveSelection maps
  // resolution.ref -> resolvedRef and resolution.commit -> desiredCommit, and
  // both fields are plain `string`, so a swapped pairing would compile. Only
  // asserting both, separately, against distinct expected values can catch
  // that swap.
  assert.equal(selection.resolvedRef, expected.resolvedRef);
  assert.equal(selection.desiredCommit, expected.desiredCommit);
  assert.equal(selection.resolutionKind, expected.resolutionKind);
}

// Ports `git show 349fe2ed405b371ec2de1347bb3fc50c6bc15dc4:tests/test_selection_state.sh:22-40::BUILDER-PERMISSION-01`. BUILDER-PERMISSION-01 is not a
// registered behavior ID (see `tests/baseline/traceability.test.js`'s
// `ID_PATTERN`) and mints no traceability row; the shell's own setup never
// uses permission_target/permission_root/permission_parent again after this
// block, so this ports the builder's own guarantee (a deterministically
// unreadable target) rather than any selection.sh behavior.
void test("the permission-denied builder produces a deterministically unreadable target", (t) => {
  const base = mkdtempSync(join(tmpdir(), "spw-sel-builder-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const destination = join(base, "permission-denied");
  const built = spawnSync(
    "sh",
    [BASELINE_SCENARIO_SH, "permission-denied", destination],
    {
      encoding: "utf8",
    },
  );
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const rootMatch = /^ROOT=(.*)$/m.exec(built.stdout);
  const targetMatch = /^TARGET=(.*)$/m.exec(built.stdout);
  assert.ok(rootMatch !== null && targetMatch !== null, built.stdout);
  const permissionRoot = /** @type {RegExpExecArray} */ (rootMatch)[1];
  const permissionTarget = /** @type {RegExpExecArray} */ (targetMatch)[1];
  assert.equal(existsSync(permissionRoot), true); // :30

  if (process.getuid !== undefined && process.getuid() === 0) {
    // :31-33 the shell driver skips the read-access assertion for root too.
  } else {
    let readable = true;
    try {
      accessSync(permissionTarget, constants.R_OK);
    } catch {
      readable = false;
    }
    assert.equal(readable, false); // :34-37
  }
  chmodSync(dirname(permissionTarget), 0o700); // :39, cleanup, not an assertion
});

void test("SEL-LOCATION-01 selection location chain and fail-closed bases", () => {
  // :42 an explicit SUPERPOWERS_CONFIG_DIR wins over every other base.
  assert.equal(
    selectionConfigDir({
      SUPERPOWERS_CONFIG_DIR: "/explicit",
      XDG_CONFIG_HOME: "/xdg",
      HOME: "/home",
    }),
    "/explicit",
  );
  // :43 XDG_CONFIG_HOME, absent SUPERPOWERS_CONFIG_DIR, wins over HOME.
  assert.equal(
    selectionConfigDir({ XDG_CONFIG_HOME: "/xdg", HOME: "/home" }),
    "/xdg/superpowers-manager",
  );
  // :44 an empty XDG_CONFIG_HOME is treated as absent, falling through to HOME.
  assert.equal(
    selectionConfigDir({ XDG_CONFIG_HOME: "", HOME: "/home" }),
    "/home/.config/superpowers-manager",
  );
  // :45 HOME alone is the last base.
  assert.equal(
    selectionConfigDir({ HOME: "/home" }),
    "/home/.config/superpowers-manager",
  );
  // :47-51 a relative SUPERPOWERS_CONFIG_DIR fails closed with its own
  // diagnostic (the if-guard at :47, "unexpectedly succeeded", is subsumed
  // by assert.throws itself: a thrown error is strictly "did not succeed").
  assert.throws(
    () => selectionConfigDir({ SUPERPOWERS_CONFIG_DIR: "relative" }),
    {
      module: "selection",
      message: "SUPERPOWERS_CONFIG_DIR must be absolute",
    },
  );
  // :52-56 a relative XDG_CONFIG_HOME fails closed likewise.
  assert.throws(
    () => selectionConfigDir({ XDG_CONFIG_HOME: "relative", HOME: "/home" }),
    { module: "selection", message: "XDG_CONFIG_HOME must be absolute" },
  );
  // :57-61 with every base absent, resolution fails closed rather than
  // defaulting to a cwd-relative path.
  assert.throws(() => selectionConfigDir({}), {
    module: "selection",
    message: "HOME is required to locate selection state",
  });

  // :63-70 re-expressed through src/cli.ts's surviving usage-error contract:
  // `error: <msg>` on stderr, followed by the same usage block `--help`
  // prints, with exit 2. The shell guard's "unexpectedly succeeded" half is
  // subsumed by the exact-status assertion below.
  const help = spawnSync(process.execPath, [BIN, "--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0, help.stdout + help.stderr);
  const usage = spawnSync(process.execPath, [BIN, "bogus"], {
    encoding: "utf8",
  });
  assert.equal(usage.status, 2); // :63, :69
  assert.equal(usage.stdout, "");
  assert.equal(
    usage.stderr,
    `error: unknown subcommand: bogus\n${help.stdout}`,
  ); // :70
});

void test("SEL-PRECEDENCE-REF-01 complete ref precedence", async (t) => {
  const pkgRoot = makePackageRoot(t);
  const { dir: gitDir, log } = fakeResolverGitDir(t);

  // Absent state: packaged defaults, then independent environment overrides.
  // :137-144
  resetLog(log);
  const absentConfig = makeConfigDir(t, null);
  const absentSelection = await withResolverEnv(gitDir, log, () =>
    computeEffectiveSelection(pkgRoot, {
      SUPERPOWERS_CONFIG_DIR: absentConfig,
    }),
  );
  assertEffective(absentSelection, {
    selectionOrigin: "package-default",
    selectionMode: "default",
    upstreamSourceOrigin: "package-default",
    effectiveSource: UPSTREAM_URL_DEFAULT,
    requestedRef: "v1.2.3",
    resolvedRef: "v1.2.3",
    desiredCommit: RESOLVED_DEFAULT,
    resolutionKind: "tag",
  }); // :141-142
  assert.equal(absentSelection.saved.saved_mode, "none"); // :143
  assert.equal(resolutionCount(log), 1); // :144

  // :146-154
  resetLog(log);
  const envOverrideSelection = await withResolverEnv(gitDir, log, () =>
    computeEffectiveSelection(pkgRoot, {
      SUPERPOWERS_CONFIG_DIR: absentConfig,
      SUPERPOWERS_REF: "main",
      SUPERPOWERS_UPSTREAM_URL: ENVIRONMENT_SOURCE,
    }),
  );
  assertEffective(envOverrideSelection, {
    selectionOrigin: "environment",
    selectionMode: "override",
    upstreamSourceOrigin: "environment",
    effectiveSource: ENVIRONMENT_SOURCE,
    requestedRef: "main",
    resolvedRef: "main",
    desiredCommit: RESOLVED_ENVIRONMENT,
    resolutionKind: "ref",
  }); // :153-154

  // :156-163
  resetLog(log);
  const refOnlySelection = await withResolverEnv(gitDir, log, () =>
    computeEffectiveSelection(pkgRoot, {
      SUPERPOWERS_CONFIG_DIR: absentConfig,
      SUPERPOWERS_REF: "main",
    }),
  );
  assertEffective(refOnlySelection, {
    selectionOrigin: "environment",
    selectionMode: "override",
    upstreamSourceOrigin: "package-default",
    effectiveSource: UPSTREAM_URL_DEFAULT,
    requestedRef: "main",
    resolvedRef: "main",
    desiredCommit: RESOLVED_ENVIRONMENT,
    resolutionKind: "ref",
  }); // :162-163

  // :165-172
  resetLog(log);
  const sourceOnlySelection = await withResolverEnv(gitDir, log, () =>
    computeEffectiveSelection(pkgRoot, {
      SUPERPOWERS_CONFIG_DIR: absentConfig,
      SUPERPOWERS_UPSTREAM_URL: ENVIRONMENT_SOURCE,
    }),
  );
  assertEffective(sourceOnlySelection, {
    selectionOrigin: "package-default",
    selectionMode: "default",
    upstreamSourceOrigin: "environment",
    effectiveSource: ENVIRONMENT_SOURCE,
    requestedRef: "v1.2.3",
    resolvedRef: "v1.2.3",
    desiredCommit: RESOLVED_DEFAULT,
    resolutionKind: "tag",
  }); // :171-172

  // Track-latest state: saved ref and source can each be overridden
  // independently. :176-182
  resetLog(log);
  const trackConfig = makeConfigDir(t, JSON.stringify(TRACK_LATEST_RECORD));
  const trackSelection = await withResolverEnv(gitDir, log, () =>
    computeEffectiveSelection(pkgRoot, { SUPERPOWERS_CONFIG_DIR: trackConfig }),
  );
  assertEffective(trackSelection, {
    selectionOrigin: "user-config",
    selectionMode: "track-latest",
    upstreamSourceOrigin: "user-config",
    effectiveSource: SAVED_SOURCE,
    requestedRef: "latest-release",
    resolvedRef: RESOLVED_LATEST_TAG,
    desiredCommit: RESOLVED_LATEST,
    resolutionKind: "latest-release",
  }); // :180-181
  assert.equal(trackSelection.saved.saved_mode, "track-latest"); // :182

  // :184-191
  resetLog(log);
  const trackRefOverride = await withResolverEnv(gitDir, log, () =>
    computeEffectiveSelection(pkgRoot, {
      SUPERPOWERS_CONFIG_DIR: trackConfig,
      SUPERPOWERS_REF: "main",
    }),
  );
  assertEffective(trackRefOverride, {
    selectionOrigin: "environment",
    selectionMode: "override",
    upstreamSourceOrigin: "user-config",
    effectiveSource: SAVED_SOURCE,
    requestedRef: "main",
    resolvedRef: "main",
    desiredCommit: RESOLVED_ENVIRONMENT,
    resolutionKind: "ref",
  }); // :190-191

  // :193-200
  resetLog(log);
  const trackSourceOverride = await withResolverEnv(gitDir, log, () =>
    computeEffectiveSelection(pkgRoot, {
      SUPERPOWERS_CONFIG_DIR: trackConfig,
      SUPERPOWERS_UPSTREAM_URL: ENVIRONMENT_SOURCE,
    }),
  );
  assertEffective(trackSourceOverride, {
    selectionOrigin: "user-config",
    selectionMode: "track-latest",
    upstreamSourceOrigin: "environment",
    effectiveSource: ENVIRONMENT_SOURCE,
    requestedRef: "latest-release",
    resolvedRef: RESOLVED_LATEST_TAG,
    desiredCommit: RESOLVED_LATEST,
    resolutionKind: "latest-release",
  }); // :199-200

  // :202-210
  resetLog(log);
  const trackBothOverride = await withResolverEnv(gitDir, log, () =>
    computeEffectiveSelection(pkgRoot, {
      SUPERPOWERS_CONFIG_DIR: trackConfig,
      SUPERPOWERS_REF: "main",
      SUPERPOWERS_UPSTREAM_URL: ENVIRONMENT_SOURCE,
    }),
  );
  assertEffective(trackBothOverride, {
    selectionOrigin: "environment",
    selectionMode: "override",
    upstreamSourceOrigin: "environment",
    effectiveSource: ENVIRONMENT_SOURCE,
    requestedRef: "main",
    resolvedRef: "main",
    desiredCommit: RESOLVED_ENVIRONMENT,
    resolutionKind: "ref",
  }); // :209-210

  // Pinned state reuses its verified identity unless the ref itself is
  // overridden. :213-223
  resetLog(log);
  const pinnedConfig = makeConfigDir(t, JSON.stringify(PINNED_RECORD));
  const pinnedSelection = await withResolverEnv(gitDir, log, () =>
    computeEffectiveSelection(pkgRoot, {
      SUPERPOWERS_CONFIG_DIR: pinnedConfig,
    }),
  );
  assertEffective(pinnedSelection, {
    selectionOrigin: "user-config",
    selectionMode: "pinned",
    upstreamSourceOrigin: "user-config",
    effectiveSource: SAVED_SOURCE,
    requestedRef: "v6.1.1",
    resolvedRef: "v6.1.1",
    desiredCommit: PINNED_COMMIT,
    resolutionKind: "tag",
  }); // :218-219
  assert.equal(logText(log), ""); // :220
  assert.equal(pinnedSelection.saved.saved_requested_ref, "v6.1.1"); // :221
  assert.equal(pinnedSelection.saved.saved_resolved_ref, "v6.1.1"); // :222
  assert.equal(pinnedSelection.saved.saved_commit, PINNED_COMMIT); // :223

  // :225-233
  resetLog(log);
  const pinnedRefOverride = await withResolverEnv(gitDir, log, () =>
    computeEffectiveSelection(pkgRoot, {
      SUPERPOWERS_CONFIG_DIR: pinnedConfig,
      SUPERPOWERS_REF: "main",
    }),
  );
  assertEffective(pinnedRefOverride, {
    selectionOrigin: "environment",
    selectionMode: "override",
    upstreamSourceOrigin: "user-config",
    effectiveSource: SAVED_SOURCE,
    requestedRef: "main",
    resolvedRef: "main",
    desiredCommit: RESOLVED_ENVIRONMENT,
    resolutionKind: "ref",
  }); // :231-232
  assert.equal(resolutionCount(log), 1); // :233

  // :235-243
  resetLog(log);
  const pinnedSourceOverride = await withResolverEnv(gitDir, log, () =>
    computeEffectiveSelection(pkgRoot, {
      SUPERPOWERS_CONFIG_DIR: pinnedConfig,
      SUPERPOWERS_UPSTREAM_URL: ENVIRONMENT_SOURCE,
    }),
  );
  assertEffective(pinnedSourceOverride, {
    selectionOrigin: "user-config",
    selectionMode: "pinned",
    upstreamSourceOrigin: "environment",
    effectiveSource: ENVIRONMENT_SOURCE,
    requestedRef: "v6.1.1",
    resolvedRef: "v6.1.1",
    desiredCommit: PINNED_COMMIT,
    resolutionKind: "tag",
  }); // :241-242
  assert.equal(logText(log), ""); // :243

  // :245-252
  resetLog(log);
  const pinnedBothOverride = await withResolverEnv(gitDir, log, () =>
    computeEffectiveSelection(pkgRoot, {
      SUPERPOWERS_CONFIG_DIR: pinnedConfig,
      SUPERPOWERS_REF: "main",
      SUPERPOWERS_UPSTREAM_URL: ENVIRONMENT_SOURCE,
    }),
  );
  assertEffective(pinnedBothOverride, {
    selectionOrigin: "environment",
    selectionMode: "override",
    upstreamSourceOrigin: "environment",
    effectiveSource: ENVIRONMENT_SOURCE,
    requestedRef: "main",
    resolvedRef: "main",
    desiredCommit: RESOLVED_ENVIRONMENT,
    resolutionKind: "ref",
  }); // :252-253
});

// SEL-REF-GENERIC-01 is not a registered behavior ID (see
// `tests/baseline/traceability.test.js`'s `ID_PATTERN`) and mints no
// traceability row.
void test("an arbitrary environment ref and a raw-commit pin resolve without shell-quoting surprises", async (t) => {
  const pkgRoot = makePackageRoot(t);
  const { dir: gitDir, log } = fakeResolverGitDir(t);

  // Resolver output is parsed as data even when a mutable ref contains a
  // glob. :256-264
  resetLog(log);
  const absentConfig = makeConfigDir(t, null);
  const globSelection = await withResolverEnv(gitDir, log, () =>
    computeEffectiveSelection(pkgRoot, {
      SUPERPOWERS_CONFIG_DIR: absentConfig,
      SUPERPOWERS_REF: "*",
    }),
  );
  assertEffective(globSelection, {
    selectionOrigin: "environment",
    selectionMode: "override",
    upstreamSourceOrigin: "package-default",
    effectiveSource: UPSTREAM_URL_DEFAULT,
    requestedRef: "*",
    resolvedRef: "*",
    desiredCommit: RESOLVED_ENVIRONMENT,
    resolutionKind: "ref",
  }); // :263-264

  // Raw commit saved pins derive their resolution kind without resolver
  // access. :266-279
  resetLog(log);
  const rawConfig = makeConfigDir(
    t,
    JSON.stringify({
      schema_version: 1,
      mode: "pinned",
      source: SAVED_SOURCE,
      requested_ref: PINNED_COMMIT,
      resolved_ref: PINNED_COMMIT,
      commit: PINNED_COMMIT,
    }),
  );
  const rawSelection = await withResolverEnv(gitDir, log, () =>
    computeEffectiveSelection(pkgRoot, { SUPERPOWERS_CONFIG_DIR: rawConfig }),
  );
  assertEffective(rawSelection, {
    selectionOrigin: "user-config",
    selectionMode: "pinned",
    upstreamSourceOrigin: "user-config",
    effectiveSource: SAVED_SOURCE,
    requestedRef: PINNED_COMMIT,
    resolvedRef: PINNED_COMMIT,
    desiredCommit: PINNED_COMMIT,
    resolutionKind: "raw-commit",
  }); // :277-278
  assert.equal(logText(log), ""); // :279
});

void test("SEL-PRECEDENCE-VALIDATE-01 invalid saved state stops resolution", async (t) => {
  const pkgRoot = makePackageRoot(t);
  const { dir: gitDir, log } = fakeResolverGitDir(t);

  // Invalid saved state fails before source validation can reach ref
  // resolution. :283-297. The if-guard at :292 ("unexpectedly succeeded") is
  // subsumed by assert.rejects itself.
  resetLog(log);
  const malformedConfig = makeConfigDir(
    t,
    '{"schema_version":2,"mode":"track-latest","source":"https://example.invalid/repo"}',
  );
  await assert.rejects(
    () =>
      withResolverEnv(gitDir, log, () =>
        computeEffectiveSelection(pkgRoot, {
          SUPERPOWERS_CONFIG_DIR: malformedConfig,
          SUPERPOWERS_REF: "main",
          SUPERPOWERS_UPSTREAM_URL: ENVIRONMENT_SOURCE,
        }),
      ),
    (error) =>
      error instanceof Error &&
      error.message.includes("schema_version must equal integer 1"), // :296
  );
  assert.equal(logText(log), ""); // :297

  // Effective HTTP(S) userinfo is rejected before resolver access and
  // display is safe. :300-312. The if-guard at :305 is likewise subsumed by
  // assert.rejects.
  resetLog(log);
  const absentConfig = makeConfigDir(t, null);
  const credentialSource = "https://token@example.invalid/repo";
  await assert.rejects(
    () =>
      withResolverEnv(gitDir, log, () =>
        computeEffectiveSelection(pkgRoot, {
          SUPERPOWERS_CONFIG_DIR: absentConfig,
          SUPERPOWERS_UPSTREAM_URL: credentialSource,
        }),
      ),
    (error) =>
      error instanceof Error &&
      error.message.includes("HTTP(S) source must not include userinfo"), // :309
  );
  assert.equal(logText(log), ""); // :310
  assert.equal(displaySource(credentialSource), "<redacted-source>"); // :311
  assert.equal(displaySource(UPSTREAM_URL_DEFAULT), UPSTREAM_URL_DEFAULT); // :312
});

// @ts-check
// End-to-end driver for the in-process `prepare` command, ported from
// tests/test_prepare_with_fake_upstream.sh.
//
// Unlike tests/baseline/probe.test.js, this driver SPAWNS runPrepare rather
// than calling it: see tests/baseline/prepare-child.js for why ctx.env cannot
// make a prepare run hermetic on its own.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createCase } from "../bin/lifecycle-fixture.js";
import {
  caseEnv,
  cloneUpstream,
  commitOf,
  DECLARED_HOOK_PATHS,
  describeRepository,
  prepare,
  REFS,
  UPSTREAM,
} from "./prepare-fixture.js";

/** @type {typeof import("../../src/selection-store.js")} */
const { writeSelectionState } = await import(
  new URL("../../dist/selection-store.js", import.meta.url).href
);

/** @typedef {import("../bin/lifecycle-fixture.js").CaseEnv} CaseEnv */

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MANIFESTS = join(ROOT, "tests/fixtures/baseline/manifests");
const LAYOUTS = join(ROOT, "tests/fixtures/baseline/generated-tree");

/** @param {{ pkg: string }} c */
const generated = (c) => join(c.pkg, "plugins", "superpowers");

/** @param {CaseEnv} c */
const cacheRepo = (c) => join(c.dir, "cache", "superpowers");

/** @param {CaseEnv} c */
const cacheManifest = (c) => join(cacheRepo(c), ".codex-plugin", "plugin.json");

// Errno names are ENUMERATED rather than matched as a pattern, because no
// pattern over `E[A-Z]+` can tell an errno from the other two kinds of token
// this assertion runs against:
//
//   - `LICENSE` is one of the four required upstream paths, and
//     `required upstream path missing: LICENSE` legitimately names it. A bare
//     `E[A-Z]{3,}` matches the `ENSE` inside it, so case 11 cannot pass.
//   - every diagnostic here names a path under an mkdtempSync directory, and
//     those six-character [A-Za-z0-9] suffixes are preceded by `-` or `.` —
//     both non-word characters. So `\bE[A-Z]{3,}\b` still matches a suffix that
//     happens to be `E` plus five capitals: measured at 2.3e-4 per suffix, and
//     with ~14 independent draws inside exact-equality diagnostics that is
//     ~0.3% per suite run. A 1-in-330 false failure gets blamed on something
//     else when it fires.
//
// The enumeration removes that class outright and additionally catches `EIO`,
// which neither pattern form matched. Extend the list rather than loosening it
// back into a pattern.
const LEAKED_INTERNALS =
  /\b(ENOENT|EACCES|EPERM|EEXIST|ENOTDIR|EISDIR|EBUSY|ENOTEMPTY|ELOOP|ENAMETOOLONG|EMFILE|ENFILE|EROFS|EXDEV|EIO|EAGAIN)\b|errno|\bat .*\.js:\d+|Traceback/;

/**
 * No prepare-owned diagnostic may carry errno text, a stack frame, or reader
 * vocabulary. Applied to every negative case, and to the positive cases whose
 * stderr is expected to be empty — a status-0 run that leaks errno text on a
 * warning line is the same defect.
 * @param {string} stderr
 */
function assertNoLeakedInternals(stderr) {
  assert.doesNotMatch(stderr, LEAKED_INTERNALS);
}

/**
 * `path\tkind[\tdigest]` lines for everything under `root`, so "the prior
 * generated tree survived byte-identical" is a real byte comparison rather than
 * an existence check. Same shape as tests/baseline/probe.test.js:65.
 * @param {string} root
 * @returns {string[]}
 */
function snapshotTree(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      const name = relative(root, path);
      if (!entry.isFile()) return `${name}\t${entry.isDirectory() ? "d" : "?"}`;
      return `${name}\tf\t${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
    })
    .sort();
}

/**
 * The `python3 -S` listing the two committed layout fixtures were generated
 * from (tests/test_prepare_with_fake_upstream.sh:459-479): sorted relative
 * paths, one per line, directories suffixed with `/`.
 * @param {string} root
 * @returns {string}
 */
function listing(root) {
  const entries = readdirSync(root, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const name = relative(root, join(entry.parentPath, entry.name));
      return entry.isDirectory() ? `${name}/` : name;
    })
    .sort();
  return `${entries.join("\n")}\n`;
}

/**
 * A prior generated tree the run must not disturb. Every negative case seeds
 * one and compares it afterwards; the assertion is worthless without a file in
 * there that a replacement would remove.
 * @param {CaseEnv} c
 * @returns {string[]}
 */
function seedSentinel(c) {
  const root = generated(c);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "sentinel.txt"), "prior generated tree\n");
  return snapshotTree(root);
}

/**
 * The parsed generated manifest.
 * @param {CaseEnv} c
 * @returns {Record<string, unknown>}
 */
function generatedManifest(c) {
  return JSON.parse(
    readFileSync(join(generated(c), ".codex-plugin", "plugin.json"), "utf8"),
  );
}

/**
 * A committed upstream manifest fixture, read at test time so no expectation
 * here is a literal copy of it.
 * @param {string} name
 * @returns {Record<string, unknown>}
 */
function fixtureManifest(name) {
  return JSON.parse(readFileSync(join(MANIFESTS, name), "utf8"));
}

/**
 * The single helper cases 14-20 share: a throwaway upstream whose
 * `.codex-plugin/plugin.json` is whatever `write` puts there, committed on
 * `main`. Returns the ref to request and the cache path prepare will report.
 * @param {CaseEnv} c
 * @param {(path: string) => void} write
 * @returns {{ source: string, commit: string, manifest: string }}
 */
function brokenManifestUpstream(c, write) {
  const source = join(c.dir, "upstream-broken-manifest");
  const { commit } = cloneUpstream(source, "main", (repository) => {
    const dir = join(repository, ".codex-plugin");
    mkdirSync(dir, { recursive: true });
    write(join(dir, "plugin.json"));
  });
  return { source, commit, manifest: cacheManifest(c) };
}

/**
 * Runs prepare against a broken-manifest upstream and pins the whole contract:
 * exit 1, the exact hand-written diagnostic, no leaked internals, prior tree
 * intact.
 * @param {CaseEnv} c
 * @param {(path: string) => void} write
 * @param {(manifest: string) => string} message
 */
async function assertManifestRejected(c, write, message) {
  const before = seedSentinel(c);
  const broken = brokenManifestUpstream(c, write);
  const result = await prepare(c, {
    SUPERPOWERS_UPSTREAM_URL: broken.source,
    SUPERPOWERS_REF: broken.commit,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, `error: ${message(broken.manifest)}\n`);
  assertNoLeakedInternals(result.stderr);
  assert.deepEqual(snapshotTree(generated(c)), before);
}

/**
 * @param {CaseEnv} c
 * @param {import("../../src/selection.js").SelectionRecord} record
 */
async function saveSelection(c, record) {
  await writeSelectionState(
    join(c.home, ".config", "superpowers-manager", "selection.json"),
    record,
  );
}

void test("GENERATED-FALLBACK-01 manifest-less upstream uses the manager fallback", async () => {
  const c = createCase({ fakes: "probe" });
  const result = await prepare(c, { SUPERPOWERS_REF: REFS.fallback });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^prepared v5\.0\.0 at [0-9a-f]{40}\n$/m);

  // The generated manifest came from the manager template, not from upstream:
  // the v5.0.0 commit has no .codex-plugin/plugin.json at all.
  const manifest = JSON.parse(
    readFileSync(join(generated(c), ".codex-plugin", "plugin.json"), "utf8"),
  );
  assert.equal(manifest.name, "superpowers");
  assert.equal(manifest.skills, "./skills/");

  // A manifest-less upstream generates no hooks/ (AGENTS.md's hook policy).
  assert.equal(existsSync(join(generated(c), "hooks")), false);

  // prepare makes no Codex-dependent adapter call, so the fake codex in this
  // case must never have been launched.
  assert.equal(existsSync(c.codexLog), false);
});

void test("MANIFEST-READER-UPSTREAM-01 upstream manifest version reaches provenance", async () => {
  const c = createCase({ fakes: "probe" });
  const result = await prepare(c, { SUPERPOWERS_REF: REFS.noHooksManifest });
  assert.equal(result.status, 0, result.stderr);

  const provenance = JSON.parse(
    readFileSync(join(generated(c), ".superpowers-upstream.json"), "utf8"),
  );
  // Read from the committed fixture at test time. A literal here would be a
  // claim about a file this test does not own.
  assert.equal(
    provenance.upstream_manifest_version,
    fixtureManifest("upstream-no-hooks.json").version,
  );
  assert.equal(provenance.requested_ref, REFS.noHooksManifest);
  assert.equal(provenance.source, UPSTREAM);
  assert.equal(existsSync(c.codexLog), false);
});

void test("GENERATED-WRONG-NAME-01 wrong upstream manifest name is rejected", async () => {
  const c = createCase({ fakes: "probe" });
  const before = seedSentinel(c);
  const result = await prepare(c, { SUPERPOWERS_REF: REFS.wrongName });
  assert.equal(result.status, 1, result.stdout);

  // The adapter's own rejection, replayed verbatim, then prepare's own trailer.
  assert.match(
    result.stderr,
    /^- plugin manifest field `name` must equal `superpowers`$/m,
  );
  assert.match(
    result.stderr,
    /^error: built-in generated plugin validation failed\n$/m,
  );
  assertNoLeakedInternals(result.stderr);
  assert.deepEqual(snapshotTree(generated(c)), before);
});

void test("GENERATED-HOOKS-FORBID-01 an exact empty hooks object stays hook-free", async () => {
  const c = createCase({ fakes: "probe" });
  const result = await prepare(c, { SUPERPOWERS_REF: REFS.emptyObjectHooks });
  assert.equal(result.status, 0, result.stderr);

  assert.deepEqual(
    generatedManifest(c).hooks,
    fixtureManifest("upstream-empty-hooks.json").hooks,
  );
  assert.equal(existsSync(join(generated(c), "hooks")), false);
});

void test("GENERATED-HOOKS-DEFAULT-01 GENERATED-HOOKS-DEFAULT-LAYOUT-01 empty-array default discovery", async () => {
  const c = createCase({ fakes: "probe" });
  const result = await prepare(c, { SUPERPOWERS_REF: REFS.defaultHooks });
  assert.equal(result.status, 0, result.stderr);

  assert.deepEqual(
    generatedManifest(c).hooks,
    fixtureManifest("upstream-default-hooks.json").hooks,
  );
  // Layout fixtures contain only relative paths, so no dynamic commit,
  // version, or source value requires normalization.
  assert.equal(
    listing(generated(c)),
    readFileSync(join(LAYOUTS, "default-hooks.txt"), "utf8"),
  );
});

void test("GENERATED-HOOKS-DECLARED-01 GENERATED-UNKNOWN-FIELDS-01 declared hook paths and unknown fields", async () => {
  // The single-path form. Its manifest is the committed fixture unmodified, so
  // this half also pins that an unknown upstream field survives the build.
  const single = createCase({ fakes: "probe" });
  const active = await prepare(single, { SUPERPOWERS_REF: REFS.activeHooks });
  assert.equal(active.status, 0, active.stderr);
  const upstreamManifest = fixtureManifest("upstream-active-hooks.json");
  assert.deepEqual(generatedManifest(single).hooks, upstreamManifest.hooks);
  assert.deepEqual(
    generatedManifest(single).x_future_manifest,
    upstreamManifest.x_future_manifest,
  );
  assert.equal(
    existsSync(join(generated(single), "hooks", "hooks-codex.json")),
    true,
  );

  // The multi-path form, whose declared targets sit outside hooks/. This is the
  // shape declared-hooks.txt was captured from
  // (tests/test_prepare_with_fake_upstream.sh:864-876).
  const many = createCase({ fakes: "probe" });
  const declared = await prepare(many, { SUPERPOWERS_REF: REFS.declaredHooks });
  assert.equal(declared.status, 0, declared.stderr);
  // Taken from the fixture that wrote them, never re-typed here.
  assert.deepEqual(generatedManifest(many).hooks, DECLARED_HOOK_PATHS);
  assert.deepEqual(
    generatedManifest(many).x_future_manifest,
    upstreamManifest.x_future_manifest,
  );
  assert.equal(
    listing(generated(many)),
    readFileSync(join(LAYOUTS, "declared-hooks.txt"), "utf8"),
  );
});

void test("FS-HOOK-CONTAINMENT-01 an escaping hook symlink fails closed", async () => {
  const c = createCase({ fakes: "probe" });
  const before = seedSentinel(c);
  const result = await prepare(c, { SUPERPOWERS_REF: REFS.escapingSymlink });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /^hook materialization failed: symlink escapes/m);
  assert.match(
    result.stderr,
    /^error: failed to prepare upstream Codex hooks\n$/m,
  );
  assertNoLeakedInternals(result.stderr);
  assert.deepEqual(snapshotTree(generated(c)), before);
});

// P1 — the adapter's classification wrapper (src/adapter.ts:364). Ported from
// tests/test_prepare_with_fake_upstream.sh:1001-1022, which held the only
// witness of this prefix anywhere in the repository. The eight inner causes
// those shell lines also asserted are already message-exact in
// tests/unit/hooks.test.js and are deliberately NOT re-ported: what was
// missing is that a classification failure reaches stderr through the adapter
// with this prefix intact. Its materialization twin (src/adapter.ts:373) is
// asserted by the FS-HOOK-CONTAINMENT-01 case directly above.
void test("a classification failure reaches stderr through the adapter wrapper", async () => {
  const c = createCase({ fakes: "probe" });
  const before = seedSentinel(c);
  const result = await prepare(c, { SUPERPOWERS_REF: REFS.unsupportedHooks });
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stderr,
    /^hook classification failed: unsupported or mixed hooks declaration$/m,
  );
  assert.match(
    result.stderr,
    /^error: failed to prepare upstream Codex hooks\n$/m,
  );
  assertNoLeakedInternals(result.stderr);
  assert.deepEqual(snapshotTree(generated(c)), before);
});

// P2a — src/hooks.ts:303 reached from the SOURCE-side call at :358. Ports the
// retired driver's :1041 and :1044 cases (inventory items 127 and 128).
//
// The PATH is the assertion, not the message. Three different failures print
// `hook subtree escapes or is broken`: this one names the hooks root under the
// upstream cache checkout, P2b names the root under the staging candidate, and
// P3 names a subdirectory inside hooks/. Matching the bare message would leave
// all three indistinguishable and satisfy none specifically.
void test("an escaping hooks-root symlink fails closed on the source side", async () => {
  const c = createCase({ fakes: "probe" });
  const before = seedSentinel(c);
  const result = await prepare(c, { SUPERPOWERS_REF: REFS.escapingHooksRoot });
  assert.equal(result.status, 1, result.stdout);
  const emitted = result.stderr.match(
    /^hook materialization failed: hook subtree escapes or is broken: (.+)$/m,
  );
  assert.ok(emitted, result.stderr);
  assert.equal(emitted[1], join(cacheRepo(c), "hooks"));
  assert.match(
    result.stderr,
    /^error: failed to prepare upstream Codex hooks\n$/m,
  );
  assertNoLeakedInternals(result.stderr);
  assert.deepEqual(snapshotTree(generated(c)), before);
});

// P2b — src/hooks.ts:303 reached from the CANDIDATE-side call at :367. Ports
// the retired driver's :1035 case (inventory item 125), which is the only
// root-specific witness that post-copy validation runs.
//
// The discriminator is which root the emitted path names. Both P2a and this
// case end in `/hooks`, so a `/hooks$` matcher cannot tell them apart. The
// candidate root is an invocation-specific staging path the workspace trap
// removes on failure, so assert its RELATIONSHIP to the cache root rather
// than pinning a literal that cannot exist by the time the test reads it.
void test("a source-only hooks root fails closed on the candidate side", async () => {
  const c = createCase({ fakes: "probe" });
  const before = seedSentinel(c);
  const result = await prepare(c, {
    SUPERPOWERS_REF: REFS.sourceOnlyHooksRoot,
  });
  assert.equal(result.status, 1, result.stdout);
  const emitted = result.stderr.match(
    /^hook materialization failed: hook subtree escapes or is broken: (.+)$/m,
  );
  assert.ok(emitted, result.stderr);
  assert.match(emitted[1], /\/hooks$/);
  assert.ok(
    !emitted[1].startsWith(cacheRepo(c)),
    `expected the CANDIDATE hooks root, got a path under the source ` +
      `checkout: ${emitted[1]}`,
  );
  assert.match(
    result.stderr,
    /^error: failed to prepare upstream Codex hooks\n$/m,
  );
  assertNoLeakedInternals(result.stderr);
  assert.deepEqual(snapshotTree(generated(c)), before);
});

void test("CLI-ENV-PREPARE-PATHS-01 relative prepare paths use the invocation cwd", async () => {
  const c = createCase({ fakes: "probe" });
  // The package root's own generated tree must be untouched: a relative
  // SUPERPOWERS_PLUGIN_ROOT resolves against the invocation cwd
  // (scripts/prepare:17-24), never against ctx.root.
  const untouched = snapshotTree(generated(c));
  const result = await prepare(
    c,
    {
      SUPERPOWERS_CACHE_DIR: "relative-cache",
      SUPERPOWERS_PLUGIN_ROOT: "relative-plugins/superpowers",
    },
    { cwd: c.dir },
  );
  assert.equal(result.status, 0, result.stderr);

  assert.equal(
    existsSync(join(c.dir, "relative-cache", "superpowers", ".git")),
    true,
  );
  assert.equal(
    existsSync(
      join(
        c.dir,
        "relative-plugins",
        "superpowers",
        ".codex-plugin",
        "plugin.json",
      ),
    ),
    true,
  );
  assert.deepEqual(snapshotTree(generated(c)), untouched);
});

void test("prepare honours a pinned saved selection", async () => {
  const c = createCase({ fakes: "probe" });
  const commit = commitOf(REFS.fallback);
  await saveSelection(c, {
    schema_version: 1,
    mode: "pinned",
    source: UPSTREAM,
    requested_ref: REFS.fallback,
    resolved_ref: REFS.fallback,
    commit,
  });
  // No SUPERPOWERS_REF: this is the branch that reaches fetchExactCommit.
  const result = await prepare(c, {});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.includes(`prepared ${REFS.fallback} at ${commit}\n`),
    true,
  );

  const provenance = JSON.parse(
    readFileSync(join(generated(c), ".superpowers-upstream.json"), "utf8"),
  );
  assert.equal(provenance.commit, commit);
  assert.equal(provenance.source, UPSTREAM);
});

void test("prepare clones once and then fetches into the same cache", async () => {
  const c = createCase({ fakes: "probe" });
  const first = await prepare(c, { SUPERPOWERS_REF: REFS.fallback });
  assert.equal(first.status, 0, first.stderr);
  const inode = statSync(cacheRepo(c)).ino;

  const second = await prepare(c, { SUPERPOWERS_REF: REFS.fallback });
  assert.equal(second.status, 0, second.stderr);
  // Same inode: the second run took the fetch branch
  // (src/commands/prepare.ts:310) instead of removing and re-cloning.
  assert.equal(statSync(cacheRepo(c)).ino, inode);
});

void test("prepare rejects an upstream missing any required path", async () => {
  // scripts/prepare:64-67's labels, in the shell's order. The label, not the
  // path, is what the diagnostic carries.
  for (const [path, label] of [
    ["skills", "skills/"],
    ["LICENSE", "LICENSE"],
    ["README.md", "README.md"],
    ["CODE_OF_CONDUCT.md", "CODE_OF_CONDUCT.md"],
  ]) {
    const c = createCase({ fakes: "probe" });
    const before = seedSentinel(c);
    const { source, commit } = cloneUpstream(
      join(c.dir, `upstream-without-${label.replace("/", "")}`),
      "main",
      (repository) => {
        rmSync(join(repository, path), { recursive: true, force: true });
      },
    );
    const result = await prepare(c, {
      SUPERPOWERS_UPSTREAM_URL: source,
      SUPERPOWERS_REF: commit,
    });
    // src/commands/prepare.ts:330-335 names only the source when a clone fails
    // and discards git's output by contract, so an unexpected failure here
    // cannot say why on its own. Attach the fixture's own view of the source —
    // computed only once the expectation has already failed, so a passing run
    // pays for no extra git processes.
    const expected = `error: required upstream path missing: ${label}\n`;
    const diagnosis =
      result.status === 1 && result.stderr === expected
        ? ""
        : `\n${describeRepository(source)}`;
    assert.equal(result.status, 1, `${result.stdout}${diagnosis}`);
    assert.equal(result.stderr, expected, `${result.stderr}${diagnosis}`);
    assertNoLeakedInternals(result.stderr);
    assert.deepEqual(snapshotTree(generated(c)), before);
  }
});

void test("prepare runs the additional plugin validator inside the staging workspace", async () => {
  // (a) A validator that succeeds. Its stdout reaches result.stdout, and it
  // prints the TMPDIR it actually ran under.
  const ok = createCase({ fakes: "probe" });
  const okValidator = join(ok.dir, "validator-ok.py");
  writeFileSync(
    okValidator,
    'import os\nimport sys\nprint("validator saw " + sys.argv[1])\nprint("TMPDIR=" + os.environ["TMPDIR"])\n',
  );
  const passed = await prepare(ok, {
    SUPERPOWERS_REF: REFS.fallback,
    SUPERPOWERS_VALIDATOR: okValidator,
  });
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /^validator saw .*\/superpowers$/m);

  // scripts/prepare:35-36 exported TMPDIR="$prepare_workspace"; runValidator
  // restores that. Without the override the child would inherit the case's own
  // TMPDIR, so this is the assertion that keeps the ported half of spec
  // divergence 9 load-bearing rather than comment-only.
  const environment = caseEnv(ok);
  const printed = passed.stdout.match(/^TMPDIR=(.*)$/m)?.[1];
  assert.equal(typeof printed, "string", passed.stdout);
  const workspace = /** @type {string} */ (printed);
  assert.notEqual(workspace, environment.TMPDIR);
  assert.equal(
    dirname(workspace),
    dirname(environment.SUPERPOWERS_PLUGIN_ROOT),
  );
  assert.match(basename(workspace), /^\.superpowers\.prepare\./);

  // (b) A validator that fails.
  const failing = createCase({ fakes: "probe" });
  const before = seedSentinel(failing);
  const failValidator = join(failing.dir, "validator-fail.py");
  writeFileSync(failValidator, "import sys\nsys.exit(1)\n");
  const rejected = await prepare(failing, {
    SUPERPOWERS_REF: REFS.fallback,
    SUPERPOWERS_VALIDATOR: failValidator,
  });
  assert.equal(rejected.status, 1, rejected.stdout);
  assert.equal(rejected.stderr, "error: additional plugin validation failed\n");
  assertNoLeakedInternals(rejected.stderr);
  assert.deepEqual(snapshotTree(generated(failing)), before);

  // (c) A validator path that does not exist.
  const absent = createCase({ fakes: "probe" });
  const missing = join(absent.dir, "validator-missing.py");
  const notFound = await prepare(absent, {
    SUPERPOWERS_REF: REFS.fallback,
    SUPERPOWERS_VALIDATOR: missing,
  });
  assert.equal(notFound.status, 1, notFound.stdout);
  assert.equal(
    notFound.stderr,
    `error: additional plugin validator not found: ${missing}\n`,
  );
  assertNoLeakedInternals(notFound.stderr);
});

void test("prepare writes complete provenance and is idempotent", async () => {
  const c = createCase({ fakes: "probe" });
  const first = await prepare(c, { SUPERPOWERS_REF: REFS.noHooksManifest });
  assert.equal(first.status, 0, first.stderr);

  const path = join(generated(c), ".superpowers-upstream.json");
  const bytes = readFileSync(path);
  const provenance = JSON.parse(bytes.toString("utf8"));
  assert.deepEqual(Object.keys(provenance).sort(), [
    "commit",
    "requested_ref",
    "resolved_ref",
    "source",
    "upstream_manifest_version",
  ]);
  assert.equal(provenance.source, UPSTREAM);
  assert.equal(provenance.requested_ref, REFS.noHooksManifest);
  assert.equal(provenance.resolved_ref, REFS.noHooksManifest);
  assert.equal(provenance.commit, commitOf(REFS.noHooksManifest));
  assert.equal(
    provenance.upstream_manifest_version,
    fixtureManifest("upstream-no-hooks.json").version,
  );

  const second = await prepare(c, { SUPERPOWERS_REF: REFS.noHooksManifest });
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(readFileSync(path), bytes);
});

void test("prepare rejects a malformed upstream manifest", async () => {
  const c = createCase({ fakes: "probe" });
  await assertManifestRejected(
    c,
    (path) => {
      writeFileSync(path, '{"name": "superpowers",\n');
    },
    (manifest) => `invalid manifest JSON in ${manifest}`,
  );
});

void test("prepare rejects an upstream manifest carrying NaN", async () => {
  const c = createCase({ fakes: "probe" });
  await assertManifestRejected(
    c,
    (path) => {
      writeFileSync(path, '{"name": "superpowers", "version": NaN}\n');
    },
    (manifest) => `invalid manifest JSON in ${manifest}`,
  );
});

void test("prepare rejects an upstream manifest nested beyond the depth limit", async () => {
  const c = createCase({ fakes: "probe" });
  await assertManifestRejected(
    c,
    (path) => {
      // The profile allows 256 containers (src/hooks.ts:35); 257 arrays inside
      // the top-level object is the first shape past it.
      /** @type {unknown} */
      let nested = 0;
      for (let depth = 0; depth < 257; depth += 1) nested = [nested];
      writeFileSync(
        path,
        `${JSON.stringify({ name: "superpowers", x_future_manifest: nested })}\n`,
      );
    },
    (manifest) => `invalid manifest JSON in ${manifest}`,
  );
});

void test("prepare rejects an upstream manifest holding invalid UTF-8", async () => {
  const c = createCase({ fakes: "probe" });
  await assertManifestRejected(
    c,
    (path) => {
      writeFileSync(
        path,
        Buffer.concat([
          Buffer.from('{"name": "'),
          Buffer.from([0xff]),
          Buffer.from('"}\n'),
        ]),
      );
    },
    (manifest) => `invalid manifest JSON in ${manifest}`,
  );
});

void test("prepare reports an unreadable upstream manifest without an errno", async () => {
  const c = createCase({ fakes: "probe" });
  // Two runs: git stores no mode below the executable bit, so a committed
  // mode-000 file checks out readable. The first run populates the cache; the
  // mode is applied there, and the second run takes the fetch branch, which
  // leaves the working tree alone.
  const first = await prepare(c, { SUPERPOWERS_REF: REFS.noHooksManifest });
  assert.equal(first.status, 0, first.stderr);
  const before = snapshotTree(generated(c));

  const manifest = cacheManifest(c);
  // Captured, not assumed: the mode git checked the file out with belongs to
  // git and the process umask, so a literal restore value would be this test
  // asserting something it does not own.
  const manifestMode = statSync(manifest).mode & 0o7777;
  chmodSync(manifest, 0o000);
  try {
    const result = await prepare(c, { SUPERPOWERS_REF: REFS.noHooksManifest });
    assert.equal(result.status, 1, result.stdout);
    assert.equal(
      result.stderr,
      `error: cannot read manifest JSON in ${manifest}\n`,
    );
    assertNoLeakedInternals(result.stderr);
    assert.deepEqual(snapshotTree(generated(c)), before);
  } finally {
    chmodSync(manifest, manifestMode);
  }
});

void test("prepare rejects an upstream manifest that is a JSON array", async () => {
  const c = createCase({ fakes: "probe" });
  await assertManifestRejected(
    c,
    (path) => {
      writeFileSync(path, '[{"name": "superpowers"}]\n');
    },
    (manifest) => `manifest must be a JSON object: ${manifest}`,
  );
});

void test("prepare rejects a non-string upstream manifest version", async () => {
  const c = createCase({ fakes: "probe" });
  // Spec divergence 7: the shell stringified any type through Python's print(),
  // so `"version": 6` became "6" and flowed into provenance.
  await assertManifestRejected(
    c,
    (path) => {
      writeFileSync(path, '{"name": "superpowers", "version": 6}\n');
    },
    (manifest) => `upstream manifest version is not a string: ${manifest}`,
  );
});

void test("prepare rejects a directory as the fallback manifest template before building", async () => {
  const c = createCase({ fakes: "probe" });
  const before = seedSentinel(c);
  const template = join(c.dir, "template-directory");
  mkdirSync(template, { recursive: true });

  const result = await prepare(c, {
    SUPERPOWERS_REF: REFS.fallback,
    SUPERPOWERS_MANIFEST_TEMPLATE: template,
  });
  assert.equal(result.status, 1, result.stdout);
  assert.equal(
    result.stderr,
    `error: missing fallback manifest template: ${template}\n`,
  );
  assertNoLeakedInternals(result.stderr);

  // No adapter build ran: the same contract
  // tests/baseline/cli-parity.test.js:1190-1209 asserts for the spawned path.
  // An adapter build always replays `generated plugin validation passed: …`
  // onto stdout, and the template check precedes the cache mkdir
  // (src/commands/prepare.ts:292-299), so neither is present.
  assert.equal(result.stdout, "");
  assert.equal(existsSync(join(c.dir, "cache")), false);

  // And no staging tree was left behind under the plugin root's parent.
  const plugins = dirname(caseEnv(c).SUPERPOWERS_PLUGIN_ROOT);
  assert.deepEqual(
    readdirSync(plugins).filter((name) =>
      name.startsWith(".superpowers.prepare."),
    ),
    [],
  );
  assert.deepEqual(snapshotTree(generated(c)), before);
});

void test("prepare rejects a directory as the additional plugin validator", async () => {
  const c = createCase({ fakes: "probe" });
  const before = seedSentinel(c);
  const validator = join(c.dir, "validator-directory");
  mkdirSync(validator, { recursive: true });

  const result = await prepare(c, {
    SUPERPOWERS_REF: REFS.fallback,
    SUPERPOWERS_VALIDATOR: validator,
  });
  assert.equal(result.status, 1, result.stdout);
  assert.equal(
    result.stderr,
    `error: additional plugin validator not found: ${validator}\n`,
  );
  assertNoLeakedInternals(result.stderr);
  assert.deepEqual(snapshotTree(generated(c)), before);
});

void test("prepare reports a failed upstream copy without an errno", async () => {
  const c = createCase({ fakes: "probe" });
  // Two runs for the same reason as the unreadable-manifest case: git records
  // no directory modes at all, so the mode has to be applied to the cache.
  const first = await prepare(c, { SUPERPOWERS_REF: REFS.fallback });
  assert.equal(first.status, 0, first.stderr);
  const before = snapshotTree(generated(c));

  const skill = join(cacheRepo(c), "skills", "brainstorming");
  // Captured for the same reason as the unreadable-manifest case above.
  const skillMode = statSync(skill).mode & 0o7777;
  chmodSync(skill, 0o000);
  try {
    const result = await prepare(c, { SUPERPOWERS_REF: REFS.fallback });
    assert.equal(result.status, 1, result.stdout);
    assert.equal(
      result.stderr,
      `error: cannot copy upstream path into candidate: ${join(cacheRepo(c), "skills")}\n`,
    );
    assertNoLeakedInternals(result.stderr);
    assert.deepEqual(snapshotTree(generated(c)), before);
  } finally {
    chmodSync(skill, skillMode);
  }
});

void test("prepare keeps hostile git output off its stream on both fetch branches", async () => {
  /**
   * A source that is a directory but not a repository. Measured: git itself
   * writes five lines to the combined stream for this shape.
   * @param {CaseEnv} c
   * @returns {string}
   */
  const nonRepository = (c) => {
    const path = join(c.dir, "not-a-repository");
    mkdirSync(path, { recursive: true });
    return path;
  };

  // Non-pinned: the cache already exists, so this is the fetch branch
  // (src/commands/prepare.ts:311-328), whose diagnostic names the source and
  // nothing else. Exact equality is the assertion — one hand-written line.
  const env = createCase({ fakes: "probe" });
  const commit = commitOf(REFS.fallback);
  const seeded = await prepare(env, { SUPERPOWERS_REF: commit });
  assert.equal(seeded.status, 0, seeded.stderr);
  const before = snapshotTree(generated(env));

  const hostile = nonRepository(env);
  const fetched = await prepare(env, {
    SUPERPOWERS_REF: commit,
    SUPERPOWERS_UPSTREAM_URL: hostile,
  });
  assert.equal(fetched.status, 1, fetched.stdout);
  assert.equal(
    fetched.stderr,
    `error: cannot fetch upstream repo: ${hostile}\n`,
  );
  assertNoLeakedInternals(fetched.stderr);
  assert.deepEqual(snapshotTree(generated(env)), before);

  // Pinned: this reaches fetchExactCommit. NOTE what actually happens, because
  // it is not what the splice sites would suggest: proveCommit's fetch fails,
  // `UNAVAILABLE_OBJECT_RE` does not match "does not appear to be a git
  // repository", so the HAND-WRITTEN non-splicing branch (src/upstream.ts:277)
  // wins and git's five lines are DISCARDED by the callee. oneLine() is not what
  // bounds this output.
  //
  // fetchExactCommit does hold three splice sites — src/upstream.ts:334, :349,
  // and proveCommit's init at :262, inherited from spw_upstream_cli's
  // `spw_die "${_upstream_out#error: }"` and not a regression — but no
  // externally constructible input reaches any of them. Four shapes were tried:
  // a regular file as the cache repository, `.git` as a regular file, an empty
  // `.git` directory, and a read-only `.git/objects`. Every one either fails
  // earlier or makes git emit a single `fatal:` line, so a multi-line splice
  // cannot be built from outside the process. Pinning the collapse itself needs
  // an injected git result in a src/upstream.ts unit test, not this driver.
  // Do not re-derive that list; extend it.
  //
  // So this half asserts the exact message, which is strictly stronger than the
  // single-line shape check the task text asked for. The same string is already
  // pinned at tests/unit/upstream.test.js:404 and
  // tests/baseline/selection-commands.test.js:645.
  const pinned = createCase({ fakes: "probe" });
  const pinnedBefore = seedSentinel(pinned);
  const pinnedHostile = nonRepository(pinned);
  await saveSelection(pinned, {
    schema_version: 1,
    mode: "pinned",
    source: pinnedHostile,
    requested_ref: commit,
    resolved_ref: commit,
    commit,
  });
  const result = await prepare(pinned, {
    SUPERPOWERS_UPSTREAM_URL: pinnedHostile,
  });
  assert.equal(result.status, 1, result.stdout);
  assert.equal(
    result.stderr,
    `error: cannot fetch requested commit from ${pinnedHostile}\n`,
  );
  assertNoLeakedInternals(result.stderr);
  assert.deepEqual(snapshotTree(generated(pinned)), pinnedBefore);
});

// P3 — src/hooks.ts:279, the WALK branch, where readdir fails on a directory
// inside a subtree that has already passed the containment check at :303.
//
// This branch is unwitnessed on BOTH sides. The retired driver's three
// hooks-root cases all corrupt the root and land on :303 — two source-side
// (P2a), one candidate-side (P2b). Porting "the shell's coverage" would have
// carried this gap across rather than closed it.
//
// The precondition is a filesystem permission, which git cannot store, so the
// fixture follows the shape already established for the unreadable-manifest
// case above: run once so the upstream cache is populated, capture the real
// mode rather than assuming one, chmod, run again, restore in a `finally`.
// The second run takes the fetch branch and leaves the working tree alone.
//
// A visible skip, not an early `return`: returning reports a PASS while
// asserting nothing. tests/container.sh:8-12 refuses a root container, but
// `sh tests/run.sh` on a root host has no uid check at all, so this branch is
// reachable and must say so when it is taken.
void test(
  "an unreadable hooks subdirectory fails closed naming the subdirectory",
  {
    skip:
      process.getuid?.() === 0
        ? "permission checks do not apply to root"
        : false,
  },
  async () => {
    const c = createCase({ fakes: "probe" });
    const first = await prepare(c, { SUPERPOWERS_REF: REFS.defaultHooks });
    assert.equal(first.status, 0, first.stderr);
    const before = snapshotTree(generated(c));

    // hooks/support/ holds helper.txt in the shared fixture, so collectEntries
    // pushes it onto the walk queue and readdirs it. Captured, not assumed:
    // the mode git checked the directory out with belongs to git and the
    // umask.
    const unreadable = join(cacheRepo(c), "hooks", "support");
    const mode = statSync(unreadable).mode & 0o7777;
    chmodSync(unreadable, 0o000);
    try {
      const result = await prepare(c, { SUPERPOWERS_REF: REFS.defaultHooks });
      assert.equal(result.status, 1, result.stdout);
      const emitted = result.stderr.match(
        /^hook materialization failed: hook subtree escapes or is broken: (.+)$/m,
      );
      assert.ok(emitted, result.stderr);
      assert.equal(emitted[1], unreadable);
      assert.match(
        result.stderr,
        /^error: failed to prepare upstream Codex hooks\n$/m,
      );
      assertNoLeakedInternals(result.stderr);
      assert.deepEqual(snapshotTree(generated(c)), before);
    } finally {
      chmodSync(unreadable, mode);
    }
  },
);

// P4 — src/hooks.ts:359-360, the ACCEPTING side of the hooks-root symlink
// policy, covering both halves the retired shell driver held alone (items
// 83-85 in tests/migration-inventory/prepare.md, whose entry for item 83 ends
// "Slice 3.5, read this before deleting the shell file").
//
// Every other root-symlink case in the repository asserts rejection:
// tests/baseline/generated-plugin-corpus.test.js:812-880 is twelve cases of
// status === 1, and :907 puts contained symlinks inside a REAL hooks/
// directory rather than symlinking the root. Without this case, acceptance is
// exercised by nothing on either the materializing or the validating side.
void test("a contained relative hooks root is recreated as a symlink in the candidate", async () => {
  const c = createCase({ fakes: "probe" });
  const result = await prepare(c, {
    SUPERPOWERS_REF: REFS.containedHooksRoot,
  });
  assert.equal(result.status, 0, result.stderr);
  assertNoLeakedInternals(result.stderr);

  const hooks = join(generated(c), "hooks");
  // Materializing side: the root stays a symlink and keeps its exact target.
  assert.ok(
    lstatSync(hooks).isSymbolicLink(),
    "a contained hooks root must remain a symlink in the candidate",
  );
  assert.equal(readlinkSync(hooks), "assets/hook-root");
  // Validating side: the candidate passed validateSubtreeSymlinks at
  // src/hooks.ts:367 (status 0 above) AND the content behind the root is
  // actually reachable through it, which is what makes the acceptance real
  // rather than a dangling link nobody followed.
  assert.equal(
    readFileSync(join(hooks, "root-hook.txt"), "utf8"),
    "materialized root target\n",
  );
});

// @ts-check
// Non-test helper for tests/baseline/prepare.test.js. See prepare-child.js for
// why runPrepare is spawned rather than called in process.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRATCH } from "../bin/lifecycle-fixture.js";

/** @typedef {import("../bin/lifecycle-fixture.js").CaseEnv} CaseEnv */

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MANIFESTS = join(ROOT, "tests/fixtures/baseline/manifests");
const CHILD = fileURLToPath(new URL("./prepare-child.js", import.meta.url));

// Per-invocation identity flags only. These write no git config at any scope,
// which is why they are passed on every commit and tag rather than set once —
// the choice tests/baseline/ref-resolution.test.js:75 documents. The Global
// Constraints' `git add -A` ban governs the repository under development, not a
// throwaway fixture repo like this one; the shell original stages the same way
// at tests/test_prepare_with_fake_upstream.sh:182.
const IDENTITY = [
  "-c",
  "user.name=superpowers-manager",
  "-c",
  "user.email=superpowers-manager@example.invalid",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "tag.gpgsign=false",
];

// Hermeticity for the fixture's OWN git, not just the subject's. The IDENTITY
// flags above cover identity and signing, but `core.excludesFile`,
// `init.templateDir`, `core.hooksPath`, and `gc.auto` all change what this
// repository ends up containing, so inheriting the developer's global and system
// config makes the fixture tree machine-dependent — and cases 5 and 6 compare
// that tree against committed layout fixtures byte-for-byte.
//
// It also closes the last open lead on the unexplained case-11 clone failure: a
// machine with a low `gc.auto` would let `gc.autoDetach`'s background repack run
// against UPSTREAM while a clone reads it, which is the right shape for a rare
// local-clone failure.
//
// GIT_CONFIG_GLOBAL deliberately names a path that does not exist; git reads an
// absent file as "no global config" rather than as an error. Same arrangement as
// the child environment caseEnv builds below.
const GIT_HOME = join(SCRATCH, "fixture-git-home");
const GIT_TMP = join(SCRATCH, "fixture-git-tmp");
mkdirSync(GIT_HOME, { recursive: true });
mkdirSync(GIT_TMP, { recursive: true });
const GIT_ENV = {
  HOME: GIT_HOME,
  PATH: process.env.PATH ?? "",
  TMPDIR: GIT_TMP,
  GIT_CONFIG_GLOBAL: join(GIT_HOME, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
};

/**
 * @param {string} repo
 * @param {string[]} args
 * @returns {string}
 */
function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: GIT_ENV,
  });
  assert.equal(
    result.status,
    0,
    `fixture git ${args.join(" ")} failed in ${repo}: ${result.stderr || result.stdout}`,
  );
  return result.stdout;
}

/**
 * The fixture's own view of a repository, for an assertion message.
 * src/commands/prepare.ts:330-335 names only the source when a clone fails and
 * discards git's output by contract, so a case whose clone fails for an
 * unexpected reason cannot say why. This does not change that contract; it adds
 * the fixture's side of the story to the failure message. Deliberately does not
 * go through `git()` above: every command here is expected to be able to fail.
 * @param {string} repository
 * @returns {string}
 */
export function describeRepository(repository) {
  /** @param {string[]} args */
  const attempt = (args) => {
    const result = spawnSync("git", ["-C", repository, ...args], {
      encoding: "utf8",
      env: GIT_ENV,
    });
    const output = (result.stderr || result.stdout || "").trim();
    return `  git ${args.join(" ")}: status=${result.status} ${output.replaceAll("\n", " | ")}`;
  };
  return [
    `fixture repository ${repository}`,
    attempt(["rev-parse", "HEAD"]),
    attempt(["fsck"]),
  ].join("\n");
}

/**
 * The hook paths the `hooks-string-array` branch declares AND writes. Exported
 * so the suite asserts the same two strings the fixture wrote rather than its
 * own copy of them — the manifest value and the files on disk have to agree, and
 * two literals in two files cannot be kept in agreement by anything.
 */
export const DECLARED_HOOK_PATHS = [
  "./config/hooks-first.json",
  "./alternate/hooks-second.json",
];

/**
 * Ten branches, built once. The base commit is deliberately manifest-less so
 * `v5.0.0` serves GENERATED-FALLBACK-01; every other branch adds a manifest on
 * top of it.
 * @returns {string}
 */
function buildUpstream() {
  const upstream = join(SCRATCH, "prepare-upstream");
  mkdirSync(join(upstream, "skills", "brainstorming"), { recursive: true });
  mkdirSync(join(upstream, "assets"), { recursive: true });
  mkdirSync(join(upstream, "hooks", "support"), { recursive: true });
  writeFileSync(
    join(upstream, "skills", "brainstorming", "SKILL.md"),
    "---\nname: brainstorming\ndescription: Fake upstream skill\n---\n# Brainstorming\n",
  );
  // The two committed layout fixtures both list
  // skills/brainstorming/branch.txt, because the shell original added it on
  // main before branching (tests/test_prepare_with_fake_upstream.sh:131-133).
  // Every branch here descends from this commit, so the file is present for the
  // two listing comparisons and harmless everywhere else.
  writeFileSync(
    join(upstream, "skills", "brainstorming", "branch.txt"),
    "branch data\n",
  );
  writeFileSync(join(upstream, "assets", "superpowers-small.svg"), "asset\n");
  writeFileSync(join(upstream, "hooks", "session-start-codex"), "#!/bin/sh\n");
  writeFileSync(
    join(upstream, "hooks", "support", "helper.txt"),
    "hook support\n",
  );
  writeFileSync(
    join(upstream, "hooks", "hooks-codex.json"),
    `${JSON.stringify(
      {
        hooks: {
          SessionStart: [
            {
              matcher: "startup|resume|clear|compact",
              hooks: [
                {
                  type: "command",
                  command: 'sh "${PLUGIN_ROOT}/hooks/session-start-codex"',
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(upstream, "LICENSE"), "license\n");
  writeFileSync(join(upstream, "README.md"), "readme\n");
  writeFileSync(join(upstream, "CODE_OF_CONDUCT.md"), "code\n");

  const init = spawnSync("git", ["init", upstream], {
    encoding: "utf8",
    env: GIT_ENV,
  });
  assert.equal(init.status, 0, `fixture git init failed: ${init.stderr}`);
  git(upstream, ["add", "."]);
  git(upstream, [
    ...IDENTITY,
    "commit",
    "-m",
    "fake upstream without manifest",
  ]);
  git(upstream, [
    ...IDENTITY,
    "tag",
    "-a",
    "v5.0.0",
    "-m",
    "fake legacy release",
  ]);
  git(upstream, ["branch", "-M", "main"]);

  const manifest = join(upstream, ".codex-plugin", "plugin.json");

  /**
   * @param {string} branch
   * @param {() => void} write
   */
  const branchWith = (branch, write) => {
    git(upstream, ["checkout", "-b", branch]);
    // Recreated per branch, not once before the loop: `main` is deliberately
    // manifest-less, so checking back out to it removes .codex-plugin/ along
    // with the only file in it.
    mkdirSync(join(upstream, ".codex-plugin"), { recursive: true });
    write();
    git(upstream, ["add", "."]);
    git(upstream, [...IDENTITY, "commit", "-m", branch]);
    git(upstream, ["checkout", "main"]);
  };

  branchWith("hooks-empty-object", () => {
    copyFileSync(join(MANIFESTS, "upstream-empty-hooks.json"), manifest);
  });
  branchWith("hooks-default", () => {
    copyFileSync(join(MANIFESTS, "upstream-default-hooks.json"), manifest);
    copyFileSync(
      join(upstream, "hooks", "hooks-codex.json"),
      join(upstream, "hooks", "hooks.json"),
    );
  });
  branchWith("hooks-active-fixture", () => {
    copyFileSync(join(MANIFESTS, "upstream-active-hooks.json"), manifest);
  });
  // declared-hooks.txt is the listing of the shell original's `hooks-string-array`
  // branch (tests/test_prepare_with_fake_upstream.sh:212-217, :874-876), whose
  // manifest declares TWO hook paths outside hooks/. The `hooks` value is
  // rewritten here rather than read from a fifth committed manifest, exactly as
  // the shell rewrote it with set_manifest_hooks; every other key, including
  // x_future_manifest, still comes from the committed fixture.
  branchWith("hooks-string-array", () => {
    const declared = JSON.parse(
      readFileSync(join(MANIFESTS, "upstream-active-hooks.json"), "utf8"),
    );
    declared.hooks = [...DECLARED_HOOK_PATHS];
    writeFileSync(manifest, `${JSON.stringify(declared, null, 2)}\n`);
    for (const relative of DECLARED_HOOK_PATHS) {
      const target = join(upstream, relative);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify({ fixture: relative })}\n`);
    }
  });
  branchWith("manifest-no-hooks", () => {
    copyFileSync(join(MANIFESTS, "upstream-no-hooks.json"), manifest);
  });
  branchWith("manifest-wrong-name", () => {
    writeFileSync(
      manifest,
      `${JSON.stringify({ name: "not-superpowers", version: "6.0.3" }, null, 2)}\n`,
    );
  });
  branchWith("hooks-escaping-symlink", () => {
    copyFileSync(join(MANIFESTS, "upstream-no-hooks.json"), manifest);
    copyFileSync(
      join(upstream, "hooks", "hooks-codex.json"),
      join(upstream, "hooks", "hooks.json"),
    );
    symlinkSync("../../outside", join(upstream, "hooks", "escape"));
  });
  // P1 — a `hooks` value no classification branch accepts, so the adapter's
  // `hook classification failed:` wrapper (src/adapter.ts:364) is the
  // diagnostic under test.
  //
  // The value is a NUMBER on purpose. classifyHooks accepts
  // `typeof hooks === "string"` as a single declared path
  // (src/hooks.ts:196-198), so a plain string reaches validateDeclaredFile and
  // fails with `declared hook path must start with ./` — a different cause,
  // already covered in tests/unit/hooks.test.js. 42 falls through every
  // accepted shape to the unsupported-declaration throw.
  //
  // The eight underlying causes the retired shell driver asserted behind this
  // prefix are all already message-exact in tests/unit/hooks.test.js. This
  // branch exists for the wrapper alone.
  branchWith("hooks-unsupported-declaration", () => {
    const declared = JSON.parse(
      readFileSync(join(MANIFESTS, "upstream-active-hooks.json"), "utf8"),
    );
    declared.hooks = 42;
    writeFileSync(manifest, `${JSON.stringify(declared, null, 2)}\n`);
  });
  // P2a — the hooks ROOT is a relative symlink escaping the upstream checkout,
  // so the SOURCE-side validateSubtreeSymlinks call (src/hooks.ts:358) fails
  // its containment check at :303. Ports the retired driver's
  // hooks-root-escape-symlink and hooks-root-broken-symlink cases (items 128
  // and 127), which share this branch.
  //
  // classifyHooks returns copyHooksSubtree: hooksRootPresent
  // (src/hooks.ts:230), and a symlink is present rather than missing, so
  // materializeHooks reaches the validation. The link is relative, so it
  // passes the absolute-symlink rejection at src/hooks.ts:296-298 first.
  branchWith("hooks-root-escape-symlink", () => {
    const declared = JSON.parse(
      readFileSync(join(MANIFESTS, "upstream-active-hooks.json"), "utf8"),
    );
    declared.hooks = [...DECLARED_HOOK_PATHS];
    writeFileSync(manifest, `${JSON.stringify(declared, null, 2)}\n`);
    for (const relative of DECLARED_HOOK_PATHS) {
      const target = join(upstream, relative);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify({ fixture: relative })}\n`);
    }
    rmSync(join(upstream, "hooks"), { recursive: true, force: true });
    symlinkSync("../outside-the-checkout", join(upstream, "hooks"));
  });
  // P2b — the hooks ROOT is a relative symlink to source-contained content
  // that never reaches the candidate, so SOURCE validation passes and the
  // CANDIDATE validation at src/hooks.ts:366 fails.
  //
  // `.git` is the target for the same reason the retired shell fixture used
  // it: it exists in the upstream checkout, so assertExistingContained accepts
  // it at :358, and it is absent from src/commands/prepare.ts:29-35's five
  // copied paths, so the symlink recreated at src/hooks.ts:359-360 dangles in
  // the candidate. Any target outside those five works; this one keeps the
  // ported case recognisable against the file it replaces.
  branchWith("hooks-root-contained-source-only", () => {
    const declared = JSON.parse(
      readFileSync(join(MANIFESTS, "upstream-active-hooks.json"), "utf8"),
    );
    declared.hooks = { SessionStart: [] };
    writeFileSync(manifest, `${JSON.stringify(declared, null, 2)}\n`);
    rmSync(join(upstream, "hooks"), { recursive: true, force: true });
    symlinkSync(".git", join(upstream, "hooks"));
  });
  // P4 — a CONTAINED relative hooks-root symlink, which src/hooks.ts:359-360
  // recreates in the candidate rather than dereferencing.
  //
  // The target must live under `assets/`. src/commands/prepare.ts:29-35 copies
  // exactly five paths into the candidate — skills, assets, LICENSE,
  // README.md, CODE_OF_CONDUCT.md — so a symlink to any other contained
  // directory would dangle in the candidate and fail the SECOND
  // validateSubtreeSymlinks call at src/hooks.ts:366. That is precisely what
  // P2b's `.git` fixture does on purpose; this one is its mirror image, and
  // the two differ only in whether the target is one of the copied five.
  branchWith("hooks-root-contained-materialized", () => {
    const declared = JSON.parse(
      readFileSync(join(MANIFESTS, "upstream-active-hooks.json"), "utf8"),
    );
    declared.hooks = { SessionStart: [] };
    writeFileSync(manifest, `${JSON.stringify(declared, null, 2)}\n`);
    mkdirSync(join(upstream, "assets", "hook-root"), { recursive: true });
    writeFileSync(
      join(upstream, "assets", "hook-root", "root-hook.txt"),
      "materialized root target\n",
    );
    rmSync(join(upstream, "hooks"), { recursive: true, force: true });
    symlinkSync("assets/hook-root", join(upstream, "hooks"));
  });
  return upstream;
}

export const UPSTREAM = buildUpstream();
export const REFS = {
  fallback: "v5.0.0",
  emptyObjectHooks: "hooks-empty-object",
  defaultHooks: "hooks-default",
  declaredHooks: "hooks-string-array",
  activeHooks: "hooks-active-fixture",
  noHooksManifest: "manifest-no-hooks",
  wrongName: "manifest-wrong-name",
  escapingSymlink: "hooks-escaping-symlink",
  unsupportedHooks: "hooks-unsupported-declaration",
  escapingHooksRoot: "hooks-root-escape-symlink",
  sourceOnlyHooksRoot: "hooks-root-contained-source-only",
  containedHooksRoot: "hooks-root-contained-materialized",
};

/**
 * A per-case throwaway copy of UPSTREAM, checked out at `ref`, mutated, and
 * committed. Copied rather than cloned so every branch and tag comes along and
 * a mutation can be committed on any of them. Cases that need a broken upstream
 * — a replaced manifest, a removed required path, an unreadable skills subtree —
 * all go through here so none of them can disturb the shared UPSTREAM.
 *
 * Returns the new commit, which callers pass as SUPERPOWERS_REF: a 40-hex ref
 * is a `raw-commit` resolution (src/upstream.ts:160-162), so the case reaches
 * no ref-resolution Git process at all.
 *
 * @param {string} destination
 * @param {string} ref
 * @param {(repository: string) => void} mutate
 * @returns {{ source: string, commit: string }}
 */
export function cloneUpstream(destination, ref, mutate) {
  cpSync(UPSTREAM, destination, { recursive: true, verbatimSymlinks: true });
  git(destination, ["checkout", ref]);
  mutate(destination);
  git(destination, ["add", "-A"]);
  git(destination, [...IDENTITY, "commit", "-m", "case mutation"]);
  return {
    source: destination,
    commit: git(destination, ["rev-parse", "HEAD"]).trim(),
  };
}

/**
 * The commit an UPSTREAM ref names, read from the fixture rather than written
 * as a literal: the repository is rebuilt on every run.
 * @param {string} ref
 * @returns {string}
 */
export function commitOf(ref) {
  return git(UPSTREAM, ["rev-list", "-n", "1", ref]).trim();
}

/**
 * Every environment name the child needs. Declared, never derived: a predicate
 * would also accept an env that lost a name. The child's process.env is this
 * object and nothing else, so an omission is a hermeticity hole, not a default.
 */
export const REQUIRED_ENV = [
  "HOME",
  "TMPDIR",
  "PATH",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "SUPERPOWERS_CONFIG_DIR",
  "SUPERPOWERS_CACHE_DIR",
  "SUPERPOWERS_PLUGIN_ROOT",
  "SUPERPOWERS_MANIFEST_TEMPLATE",
  "SUPERPOWERS_UPSTREAM_URL",
];

/**
 * @param {CaseEnv} c
 * @param {Record<string, string>} [extra]
 * @returns {Record<string, string>}
 */
export function caseEnv(c, extra = {}) {
  return {
    HOME: c.home,
    TMPDIR: c.tmp,
    PATH: process.env.PATH ?? "",
    GIT_CONFIG_GLOBAL: join(c.home, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    SUPERPOWERS_CONFIG_DIR: join(c.home, ".config", "superpowers-manager"),
    SUPERPOWERS_CACHE_DIR: join(c.dir, "cache"),
    SUPERPOWERS_PLUGIN_ROOT: join(c.pkg, "plugins", "superpowers"),
    SUPERPOWERS_MANIFEST_TEMPLATE: join(
      c.pkg,
      "plugins/superpowers/.codex-plugin/plugin.template.json",
    ),
    SUPERPOWERS_UPSTREAM_URL: UPSTREAM,
    ...extra,
  };
}

/**
 * @param {CaseEnv} c
 * @param {Record<string, string>} [extra]
 * @param {{ cwd?: string, argv?: string[] }} [options]
 * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
 */
export function prepare(c, extra = {}, options = {}) {
  const env = caseEnv(c, extra);
  for (const name of REQUIRED_ENV) {
    assert.ok(
      Object.hasOwn(env, name),
      `hermeticity: the child environment must declare ${name}`,
    );
  }
  const source = env.SUPERPOWERS_UPSTREAM_URL;
  assert.ok(
    source.startsWith("/"),
    `hermeticity: SUPERPOWERS_UPSTREAM_URL must be a local absolute path, got ${source}`,
  );
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      [CHILD, c.pkg, ...(options.argv ?? [])],
      { cwd: options.cwd ?? c.dir, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      resolvePromise({ status: code ?? 1, stdout, stderr });
    });
  });
}

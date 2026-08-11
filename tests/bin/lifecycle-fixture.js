// @ts-check
// Shared builder for the install and uninstall lifecycle ports. Every case
// gets its own package root, state directory, logs, and TMPDIR, so cases run
// concurrently and none depends on another's cleanup. That independence is the
// point: the shell drivers established a scenario's preconditions from an
// unrelated scenario's cleanup twenty lines earlier
// (tests/test_install_commands.sh:418-423).

import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfig } from "./lifecycle-config.js";
import { SEAM_DEPENDENT, SEAM_MODES, SEAM_REASONS } from "./adapter-seam.js";
import { registerScratch } from "./fixture-scratch.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// os.tmpdir() honors TMPDIR when set and falls back to the platform default
// when it is not, while mkdtempSync supplies the uniqueness the "never a
// hardcoded /tmp" rule actually protects. A hard `TMPDIR must be set` throw
// turns the CI toolchain job red on a bare ubuntu-latest runner while every
// local gate stays green — PR 11.2 shipped exactly that defect and had to
// remove it.
export const SCRATCH = realpathSync(
  mkdtempSync(join(tmpdir(), "spw-lifecycle-")),
);
registerScratch(SCRATCH);

/**
 * One immutable copy of everything a package root needs. Per-case roots are
 * copied from here rather than from ROOT: it is faster, and it makes a run
 * immune to the developer editing the working tree while tests execute.
 * @returns {string}
 */
function buildSnapshot() {
  const snapshot = mkdtempSync(join(SCRATCH, "snapshot-"));
  // `bin` joined the list at PR 11.5 slice 4b's flip: the subject runScript
  // launches is now the Node entrypoint bin/superpowers-manager.js, not a
  // scripts/ file. `scripts` stays until 4c deletes it — tests/bin/units.test.js
  // guards that it is still present here.
  for (const entry of ["bin", "scripts", "config", "dist"]) {
    cpSync(join(ROOT, entry), join(snapshot, entry), { recursive: true });
  }
  cpSync(join(ROOT, "package.json"), join(snapshot, "package.json"));
  const pluginDir = join(snapshot, "plugins", "superpowers", ".codex-plugin");
  mkdirSync(pluginDir, { recursive: true });
  cpSync(
    join(
      ROOT,
      "plugins",
      "superpowers",
      ".codex-plugin",
      "plugin.template.json",
    ),
    join(pluginDir, "plugin.template.json"),
  );
  return snapshot;
}

const SNAPSHOT = buildSnapshot();

/**
 * @param {string} repo
 * @param {string[]} args
 */
function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `fixture git ${args[0]} failed in ${repo}: ${result.stderr || result.stdout}`,
    );
  }
}

// Per-invocation identity flags only. These write no git config at any scope
// and mirror tests/lib/harness.sh (spw_git_commit, spw_git_tag). Do not
// convert them into `git config` calls.
const IDENTITY = [
  "-c",
  "user.email=superpowers-manager@example.invalid",
  "-c",
  "user.name=superpowers-manager",
];

/**
 * A fake upstream git repo with one stable release tag. Built once and shared
 * across every case: `scripts/prepare` only ever fetches from it, which is
 * read-only on the source, so concurrent cases cannot disturb one another
 * through it. Mirrors tests/test_install_commands.sh:51-67.
 * @returns {string}
 */
function buildUpstream() {
  const upstream = join(SCRATCH, "upstream");
  mkdirSync(join(upstream, "skills", "brainstorming"), { recursive: true });
  writeFileSync(
    join(upstream, "skills", "brainstorming", "SKILL.md"),
    "---\nname: brainstorming\ndescription: Fake upstream skill\n---\n# Brainstorming\n",
  );
  writeFileSync(join(upstream, "LICENSE"), "license\n");
  writeFileSync(join(upstream, "README.md"), "readme\n");
  writeFileSync(join(upstream, "CODE_OF_CONDUCT.md"), "code\n");
  const init = spawnSync("git", ["init", upstream], { encoding: "utf8" });
  if (init.status !== 0) {
    throw new Error(`fixture git init failed: ${init.stderr}`);
  }
  git(upstream, ["add", "."]);
  git(upstream, [
    ...IDENTITY,
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "fake upstream",
  ]);
  git(upstream, [
    ...IDENTITY,
    "-c",
    "tag.gpgsign=false",
    "tag",
    "-a",
    "v1.0.0",
    "-m",
    "fake release",
  ]);
  return upstream;
}

export const UPSTREAM = buildUpstream();

/**
 * @typedef {object} CaseEnv
 * @property {string} dir per-case scratch root
 * @property {string} pkg copied package root the subject runs from
 * @property {string} state fixture state: config.json, logs, JSON fixtures
 * @property {string} tmp TMPDIR handed to the subject
 * @property {string} home case-local HOME; XDG_CONFIG_HOME sits under it
 * @property {string} codexLog
 * @property {string} adapterLog
 * @property {string} codexBin
 * @property {string} adapterBin
 * @property {string} adapterSeam what the fake adapter does: delegate, tripwire, or intercept
 */

/**
 * A two-line sh wrapper that execs an absolute node against a fake module. A
 * `#!/usr/bin/env node` shebang is deliberately avoided: it would add a
 * node-on-PATH dependency, and the uninstall port's stripped-PATH cases
 * (tests/test_uninstall_commands.sh:172-182, :196-198) manipulate PATH on
 * purpose. Paths come from mkdtempSync and process.execPath, so they contain
 * no shell metacharacters.
 * @param {string} dir
 * @param {string} name
 * @param {string} modulePath
 * @param {"codex" | "adapter"} role
 * @returns {string}
 */
function writeFakeBin(dir, name, modulePath, role) {
  const path = join(dir, name);
  writeFileSync(
    path,
    `#!/bin/sh\nexec "${process.execPath}" "${modulePath}" ${role} "$@"\n`,
    { mode: 0o755 },
  );
  return path;
}

/**
 * @param {object} options
 * @param {"install" | "uninstall" | "probe"} options.fakes
 * @param {Record<string, unknown>} [options.config]
 * @param {"delegate" | "tripwire" | "intercept"} [options.adapterSeam]
 * @param {{ reason: "intercept" | "log", script: string }} [options.seamDependency]
 * @returns {CaseEnv}
 */
export function createCase(options) {
  // Eager validation, before anything runs. Validating only inside the fake
  // leaves the guarantee absent in exactly the cases built to make zero fake
  // calls — the missing-python3 case asserts an empty Codex log, so a typo'd
  // key there would otherwise still pass, defeating this design's rationale.
  validateConfig(options.fakes, options.config ?? {});

  // Eager, for the same reason validateConfig above is eager: a case that
  // makes zero adapter calls would otherwise carry a typo'd mode undetected.
  const adapterSeam = options.adapterSeam ?? "delegate";
  if (!SEAM_MODES.includes(adapterSeam)) {
    throw new Error(
      `createCase: unknown adapterSeam ${JSON.stringify(adapterSeam)} — ` +
        `expected one of ${SEAM_MODES.join(", ")}`,
    );
  }
  if (adapterSeam === "intercept" && !options.seamDependency) {
    throw new Error(
      "createCase: adapterSeam 'intercept' requires seamDependency, so the " +
        "case is attributable to a script in SEAM_DEPENDENT",
    );
  }
  if (options.seamDependency) {
    const { reason, script } = options.seamDependency;
    if (!SEAM_REASONS.includes(reason)) {
      throw new Error(
        `createCase: unknown seamDependency reason ${JSON.stringify(reason)}`,
      );
    }
    if (!Object.hasOwn(SEAM_DEPENDENT, script)) {
      throw new Error(
        `createCase: ${script} is not in SEAM_DEPENDENT — declare it there ` +
          "before adding a seam-dependent case, or the gate cannot see it",
      );
    }
    // The converse of the adapterSeam check above, which alone leaves the
    // implication one-directional: a case declaring reason 'intercept' while
    // running in delegate or tripwire mode would silently get no interception,
    // and the registry would over-report its intercept count.
    if (reason === "intercept" && adapterSeam !== "intercept") {
      throw new Error(
        "createCase: seamDependency reason 'intercept' requires adapterSeam " +
          "'intercept'",
      );
    }
  }

  const dir = mkdtempSync(join(SCRATCH, "case-"));
  const pkg = join(dir, "pkg");
  const state = join(dir, "state");
  const tmp = join(dir, "tmp");
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  cpSync(SNAPSHOT, pkg, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  mkdirSync(join(home, ".config"), { recursive: true });
  mkdirSync(bin, { recursive: true });

  writeFileSync(
    join(state, "config.json"),
    `${JSON.stringify(options.config ?? {}, null, 2)}\n`,
  );

  const fakeModule = fileURLToPath(
    new URL(`./${options.fakes}-fakes.js`, import.meta.url),
  );
  const codexBin = writeFakeBin(bin, "codex", fakeModule, "codex");
  const adapterBin = writeFakeBin(bin, "adapter", fakeModule, "adapter");

  return {
    dir,
    pkg,
    state,
    tmp,
    home,
    codexLog: join(state, "codex.log"),
    adapterLog: join(state, "adapter.log"),
    codexBin,
    adapterBin,
    adapterSeam,
  };
}

/**
 * MUST be awaited. `{ concurrency: true }` parallelises subtests only when
 * their bodies yield to the event loop; a synchronous body runs to completion
 * before the next one starts. Measured: four spawnSync subtests take 1.31s,
 * four awaited async spawns take 0.36s. spawnSync here would silently
 * serialise the whole suite while every concurrency option still read as set.
 * @param {CaseEnv} caseEnv
 * @param {"install" | "update" | "prepare" | "uninstall"} script
 * @param {{ env?: Record<string, string>, path?: string }} [options]
 * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
 */
export async function runScript(caseEnv, script, options = {}) {
  // Resolved, segment-aware containment. A lexical startsWith() also accepts
  // a sibling whose name merely extends the scratch path, so it would not
  // actually prevent running a lifecycle script against the real checkout.
  const resolvedPkg = resolve(caseEnv.pkg);
  const resolvedScratch = resolve(SCRATCH);
  if (
    resolvedPkg !== resolvedScratch &&
    !resolvedPkg.startsWith(resolvedScratch + sep)
  ) {
    throw new Error(
      `refusing to run ${script} against a package root outside the fixture scratch tree: ${caseEnv.pkg}`,
    );
  }
  // The runScript-side counterpart of tests/baseline/support.js's
  // assertSeamRetired, added at PR 11.5 slice 4b's flip (Task 8, Step 5b).
  // That guard fires only from runCli / runCliWithoutEnvironment, which is why
  // it did not catch the two UPDATE-CONTROL-01 subcases that reached the dying
  // seam through this function instead. It rejects a CALLER-supplied override
  // only: the fixture's own SPW_ADAPTER below is a surviving default that
  // nothing in-process reads, kept until slice 6 deletes the seam with the
  // fake adapter machinery it selects.
  for (const key of ["SPW_ADAPTER", "SPW_ADAPTER_RESPONSE_VALIDATOR"]) {
    if (options.env && Object.hasOwn(options.env, key)) {
      throw new Error(
        `runScript: ${script}'s adapter seam is retired: remove ${key} from ` +
          "this call. Every command dispatches in-process, so the in-process " +
          "runAdapter ignores it and the override is inert — inject a " +
          "ctx.adapter double instead (tests/bin/command-context.js).",
      );
    }
  }
  // An explicit allowlist, not process.env. The shell drivers used
  // `env VAR=… sh …`, which inherits the developer's whole environment.
  //
  // HOME is case-local, never the developer's: scripts/core/selection.sh:22-28
  // falls back to $HOME/.config/superpowers-manager when neither
  // SUPERPOWERS_CONFIG_DIR nor XDG_CONFIG_HOME is set, so a real HOME lets
  // production read the developer's actual selection state.
  const env = {
    PATH: options.path ?? process.env.PATH ?? "",
    HOME: caseEnv.home,
    XDG_CONFIG_HOME: join(caseEnv.home, ".config"),
    TMPDIR: caseEnv.tmp,
    SPW_ADAPTER: caseEnv.adapterBin,
    // A FIXTURE variable, read only by tests/bin/*-fakes.js. Nothing under
    // src/ may read it: it selects what the fake does, never what the subject
    // does.
    SPW_FIXTURE_ADAPTER_SEAM: caseEnv.adapterSeam,
    SPW_FIXTURE_STATE: caseEnv.state,
    SPW_TEST_PKG_ROOT: caseEnv.pkg,
    SUPERPOWERS_CODEX: caseEnv.codexBin,
    SUPERPOWERS_UPSTREAM_URL: UPSTREAM,
    SUPERPOWERS_INSTALLED_SEARCH_ROOT: join(caseEnv.state, "codex-home"),
    ...options.env,
  };
  // process.execPath, never a bare "node" resolved through the child's PATH:
  // the stripped-PATH cases set PATH to a directory holding only `dirname`,
  // where a bare "node" fails to launch and the case never reaches the
  // assertion it exists to make. process.execPath is absolute, so the argument
  // that made /bin/sh-by-absolute-path correct before slice 4b's flip carries
  // over unchanged to the Node entrypoint.
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      [join(caseEnv.pkg, "bin", "superpowers-manager.js"), script],
      { env },
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
    // A spawn error is a fixture failure, not a subject exit status. Reporting
    // it as a non-zero status would let a case that never launched masquerade
    // as a case that ran and failed.
    child.on("error", (error) => {
      rejectPromise(
        new Error(
          `failed to launch the manager bin for ${script}: ${error.message}`,
        ),
      );
    });
    child.on("close", (code, signal) => {
      if (signal !== null) {
        rejectPromise(new Error(`${script} was killed by signal ${signal}`));
        return;
      }
      resolvePromise({ status: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * @param {string} path
 * @returns {string[]}
 */
export function readLog(path) {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * First occurrence. Mirrors `grep -Fn … | head -n1`
 * (tests/test_install_commands.sh:306).
 * @param {string[]} log
 * @param {string} needle
 * @returns {number}
 */
export function firstIndex(log, needle) {
  return log.findIndex((line) => line.includes(needle));
}

/**
 * Last occurrence. Mirrors `grep -Fn … | tail -n1`
 * (tests/test_install_commands.sh:390, :400-401). Kept separate from
 * firstIndex on purpose: the shell drivers use both, and collapsing them
 * would silently change what several ordering assertions claim.
 * @param {string[]} log
 * @param {string} needle
 * @returns {number}
 */
export function lastIndex(log, needle) {
  let found = -1;
  log.forEach((line, index) => {
    if (line.includes(needle)) found = index;
  });
  return found;
}

/**
 * Asserts each needle appears, and that they appear in the given order by
 * first occurrence. A missing needle is an error, never a pass.
 * @param {string[]} log
 * @param {string[]} needles
 * @param {string} message
 * @returns {void}
 */
export function assertOrder(log, needles, message) {
  const positions = needles.map((needle) => {
    const at = firstIndex(log, needle);
    if (at === -1) {
      throw new Error(
        `${message}: ${JSON.stringify(needle)} never appears in the log:\n${log.join("\n")}`,
      );
    }
    return at;
  });
  for (let i = 1; i < positions.length; i += 1) {
    if (positions[i - 1] >= positions[i]) {
      throw new Error(
        `${message}: out of order — ${JSON.stringify(needles[i - 1])} must precede ${JSON.stringify(needles[i])}:\n${log.join("\n")}`,
      );
    }
  }
}

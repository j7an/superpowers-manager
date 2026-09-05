// Shared builder for the install and uninstall lifecycle ports. Every case
// gets its own package root, state directory, logs, and TMPDIR, so cases run
// concurrently and none depends on another's cleanup. That independence is the
// point: the shell drivers established a scenario's preconditions from an
// unrelated scenario's cleanup twenty lines earlier
// (`git show 81c2de1a9a71699ea340dc8235f9779140f7b3f6:tests/test_install_commands.sh:418-423::established`).

import {
  cpSync,
  existsSync,
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
import { validateConfig } from "./lifecycle-config.ts";
import { registerScratch } from "./fixture-scratch.ts";

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
 */
function buildSnapshot(): string {
  const snapshot = mkdtempSync(join(SCRATCH, "snapshot-"));
  // The snapshot carries the maintained native entry src/cli.ts and its
  // production module graph. runScript launches that source directly.
  for (const entry of ["src", "config"]) {
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

function git(repo: string, args: string[]) {
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
 * across every case: `src/commands/prepare.ts` only ever fetches from it via
 * `src/upstream.ts`'s `fetchExactCommit` and `src/git.ts`, which is
 * read-only on the source, so concurrent cases cannot disturb one another
 * through it. Mirrors `git show 81c2de1a9a71699ea340dc8235f9779140f7b3f6:tests/test_install_commands.sh:51-67::stable`.
 */
function buildUpstream(): string {
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

export type CaseEnv = {
  dir: string;
  pkg: string;
  state: string;
  tmp: string;
  home: string;
  codexLog: string;
  adapterLog: string;
  codexBin: string;
  adapterBin: string;
};

/**
 * A two-line sh wrapper that execs an absolute node against a fake module. A
 * `#!/usr/bin/env node` shebang is deliberately avoided: it would add a
 * node-on-PATH dependency, and the uninstall port's stripped-PATH cases
 * (`git show 81c2de1a9a71699ea340dc8235f9779140f7b3f6:tests/test_uninstall_commands.sh:172-182::no_git_path=`, :196-198) manipulate PATH on
 * purpose. Paths come from mkdtempSync and process.execPath, so they contain
 * no shell metacharacters.
 */
function writeFakeBin(
  dir: string,
  name: string,
  modulePath: string,
  role: "codex" | "adapter",
): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    `#!/bin/sh\nexec "${process.execPath}" "${modulePath}" ${role} "$@"\n`,
    { mode: 0o755 },
  );
  return path;
}

export function createCase(options: {
  fakes: "install" | "uninstall" | "probe";
  config?: Record<string, unknown>;
}): CaseEnv {
  // Eager validation, before anything runs. Validating only inside the fake
  // leaves the guarantee absent in exactly the cases built to make zero fake
  // calls — the missing-python3 case asserts an empty Codex log, so a typo'd
  // key there would otherwise still pass, defeating this design's rationale.
  validateConfig(options.fakes, options.config ?? {});

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
    new URL(`./${options.fakes}-fakes.ts`, import.meta.url),
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
  };
}

function spawnManager(
  executable: string,
  args: string[],
  env: Record<string, string>,
  script: "install" | "update" | "prepare" | "uninstall",
  timeoutMs: number | undefined,
  watchdogArmPath: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ status: number; stdout: string; stderr: string }> {
  const timed = timeoutMs !== undefined;
  const spawnOptions = timed ? { env, detached: true } : { env };
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, spawnOptions);
    const groupPid = timed ? child.pid : undefined;
    let stdout = "";
    let stderr = "";
    let spawned = false;
    let settled = false;
    let killStarted = false;

    let terminationReason: "watchdog" | "abort" | undefined;
    let groupTerminationFailed = false;

    let watchdog: NodeJS.Timeout | undefined;

    let armPoll: NodeJS.Timeout | undefined;

    let abortListener: (() => void) | undefined;

    const clearControls = () => {
      if (watchdog !== undefined) {
        clearTimeout(watchdog);
        watchdog = undefined;
      }
      if (armPoll !== undefined) {
        clearInterval(armPoll);
        armPoll = undefined;
      }
      if (signal !== undefined && abortListener !== undefined) {
        signal.removeEventListener("abort", abortListener);
        abortListener = undefined;
      }
    };

    const errorCode = (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
    const killLeaderFallback = () => {
      groupTerminationFailed = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // The close-path diagnostic below remains hand-written. Never emit a
        // platform error containing raw process details.
      }
      // A descendant can inherit these pipes. If group kill itself failed,
      // close the parent ends so `close` can still reap the leader and report
      // the controlled termination failure.
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const killProcessGroup = () => {
      if (killStarted) return;
      killStarted = true;
      if (groupPid === undefined) {
        killLeaderFallback();
        return;
      }
      try {
        process.kill(-groupPid, "SIGKILL");
      } catch (error) {
        // ESRCH means the group is already gone and `close` is imminent. Any
        // other result takes the bounded, controlled leader/pipes fallback.
        if (errorCode(error) !== "ESRCH") killLeaderFallback();
      }
    };

    const requestTermination = (reason: "watchdog" | "abort") => {
      if (settled || terminationReason !== undefined) return;
      // First reason wins. Never read AbortSignal.reason into a diagnostic.
      terminationReason = reason;
      clearControls();
      if (spawned) killProcessGroup();
    };
    // The arm path is caller-owned. A strict caller can wait for separate fake
    // readiness, validate live identity, and only then publish this path;
    // callers without that extra proof may pass final readiness itself.
    const armWatchdogIfReady = () => {
      if (
        settled ||
        terminationReason !== undefined ||
        watchdog !== undefined ||
        watchdogArmPath === undefined ||
        timeoutMs === undefined ||
        !existsSync(watchdogArmPath)
      ) {
        return;
      }
      if (armPoll !== undefined) {
        clearInterval(armPoll);
        armPoll = undefined;
      }
      watchdog = setTimeout(() => {
        requestTermination("watchdog");
      }, timeoutMs);
    };
    const startArmPolling = () => {
      armWatchdogIfReady();
      if (watchdog === undefined && terminationReason === undefined) {
        armPoll = setInterval(armWatchdogIfReady, 25);
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("spawn", () => {
      spawned = true;
      if (terminationReason !== undefined) killProcessGroup();
      else if (timed) startArmPolling();
    });
    // Spawn error preserves the existing distinction when no child launched.
    child.once("error", (error) => {
      if (settled) return;
      clearControls();
      if (spawned && terminationReason !== undefined) {
        // A kill-race error stays on the termination close path and never
        // overwrites the already-selected fixed reason.
        groupTerminationFailed = true;
        return;
      }
      settled = true;
      rejectPromise(
        new Error(
          `failed to launch the manager bin for ${script}: ${error.message}`,
        ),
      );
    });
    child.once("close", (code, closeSignal) => {
      clearControls();
      if (settled) return;
      if (terminationReason !== undefined) {
        // `close` reaps the direct manager and closes its pipes. A successful
        // negative-PID SIGKILL is authoritative for group termination; whether
        // dead grandchildren remain Z until launchd/init reaps them is external.
        settled = true;
        if (groupTerminationFailed) {
          rejectPromise(
            new Error(
              `${script} fixture watchdog could not terminate its process group`,
            ),
          );
          return;
        }
        const message =
          terminationReason === "watchdog"
            ? `${script} exceeded fixture watchdog after ${timeoutMs}ms`
            : `${script} fixture aborted`;
        rejectPromise(new Error(message));
        return;
      }
      settled = true;
      if (closeSignal !== null) {
        rejectPromise(
          new Error(`${script} was killed by signal ${closeSignal}`),
        );
        return;
      }
      resolvePromise({ status: code ?? -1, stdout, stderr });
    });

    if (signal !== undefined) {
      abortListener = () => requestTermination("abort");
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) requestTermination("abort");
    }
  });
}

/**
 * MUST be awaited. `{ concurrency: true }` parallelises subtests only when
 * their bodies yield to the event loop; a synchronous body runs to completion
 * before the next one starts. Measured: four spawnSync subtests take 1.31s,
 * four awaited async spawns take 0.36s. spawnSync here would silently
 * serialise the whole suite while every concurrency option still read as set.
 */
export async function runScript(
  caseEnv: CaseEnv,
  script: "install" | "update" | "prepare" | "uninstall",
  options: {
    env?: Record<string, string>;
    path?: string;
    timeoutMs?: number;
    watchdogArmPath?: string;
    signal?: AbortSignal;
  } = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  const timeoutMs = options.timeoutMs;
  const watchdogArmPath = options.watchdogArmPath;
  const signal = options.signal;
  const watchdogFields = [
    timeoutMs !== undefined,
    watchdogArmPath !== undefined,
    signal !== undefined,
  ];
  if (watchdogFields.some(Boolean) && !watchdogFields.every(Boolean)) {
    throw new Error(
      "runScript timeoutMs, watchdogArmPath, and signal must be provided together",
    );
  }
  if (
    timeoutMs !== undefined &&
    (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
  ) {
    throw new Error("runScript timeoutMs must be a positive integer");
  }
  if (
    watchdogArmPath !== undefined &&
    (typeof watchdogArmPath !== "string" ||
      watchdogArmPath.length === 0 ||
      resolve(watchdogArmPath) !== watchdogArmPath)
  ) {
    throw new Error(
      "runScript watchdogArmPath must be a nonempty absolute path",
    );
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new Error("runScript signal must be an AbortSignal");
  }
  if (timeoutMs !== undefined && process.platform === "win32") {
    throw new Error("runScript timeoutMs requires POSIX process groups");
  }
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
  // An explicit allowlist, not process.env. The shell drivers used
  // `env VAR=… sh …`, which inherits the developer's whole environment.
  //
  // HOME is case-local, never the developer's: `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/selection.sh:22-28::required`
  // falls back to $HOME/.config/superpowers-manager when neither
  // SUPERPOWERS_CONFIG_DIR nor XDG_CONFIG_HOME is set, so a real HOME lets
  // production read the developer's actual selection state.
  const env = {
    PATH: options.path ?? process.env.PATH ?? "",
    HOME: caseEnv.home,
    XDG_CONFIG_HOME: join(caseEnv.home, ".config"),
    TMPDIR: caseEnv.tmp,
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
  return await spawnManager(
    process.execPath,
    [join(caseEnv.pkg, "src", "cli.ts"), script],
    env,
    script,
    timeoutMs,
    watchdogArmPath,
    signal,
  );
}

export function readLog(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * First occurrence. Mirrors `grep -Fn … | head -n1`
 * (`git show 81c2de1a9a71699ea340dc8235f9779140f7b3f6:tests/test_install_commands.sh:306::grep -Fn "$1" "$log`).
 */
export function firstIndex(log: string[], needle: string): number {
  return log.findIndex((line) => line.includes(needle));
}

/**
 * Last occurrence. Mirrors `grep -Fn … | tail -n1`
 * (`git show 81c2de1a9a71699ea340dc8235f9779140f7b3f6:tests/test_install_commands.sh:390::second_control_line=`, :400-401). Kept separate from
 * firstIndex on purpose: the shell drivers use both, and collapsing them
 * would silently change what several ordering assertions claim.
 */
export function lastIndex(log: string[], needle: string): number {
  let found = -1;
  log.forEach((line, index) => {
    if (line.includes(needle)) found = index;
  });
  return found;
}

/**
 * Asserts each needle appears, and that they appear in the given order by
 * first occurrence. A missing needle is an error, never a pass.
 */
export function assertOrder(
  log: string[],
  needles: string[],
  message: string,
): void {
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

/**
 * Invokes a case's own fake adapter directly — the executable a regressed
 * subject would have spawned, with the state and package root that case runs
 * under.
 *
 * Why a tripwire case needs it. `readLog` returns `[]` for a missing file, so
 * "the adapter log holds no line" is the same observation whether the subject
 * refused to spawn the fake or the log path was never the one the fake writes
 * to (the argument at tests/migration-inventory/install-commands.md's
 * port-only preamble). Post-flip nothing the subject does can produce a
 * positive control on that channel, because the subject calls runAdapter
 * in-process and never spawns anything. This supplies the control from the
 * other side: run the fake adapter for real, and assert it refuses with the
 * tripwire's own exit status and message and that the refusal lands in
 * caseEnv.adapterLog. A caller that asserts both halves fails if the tripwire
 * stops firing, which the emptiness assertion alone cannot do.
 *
 * The fake process reads exactly two variables as fixture inputs —
 * SPW_FIXTURE_STATE (`runFake` in lifecycle-fakes.js) and SPW_TEST_PKG_ROOT
 * (`runCodex` in install-fakes.js, the codex role only). Five of the six
 * remaining keys are not fixture inputs at all: HOME, XDG_CONFIG_HOME, TMPDIR,
 * SUPERPOWERS_CODEX and SUPERPOWERS_INSTALLED_SEARCH_ROOT contain the spawned
 * PROCESS inside the case's own scratch tree rather than the developer's
 * environment, which holds whether or not anything reads them. PATH is the
 * sixth, and the one deliberate ambient pass-through: it copies the
 * developer's PATH through verbatim and points nowhere in the scratch tree.
 * Nothing is launched through it either — writeFakeBin writes
 * `exec "<process.execPath>"`, an absolute node.
 *
 * It is spelled out here rather than shared with runScript's literal because
 * extracting a common builder renumbers lines other files cite; divergence
 * fails closed, since the caller asserts an exact status and an exact stderr
 * rather than a substring.
 *
 */
export function spawnFakeAdapter(
  caseEnv: CaseEnv,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(caseEnv.adapterBin, args, {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: caseEnv.home,
      XDG_CONFIG_HOME: join(caseEnv.home, ".config"),
      TMPDIR: caseEnv.tmp,
      SPW_FIXTURE_STATE: caseEnv.state,
      SPW_TEST_PKG_ROOT: caseEnv.pkg,
      SUPERPOWERS_CODEX: caseEnv.codexBin,
      SUPERPOWERS_INSTALLED_SEARCH_ROOT: join(caseEnv.state, "codex-home"),
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

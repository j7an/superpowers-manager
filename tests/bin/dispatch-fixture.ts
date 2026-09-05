// Shared base package root plus per-case PATH overlays for the bin-dispatch
// port. The expensive operation (copying the real src/) happens once; each
// case states the tool set it needs at the assertion rather than inheriting it
// from a mutation twenty lines earlier.
//
// The base is shared but NOT literally immutable, and has not been since PR
// 11.5 slice 3.4 flipped `prepare` in-process. The `scripts` and
// `missingScripts` per-case copy options went away with the scripts tree in
// slice 4c. The subject under test still writes into the base: runPrepare's
// gatherPrepare resolves `<root>/plugins/superpowers`, mkdirs its parent, and
// opens a `.superpowers.prepare.*` workspace there, all before
// computeEffectiveSelection runs.
// Every `prepare` case that clears preflight therefore leaves an empty
// `<PACKAGE_ROOT>/plugins/` behind -- three of the four. The exception is the
// `SUPERPOWERS_VALIDATOR` case, which withholds `python3` so that preflight
// rejects the command and gatherPrepare never runs; its exact-equality stderr
// assertion admits only the preflight diagnostic, which is what pins that
// ordering down. That residue is inert: nothing in this file or in
// bin-dispatch.test.js reads the path, withWorkspace removes its own
// directory, the fakeBin `git` stub kills the run at ref resolution before
// the clone and before the `.cache/` mkdir, and the per-case cpSync copies
// the empty directory along harmlessly. Restoring literal immutability would
// mean a private root for every prepare case -- more cost than the residue is
// worth. Revisit if a case ever asserts on the base root's contents.

import {
  accessSync,
  constants,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerScratch } from "./fixture-scratch.ts";
import { shQuote, writeGitEgressShim } from "../lib/git-egress.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// Matches every other suite's convention (e.g. action-pins.test.js,
// node-tooling.test.js): os.tmpdir() honors TMPDIR when set, and
// mkdtempSync supplies the uniqueness that makes this hermetic.
const SCRATCH = mkdtempSync(join(tmpdir(), "spw-dispatch-"));
registerScratch(SCRATCH);

// Resolves a real, functioning host tool by name, searching this process's
// own (ambient, unrestricted) PATH — never a case's fakeBin, which only ever
// contains "exit 0" stubs. Mirrors tests/baseline/support.js's
// hostExecutable, kept as its own small copy here rather than imported: that
// module's version also special-cases `python3`, which nothing in this file
// needs.

function hostExecutable(name: string) {
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking through the host PATH used only to build this fixture.
    }
  }
  throw new Error(`host tool not found on PATH: ${name}`);
}

// `pin` (unlike every other in-process command flipped so far) shells out to
// a real `git` to resolve its requested ref (src/upstream.ts's
// resolveExactTag/verifyRawCommit): the "exit 0" stubs every other case in
// this file uses for preflight-only tool checks cannot make that resolution
// succeed, no matter what pin is asked to resolve. A pin dispatch case that
// needs to actually succeed therefore needs a real, functioning `git` and a
// real local upstream repository
// (tests/builders/baseline-scenario.sh's `git-release-repo`, which tags
// `v1.0.0`) for that git to resolve against. This stays hermetic: the
// upstream is a filesystem path, never a network URL, and it is built once,
// via this test process's own ambient environment (real `git`/`sh`, not a
// case's fakeBin), exactly as tests/baseline/support.js's
// createReleaseRepo/runScenario build the same scenario for the baseline
// suite.
const REAL_GIT = hostExecutable("git");

const PIN_UPSTREAM = join(SCRATCH, "pin-upstream");
{
  const built = spawnSync(
    "sh",
    [
      join(ROOT, "tests", "builders", "baseline-scenario.sh"),
      "git-release-repo",
      PIN_UPSTREAM,
    ],
    { encoding: "utf8" },
  );
  if (built.status !== 0) {
    throw new Error(
      `cannot build the pin dispatch fixture's upstream repository: ${built.stderr}`,
    );
  }
}

function writeExecutable(dir: string, name: string, body: string) {
  const path = join(dir, name);
  writeFileSync(path, body, { mode: 0o755 });
  return path;
}

// `patchDispatch` and the `dispatchOverride` option stood here until PR 11.5
// slice 4b (Task 8, Step 5a). They existed to put one command into a DISPATCH
// state src/cli.ts's IN_PROCESS_HANDLERS registry does not carry, by rewriting
// a "spawn" mode literal to "in-process" in a case-local copy of the compiled
// table. With DISPATCH at 8/8 in-process there was no "spawn" literal to
// rewrite and `patchDispatch` rejected a no-op override by design, so the
// mechanism could not construct that state at all. Its one consumer retired
// with it; the only other test that used it tested the fixture itself.

/** Copy source and optionally inject an import failure without changing exports. */
function buildPackageRoot(kind: "real" | "throwing"): string {
  const root = mkdtempSync(join(SCRATCH, `pkg-${kind}-`));
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "superpowers-manager", version: "9.9.9-test", type: "module" })}\n`,
  );
  cpSync(join(ROOT, "src"), join(root, "src"), { recursive: true });
  // In-process commands resolve the package's upstream ref from this file.
  mkdirSync(join(root, "config"), { recursive: true });
  cpSync(
    join(ROOT, "config", "upstream-ref"),
    join(root, "config", "upstream-ref"),
  );
  if (kind === "throwing") {
    const modulePath = join(root, "src", "cli-arguments.ts");
    writeFileSync(
      modulePath,
      'throw new Error("synthetic source import failure");\n' +
        readFileSync(modulePath, "utf8"),
    );
  }
  return root;
}

/** The shared base carries the real native source. */
export const PACKAGE_ROOT = buildPackageRoot("real");

/**
 * An independent native package root for direct launcher cases.
 */
export function makePackageRoot(kind: "real" | "throwing"): string {
  return buildPackageRoot(kind);
}

export type DispatchOptions = {
  tools: string[];
  args: string[];
  env?: Record<string, string>;
  packageRoot?: string;
  viaSymlink?: boolean;
  omitShell?: boolean;
  pinUpstream?: boolean;
  gitSentinel?: boolean;
};

export function runDispatch(options: DispatchOptions): {
  status: number;
  stdout: string;
  stderr: string;
  gitSentinel: string;
} {
  const caseDir = mkdtempSync(join(SCRATCH, "case-"));
  const fakeBin = join(caseDir, "bin");
  mkdirSync(fakeBin, { recursive: true });
  let sentinelPath = "";
  for (const tool of options.tools) {
    writeExecutable(fakeBin, tool, "#!/bin/sh\nexit 0\n");
  }
  if (options.pinUpstream) {
    if (options.tools.includes("git")) {
      throw new Error(
        "pinUpstream already supplies a real git; do not also list it in tools",
      );
    }
    // The shim, not a symlink to REAL_GIT. Matrix row 13: the symlink put a
    // real git in the case bin outside the only egress refusal this repository
    // has, and slice 4b adds three more commands to this fixture.
    //
    // gitSentinel inserts a recording stub between the shim and the real git,
    // so a case can prove the refusal happened BEFORE git ran rather than
    // merely that the command failed.
    let wrapped = REAL_GIT;
    if (options.gitSentinel) {
      sentinelPath = join(caseDir, "git-sentinel.log");
      writeFileSync(sentinelPath, "");
      wrapped = writeExecutable(
        caseDir,
        "git-recording",
        [
          "#!/bin/sh",
          `printf '%s\\n' "$*" >> ${shQuote(sentinelPath)}`,
          `exec ${shQuote(REAL_GIT)} "$@"`,
          "",
        ].join("\n"),
      );
    }
    writeGitEgressShim(fakeBin, wrapped);
  }
  if (!options.omitShell) symlinkSync("/bin/sh", join(fakeBin, "sh"));
  symlinkSync(process.execPath, join(fakeBin, "node"));

  // In-process commands (e.g. unpin) resolve their selection-state path via
  // src/effective-selection.ts's selectionConfigDir, which requires
  // SUPERPOWERS_CONFIG_DIR, XDG_CONFIG_HOME, or HOME. None of those are ever
  // otherwise set here, so every case gets a private, empty config dir rather
  // than each in-process case having to supply one itself.
  const configDir = join(caseDir, "config");
  mkdirSync(configDir, { recursive: true });

  const packageRoot = options.packageRoot ?? PACKAGE_ROOT;

  const entry = join(packageRoot, "src", "cli.ts");
  let target = entry;
  if (options.viaSymlink) {
    target = join(caseDir, "superpowers-manager");
    symlinkSync(entry, target);
  }

  const result = spawnSync(join(fakeBin, "node"), [target, ...options.args], {
    encoding: "utf8",
    env: {
      PATH: fakeBin,
      SUPERPOWERS_CONFIG_DIR: configDir,
      ...(options.pinUpstream
        ? { SUPERPOWERS_UPSTREAM_URL: PIN_UPSTREAM }
        : {}),
      ...options.env,
    },
  });

  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    gitSentinel: sentinelPath,
  };
}

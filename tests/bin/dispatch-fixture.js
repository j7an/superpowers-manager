// @ts-check
// Shared base package root plus per-case PATH overlays for the bin-dispatch
// port. The expensive operation (copying the real dist/) happens once; the
// state a case configures (a directory of two-line stub scripts) is per case
// and declarative, so each case states the tool set it needs at the assertion
// rather than inheriting it from a mutation twenty lines earlier.
//
// The base is shared but NOT literally immutable, and has not been since PR
// 11.5 slice 3.4 flipped `prepare` in-process. No case configures the base --
// `scripts`, `missingScripts`, and `dispatchOverride` still take a per-case
// copy -- but the subject under test now writes into it: runPrepare's
// gatherPrepare resolves `<root>/plugins/superpowers`, mkdirs its parent, and
// opens a `.superpowers.prepare.*` workspace there, all at
// src/commands/prepare.ts:274-281 and all BEFORE computeEffectiveSelection.
// Every `prepare` case therefore leaves an empty `<PACKAGE_ROOT>/plugins/`
// behind. That residue is inert: nothing in this file or in
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
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// Matches every other suite's convention (e.g. action-pins.test.js,
// node-tooling.test.js): os.tmpdir() honors TMPDIR when set, and
// mkdtempSync supplies the uniqueness that makes this hermetic.
const SCRATCH = mkdtempSync(join(tmpdir(), "spw-dispatch-"));
process.on("exit", () => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

// Resolves a real, functioning host tool by name, searching this process's
// own (ambient, unrestricted) PATH — never a case's fakeBin, which only ever
// contains "exit 0" stubs. Mirrors tests/baseline/support.js's
// hostExecutable, kept as its own small copy here rather than imported: that
// module's version also special-cases `python3`, which nothing in this file
// needs.
/** @param {string} name */
function hostExecutable(name) {
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

/** @type {typeof import("../../src/cli.js")} */
const { DISPATCH } = await import(
  new URL("../../dist/cli.js", import.meta.url).href
);

// Exported so bin-dispatch.test.js can derive its vehicle command without a
// second dynamic `dist/cli.js` import, which would recreate the drift the
// derivations in this file remove.
export { DISPATCH };

/**
 * The subcommands the real bin dispatches to. Derived, never restated: a
 * third hand-maintained copy of the eight names can agree with itself while
 * disagreeing with the code it describes.
 */
export const DISPATCH_COMMANDS = /** @type {(keyof typeof DISPATCH)[]} */ (
  Object.keys(DISPATCH)
);

/**
 * The subset the real bin still spawns. Exported here so
 * tests/bin/bin-dispatch.test.js can size ROUTING_CASES from production
 * instead of a literal — it imports only from this fixture today, and adding
 * a second dynamic `dist/cli.js` import there would recreate the drift this
 * derivation removes.
 */
export const SPAWN_COMMANDS = DISPATCH_COMMANDS.filter(
  (command) => DISPATCH[command] === "spawn",
);

/**
 * A stub script that appends its invocation to $SPW_DISPATCH_LOG. Mirrors the
 * shell fixture at tests/test_bin_dispatch.sh:19-26.
 * @param {string} command
 */
function loggingStub(command) {
  return [
    "#!/bin/sh",
    `printf '%s\\n' "${command} $* ref=\${SUPERPOWERS_REF:-}" >> "$SPW_DISPATCH_LOG"`,
    'if [ -n "${SUPERPOWERS_VALIDATOR:-}" ]; then',
    `  printf '%s\\n' "${command} validator=\${SUPERPOWERS_VALIDATOR}" >> "$SPW_DISPATCH_LOG"`,
    "fi",
    "exit 0",
    "",
  ].join("\n");
}

/**
 * @param {string} dir
 * @param {string} name
 * @param {string} body
 */
function writeExecutable(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, body, { mode: 0o755 });
  return path;
}

/**
 * Patches a case-local copy of dist/cli.js's compiled DISPATCH table —
 * never the shared dist/ this fixture copies from, and never src/cli.ts.
 * Used to simulate a DISPATCH entry the real IN_PROCESS_HANDLERS registry
 * does not carry: src/cli.ts's exhaustiveness check makes that state
 * unreachable through the real table, so this is the only way to exercise
 * the runtime backstop that remains for it.
 * @param {string} cliPath
 * @param {Record<string, "spawn" | "in-process">} overrides
 */
function patchDispatch(cliPath, overrides) {
  let text = readFileSync(cliPath, "utf8");
  for (const [command, mode] of Object.entries(overrides)) {
    // The leading negative lookbehind anchors the key: without it, `pin`
    // matches inside `unpin:` too (`pin` is a suffix of `unpin`), and
    // `String.match` silently returns whichever entry sorts first in the
    // table instead of throwing "no DISPATCH entry found".
    const pattern = new RegExp(
      `(?<![\\w$])(["']?${command}["']?:\\s*)"(spawn|in-process)"`,
    );
    const match = text.match(pattern);
    if (!match) {
      throw new Error(
        `dispatchOverride: no DISPATCH entry found for "${command}" in ${cliPath}`,
      );
    }
    if (match[2] === mode) {
      throw new Error(
        `dispatchOverride: "${command}" is already "${mode}" in ${cliPath}; ` +
          "an override that changes nothing is a vehicle that cannot fail",
      );
    }
    text = text.replace(pattern, `$1"${mode}"`);
  }
  writeFileSync(cliPath, text, "utf8");
}

/**
 * @param {string} kind "real" copies the built dist/, "none" omits it,
 *   "throwing" installs a cli.js that throws on import.
 * @returns {string} absolute path to a package root
 */
function buildPackageRoot(kind) {
  const root = mkdtempSync(join(SCRATCH, `pkg-${kind}-`));
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "superpowers-manager", version: "9.9.9-test", type: "module" })}\n`,
  );
  cpSync(
    join(ROOT, "bin", "superpowers-manager.js"),
    join(root, "bin", "superpowers-manager.js"),
  );
  // In-process commands (e.g. unpin) resolve the packaged upstream ref from
  // <root>/config/upstream-ref via src/upstream.ts's readConfigRef. Copy the
  // real file so the fixture cannot drift from the shipped default.
  mkdirSync(join(root, "config"), { recursive: true });
  cpSync(
    join(ROOT, "config", "upstream-ref"),
    join(root, "config", "upstream-ref"),
  );
  for (const command of DISPATCH_COMMANDS) {
    writeExecutable(join(root, "scripts"), command, loggingStub(command));
  }
  if (kind === "real") {
    // Read-only, from the real working tree, exactly as the shell driver did
    // (tests/test_bin_dispatch.sh:69). tests/run-node-suites.js already fails
    // closed on a missing or stale dist/ (:31, :49, :68).
    cpSync(join(ROOT, "dist"), join(root, "dist"), { recursive: true });
  } else if (kind === "throwing") {
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(
      join(root, "dist", "cli.js"),
      'throw new Error("synthetic dist import failure");\n',
    );
  }
  return root;
}

/** The shared base: real bin, real dist, logging stubs for every subcommand. */
export const PACKAGE_ROOT = buildPackageRoot("real");

/**
 * A package root in a degenerate dist/ state. Neither needs the real build.
 * @param {"none" | "throwing"} kind
 */
export function makePackageRoot(kind) {
  return buildPackageRoot(kind);
}

/**
 * @typedef {object} DispatchOptions
 * @property {string[]} tools tools present on PATH. `sh` and `node` are always
 *   added — src/cli.ts:247-255 resolves `sh` as a required tool, so its
 *   presence is itself under test and must be stated, not assumed absent. Set
 *   `omitShell` to state its absence instead.
 * @property {string[]} args argv passed to the bin
 * @property {Record<string, string>} [env] extra environment variables
 * @property {Record<string, string>} [scripts] scripts/<name> bodies to override
 * @property {string[]} [missingScripts] scripts/<name> files to remove
 * @property {string} [packageRoot] defaults to PACKAGE_ROOT
 * @property {boolean} [viaSymlink] invoke through a symlink to the bin, as npx does
 * @property {boolean} [omitShell] skip the always-on `sh` symlink so a case can
 *   state that no POSIX shell is on PATH, rather than have it assumed absent.
 *   Scoped to the one case that needs it — every other case keeps `sh` present
 *   by default so its presence remains stated, not assumed.
 * @property {boolean} [pinUpstream] add a real, functioning `git` to `fakeBin`
 *   (composing with `tools`, never replacing PATH) and point
 *   SUPERPOWERS_UPSTREAM_URL at a real local upstream with a `v1.0.0` tag —
 *   for the one command whose success genuinely depends on git actually
 *   resolving something. `git` must not also appear in `tools` when this is
 *   set. Every other tool's presence or absence is still stated by `tools`
 *   exactly as the file header promises.
 * @property {Record<string, "spawn" | "in-process">} [dispatchOverride]
 *   patches the case-local copy of dist/cli.js's compiled DISPATCH table for
 *   the named commands — never the real src/cli.ts. The only way to put a
 *   command into a DISPATCH state src/cli.ts's IN_PROCESS_HANDLERS registry
 *   does not carry, which is otherwise a compile error and thus unreachable
 *   through the real table.
 */

/**
 * @param {DispatchOptions} options
 * @returns {{ status: number, stdout: string, stderr: string, log: string[] }}
 */
export function runDispatch(options) {
  const caseDir = mkdtempSync(join(SCRATCH, "case-"));
  const fakeBin = join(caseDir, "bin");
  mkdirSync(fakeBin, { recursive: true });
  for (const tool of options.tools) {
    writeExecutable(fakeBin, tool, "#!/bin/sh\nexit 0\n");
  }
  if (options.pinUpstream) {
    if (options.tools.includes("git")) {
      throw new Error(
        "pinUpstream already supplies a real git; do not also list it in tools",
      );
    }
    symlinkSync(REAL_GIT, join(fakeBin, "git"));
  }
  if (!options.omitShell) symlinkSync("/bin/sh", join(fakeBin, "sh"));
  symlinkSync(process.execPath, join(fakeBin, "node"));

  const logPath = join(caseDir, "dispatch.log");
  writeFileSync(logPath, "");

  // In-process commands (e.g. unpin) resolve their selection-state path via
  // src/effective-selection.ts's selectionConfigDir, which requires
  // SUPERPOWERS_CONFIG_DIR, XDG_CONFIG_HOME, or HOME. None of those are ever
  // otherwise set here, so every case gets a private, empty config dir —
  // mirroring SPW_DISPATCH_LOG's always-set pattern — rather than each
  // in-process case having to supply one itself.
  const configDir = join(caseDir, "config");
  mkdirSync(configDir, { recursive: true });

  let packageRoot = options.packageRoot ?? PACKAGE_ROOT;
  if (options.scripts || options.missingScripts || options.dispatchOverride) {
    // Overrides mutate scripts/ or dist/, so this case gets its own copy of
    // the root rather than editing the shared base out from under other
    // cases.
    const copy = join(caseDir, "pkg");
    cpSync(packageRoot, copy, { recursive: true });
    for (const [name, body] of Object.entries(options.scripts ?? {})) {
      writeExecutable(join(copy, "scripts"), name, body);
    }
    for (const name of options.missingScripts ?? []) {
      rmSync(join(copy, "scripts", name), { force: true });
    }
    if (options.dispatchOverride) {
      patchDispatch(join(copy, "dist", "cli.js"), options.dispatchOverride);
    }
    packageRoot = copy;
  }

  const entry = join(packageRoot, "bin", "superpowers-manager.js");
  let target = entry;
  if (options.viaSymlink) {
    target = join(caseDir, "superpowers-manager");
    symlinkSync(entry, target);
  }

  const result = spawnSync(join(fakeBin, "node"), [target, ...options.args], {
    encoding: "utf8",
    env: {
      PATH: fakeBin,
      SPW_DISPATCH_LOG: logPath,
      SUPERPOWERS_CONFIG_DIR: configDir,
      ...(options.pinUpstream
        ? { SUPERPOWERS_UPSTREAM_URL: PIN_UPSTREAM }
        : {}),
      ...options.env,
    },
  });

  const log = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    log,
  };
}

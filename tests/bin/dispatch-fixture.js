// @ts-check
// Shared, immutable base package root plus per-case PATH overlays for the
// bin-dispatch port. The expensive operation (copying the real dist/) happens
// once; the mutated state (a directory of two-line stub scripts) is per case
// and declarative, so each case states the tool set it needs at the assertion
// rather than inheriting it from a mutation twenty lines earlier.

import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// ${TMPDIR:?} with no fallback: os.tmpdir() would silently substitute /tmp when
// TMPDIR is unset, which is the hardcoded path the hermetic-test rule forbids.
// An unset TMPDIR must fail loudly here.
const TMPDIR = process.env.TMPDIR;
if (TMPDIR === undefined || TMPDIR === "") {
  throw new Error(
    "TMPDIR must be set — this fixture will not fall back to /tmp",
  );
}
const SCRATCH = mkdtempSync(join(TMPDIR, "spw-dispatch-"));
process.on("exit", () => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

/** The subcommands the real bin dispatches to. */
export const DISPATCH_COMMANDS = [
  "pin",
  "track-latest",
  "unpin",
  "prepare",
  "probe",
  "install",
  "update",
  "uninstall",
];

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
 *   added — src/cli.ts:206 resolves `sh` as a required tool, so its presence is
 *   itself under test and must be stated, not assumed absent.
 * @property {string[]} args argv passed to the bin
 * @property {Record<string, string>} [env] extra environment variables
 * @property {Record<string, string>} [scripts] scripts/<name> bodies to override
 * @property {string[]} [missingScripts] scripts/<name> files to remove
 * @property {string} [packageRoot] defaults to PACKAGE_ROOT
 * @property {boolean} [viaSymlink] invoke through a symlink to the bin, as npx does
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
  symlinkSync("/bin/sh", join(fakeBin, "sh"));
  symlinkSync(process.execPath, join(fakeBin, "node"));

  const logPath = join(caseDir, "dispatch.log");
  writeFileSync(logPath, "");

  let packageRoot = options.packageRoot ?? PACKAGE_ROOT;
  if (options.scripts || options.missingScripts) {
    // Overrides mutate scripts/, so this case gets its own copy of the root
    // rather than editing the shared base out from under other cases.
    const copy = join(caseDir, "pkg");
    cpSync(packageRoot, copy, { recursive: true });
    for (const [name, body] of Object.entries(options.scripts ?? {})) {
      writeExecutable(join(copy, "scripts"), name, body);
    }
    for (const name of options.missingScripts ?? []) {
      rmSync(join(copy, "scripts", name), { force: true });
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

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { runAdapter } from "./adapter.js";
import { oneLine } from "./cli-arguments.js";
import type { CommandContext } from "./commands/context.js";
import { runPin } from "./commands/pin.js";
import { runPrepare } from "./commands/prepare.js";
import { runProbe } from "./commands/probe.js";
import { runTrackLatest } from "./commands/track-latest.js";
import { runUnpin } from "./commands/unpin.js";
import { COMMIT_INPUT_RE, TAG_RE } from "./domain/refs.js";

type Subcommand =
  | "pin"
  | "track-latest"
  | "unpin"
  | "prepare"
  | "probe"
  | "install"
  | "update"
  | "uninstall";

type RunParseResult = {
  kind: "run";
  cmd: Subcommand;
  args: string[];
};
type HelpParseResult = { kind: "help" };
type VersionParseResult = { kind: "version" };
type UsageErrorParseResult = {
  kind: "usage-error";
  message: string;
};
type ParseResult =
  RunParseResult | HelpParseResult | VersionParseResult | UsageErrorParseResult;

// The success variant is keyed by dispatch mode so the compiler — not a
// runtime check — enforces that `shell` exists only where it was actually
// discovered. A later slice that flips a `DISPATCH` entry before wiring its
// in-process handler cannot reach `pf.shell` by accident.
type PreflightResult =
  | { ok: true; dispatch: "spawn"; shell: string }
  | { ok: true; dispatch: "in-process" }
  | { ok: false; errors: string[] };

type SpawnDescriptor = {
  file: string;
  argv: string[];
};

const SUBCOMMANDS: readonly Subcommand[] = [
  "pin",
  "track-latest",
  "unpin",
  "prepare",
  "probe",
  "install",
  "update",
  "uninstall",
];

export type DispatchMode = "spawn" | "in-process";

// The PR 11.5 migration state, in production code because `preflight` reads it:
// a POSIX shell is required only while a command is still spawned. Each slice
// flips entries to "in-process"; when none remain, `buildSpawn`,
// `discoverShell`, and this table are deleted together.
const DISPATCH = {
  pin: "in-process",
  "track-latest": "in-process",
  unpin: "in-process",
  prepare: "in-process",
  probe: "in-process",
  install: "spawn",
  update: "spawn",
  uninstall: "spawn",
} as const satisfies Record<Subcommand, DispatchMode>;

type InProcessCommand = {
  [K in Subcommand]: (typeof DISPATCH)[K] extends "in-process" ? K : never;
}[Subcommand];

type InProcessHandler = (
  argv: string[],
  ctx: CommandContext,
) => Promise<number>;

// Keyed by exactly the DISPATCH entries that read "in-process". Flipping an
// entry without registering its handler is now a compile error, not a
// runtime surprise. Requires DISPATCH to be declared `as const` so its value
// types are literals rather than widened to DispatchMode.
const IN_PROCESS_HANDLERS: Record<InProcessCommand, InProcessHandler> = {
  pin: runPin,
  "track-latest": runTrackLatest,
  unpin: runUnpin,
  prepare: runPrepare,
  probe: runProbe,
};
const COMMAND_REQUIREMENTS: Record<Subcommand, string[]> = {
  pin: ["git"],
  "track-latest": [],
  unpin: [],
  prepare: ["git"],
  probe: ["git", "codex"],
  install: ["git", "python3", "codex"],
  update: ["git", "python3", "codex"],
  uninstall: ["python3", "codex"],
};
// Mirrors upstream Superpowers' hooks/run-hook.cmd discovery order.
const GIT_BASH_CANDIDATES = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
];

// Walk upward from the bin's physical location to the directory containing
// package.json. realpathSync first: npm/npx expose the bin through a symlink
// or shim outside the package root.
function resolvePackageRoot(scriptPath: string): string | null {
  let dir: string;
  try {
    dir = path.dirname(fs.realpathSync(scriptPath));
  } catch {
    return null;
  }
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isMain(moduleFilename: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  return moduleFilename === fs.realpathSync(argvPath);
}

function parseArgs(argv: string[]): ParseResult {
  const first = argv[0];
  if (argv.length === 0) return { kind: "run", cmd: "update", args: [] };
  if (first === "--help" || first === "-h") return { kind: "help" };
  if (first === "--version") return { kind: "version" };
  if (first && SUBCOMMANDS.includes(first as Subcommand)) {
    const command = first as Subcommand;
    const args = argv.slice(1);
    if (command === "pin" && args.length !== 1) {
      return {
        kind: "usage-error",
        message: "usage: superpowers-manager pin REF",
      };
    }
    if (
      command === "pin" &&
      !TAG_RE.test(args[0]!) &&
      !COMMIT_INPUT_RE.test(args[0]!)
    ) {
      return {
        kind: "usage-error",
        message:
          "pin REF must be an exact v-prefixed SemVer tag or full 40-hex commit",
      };
    }
    if (
      (command === "track-latest" || command === "unpin") &&
      args.length !== 0
    ) {
      return {
        kind: "usage-error",
        message: `usage: superpowers-manager ${command}`,
      };
    }
    // Arity lives HERE, not only in src/commands/probe.ts, so `probe` gets the
    // same shape as every other CLI-owned usage error: `error: <msg>` plus the
    // full usage block, exit 2, decided before preflight. Leaving it to the
    // handler alone made `probe --porcelaine` print no usage block, and made
    // the identical input exit 1 on a machine without `codex` because preflight
    // ran first. `PROBE_USAGE` stays as the same unreachable-from-CLI duplicate
    // that track-latest and unpin already carry.
    if (
      command === "probe" &&
      !(args.length === 0 || (args.length === 1 && args[0] === "--porcelain"))
    ) {
      return {
        kind: "usage-error",
        message: "usage: superpowers-manager probe [--porcelain]",
      };
    }
    return { kind: "run", cmd: command, args };
  }
  return { kind: "usage-error", message: `unknown subcommand: ${first}` };
}

// Search env.PATH for an executable named `name`; on win32 also try PATHEXT
// extensions. Returns the full path or null.
function findTool(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | null {
  const pathVar = env.PATH || env.Path || "";
  const dirs = pathVar.split(path.delimiter).filter(Boolean);
  const exts =
    platform === "win32"
      ? (env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

// POSIX: `sh` on PATH. Windows: Git Bash at its standard install paths,
// then `bash` on PATH.
function discoverShell(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | null {
  if (platform !== "win32") return findTool("sh", env, platform);
  for (const candidate of GIT_BASH_CANDIDATES) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return findTool("bash", env, platform);
}

// python3 is required by `prepare` only when SUPERPOWERS_VALIDATOR names one:
// after the port, that optional spawn (src/commands/prepare.ts:221) is Python's
// only remaining consumer on the prepare path. The conditional lives here, in
// the accessor preflight reads, rather than inside preflight — an accessor that
// under-reports what preflight enforces is the blind spot slice 2 closed when
// it made CLI-PREFLIGHT-01 derive its map from production.
function commandRequirements(
  env: NodeJS.ProcessEnv,
): Record<Subcommand, string[]> {
  if (!env.SUPERPOWERS_VALIDATOR) return COMMAND_REQUIREMENTS;
  return {
    ...COMMAND_REQUIREMENTS,
    prepare: [...COMMAND_REQUIREMENTS.prepare, "python3"],
  };
}

// Tool preflight; never touches Codex state. Requirements are specific to the
// selected command; a POSIX shell is required only for commands the DISPATCH
// gate still spawns, not for in-process commands.
function preflight(
  cmd: Subcommand,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): PreflightResult {
  const errors: string[] = [];
  for (const tool of commandRequirements(env)[cmd]) {
    if (tool === "codex") {
      const codexBin = env.SUPERPOWERS_CODEX || "codex";
      // An explicit override may be a path rather than a PATH-resolvable name.
      const found = codexBin.includes(path.sep)
        ? fs.existsSync(codexBin)
        : Boolean(findTool(codexBin, env, platform));
      if (!found) {
        errors.push(
          `required command not found: ${codexBin} — install the Codex CLI or set SUPERPOWERS_CODEX`,
        );
      }
    } else if (!findTool(tool, env, platform)) {
      errors.push(
        `required command not found: ${tool} — install ${tool} and re-run`,
      );
    }
  }
  if (DISPATCH[cmd] !== "spawn") {
    if (errors.length) return { ok: false, errors };
    return { ok: true, dispatch: "in-process" };
  }
  const shell = discoverShell(env, platform);
  if (!shell) {
    errors.push(
      platform === "win32"
        ? "no POSIX shell found — install Git for Windows (provides bash) or use WSL2"
        : "required command not found: sh",
    );
    return { ok: false, errors };
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, dispatch: "spawn", shell };
}

// POSIX executes the script directly (#!/bin/sh shebang); Windows cannot
// spawn extensionless scripts, so the discovered shell runs the script as
// its first argument.
function buildSpawn(
  cmd: Subcommand,
  args: string[],
  root: string,
  shell: string,
  platform: NodeJS.Platform,
): SpawnDescriptor {
  const script = path.join(root, "scripts", cmd);
  if (platform === "win32") {
    return { file: shell, argv: [script, ...args] };
  }
  return { file: script, argv: args };
}

function usage(): string {
  return [
    "usage: superpowers-manager [command] [args...]",
    "",
    "Selection commands (save intent only; they do not prepare or install it):",
    "  pin REF       save an exact upstream release tag or commit",
    "  track-latest  save selection of the latest stable upstream release",
    "  unpin         remove the saved selection and return to the packaged fallback",
    "",
    "Apply and lifecycle commands:",
    "  prepare    fetch the pinned upstream ref and generate the plugin tree",
    "  probe      report upstream/generated/installed status (accepts --porcelain)",
    "  install    register this package root as a Codex marketplace and install the plugin",
    "  update     probe, then prepare/install only if needed (default when no subcommand)",
    "  uninstall  remove the manager plugin and marketplace from Codex",
    "",
    "Environment overrides (passed through to the scripts): SUPERPOWERS_REF,",
    "SUPERPOWERS_UPSTREAM_URL, SUPERPOWERS_CODEX, SUPERPOWERS_CACHE_DIR,",
    "SUPERPOWERS_CONFIG_DIR, XDG_CONFIG_HOME,",
    "SUPERPOWERS_PLUGIN_ROOT, SUPERPOWERS_MANIFEST_TEMPLATE,",
    "SUPERPOWERS_VALIDATOR,",
    "SUPERPOWERS_INSTALLED_SEARCH_ROOT, SUPERPOWERS_INSTALL_REFRESH_MODE",
    "",
    "Selection state uses SUPERPOWERS_CONFIG_DIR when set; otherwise it uses",
    "$XDG_CONFIG_HOME/superpowers-manager, then $HOME/.config/superpowers-manager.",
  ].join("\n");
}

async function main(): Promise<never> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.kind === "help") {
    console.log(usage());
    process.exit(0);
  }
  const root = resolvePackageRoot(import.meta.filename);
  if (!root) {
    console.error("error: cannot resolve the superpowers-manager package root");
    process.exit(1);
  }
  if (parsed.kind === "version") {
    console.log(
      JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
        .version,
    );
    process.exit(0);
  }
  if (parsed.kind === "usage-error") {
    console.error(`error: ${parsed.message}`);
    console.error(usage());
    process.exit(2);
  }
  const pf = preflight(parsed.cmd, process.env, process.platform);
  if (!pf.ok) {
    for (const e of pf.errors) console.error(`error: ${e}`);
    process.exit(1);
  }
  if (pf.dispatch === "in-process") {
    // `pf.dispatch === "in-process"` narrows only the preflight result, not
    // `parsed.cmd`'s type: PreflightResult carries no command, so `cmd` stays
    // the wider Subcommand here. The registry is keyed by the narrower
    // InProcessCommand, so this cast is required to index it. The
    // exhaustiveness check on IN_PROCESS_HANDLERS makes this branch
    // unreachable through the real DISPATCH table; the `!handler` guard below
    // is the runtime backstop for that guarantee, and is unreachable through
    // production code but covered by a fixture that patches the dispatch
    // table directly (Task 3, Step 5).
    const handler: InProcessHandler | undefined =
      IN_PROCESS_HANDLERS[parsed.cmd as InProcessCommand];
    if (!handler) {
      console.error(
        `error: no in-process handler registered for: ${parsed.cmd}`,
      );
      process.exit(1);
    }
    const ctx: CommandContext = {
      root,
      env: process.env,
      stdout: process.stdout,
      stderr: process.stderr,
      // The ONLY place runAdapter is bound to a context. Every command module
      // reaches the adapter through this field; none imports runAdapter
      // itself. tests/unit/ctx-adapter-provenance.test.js gates both halves.
      adapter: runAdapter,
    };
    let status: number;
    try {
      status = await handler(parsed.args, ctx);
    } catch (cause) {
      // Belt-and-suspenders: every registered handler already catches its own
      // failures and returns a status code (see src/commands/unpin.ts). This
      // re-emits a subordinate module's own diagnostic if one somehow escapes.
      console.error(`error: ${oneLine(cause)}`);
      process.exit(1);
    }
    process.exit(status);
  }
  const script = path.join(root, "scripts", parsed.cmd);
  if (!fs.existsSync(script)) {
    console.error(`error: missing script: ${script}`);
    process.exit(1);
  }
  const spawn = buildSpawn(
    parsed.cmd,
    parsed.args,
    root,
    pf.shell,
    process.platform,
  );
  // env is inherited wholesale, so every SUPERPOWERS_* override passes through.
  const res = spawnSync(spawn.file, spawn.argv, {
    stdio: "inherit",
    env: process.env,
  });
  if (res.error) {
    console.error(`error: cannot run ${spawn.file}: ${res.error.message}`);
    process.exit(1);
  }
  process.exit(res.status === null ? 1 : res.status);
}

export {
  resolvePackageRoot,
  isMain,
  parseArgs,
  findTool,
  discoverShell,
  commandRequirements,
  preflight,
  buildSpawn,
  usage,
  main,
  DISPATCH,
};

if (isMain(import.meta.filename, process.argv[1])) {
  main().catch((cause: unknown) => {
    console.error(`error: ${oneLine(cause)}`);
    process.exit(1);
  });
}

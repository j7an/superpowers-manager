// FROZEN CITATIONS: `scripts/…:NN` references below resolve against the tree at
// ad56569a4c161e7b122967442e2b026eeb6395f6, the last commit in which those paths existed. They are unmaintained
// and will not be re-derived. Resolve one with:
//   git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/adapter.sh

import * as fs from "node:fs";
import * as path from "node:path";
import { runAdapter } from "./adapter.js";
import { oneLine } from "./cli-arguments.js";
import type { CommandContext } from "./commands/context.js";
import { runInstall } from "./commands/install.js";
import { runPin } from "./commands/pin.js";
import { runPrepare } from "./commands/prepare.js";
import { runProbe } from "./commands/probe.js";
import { runTrackLatest } from "./commands/track-latest.js";
import { runUninstall } from "./commands/uninstall.js";
import { runUnpin } from "./commands/unpin.js";
import { runUpdate } from "./commands/update.js";
import { COMMIT_INPUT_RE, TAG_RE } from "./domain/refs.js";
import { configurationErrors } from "./validator.js";

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

type PreflightResult = { ok: true } | { ok: false; errors: string[] };

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

type InProcessHandler = (
  argv: string[],
  ctx: CommandContext,
) => Promise<number>;

// Keyed by Subcommand itself. Until slice 6 this was keyed by a mapped type
// that filtered Subcommand through a DISPATCH table of "spawn" | "in-process"
// literals; with every command in-process that filter was the identity, so the
// table, its mode union and the mapped type were one indirection with nothing
// left to discriminate. The guarantee is unchanged and is the whole protection
// — tests/bin/bin-dispatch.test.js records that decision: a Subcommand added
// without a handler registered here is a compile error, not a runtime surprise.
const IN_PROCESS_HANDLERS: Record<Subcommand, InProcessHandler> = {
  pin: runPin,
  "track-latest": runTrackLatest,
  unpin: runUnpin,
  prepare: runPrepare,
  probe: runProbe,
  install: runInstall,
  update: runUpdate,
  uninstall: runUninstall,
};
// `python3` left install, update and uninstall at slice 4b's flip. It was
// required because `spw_invoke_adapter` ran validate-adapter-response.py once
// per adapter call (scripts/core/adapter.sh:37-44); the in-process path has no
// validator process. It remains CONDITIONAL for `prepare` through
// commandRequirements(env) below, unchanged from slice 3.4. No command requires
// a POSIX shell any more.
const COMMAND_REQUIREMENTS: Record<Subcommand, string[]> = {
  pin: ["git"],
  "track-latest": [],
  unpin: [],
  prepare: ["git"],
  probe: ["git", "codex"],
  install: ["git", "codex"],
  update: ["git", "codex"],
  uninstall: ["codex"],
};

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

// python3 is required by `prepare` only when SUPERPOWERS_VALIDATOR names one:
// after the port, that optional spawn (runValidator, in
// src/commands/prepare.ts) is Python's only remaining consumer on the
// prepare path. The conditional lives here, in the accessor preflight reads,
// rather than inside preflight — an accessor that under-reports what
// preflight enforces is the blind spot slice 2 closed when it made
// CLI-PREFLIGHT-01 derive its map from production.
function commandRequirements(
  env: NodeJS.ProcessEnv,
): Record<Subcommand, string[]> {
  if (!env.SUPERPOWERS_VALIDATOR) return COMMAND_REQUIREMENTS;
  return {
    ...COMMAND_REQUIREMENTS,
    prepare: [...COMMAND_REQUIREMENTS.prepare, "python3"],
  };
}

// Preflight; never touches Codex state. It is the union of two exported
// accessors: configurationErrors (validator configuration) and
// commandRequirements (tool availability), both specific to the selected
// command. No command requires a POSIX shell: slice 4b flipped the last
// spawned command in-process, so there is no shell to discover.
function preflight(
  cmd: Subcommand,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): PreflightResult {
  const errors: string[] = [...configurationErrors(cmd, env)];
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
  if (errors.length) return { ok: false, errors };
  return { ok: true };
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
    "Environment overrides (used by in-process commands): SUPERPOWERS_REF,",
    "SUPERPOWERS_UPSTREAM_URL, SUPERPOWERS_CODEX, SUPERPOWERS_CACHE_DIR,",
    "SUPERPOWERS_CONFIG_DIR, XDG_CONFIG_HOME,",
    "SUPERPOWERS_PLUGIN_ROOT, SUPERPOWERS_MANIFEST_TEMPLATE,",
    "SUPERPOWERS_VALIDATOR, SUPERPOWERS_VALIDATOR_EXECUTABLE,",
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
  // Dispatch is no longer a branch: slice 4b flipped the last spawned command,
  // so every subcommand runs here, and slice 6 deleted the DISPATCH table whose
  // only remaining job was narrowing this registry's key type. `parsed.cmd` is
  // a Subcommand and the registry is keyed by Subcommand, so no cast is needed.
  // The exhaustiveness check on IN_PROCESS_HANDLERS makes an unregistered
  // handler a compile error; the `!handler` guard below is the runtime backstop
  // for that guarantee. It is unreachable through production code, and no
  // fixture reaches it either.
  const handler: InProcessHandler | undefined = IN_PROCESS_HANDLERS[parsed.cmd];
  if (!handler) {
    console.error(`error: no in-process handler registered for: ${parsed.cmd}`);
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

export {
  resolvePackageRoot,
  isMain,
  parseArgs,
  findTool,
  commandRequirements,
  preflight,
  usage,
  main,
};

if (isMain(import.meta.filename, process.argv[1])) {
  main().catch((cause: unknown) => {
    console.error(`error: ${oneLine(cause)}`);
    process.exit(1);
  });
}

#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { extractHarnessOptions, oneLine, UsageError } from "./cli-arguments.ts";
import { codexHarness } from "./codex-harness.ts";
import { piHarness } from "./pi-harness.ts";
import type { InvocationOptions } from "./harness-compatibility.ts";
import { createResourceCoordinator } from "./resource-lock.ts";
import type { CommandContext } from "./commands/context.ts";
import { runInstall } from "./commands/install.ts";
import { runPin } from "./commands/pin.ts";
import { runPrepare } from "./commands/prepare.ts";
import { runProbe } from "./commands/probe.ts";
import { runTrackLatest } from "./commands/track-latest.ts";
import { runUninstall } from "./commands/uninstall.ts";
import { runUnpin } from "./commands/unpin.ts";
import { runUpdate } from "./commands/update.ts";
import { COMMIT_INPUT_RE, TAG_RE } from "./domain/refs.ts";
import type {
  HarnessAdapter,
  HarnessCommand,
  ToolRequirement,
} from "./harness.ts";
import { configurationErrors } from "./validator.ts";

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
  options: InvocationOptions;
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

type InProcessHandler = <R>(
  argv: string[],
  ctx: CommandContext<R>,
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
// per adapter call
// (`git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/adapter.sh:37-44::--response "$response_file" --result "$result_file" \`);
// the in-process path has no validator process. It remains CONDITIONAL for
// `prepare` through commandRequirements(env) below, unchanged from slice 3.4.
// No command requires a POSIX shell any more.
const SHARED_COMMAND_REQUIREMENTS: Record<Subcommand, string[]> = {
  pin: ["git"],
  "track-latest": [],
  unpin: [],
  prepare: ["git"],
  probe: ["git"],
  install: ["git"],
  update: ["git"],
  uninstall: [],
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
  if (argv.length === 0)
    return {
      kind: "run",
      cmd: "update",
      args: [],
      options: { harness: "codex", allowExperimental: false },
    };
  if (first === "--help" || first === "-h") return { kind: "help" };
  if (first === "--version") return { kind: "version" };
  if (first && SUBCOMMANDS.includes(first as Subcommand)) {
    const command = first as Subcommand;
    let extracted: ReturnType<typeof extractHarnessOptions>;
    try {
      extracted = extractHarnessOptions(command, argv.slice(1));
    } catch (cause) {
      if (cause instanceof UsageError)
        return { kind: "usage-error", message: cause.message };
      throw cause;
    }
    const { args, options } = extracted;
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
    return { kind: "run", cmd: command, args, options };
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
// after the port, that optional spawn (runValidator, in src/validator.ts,
// called from src/commands/prepare.ts) is Python's only remaining consumer
// on the prepare path. The conditional lives here, in the accessor preflight reads,
// rather than inside preflight — an accessor that under-reports what
// preflight enforces is the blind spot slice 2 closed when it made
// CLI-PREFLIGHT-01 derive its map from production.
function sharedRequirement(name: string): ToolRequirement {
  return {
    name,
    executable: name,
    lookup: "path",
    missingMessage: `required command not found: ${name} — install ${name} and re-run`,
  };
}

function commandRequirementsFor<R>(
  env: NodeJS.ProcessEnv,
  adapter: HarnessAdapter<R>,
): Record<Subcommand, readonly ToolRequirement[]> {
  const forCommand = (command: Subcommand): readonly ToolRequirement[] => {
    const shared = SHARED_COMMAND_REQUIREMENTS[command].map(sharedRequirement);
    if (command === "prepare" && env.SUPERPOWERS_VALIDATOR) {
      shared.push(sharedRequirement("python3"));
    }
    return [...shared, ...adapter.requirements(command as HarnessCommand, env)];
  };
  return {
    pin: forCommand("pin"),
    "track-latest": forCommand("track-latest"),
    unpin: forCommand("unpin"),
    prepare: forCommand("prepare"),
    probe: forCommand("probe"),
    install: forCommand("install"),
    update: forCommand("update"),
    uninstall: forCommand("uninstall"),
  };
}

function commandRequirements(
  env: NodeJS.ProcessEnv,
): Record<Subcommand, string[]> {
  return Object.fromEntries(
    SUBCOMMANDS.map((command) => [
      command,
      commandRequirementsFor(env, codexHarness)[command].map(
        (requirement) => requirement.name,
      ),
    ]),
  ) as Record<Subcommand, string[]>;
}

// Preflight; never touches Codex state. It is the union of two exported
// accessors: configurationErrors (validator configuration) and
// commandRequirements (tool availability), both specific to the selected
// command. No command requires a POSIX shell: slice 4b flipped the last
// spawned command in-process, so there is no shell to discover.
function preflightFor<R>(
  cmd: Subcommand,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  adapter: HarnessAdapter<R>,
): PreflightResult {
  const errors: string[] = [...configurationErrors(cmd, env)];
  for (const requirement of commandRequirementsFor(env, adapter)[cmd]) {
    const found =
      requirement.lookup === "explicit-path-or-path" &&
      requirement.executable.includes(path.sep)
        ? fs.existsSync(requirement.executable)
        : Boolean(findTool(requirement.executable, env, platform));
    if (!found) errors.push(requirement.missingMessage);
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true };
}

function preflight(
  cmd: Subcommand,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): PreflightResult {
  return preflightFor(cmd, env, platform, codexHarness);
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
    "Target one invocation (default: codex; selection commands are shared):",
    "  probe --harness pi [--porcelain]",
    "  prepare --harness pi",
    "  install --harness pi [--allow-experimental]",
    "  update --harness pi [--allow-experimental]",
    "  uninstall --harness pi",
    "  --harness=codex and --harness=pi are also accepted after the command.",
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
  const status =
    parsed.options.harness === "pi"
      ? await dispatch(piHarness, parsed)
      : await dispatch(codexHarness, parsed);
  process.exit(status);
}

async function dispatch<R>(
  adapter: HarnessAdapter<R>,
  parsed: RunParseResult,
): Promise<number> {
  const root = resolvePackageRoot(import.meta.filename);
  if (!root) {
    console.error("error: cannot resolve the superpowers-manager package root");
    return 1;
  }
  const pf = preflightFor(parsed.cmd, process.env, process.platform, adapter);
  if (!pf.ok) {
    for (const e of pf.errors) console.error(`error: ${e}`);
    return 1;
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
    return 1;
  }
  const ctx: CommandContext<R> = {
    root,
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    options: parsed.options,
    coordination: createResourceCoordinator(),
    // The ONLY production binding of a concrete harness implementation.
    adapter,
  };
  let status: number;
  try {
    status = await handler(parsed.args, ctx);
  } catch (cause) {
    // Belt-and-suspenders: every registered handler already catches its own
    // failures and returns a status code (see src/commands/unpin.ts). This
    // re-emits a subordinate module's own diagnostic if one somehow escapes.
    console.error(`error: ${oneLine(cause)}`);
    return 1;
  }
  return status;
}

export {
  resolvePackageRoot,
  isMain,
  parseArgs,
  findTool,
  commandRequirements,
  commandRequirementsFor,
  preflight,
  preflightFor,
  usage,
  dispatch,
  main,
};

if (isMain(import.meta.filename, process.argv[1])) {
  main().catch((cause: unknown) => {
    console.error(`error: ${oneLine(cause)}`);
    process.exit(1);
  });
}

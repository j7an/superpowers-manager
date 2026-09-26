#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { extractHarnessOptions, oneLine, UsageError } from "./cli-arguments.ts";
import { codexHarness } from "./harnesses/codex/harness.ts";
import { claudeCodeHarness } from "./harnesses/claude-code/harness.ts";
import { piHarness } from "./harnesses/pi/harness.ts";
import { openCodeHarness } from "./harnesses/opencode/harness.ts";
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

type RunParseResult = {
  kind: "run";
  cmd: HarnessCommand;
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

type InProcessHandler = <R>(
  argv: string[],
  ctx: CommandContext<R>,
) => Promise<number>;

// Keyed by HarnessCommand: a command added to that type without a handler
// here is a compile error, not a runtime surprise.
const IN_PROCESS_HANDLERS: Record<HarnessCommand, InProcessHandler> = {
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
// the in-process path no longer uses that adapter-response validator.
// No command has a Python requirement in requirementsFor().
// No command requires a POSIX shell any more.
const SHARED_COMMAND_REQUIREMENTS: Record<HarnessCommand, string[]> = {
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
  if (first && Object.hasOwn(IN_PROCESS_HANDLERS, first)) {
    const command = first as HarnessCommand;
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

function sharedRequirement(name: string): ToolRequirement {
  return {
    name,
    executable: name,
    lookup: "path",
    missingMessage: `required command not found: ${name} — install ${name} and re-run`,
  };
}

function requirementsFor<R>(
  command: HarnessCommand,
  env: NodeJS.ProcessEnv,
  adapter: HarnessAdapter<R>,
): readonly ToolRequirement[] {
  return [
    ...SHARED_COMMAND_REQUIREMENTS[command].map(sharedRequirement),
    ...adapter.requirements(command, env),
  ];
}

// Preflight; never touches Codex state. It is the union of two exported
// accessors: configurationErrors (validator configuration) and
// requirementsFor (tool availability), both specific to the selected
// command. No command requires a POSIX shell: slice 4b flipped the last
// spawned command in-process, so there is no shell to discover.
function preflight<R>(
  cmd: HarnessCommand,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  adapter: HarnessAdapter<R>,
): PreflightResult {
  const errors: string[] = [...configurationErrors(cmd, env)];
  if (errors.length > 0) return { ok: false, errors };
  for (const requirement of requirementsFor(cmd, env, adapter)) {
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
    "  probe --harness opencode [--porcelain]",
    "  prepare --harness opencode",
    "  install --harness opencode [--allow-experimental]",
    "  update --harness opencode [--allow-experimental]",
    "  uninstall --harness opencode",
    "  --harness=codex, --harness=pi, --harness=opencode, and --harness=claude-code are also accepted after the command.",
    "",
    "Environment overrides (used by in-process commands): SUPERPOWERS_REF,",
    "SUPERPOWERS_UPSTREAM_URL, SUPERPOWERS_CODEX, SUPERPOWERS_CACHE_DIR,",
    "SUPERPOWERS_CONFIG_DIR, XDG_CONFIG_HOME,",
    "SUPERPOWERS_PLUGIN_ROOT, SUPERPOWERS_MANIFEST_TEMPLATE,",
    "SUPERPOWERS_VALIDATOR_EXECUTABLE,",
    "SUPERPOWERS_INSTALLED_SEARCH_ROOT, SUPERPOWERS_INSTALL_REFRESH_MODE,",
    "SUPERPOWERS_OPENCODE, SUPERPOWERS_CLAUDE_CODE, CLAUDE_CONFIG_DIR",
    "",
    "SUPERPOWERS_VALIDATOR is removed; unset it and use",
    "SUPERPOWERS_VALIDATOR_EXECUTABLE with an executable validator.",
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
    parsed.options.harness === "claude-code"
      ? await dispatch(claudeCodeHarness, parsed, root)
      : parsed.options.harness === "opencode"
        ? await dispatch(openCodeHarness, parsed, root)
        : parsed.options.harness === "pi"
          ? await dispatch(piHarness, parsed, root)
          : await dispatch(codexHarness, parsed, root);
  process.exit(status);
}

async function dispatch<R>(
  adapter: HarnessAdapter<R>,
  parsed: RunParseResult,
  root: string,
): Promise<number> {
  const pf = preflight(parsed.cmd, process.env, process.platform, adapter);
  if (!pf.ok) {
    for (const e of pf.errors) console.error(`error: ${e}`);
    return 1;
  }
  const handler = IN_PROCESS_HANDLERS[parsed.cmd];
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
  requirementsFor,
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

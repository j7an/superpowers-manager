import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, mkdir, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import {
  AdapterMessageLog,
  failureResult,
  successResult,
  type AdapterResult,
} from "./adapter-protocol.js";
import {
  activePluginVersionFromJson,
  installedListingHas,
  marketplaceRootFromJson,
} from "./codex-json.js";
import { oneLine } from "./cli-arguments.js";
import {
  installedCommitFromRoot,
  installedRootForVersion,
  pathsEqual,
} from "./codex-state.js";
import {
  classifyHooks,
  materializeHooks,
  readManifest,
  type ManifestSource,
} from "./hooks.js";
import { readCodexBuildSource } from "./provenance.js";
import type { JsonValue } from "./strict-json.js";
import { withWorkspace } from "./workspace.js";

const PLUGIN_ID = "superpowers@superpowers-manager";
const MARKETPLACE_NAME = "superpowers-manager";
const LEGACY_PLUGIN_ID = "superpowers@superpowers-wrapper";
const LEGACY_MARKETPLACE_NAME = "superpowers-wrapper";

export interface AdapterContext {
  readonly root: string;
  readonly env?: NodeJS.ProcessEnv;
}

class AdapterFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hints: readonly string[] = [],
  ) {
    super(message);
  }
}

function fail(
  code: string,
  message: string,
  hints: readonly string[] = [],
): never {
  throw new AdapterFailure(code, message, hints);
}

function parseFlags(
  argv: readonly string[],
  allowed: readonly string[],
): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]!;
    if (!allowed.includes(flag)) {
      fail("invalid-arguments", `unknown flag: ${flag}`);
    }
    if (index + 1 >= argv.length) {
      fail("invalid-arguments", `missing value for ${flag}`);
    }
    if (Object.hasOwn(values, flag)) {
      fail("invalid-arguments", `duplicate flag: ${flag}`);
    }
    values[flag] = argv[index + 1]!;
  }
  for (const flag of allowed) {
    if (!Object.hasOwn(values, flag)) {
      fail("invalid-arguments", `missing required flag: ${flag}`);
    }
  }
  return values;
}

interface CommandResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

function runCommand(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        encoding: "buffer",
        env,
        maxBuffer: Infinity,
        shell: false,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ status: 0, signal: null, stdout, stderr });
          return;
        }
        const failure = error as NodeJS.ErrnoException & {
          code?: number | string;
          signal?: NodeJS.Signals | null;
        };
        if (typeof failure.code === "string") {
          reject(failure);
          return;
        }
        resolve({
          status: typeof failure.code === "number" ? failure.code : null,
          signal: failure.signal ?? null,
          stdout,
          stderr,
        });
      },
    );
  });
}

function commandFailed(result: CommandResult): boolean {
  return result.status !== 0;
}

function mapCodexLaunchFailure(cause: unknown, codexBin: string): never {
  const code =
    cause !== null && typeof cause === "object" && "code" in cause
      ? String(cause.code)
      : "";
  if (code === "ENOENT" || code === "EACCES") {
    fail("command-not-found", `required Codex command not found: ${codexBin}`);
  }
  throw cause;
}

async function runCodexCommand(
  codexBin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  try {
    return await runCommand(codexBin, args, env);
  } catch (cause) {
    mapCodexLaunchFailure(cause, codexBin);
  }
}

async function mutationCommand(
  log: AdapterMessageLog,
  codexBin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  const result = await runCodexCommand(codexBin, args, env);
  log.appendBytes("stderr", result.stdout);
  log.appendBytes("stderr", result.stderr);
  return result;
}

async function listingCommand(
  log: AdapterMessageLog,
  codexBin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  const result = await runCodexCommand(codexBin, args, env);
  log.appendBytes("stderr", result.stderr);
  return result;
}

async function pythonCommand(
  log: AdapterMessageLog,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  const result = await runCommand("python3", args, env);
  log.appendBytes("stdout", result.stdout);
  log.appendBytes("stderr", result.stderr);
  return result;
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function commandAvailable(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (command.includes("/")) return executable(command);
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (directory.length > 0 && (await executable(join(directory, command)))) {
      return true;
    }
  }
  return false;
}

async function requireCodex(
  codexBin: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (!(await commandAvailable(codexBin, env))) {
    fail("command-not-found", `required Codex command not found: ${codexBin}`);
  }
}

const BUILD_FLAGS = [
  "--upstream-root",
  "--candidate-root",
  "--requested-ref",
  "--resolved-ref",
  "--commit",
  "--manager-version",
  "--upstream-manifest-version",
  "--fallback-manifest",
] as const;

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function runBuild(
  argv: readonly string[],
  root: string,
  env: NodeJS.ProcessEnv,
  log: AdapterMessageLog,
): Promise<JsonValue> {
  const flags = parseFlags(argv, BUILD_FLAGS);
  const upstreamRoot = flags["--upstream-root"];
  const candidateRoot = flags["--candidate-root"];
  const fallbackManifest = flags["--fallback-manifest"];
  if (!isAbsolute(upstreamRoot)) {
    fail("invalid-arguments", "--upstream-root must be an absolute path");
  }
  if (!isAbsolute(candidateRoot)) {
    fail("invalid-arguments", "--candidate-root must be an absolute path");
  }
  if (!(await directoryExists(upstreamRoot))) {
    fail("invalid-arguments", `upstream root not found: ${upstreamRoot}`);
  }
  if (!(await directoryExists(candidateRoot))) {
    fail("invalid-arguments", `candidate root not found: ${candidateRoot}`);
  }
  if (!(await fileExists(fallbackManifest))) {
    fail(
      "invalid-arguments",
      `fallback manifest not found: ${fallbackManifest}`,
    );
  }
  const validator = join(
    root,
    "scripts/adapters/codex/validate-generated-plugin.py",
  );
  if (!(await fileExists(validator))) {
    fail("build-failed", `missing built-in plugin validator: ${validator}`);
  }

  let entered = false;
  try {
    return await withWorkspace(
      tmpdir(),
      "superpowers-manager.adapter-build.",
      async () => {
        entered = true;
        const candidateManifest = join(
          candidateRoot,
          ".codex-plugin/plugin.json",
        );
        const upstreamManifest = join(
          upstreamRoot,
          ".codex-plugin/plugin.json",
        );
        const manifestSource: ManifestSource = (await fileExists(
          upstreamManifest,
        ))
          ? "upstream"
          : "fallback";
        try {
          await mkdir(join(candidateRoot, ".codex-plugin"), {
            recursive: true,
          });
          await copyFile(
            manifestSource === "upstream" ? upstreamManifest : fallbackManifest,
            candidateManifest,
          );
        } catch {
          fail(
            "build-failed",
            manifestSource === "upstream"
              ? "cannot copy upstream manifest into candidate"
              : "cannot copy fallback manifest into candidate",
          );
        }

        let plan;
        let sourceRoot: string;
        let realCandidateRoot: string;
        try {
          sourceRoot = await realpath(upstreamRoot);
          realCandidateRoot = await realpath(candidateRoot);
          const manifest = await readManifest(candidateManifest);
          plan = await classifyHooks(manifest, manifestSource, sourceRoot);
        } catch (cause) {
          log.appendText(
            "stderr",
            `hook classification failed: ${oneLine(cause)}`,
          );
          fail("build-failed", "failed to prepare upstream Codex hooks");
        }
        try {
          await materializeHooks(plan, sourceRoot, realCandidateRoot);
        } catch (cause) {
          log.appendText(
            "stderr",
            `hook materialization failed: ${oneLine(cause)}`,
          );
          fail("build-failed", "failed to prepare upstream Codex hooks");
        }

        let overlay: CommandResult;
        try {
          overlay = await pythonCommand(
            log,
            [
              "-S",
              join(root, "scripts/adapters/codex/apply-manifest-overlay.py"),
              candidateManifest,
              flags["--manager-version"],
            ],
            env,
          );
        } catch {
          fail("build-failed", "failed to apply manager manifest overlay");
        }
        if (commandFailed(overlay)) {
          fail("build-failed", "failed to apply manager manifest overlay");
        }
        try {
          await copyFile(
            fallbackManifest,
            join(candidateRoot, ".codex-plugin/plugin.template.json"),
          );
        } catch {
          fail(
            "build-failed",
            "cannot copy fallback manifest template into candidate",
          );
        }

        let upstreamSource: string;
        try {
          upstreamSource = await readCodexBuildSource(
            join(candidateRoot, ".superpowers-upstream.json"),
          );
        } catch {
          fail(
            "invalid-provenance",
            "candidate provenance is missing or invalid",
          );
        }
        let validation: CommandResult;
        try {
          validation = await pythonCommand(
            log,
            [
              "-S",
              validator,
              "--plugin-root",
              candidateRoot,
              `--source=${upstreamSource}`,
              "--requested-ref",
              flags["--requested-ref"],
              "--resolved-ref",
              flags["--resolved-ref"],
              "--commit",
              flags["--commit"],
              "--manifest-version",
              flags["--manager-version"],
              "--manifest-source",
              manifestSource,
              "--upstream-manifest-version",
              flags["--upstream-manifest-version"],
            ],
            env,
          );
        } catch {
          fail(
            "generated-plugin-validation-failed",
            "built-in generated plugin validation failed",
          );
        }
        if (commandFailed(validation)) {
          fail(
            "generated-plugin-validation-failed",
            "built-in generated plugin validation failed",
          );
        }
        return {};
      },
    );
  } catch (cause) {
    if (!entered) {
      fail(
        "build-failed",
        `cannot create adapter build workspace under ${tmpdir()}`,
      );
    }
    throw cause;
  }
}

async function runInstall(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  log: AdapterMessageLog,
): Promise<JsonValue> {
  const flags = parseFlags(argv, ["--package-root"]);
  const packageRoot = flags["--package-root"];
  if (!isAbsolute(packageRoot)) {
    fail("invalid-arguments", "--package-root must be an absolute path");
  }
  if (!(await directoryExists(packageRoot))) {
    fail("invalid-arguments", `package root not found: ${packageRoot}`);
  }
  const codexBin = env.SUPERPOWERS_CODEX || "codex";
  const refreshMode = env.SUPERPOWERS_INSTALL_REFRESH_MODE || "add-only";
  await requireCodex(codexBin, env);
  if (refreshMode !== "add-only" && refreshMode !== "remove-add") {
    fail(
      "invalid-arguments",
      `unsupported SUPERPOWERS_INSTALL_REFRESH_MODE: ${refreshMode}`,
    );
  }

  let entered = false;
  try {
    return await withWorkspace(
      tmpdir(),
      "superpowers-manager.adapter-install.",
      async () => {
        entered = true;
        const marketplaceList = await listingCommand(
          log,
          codexBin,
          ["plugin", "marketplace", "list", "--json"],
          env,
        );
        if (commandFailed(marketplaceList)) {
          fail(
            "install-failed",
            `cannot list Codex marketplaces via '${codexBin} plugin marketplace list --json'`,
          );
        }
        let registeredRoot: string;
        try {
          registeredRoot = marketplaceRootFromJson(
            marketplaceList.stdout.toString("utf8"),
            MARKETPLACE_NAME,
          );
        } catch {
          fail(
            "install-failed",
            `cannot parse output of '${codexBin} plugin marketplace list --json'`,
          );
        }
        if (registeredRoot.length === 0) {
          const added = await mutationCommand(
            log,
            codexBin,
            ["plugin", "marketplace", "add", packageRoot],
            env,
          );
          if (commandFailed(added)) {
            fail(
              "install-failed",
              `codex marketplace add failed for ${packageRoot}`,
            );
          }
        } else if (!(await pathsEqual(packageRoot, registeredRoot))) {
          log.appendText(
            "stdout",
            `marketplace ${MARKETPLACE_NAME} registered at ${registeredRoot}; re-registering at ${packageRoot}`,
          );
          const removed = await mutationCommand(
            log,
            codexBin,
            ["plugin", "marketplace", "remove", MARKETPLACE_NAME],
            env,
          );
          if (commandFailed(removed)) {
            fail(
              "install-failed",
              `codex marketplace remove failed for ${MARKETPLACE_NAME} (registered at ${registeredRoot})`,
            );
          }
          const added = await mutationCommand(
            log,
            codexBin,
            ["plugin", "marketplace", "add", packageRoot],
            env,
          );
          if (commandFailed(added)) {
            fail(
              "install-failed",
              `marketplace ${MARKETPLACE_NAME} was removed but re-adding failed.`,
              [
                `recover with: ${codexBin} plugin marketplace add ${packageRoot}`,
                `previous root (last known good): ${registeredRoot}`,
              ],
            );
          }
        }
        if (refreshMode === "remove-add") {
          await mutationCommand(
            log,
            codexBin,
            ["plugin", "remove", PLUGIN_ID],
            env,
          );
        }
        const pluginAdded = await mutationCommand(
          log,
          codexBin,
          ["plugin", "add", PLUGIN_ID],
          env,
        );
        if (commandFailed(pluginAdded)) {
          fail("install-failed", `codex plugin add failed for ${PLUGIN_ID}`);
        }
        return {
          verification_hints: {
            ...(refreshMode === "add-only"
              ? {
                  mismatch:
                    "retry with SUPERPOWERS_INSTALL_REFRESH_MODE=remove-add",
                }
              : {}),
            missing: "verify with 'codex plugin list --json'.",
          },
        };
      },
    );
  } catch (cause) {
    if (!entered) {
      fail(
        "install-failed",
        `cannot create adapter install workspace under ${tmpdir()}`,
      );
    }
    throw cause;
  }
}

async function runUninstall(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  log: AdapterMessageLog,
): Promise<JsonValue> {
  const flags = parseFlags(argv, ["--plugin-present", "--marketplace-present"]);
  const pluginPresent = flags["--plugin-present"];
  const marketplacePresent = flags["--marketplace-present"];
  if (pluginPresent !== "true" && pluginPresent !== "false") {
    fail("invalid-arguments", "--plugin-present must be true or false");
  }
  if (marketplacePresent !== "true" && marketplacePresent !== "false") {
    fail("invalid-arguments", "--marketplace-present must be true or false");
  }
  const codexBin = env.SUPERPOWERS_CODEX || "codex";
  await requireCodex(codexBin, env);
  let entered = false;
  try {
    return await withWorkspace(
      tmpdir(),
      "superpowers-manager.adapter-uninstall.",
      async () => {
        entered = true;
        if (pluginPresent === "true") {
          const result = await mutationCommand(
            log,
            codexBin,
            ["plugin", "remove", PLUGIN_ID],
            env,
          );
          if (commandFailed(result)) {
            fail(
              "uninstall-failed",
              `codex plugin remove failed for ${PLUGIN_ID}`,
            );
          }
          log.appendText("stdout", `removed plugin ${PLUGIN_ID}`);
        } else {
          log.appendText("stdout", "plugin not installed; skipping");
        }
        if (marketplacePresent === "true") {
          const result = await mutationCommand(
            log,
            codexBin,
            ["plugin", "marketplace", "remove", MARKETPLACE_NAME],
            env,
          );
          if (commandFailed(result)) {
            fail(
              "uninstall-failed",
              `codex plugin marketplace remove failed for ${MARKETPLACE_NAME}`,
            );
          }
          log.appendText("stdout", `removed marketplace ${MARKETPLACE_NAME}`);
        } else {
          log.appendText("stdout", "marketplace not registered; skipping");
        }
        return {};
      },
    );
  } catch (cause) {
    if (!entered) {
      fail(
        "uninstall-failed",
        `cannot create adapter uninstall workspace under ${tmpdir()}`,
      );
    }
    throw cause;
  }
}

async function runInspect(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  log: AdapterMessageLog,
): Promise<JsonValue> {
  const flags = parseFlags(argv, ["--view"]);
  const view = flags["--view"];
  if (view === "update-control") {
    return { view: "update-control", update_control: "managed" };
  }
  if (view === "fingerprint") {
    const codexBin = env.SUPERPOWERS_CODEX || "codex";
    await requireCodex(codexBin, env);
    let entered = false;
    try {
      return await withWorkspace(
        tmpdir(),
        "superpowers-manager.adapter-fingerprint.",
        async () => {
          entered = true;
          const listing = await listingCommand(
            log,
            codexBin,
            ["plugin", "list", "--json"],
            env,
          );
          if (commandFailed(listing)) {
            fail(
              "inspect-failed",
              `cannot list Codex plugins via '${codexBin} plugin list --json'`,
            );
          }
          let activeVersion: string;
          try {
            activeVersion = activePluginVersionFromJson(
              listing.stdout.toString("utf8"),
              PLUGIN_ID,
            );
          } catch {
            fail(
              "inspect-failed",
              `cannot parse output of '${codexBin} plugin list --json'`,
            );
          }
          if (activeVersion.length === 0) {
            return { view: "fingerprint", fingerprint: null };
          }
          const searchRoot =
            env.SUPERPOWERS_INSTALLED_SEARCH_ROOT ??
            join(env.HOME ?? "", ".codex");
          const activeRoot = installedRootForVersion(
            searchRoot,
            MARKETPLACE_NAME,
            "superpowers",
            activeVersion,
          );
          const fingerprint = await installedCommitFromRoot(activeRoot);
          if (fingerprint.length === 0) {
            fail(
              "inspect-failed",
              `cannot inspect active Codex plugin fingerprint under ${activeRoot}`,
            );
          }
          return { view: "fingerprint", fingerprint };
        },
      );
    } catch (cause) {
      if (!entered) {
        fail(
          "inspect-failed",
          `cannot create adapter fingerprint workspace under ${tmpdir()}`,
        );
      }
      throw cause;
    }
  }
  if (view === "ownership") {
    const codexBin = env.SUPERPOWERS_CODEX || "codex";
    await requireCodex(codexBin, env);
    let entered = false;
    try {
      return await withWorkspace(
        tmpdir(),
        "superpowers-manager.adapter-inspect.",
        async () => {
          entered = true;
          const plugins = await listingCommand(
            log,
            codexBin,
            ["plugin", "list", "--json"],
            env,
          );
          if (commandFailed(plugins)) {
            fail(
              "inspect-failed",
              `cannot list Codex plugins via '${codexBin} plugin list --json'`,
            );
          }
          const marketplaces = await listingCommand(
            log,
            codexBin,
            ["plugin", "marketplace", "list", "--json"],
            env,
          );
          if (commandFailed(marketplaces)) {
            fail(
              "inspect-failed",
              `cannot list Codex marketplaces via '${codexBin} plugin marketplace list --json'`,
            );
          }
          const pluginJson = plugins.stdout.toString("utf8");
          const marketplaceJson = marketplaces.stdout.toString("utf8");
          let managerPlugin: boolean;
          let legacyPlugin: boolean;
          let managerMarketplace: boolean;
          let legacyMarketplace: boolean;
          try {
            managerPlugin = installedListingHas(
              pluginJson,
              "installed",
              "pluginId",
              PLUGIN_ID,
            );
            legacyPlugin = installedListingHas(
              pluginJson,
              "installed",
              "pluginId",
              LEGACY_PLUGIN_ID,
            );
          } catch {
            fail(
              "inspect-failed",
              `cannot parse output of '${codexBin} plugin list --json'`,
            );
          }
          try {
            managerMarketplace = installedListingHas(
              marketplaceJson,
              "marketplaces",
              "name",
              MARKETPLACE_NAME,
            );
            legacyMarketplace = installedListingHas(
              marketplaceJson,
              "marketplaces",
              "name",
              LEGACY_MARKETPLACE_NAME,
            );
          } catch {
            fail(
              "inspect-failed",
              `cannot parse output of '${codexBin} plugin marketplace list --json'`,
            );
          }
          const managerPresent = managerPlugin || managerMarketplace;
          const legacyPresent = legacyPlugin || legacyMarketplace;
          return {
            view: "ownership",
            resources: {
              plugin: managerPlugin,
              marketplace: managerMarketplace,
            },
            legacy_resources: {
              plugin: legacyPlugin,
              marketplace: legacyMarketplace,
            },
            identity_state: managerPresent
              ? legacyPresent
                ? "both"
                : "manager"
              : legacyPresent
                ? "legacy"
                : "neither",
          };
        },
      );
    } catch (cause) {
      if (!entered) {
        fail(
          "inspect-failed",
          `cannot create adapter inspect workspace under ${tmpdir()}`,
        );
      }
      throw cause;
    }
  }
  fail("invalid-arguments", `unsupported inspect view: ${view}`);
}

export async function runAdapter(
  argv: readonly string[],
  context: AdapterContext,
): Promise<AdapterResult> {
  const operation = argv[0] ?? "adapter";
  const args = argv.slice(1);
  const env = { ...process.env, ...context.env };
  const log = new AdapterMessageLog();

  try {
    let result: JsonValue;
    if (argv.length === 0) {
      fail("invalid-arguments", "missing adapter operation");
    } else if (operation === "build") {
      result = await runBuild(args, context.root, env, log);
    } else if (operation === "install") {
      result = await runInstall(args, env, log);
    } else if (operation === "uninstall") {
      result = await runUninstall(args, env, log);
    } else if (operation === "inspect") {
      result = await runInspect(args, env, log);
    } else {
      fail(
        "unsupported-operation",
        `unsupported adapter operation: ${operation}`,
      );
    }
    return successResult(operation, result, log.snapshot());
  } catch (cause) {
    if (cause instanceof AdapterFailure) {
      return failureResult(
        operation,
        cause.code,
        cause.message,
        cause.hints,
        log.snapshot(),
      );
    }
    throw cause;
  }
}

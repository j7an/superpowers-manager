import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import {
  AdapterMessageLog,
  failureResult,
  successResult,
  type AdapterContext,
  type AdapterResult,
} from "../../adapter-result.ts";
import {
  activePluginVersionFromJson,
  codexInstalledPluginsFromJson,
  installedListingHas,
  marketplaceRootFromJson,
} from "./json.ts";
import {
  CODEX_LEGACY_PLUGIN_ID,
  CODEX_MANAGER_PLUGIN_ID,
  inspectCodexConflicts,
} from "./conflicts.ts";
import { oneLine } from "../../cli-arguments.ts";
import {
  installedCommitFromRoot,
  installedRootForVersion,
  pathsEqual,
} from "./state.ts";
import { codexHome } from "./paths.ts";
import { readCodexStoredState, type CodexStoredState } from "./stored-state.ts";
import { validateGeneratedPlugin } from "./generated-plugin.ts";
import {
  classifyHooks,
  materializeHooks,
  readManifest,
  type ManifestSource,
} from "./hooks.ts";
import { applyManifestOverlay } from "./manifest-overlay.ts";
import { readCodexBuildSource } from "../../provenance.ts";
import type { JsonValue } from "../../strict-json.ts";
import { isAcceptedSplitValue } from "../../validate-generated-plugin-cli.ts";
import { withWorkspace, workspaceRemovalFailure } from "../../workspace.ts";

const PLUGIN_ID = CODEX_MANAGER_PLUGIN_ID;
const MARKETPLACE_NAME = "superpowers-manager";
const LEGACY_PLUGIN_ID = CODEX_LEGACY_PLUGIN_ID;
const LEGACY_MARKETPLACE_NAME = "superpowers-wrapper";

// Re-exported so existing importers of AdapterContext from this module are
// unaffected: the interface itself now lives in adapter-result.js, grouped
// with the other protocol types (AdapterResult, AdapterOutcome) rather than
// with this module's implementation. Not a cycle avoidance — see
// adapter-result.ts's comment on AdapterContext for why a cycle was never
// possible here regardless of import direction.
export type { AdapterContext };

export interface CodexBuildInput {
  readonly upstreamRoot: string;
  readonly candidateRoot: string;
  readonly requestedRef: string;
  readonly resolvedRef: string;
  readonly commit: string;
  readonly managerVersion: string;
  readonly upstreamManifestVersion: string;
  readonly fallbackManifest: string;
}

export interface CodexRemovalInput {
  readonly pluginPresent: boolean;
  readonly marketplacePresent: boolean;
}

export interface CodexNativeState {
  readonly marketplaceRoot: string | null;
  readonly pluginPresent: boolean;
  readonly pluginEnabled: boolean;
  readonly activeVersion: string | null;
  readonly activeRoot: string | null;
}

export type CodexInstallRefreshMode = "add-only" | "remove-add";

export function codexInstallRefreshMode(
  env: NodeJS.ProcessEnv,
): CodexInstallRefreshMode | null {
  const refreshMode = env.SUPERPOWERS_INSTALL_REFRESH_MODE || "add-only";
  return refreshMode === "add-only" || refreshMode === "remove-add"
    ? refreshMode
    : null;
}

class AdapterFailure extends Error {
  readonly code: string;
  readonly hints: readonly string[];

  constructor(code: string, message: string, hints: readonly string[] = []) {
    super(message);
    this.code = code;
    this.hints = hints;
  }
}

function fail(
  code: string,
  message: string,
  hints: readonly string[] = [],
): never {
  throw new AdapterFailure(code, message, hints);
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
  // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/common.sh:71::NODE_OPTIONS`
  // is the system's only scrubbing site and it dies with scripts/ in 4c.
  // Without this, NODE_OPTIONS would NEWLY reach codex.
  // Preserves the property that was load-bearing — the child is clean — and
  // drops the part that was never true, that the dispatcher scrubbed itself.
  // Carried matrix row 11.
  const childEnv = { ...env };
  delete childEnv.NODE_OPTIONS;
  delete childEnv.NODE_PATH;
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        encoding: "buffer",
        env: childEnv,
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

// Exported only so tests/unit/harnesses/codex/adapter.test.ts can assert the env scrub
// directly. No production caller uses this name.
export { runCommand as runCommandForTest };

function commandFailed(result: CommandResult): boolean {
  return result.status !== 0;
}

async function storedStateAfterListingFailure(
  env: NodeJS.ProcessEnv,
  code: "inspect-failed" | "install-failed",
  message: string,
): Promise<CodexStoredState> {
  try {
    return await readCodexStoredState(env, process.cwd());
  } catch {
    fail(code, message);
  }
}

// Exported only so its unit test can reach it. No integration test can cover
// it: on Linux glibc, `execvp`'s ENOEXEC falls back to `/bin/sh`, so the spawn
// still succeeds, and every other candidate errno is already peeled off by an
// `X_OK` check or the `ENOENT`/`EACCES` branch. See the test's own comment
// for the full analysis.
export function mapCodexLaunchFailure(
  cause: unknown,
  codexBin: string,
): CommandResult {
  const code =
    cause !== null && typeof cause === "object" && "code" in cause
      ? String(cause.code)
      : "";
  if (code === "ENOENT" || code === "EACCES") {
    fail("command-not-found", `required Codex command not found: ${codexBin}`);
  }
  // A bounded, enumerable, path-free errno is not the cause's message, so the no-interpolation rule
  // does not reach it; unvalidated, String(cause.code) would put another module's free-form text
  // in a sentence this module signs. appendBytes below escapes it, but escaping is not ownership:
  // the rule governs whose wording the operator reads, not whether it reaches the terminal intact.
  const detail = /^E[A-Z0-9]+$/.test(code) ? `: ${code}` : "";
  return {
    status: 1,
    signal: null,
    stdout: Buffer.alloc(0),
    // Trailing newline matches how a real process writes stderr;
    // `src/adapter-result.ts:133::appendBytes` splits on newlines and terminates the
    // final chunk at end-of-buffer either way.
    stderr: Buffer.from(
      `cannot launch Codex command ${codexBin}${detail}\n`,
      "utf8",
    ),
  };
}

async function runCodexCommand(
  codexBin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  try {
    return await runCommand(codexBin, args, env);
  } catch (cause) {
    return mapCodexLaunchFailure(cause, codexBin);
  }
}

function reportOrphanedWorkspace(
  log: AdapterMessageLog,
): (path: string) => void {
  return (path) => {
    log.appendText("stderr", workspaceRemovalFailure(path));
  };
}

async function withCodexWorkspace(
  label: "build" | "install" | "uninstall" | "fingerprint" | "inspect",
  failureCode:
    "build-failed" | "install-failed" | "uninstall-failed" | "inspect-failed",
  log: AdapterMessageLog,
  execute: () => Promise<JsonValue>,
): Promise<JsonValue> {
  let entered = false;
  try {
    return await withWorkspace(
      tmpdir(),
      "superpowers-manager.adapter-" + label + ".",
      async () => {
        entered = true;
        return await execute();
      },
      { onCleanupFailure: reportOrphanedWorkspace(log) },
    );
  } catch (cause) {
    if (!entered) {
      fail(
        failureCode,
        "cannot create adapter " + label + " workspace under " + tmpdir(),
      );
    }
    throw cause;
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
  if (env.PATH === undefined) return false;
  for (const directory of env.PATH.split(delimiter)) {
    if (await executable(join(directory, command))) {
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
  input: CodexBuildInput,
  env: NodeJS.ProcessEnv,
  log: AdapterMessageLog,
): Promise<JsonValue> {
  const { upstreamRoot, candidateRoot, fallbackManifest } = input;
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

  return await withCodexWorkspace("build", "build-failed", log, async () => {
    const candidateManifest = join(candidateRoot, ".codex-plugin/plugin.json");
    const upstreamManifest = join(upstreamRoot, ".codex-plugin/plugin.json");
    const manifestSource: ManifestSource = (await fileExists(upstreamManifest))
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
      log.appendText("stderr", `hook classification failed: ${oneLine(cause)}`);
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

    let source: string;
    try {
      // Decoded fatally, not leniently: the file can change between this read and `readManifest`'s read above.
      const rawManifestBytes = await readFile(candidateManifest);
      source = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(rawManifestBytes);
    } catch {
      // Deliberately drops the cause. The Python interpolated the raw OSError here:
      // `git show 0b6d50e1e9c688397285c6fa274dc8c9437d8ba3:scripts/adapters/codex/apply-manifest-overlay.py:42::read`,
      // putting "[Errno 2] No such file or directory" on the operator's stream.
      // The prefix is preserved; the errno leak is not.
      log.appendText(
        "stderr",
        `cannot read manifest JSON in ${candidateManifest}`,
      );
      fail("build-failed", "failed to apply manager manifest overlay");
    }

    let overlaid: string;
    try {
      overlaid = applyManifestOverlay(
        source,
        input.managerVersion,
        candidateManifest,
      );
    } catch (cause) {
      // applyManifestOverlay's own messages already name the manifest
      // path — three are the frozen CPython wording, and the fourth (the
      // numeric-overflow diagnostic, which has no CPython oracle wording
      // to match) now carries the path via its own rewrap in
      // src/harnesses/codex/manifest-overlay.ts. Emit as-is, with no added prefix — a
      // prefix here would double up the path these messages already
      // name.
      log.appendText("stderr", oneLine(cause));
      fail("build-failed", "failed to apply manager manifest overlay");
    }

    try {
      await writeFile(candidateManifest, overlaid, "utf8");
    } catch {
      log.appendText(
        "stderr",
        `cannot write manifest JSON in ${candidateManifest}`,
      );
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
      fail("invalid-provenance", "candidate provenance is missing or invalid");
    }
    // The seven values the validator CLI would receive in split form:
    // --plugin-root, --requested-ref, --resolved-ref, --commit,
    // --manifest-version, --manifest-source, --upstream-manifest-version.
    // The eighth, --source, is passed attached, where argparse accepts any
    // dash-leading value, so it is deliberately absent here. Each value is
    // paired with the ADAPTER-facing flag name to report: --manager-version
    // (the CLI calls it --manifest-version) and --plugin-root /
    // --manifest-source (derived, not user-supplied) deliberately differ
    // from the validator CLI's own names, since the operator can only act
    // on the adapter's surface.
    const splitValues: ReadonlyArray<{
      readonly value: string;
      readonly name: string;
    }> = [
      { value: candidateRoot, name: "--plugin-root" },
      { value: input.requestedRef, name: "--requested-ref" },
      { value: input.resolvedRef, name: "--resolved-ref" },
      { value: input.commit, name: "--commit" },
      { value: input.managerVersion, name: "--manager-version" },
      { value: manifestSource, name: "--manifest-source" },
      {
        value: input.upstreamManifestVersion,
        name: "--upstream-manifest-version",
      },
    ];
    const firstRejected = splitValues.find(
      ({ value }) => !isAcceptedSplitValue(value),
    );
    if (firstRejected !== undefined) {
      // Declared exception to message-record parity: argparse wrote usage
      // records here; this guard precedes the call and writes a
      // differently-worded record naming the rejected flag instead. The
      // failure code and message are unchanged.
      const text =
        "Generated plugin validation failed:\n" +
        `- validator argument \`${firstRejected.name}\` has a dash-leading value the argument parser rejects\n`;
      log.appendBytes("stderr", Buffer.from(text, "utf8"));
      fail(
        "generated-plugin-validation-failed",
        "built-in generated plugin validation failed",
      );
    }
    let errors: readonly string[];
    try {
      errors = await validateGeneratedPlugin({
        pluginRoot: candidateRoot,
        source: upstreamSource,
        requestedRef: input.requestedRef,
        resolvedRef: input.resolvedRef,
        commit: input.commit,
        manifestVersion: input.managerVersion,
        manifestSource,
        upstreamManifestVersion: input.upstreamManifestVersion,
      });
    } catch {
      fail(
        "generated-plugin-validation-failed",
        "built-in generated plugin validation failed",
      );
    }
    if (errors.length > 0) {
      // appendBytes, not appendText: one record per line, matching what
      // mutationCommand writes from the subprocess streams.
      const text =
        "Generated plugin validation failed:\n" +
        errors.map((error) => `- ${error}\n`).join("");
      log.appendBytes("stderr", Buffer.from(text, "utf8"));
      fail(
        "generated-plugin-validation-failed",
        "built-in generated plugin validation failed",
      );
    }
    log.appendBytes(
      "stdout",
      Buffer.from(
        `generated plugin validation passed: ${candidateRoot}\n`,
        "utf8",
      ),
    );
    return {};
  });
}

async function runInstall(
  packageRoot: string,
  env: NodeJS.ProcessEnv,
  log: AdapterMessageLog,
): Promise<JsonValue> {
  if (!isAbsolute(packageRoot)) {
    fail("invalid-arguments", "--package-root must be an absolute path");
  }
  if (!(await directoryExists(packageRoot))) {
    fail("invalid-arguments", `package root not found: ${packageRoot}`);
  }
  const codexBin = env.SUPERPOWERS_CODEX || "codex";
  const refreshMode = codexInstallRefreshMode(env);
  await requireCodex(codexBin, env);
  if (refreshMode === null) {
    fail(
      "invalid-arguments",
      `unsupported SUPERPOWERS_INSTALL_REFRESH_MODE: ${env.SUPERPOWERS_INSTALL_REFRESH_MODE}`,
    );
  }

  return await withCodexWorkspace(
    "install",
    "install-failed",
    log,
    async () => {
      const marketplaceList = await listingCommand(
        log,
        codexBin,
        ["plugin", "marketplace", "list", "--json"],
        env,
      );
      let registeredRoot: string;
      if (commandFailed(marketplaceList)) {
        registeredRoot = (
          await storedStateAfterListingFailure(
            env,
            "install-failed",
            `cannot list Codex marketplaces via '${codexBin} plugin marketplace list --json'`,
          )
        ).managerMarketplaceRoot;
      } else {
        try {
          registeredRoot = marketplaceRootFromJson(
            marketplaceList.stdout,
            MARKETPLACE_NAME,
          );
        } catch {
          fail(
            "install-failed",
            `cannot parse output of '${codexBin} plugin marketplace list --json'`,
          );
        }
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
}

async function runUninstall(
  input: CodexRemovalInput,
  env: NodeJS.ProcessEnv,
  log: AdapterMessageLog,
): Promise<JsonValue> {
  const { pluginPresent, marketplacePresent } = input;
  const codexBin = env.SUPERPOWERS_CODEX || "codex";
  await requireCodex(codexBin, env);
  return await withCodexWorkspace(
    "uninstall",
    "uninstall-failed",
    log,
    async () => {
      if (pluginPresent) {
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
      if (marketplacePresent) {
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
}

async function runInspect(
  view: "ownership" | "update-control" | "fingerprint",
  context: AdapterContext,
  env: NodeJS.ProcessEnv,
  log: AdapterMessageLog,
): Promise<JsonValue> {
  if (view === "update-control") {
    return { view: "update-control", update_control: "managed" };
  }
  if (view === "fingerprint") {
    const codexBin = env.SUPERPOWERS_CODEX || "codex";
    await requireCodex(codexBin, env);
    return await withCodexWorkspace(
      "fingerprint",
      "inspect-failed",
      log,
      async () => {
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
            listing.stdout,
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
        let searchRoot = env.SUPERPOWERS_INSTALLED_SEARCH_ROOT;
        if (!searchRoot) {
          if (env.HOME === undefined) {
            fail(
              "inspect-failed",
              "cannot inspect active Codex plugin fingerprint without HOME",
            );
          }
          searchRoot = join(env.HOME || "/", ".codex");
        }
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
  }
  if (view === "ownership") {
    const codexBin = env.SUPERPOWERS_CODEX || "codex";
    await requireCodex(codexBin, env);
    return await withCodexWorkspace(
      "inspect",
      "inspect-failed",
      log,
      async () => {
        const plugins = await listingCommand(
          log,
          codexBin,
          ["plugin", "list", "--json"],
          env,
        );
        if (commandFailed(plugins)) {
          const stored = await storedStateAfterListingFailure(
            env,
            "inspect-failed",
            `cannot list Codex plugins via '${codexBin} plugin list --json'`,
          );
          const conflicts = await inspectCodexConflicts(
            { root: context.root, env },
            stored.installedListingJson,
          );
          const managerPresent =
            stored.managerPluginPresent ||
            stored.managerMarketplaceRoot.length > 0;
          const legacyPresent =
            stored.legacyPluginPresent || stored.legacyMarketplaceRoot !== null;
          return {
            view: "ownership",
            resources: {
              plugin: stored.managerPluginPresent,
              marketplace: true,
            },
            legacy_resources: {
              plugin: stored.legacyPluginPresent,
              marketplace: stored.legacyMarketplaceRoot !== null,
            },
            identity_state: managerPresent
              ? legacyPresent
                ? "both"
                : "manager"
              : legacyPresent
                ? "legacy"
                : "neither",
            conflicts: [...conflicts],
          };
        }
        let managerPlugin: boolean;
        let legacyPlugin: boolean;
        let conflicts: readonly string[];
        try {
          managerPlugin = installedListingHas(
            plugins.stdout,
            "installed",
            "pluginId",
            PLUGIN_ID,
          );
          legacyPlugin = installedListingHas(
            plugins.stdout,
            "installed",
            "pluginId",
            LEGACY_PLUGIN_ID,
          );
          conflicts = await inspectCodexConflicts(
            { root: context.root, env },
            plugins.stdout.toString("utf8"),
          );
        } catch {
          fail(
            "inspect-failed",
            `cannot parse output of '${codexBin} plugin list --json'`,
          );
        }
        const marketplaces = await listingCommand(
          log,
          codexBin,
          ["plugin", "marketplace", "list", "--json"],
          env,
        );
        if (commandFailed(marketplaces)) {
          const stored = await storedStateAfterListingFailure(
            env,
            "inspect-failed",
            `cannot list Codex marketplaces via '${codexBin} plugin marketplace list --json'`,
          );
          const conflicts = await inspectCodexConflicts(
            { root: context.root, env },
            stored.installedListingJson,
          );
          const managerPresent = true;
          const legacyPresent =
            stored.legacyPluginPresent || stored.legacyMarketplaceRoot !== null;
          return {
            view: "ownership",
            resources: {
              plugin: stored.managerPluginPresent,
              marketplace: true,
            },
            legacy_resources: {
              plugin: stored.legacyPluginPresent,
              marketplace: stored.legacyMarketplaceRoot !== null,
            },
            identity_state: managerPresent
              ? legacyPresent
                ? "both"
                : "manager"
              : legacyPresent
                ? "legacy"
                : "neither",
            conflicts: [...conflicts],
          };
        }
        let managerMarketplace: boolean;
        let legacyMarketplace: boolean;
        try {
          managerMarketplace = installedListingHas(
            marketplaces.stdout,
            "marketplaces",
            "name",
            MARKETPLACE_NAME,
          );
          legacyMarketplace = installedListingHas(
            marketplaces.stdout,
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
          conflicts: [...conflicts],
        };
      },
    );
  }
  const unsupportedView: string = view;
  fail("invalid-arguments", `unsupported inspect view: ${unsupportedView}`);
}

async function runCodexOperation<T = JsonValue>(
  operation: string,
  context: AdapterContext,
  execute: (env: NodeJS.ProcessEnv, log: AdapterMessageLog) => Promise<T>,
): Promise<AdapterResult<T>> {
  const env = { ...process.env, ...context.env };
  const log = new AdapterMessageLog();

  try {
    const result = await execute(env, log);
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

export function codexBuild(
  input: CodexBuildInput,
  context: AdapterContext,
): Promise<AdapterResult> {
  return runCodexOperation("build", context, (env, log) =>
    runBuild(input, env, log),
  );
}

export function codexInstall(
  packageRoot: string,
  context: AdapterContext,
): Promise<AdapterResult> {
  return runCodexOperation("install", context, (env, log) =>
    runInstall(packageRoot, env, log),
  );
}

export function codexRemove(
  input: CodexRemovalInput,
  context: AdapterContext,
): Promise<AdapterResult> {
  return runCodexOperation("uninstall", context, (env, log) =>
    runUninstall(input, env, log),
  );
}

export function codexInspect(
  view: "ownership" | "update-control" | "fingerprint",
  context: AdapterContext,
): Promise<AdapterResult> {
  return runCodexOperation("inspect", context, (env, log) =>
    runInspect(view, context, env, log),
  );
}

export function codexReadNativeState(
  context: AdapterContext,
): Promise<AdapterResult<CodexNativeState>> {
  return runCodexOperation("native-state", context, async (env, log) => {
    const codexBin = env.SUPERPOWERS_CODEX || "codex";
    await requireCodex(codexBin, env);
    const plugins = await listingCommand(
      log,
      codexBin,
      ["plugin", "list", "--json"],
      env,
    );
    if (commandFailed(plugins)) {
      const stored = await storedStateAfterListingFailure(
        env,
        "inspect-failed",
        `cannot list Codex plugins via '${codexBin} plugin list --json'`,
      );
      return {
        marketplaceRoot: stored.managerMarketplaceRoot,
        pluginPresent: stored.managerPluginPresent,
        pluginEnabled: stored.managerPluginEnabled,
        activeVersion: null,
        activeRoot: null,
      };
    }
    let manager:
      ReturnType<typeof codexInstalledPluginsFromJson>[number] | undefined;
    let activeVersion: string;
    try {
      const managers = codexInstalledPluginsFromJson(plugins.stdout).filter(
        (plugin) => plugin.pluginId === PLUGIN_ID,
      );
      if (managers.length > 1)
        fail("inspect-failed", "Codex manager plugin appears more than once");
      manager = managers[0];
      activeVersion =
        manager === undefined
          ? ""
          : activePluginVersionFromJson(plugins.stdout, PLUGIN_ID);
    } catch (cause) {
      if (cause instanceof AdapterFailure) throw cause;
      fail(
        "inspect-failed",
        `cannot parse output of '${codexBin} plugin list --json'`,
      );
    }
    const marketplaces = await listingCommand(
      log,
      codexBin,
      ["plugin", "marketplace", "list", "--json"],
      env,
    );
    if (commandFailed(marketplaces)) {
      const stored = await storedStateAfterListingFailure(
        env,
        "inspect-failed",
        `cannot list Codex marketplaces via '${codexBin} plugin marketplace list --json'`,
      );
      return {
        marketplaceRoot: stored.managerMarketplaceRoot,
        pluginPresent: stored.managerPluginPresent,
        pluginEnabled: stored.managerPluginEnabled,
        activeVersion: null,
        activeRoot: null,
      };
    }
    let marketplaceRoot: string;
    try {
      marketplaceRoot = marketplaceRootFromJson(
        marketplaces.stdout,
        MARKETPLACE_NAME,
        true,
      );
    } catch (cause) {
      if (cause instanceof AdapterFailure) throw cause;
      fail(
        "inspect-failed",
        `cannot parse output of '${codexBin} plugin marketplace list --json'`,
      );
    }
    const searchRoot =
      env.SUPERPOWERS_INSTALLED_SEARCH_ROOT || codexHome(env, process.cwd());
    return {
      marketplaceRoot: marketplaceRoot || null,
      pluginPresent: manager !== undefined,
      pluginEnabled: manager?.enabled === true,
      activeVersion: activeVersion || null,
      activeRoot: activeVersion
        ? installedRootForVersion(
            searchRoot,
            MARKETPLACE_NAME,
            "superpowers",
            activeVersion,
          )
        : null,
    };
  });
}

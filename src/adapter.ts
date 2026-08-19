// FROZEN CITATIONS: `scripts/…:NN` references below resolve against the tree at
// ad56569a4c161e7b122967442e2b026eeb6395f6, the last commit in which those paths existed. They are unmaintained
// and will not be re-derived. Resolve one with:
//   git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/common.sh

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
} from "./adapter-result.js";
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
import { validateGeneratedPlugin } from "./generated-plugin.js";
import {
  classifyHooks,
  materializeHooks,
  readManifest,
  type ManifestSource,
} from "./hooks.js";
import { applyManifestOverlay } from "./manifest-overlay.js";
import { readCodexBuildSource } from "./provenance.js";
import type { JsonValue } from "./strict-json.js";
import { isAcceptedSplitValue } from "./validate-generated-plugin-cli.js";
import { withWorkspace, workspaceRemovalFailure } from "./workspace.js";

const PLUGIN_ID = "superpowers@superpowers-manager";
const MARKETPLACE_NAME = "superpowers-manager";
const LEGACY_PLUGIN_ID = "superpowers@superpowers-wrapper";
const LEGACY_MARKETPLACE_NAME = "superpowers-wrapper";

// Re-exported so existing importers of AdapterContext from this module are
// unaffected: the interface itself now lives in adapter-result.js, grouped
// with the other protocol types (AdapterResult, AdapterOutcome) rather than
// with this module's implementation. Not a cycle avoidance — see
// adapter-result.ts's comment on AdapterContext for why a cycle was never
// possible here regardless of import direction.
export type { AdapterContext };

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
  // scripts/core/common.sh:71 is the system's only scrubbing site and it dies
  // with scripts/ in 4c. Without this, NODE_OPTIONS would NEWLY reach codex.
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

// Exported only so tests/unit/adapter.test.js can assert the env scrub
// directly. No production caller uses this name.
export { runCommand as runCommandForTest };

function commandFailed(result: CommandResult): boolean {
  return result.status !== 0;
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
  // The errno is a bounded, enumerable, path-free token — not the cause's
  // message — so the no-interpolation rule does not reach it. The shape guard
  // is what keeps that true: an unvalidated String(cause.code) would be
  // free-form again on a stream the protocol constrains.
  const detail = /^E[A-Z0-9]+$/.test(code) ? `: ${code}` : "";
  return {
    status: 1,
    signal: null,
    stdout: Buffer.alloc(0),
    // Trailing newline matches how a real process writes stderr; appendBytes
    // (src/adapter-result.ts:133) splits on newlines and terminates the
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

        let source: string;
        try {
          // Decoded fatally, not leniently: the file can change between this read and `readManifest`'s read above.
          const rawManifestBytes = await readFile(candidateManifest);
          source = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(rawManifestBytes);
        } catch {
          // Deliberately drops the cause. The Python interpolated the raw
          // OSError here (apply-manifest-overlay.py:42), putting
          // "[Errno 2] No such file or directory" on the operator's stream.
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
            flags["--manager-version"],
            candidateManifest,
          );
        } catch (cause) {
          // applyManifestOverlay's own messages already name the manifest
          // path — three are the frozen CPython wording, and the fourth (the
          // numeric-overflow diagnostic, which has no CPython oracle wording
          // to match) now carries the path via its own rewrap in
          // src/manifest-overlay.ts. Emit as-is, with no added prefix — a
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
          fail(
            "invalid-provenance",
            "candidate provenance is missing or invalid",
          );
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
          { value: flags["--requested-ref"], name: "--requested-ref" },
          { value: flags["--resolved-ref"], name: "--resolved-ref" },
          { value: flags["--commit"], name: "--commit" },
          { value: flags["--manager-version"], name: "--manager-version" },
          { value: manifestSource, name: "--manifest-source" },
          {
            value: flags["--upstream-manifest-version"],
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
            requestedRef: flags["--requested-ref"],
            resolvedRef: flags["--resolved-ref"],
            commit: flags["--commit"],
            manifestVersion: flags["--manager-version"],
            manifestSource,
            upstreamManifestVersion: flags["--upstream-manifest-version"],
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
      },
      { onCleanupFailure: reportOrphanedWorkspace(log) },
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
            marketplaceList.stdout,
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
      { onCleanupFailure: reportOrphanedWorkspace(log) },
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
      { onCleanupFailure: reportOrphanedWorkspace(log) },
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
        { onCleanupFailure: reportOrphanedWorkspace(log) },
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
          let managerPlugin: boolean;
          let legacyPlugin: boolean;
          let managerMarketplace: boolean;
          let legacyMarketplace: boolean;
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
          } catch {
            fail(
              "inspect-failed",
              `cannot parse output of '${codexBin} plugin list --json'`,
            );
          }
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
          };
        },
        { onCleanupFailure: reportOrphanedWorkspace(log) },
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
  const rawOperation = argv[0];
  const operation = rawOperation || "adapter";
  const args = argv.slice(1);
  const env = { ...process.env, ...context.env };
  const log = new AdapterMessageLog();

  try {
    let result: JsonValue;
    if (rawOperation === undefined || rawOperation.length === 0) {
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

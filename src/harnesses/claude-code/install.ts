import { cp, mkdir, mkdtemp, rm, rmdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { readArtifactFile } from "../../artifact-tree.ts";
import {
  failureResult,
  successResult,
  type AdapterContext,
  type AdapterResult,
} from "../../adapter-result.ts";
import {
  atomicWriteFile,
  beginDirectoryPublication,
  type DirectoryPublication,
} from "../../atomic.ts";
import type { InstallReceipt, PreparedArtifact } from "../../harness.ts";
import {
  assertNoFollowType,
  classifyPathNoFollow,
  isErrno,
} from "../../safe-path.ts";
import { displayPath } from "../../validator.ts";
import {
  readClaudeCodeState,
  runClaude,
  type ClaudeCodePlugin,
  type RunClaude,
} from "./native.ts";
import {
  assertClaudeCodeStorageSafe,
  claudeCodePaths,
  type ClaudeCodePaths,
} from "./paths.ts";
import {
  readClaudeCodeManifestVersion,
  readClaudeCodePackageAssessment,
} from "./prepare.ts";
import {
  CLAUDE_CODE_MARKETPLACE,
  CLAUDE_CODE_MARKETPLACE_BYTES,
  CLAUDE_CODE_PLUGIN_ID,
  inspectClaudeCodeMarketplaceStorage,
  leftoverPublicationMaterial,
  managerPlugin,
  marketplaceRegistration,
  type ClaudeCodeRemovalInput,
  type MarketplaceRegistration,
} from "./state.ts";

export { CLAUDE_CODE_MARKETPLACE_BYTES } from "./state.ts";

interface ClaudeCodeInstallDependencies {
  readonly run: RunClaude;
  readonly beginPublication: typeof beginDirectoryPublication;
}

const DEFAULTS: ClaudeCodeInstallDependencies = {
  run: runClaude,
  beginPublication: beginDirectoryPublication,
};

// Carries only hand-written text; anything else becomes a generic message.
class ClaudeCodeStep extends Error {}

interface Start {
  readonly registration: MarketplaceRegistration;
  readonly plugin: ClaudeCodePlugin | undefined;
}

async function native(
  run: RunClaude,
  args: readonly string[],
  ctx: AdapterContext,
): Promise<void> {
  const result = await run(args, ctx);
  if (!result.outcome.ok || result.status !== 0) {
    const reported = result.outcome.ok
      ? undefined
      : /^Claude Code command exited with status ([0-9]{1,3})$/.exec(
          result.outcome.error.message,
        )?.[1];
    const exitStatus =
      reported !== undefined && Number(reported) <= 255
        ? ` (exit status ${reported})`
        : "";
    throw new ClaudeCodeStep(
      `claude ${displayPath(args.join(" "))} did not complete${exitStatus}`,
    );
  }
}

const MANIFEST_LIMIT = 64 * 1024;

interface MarketplaceBefore {
  manifest: Buffer | null;
  createdRoot: boolean;
  createdMetadata: boolean;
  createdPlugins: boolean;
}

async function readMarketplaceManifest(
  paths: ClaudeCodePaths,
): Promise<Buffer | null> {
  const kind = await classifyPathNoFollow(paths.marketplaceManifest);
  if (kind === "missing") return null;
  if (kind !== "regular-file")
    throw new Error("unverified Claude Code marketplace manifest");
  return await readArtifactFile(
    paths.marketplaceRoot,
    paths.marketplaceManifest,
    MANIFEST_LIMIT,
  );
}

async function createDirectoryIfMissing(path: string): Promise<boolean> {
  if ((await classifyPathNoFollow(path)) !== "missing") return false;
  try {
    await mkdir(path);
    return true;
  } catch (cause) {
    if (isErrno(cause, "EEXIST")) return false;
    throw cause;
  }
}

async function writeMarketplaceManifest(paths: ClaudeCodePaths): Promise<void> {
  const path = paths.marketplaceManifest;
  if (
    (await readMarketplaceManifest(paths))?.equals(
      CLAUDE_CODE_MARKETPLACE_BYTES,
    )
  )
    return;
  await atomicWriteFile(path, CLAUDE_CODE_MARKETPLACE_BYTES, {
    validate: async () => {
      await assertNoFollowType(path, ["regular-file", "missing"]);
    },
  });
}

async function removeEmptyDirectory(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (cause) {
    if (!isErrno(cause, "ENOENT")) throw cause;
  }
}

// Restore only bytes and directories this invocation changed. An unexpected
// replacement or extra entry remains in place and makes rollback fail closed.
async function restoreMarketplace(
  paths: ClaudeCodePaths,
  before: MarketplaceBefore,
): Promise<void> {
  const current = await readMarketplaceManifest(paths);
  if (before.manifest === null) {
    if (current !== null) {
      if (!current.equals(CLAUDE_CODE_MARKETPLACE_BYTES))
        throw new Error("Claude Code marketplace manifest changed");
      await unlink(paths.marketplaceManifest);
    }
  } else if (current === null) {
    throw new Error("Claude Code marketplace manifest disappeared");
  } else if (!current.equals(before.manifest)) {
    if (!current.equals(CLAUDE_CODE_MARKETPLACE_BYTES))
      throw new Error("Claude Code marketplace manifest changed");
    await atomicWriteFile(paths.marketplaceManifest, before.manifest, {
      validate: async () => {
        await assertNoFollowType(paths.marketplaceManifest, ["regular-file"]);
      },
    });
  }
  if (before.createdPlugins) await removeEmptyDirectory(paths.pluginsRoot);
  if (before.createdMetadata)
    await removeEmptyDirectory(join(paths.marketplaceRoot, ".claude-plugin"));
  if (before.createdRoot) await removeEmptyDirectory(paths.marketplaceRoot);
}

async function removeVerifiedMarketplace(
  paths: ClaudeCodePaths,
): Promise<void> {
  const storage = await inspectClaudeCodeMarketplaceStorage(paths);
  if (storage === "absent") return;
  if (storage !== "owned")
    throw new Error("unverified Claude Code marketplace storage");
  if ((await classifyPathNoFollow(paths.pluginRoot)) === "directory")
    await rm(paths.pluginRoot, { recursive: true, force: false });
  if (
    (await classifyPathNoFollow(paths.marketplaceManifest)) === "regular-file"
  )
    await unlink(paths.marketplaceManifest);
  for (const path of [
    paths.pluginsRoot,
    join(paths.marketplaceRoot, ".claude-plugin"),
    paths.marketplaceRoot,
  ])
    await removeEmptyDirectory(path);
}

// Undo native steps relative to what step 1 observed, after the snapshot has
// already been restored so a rerun `plugin update` records the restored version.
async function restoreNative(
  start: Start,
  refreshed: boolean,
  paths: ClaudeCodePaths,
  run: RunClaude,
  ctx: AdapterContext,
): Promise<void> {
  const now = await readClaudeCodeState(ctx, run);
  const scope = ["--scope", "user"];
  if (start.registration === "absent") {
    if ((await marketplaceRegistration(now, paths)) === "owned")
      await native(
        run,
        ["plugin", "marketplace", "remove", CLAUDE_CODE_MARKETPLACE],
        ctx,
      );
    return;
  }
  const plugin = managerPlugin(now);
  if (start.plugin === undefined) {
    if (plugin !== undefined)
      await native(
        run,
        ["plugin", "uninstall", CLAUDE_CODE_PLUGIN_ID, ...scope],
        ctx,
      );
    return;
  }
  if (!start.plugin.enabled && plugin?.enabled === true)
    await native(
      run,
      ["plugin", "disable", CLAUDE_CODE_PLUGIN_ID, ...scope],
      ctx,
    );
  if (refreshed)
    await native(
      run,
      ["plugin", "update", CLAUDE_CODE_PLUGIN_ID, ...scope],
      ctx,
    );
}

async function settle(
  operation: string,
  failure: string,
  action: () => Promise<void>,
): Promise<AdapterResult<null>> {
  try {
    await action();
    return successResult(operation, null, []);
  } catch {
    return failureResult(operation, "settlement-failed", failure, [], []);
  }
}

export async function installClaudeCode(
  artifact: PreparedArtifact,
  ctx: AdapterContext,
  deps: ClaudeCodeInstallDependencies = DEFAULTS,
): Promise<AdapterResult<InstallReceipt>> {
  const operation = "install-claude-code";
  const paths = claudeCodePaths(ctx.env ?? {}, process.cwd());
  const scope = ["--scope", "user"];
  let start: Start | undefined;
  let stageContainer: string | undefined;
  let publication: DirectoryPublication | undefined;
  let publicationAttempted = false;
  let refreshed = false;
  let marketplaceBefore: MarketplaceBefore | undefined;
  try {
    await assertClaudeCodeStorageSafe(paths);
    if (artifact.root !== paths.preparedRoot)
      throw new ClaudeCodeStep("unexpected Claude Code prepared root");
    const assessment = await readClaudeCodePackageAssessment(artifact.root);
    if (
      assessment.receipt.digest !== artifact.identity ||
      assessment.receipt.commit !== artifact.commit ||
      assessment.compatibility.kind !== "supported"
    )
      throw new ClaudeCodeStep(
        "the Claude Code prepared artifact changed before activation",
      );
    const leftovers = await leftoverPublicationMaterial(paths);
    if (leftovers.length > 0)
      throw new ClaudeCodeStep(
        `Claude Code recovery required; inspect leftover publication material at ${displayPath(leftovers[0]!)}`,
      );
    const before = await readClaudeCodeState(ctx, deps.run);
    const observed: Start = {
      registration: await marketplaceRegistration(before, paths),
      plugin: managerPlugin(before),
    };
    if (observed.registration === "foreign")
      throw new ClaudeCodeStep(
        `a foreign ${CLAUDE_CODE_MARKETPLACE} Claude Code marketplace is registered`,
      );
    if (observed.registration === "absent") {
      const storage = await inspectClaudeCodeMarketplaceStorage(paths);
      if (storage === "recovery")
        throw new ClaudeCodeStep(
          `Claude Code recovery required; inspect leftover publication material in ${displayPath(paths.pluginsRoot)}`,
        );
      if (storage === "unverified")
        throw new ClaudeCodeStep(
          `unverified Claude Code marketplace storage at ${displayPath(paths.marketplaceRoot)}`,
        );
    }
    const conflicting = before.plugins.find(
      (plugin) =>
        plugin.enabled &&
        plugin.id.startsWith("superpowers@") &&
        plugin.id !== CLAUDE_CODE_PLUGIN_ID &&
        plugin.id !== "superpowers@synced",
    );
    if (conflicting !== undefined) {
      const action = /^superpowers@[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(
        conflicting.id,
      )
        ? `; run claude plugin disable ${conflicting.id} before retrying`
        : "; inspect and disable the competing plugin before retrying";
      throw new ClaudeCodeStep(
        `another Superpowers Claude Code plugin is enabled${action}`,
      );
    }
    start = observed;
    const storageBefore: MarketplaceBefore = {
      manifest: await readMarketplaceManifest(paths),
      createdRoot: false,
      createdMetadata: false,
      createdPlugins: false,
    };
    marketplaceBefore = storageBefore;
    storageBefore.createdRoot = await createDirectoryIfMissing(
      paths.marketplaceRoot,
    );
    storageBefore.createdMetadata = await createDirectoryIfMissing(
      join(paths.marketplaceRoot, ".claude-plugin"),
    );
    storageBefore.createdPlugins = await createDirectoryIfMissing(
      paths.pluginsRoot,
    );
    await assertClaudeCodeStorageSafe(paths);
    await writeMarketplaceManifest(paths);
    stageContainer = await mkdtemp(
      join(paths.pluginsRoot, `.superpowers.stage.${process.pid}.`),
    );
    const stage = join(stageContainer, "superpowers");
    await cp(artifact.root, stage, {
      recursive: true,
      verbatimSymlinks: true,
      force: false,
      errorOnExist: true,
    });
    if (
      (await readClaudeCodePackageAssessment(stage)).receipt.digest !==
      assessment.receipt.digest
    )
      throw new ClaudeCodeStep("the staged Claude Code artifact changed");
    publicationAttempted = true;
    publication = await deps.beginPublication(stage, paths.pluginRoot);
    await rm(stageContainer, { recursive: true, force: true });
    stageContainer = undefined;
    if (start.registration === "absent")
      await native(
        deps.run,
        ["plugin", "marketplace", "add", paths.marketplaceRoot],
        ctx,
      );
    if (start.plugin === undefined) {
      await native(
        deps.run,
        ["plugin", "install", CLAUDE_CODE_PLUGIN_ID, ...scope],
        ctx,
      );
    } else {
      if (!start.plugin.enabled)
        await native(
          deps.run,
          ["plugin", "enable", CLAUDE_CODE_PLUGIN_ID, ...scope],
          ctx,
        );
      // `plugin list` reports the version recorded at install, so a swapped
      // snapshot leaves it stale until `plugin update` recomputes it.
      if (
        start.plugin.version !==
        (await readClaudeCodeManifestVersion(paths.pluginRoot))
      ) {
        refreshed = true;
        await native(
          deps.run,
          ["plugin", "update", CLAUDE_CODE_PLUGIN_ID, ...scope],
          ctx,
        );
      }
    }
    const published = publication;
    const begun = start;
    const wasRefreshed = refreshed;
    const previousMarketplace = marketplaceBefore;
    const backup = displayPath(published.backup ?? paths.pluginsRoot);
    return successResult(
      operation,
      {
        missingVerificationOutput: {
          stdout: [],
          stderr: [
            "error: the Manager Claude Code plugin is not listed after activation",
          ],
        },
        mismatchVerificationOutput: {
          stdout: [],
          stderr: [
            "error: the installed Claude Code plugin does not match the prepared artifact; run `claude plugin list` to inspect load errors",
          ],
        },
        transaction: {
          finalize: () =>
            settle(
              operation,
              `Claude Code activation succeeded but backup cleanup failed at ${backup}`,
              () => published.finalize(),
            ),
          rollback: () =>
            settle(
              operation,
              `Claude Code rollback did not complete; the previous snapshot may not be restored — inspect ${backup}`,
              async () => {
                await published.rollback();
                await restoreNative(begun, wasRefreshed, paths, deps.run, ctx);
                await restoreMarketplace(paths, previousMarketplace);
              },
            ),
        },
      },
      [],
    );
  } catch (cause) {
    const message =
      cause instanceof ClaudeCodeStep
        ? cause.message
        : "cannot activate the Manager-owned Claude Code installation";
    let restored = !publicationAttempted || publication !== undefined;
    if (stageContainer !== undefined) {
      try {
        await rm(stageContainer, { recursive: true, force: true });
      } catch {
        restored = false;
      }
    }
    let snapshotRestored = !publicationAttempted || publication !== undefined;
    if (publication !== undefined) {
      try {
        await publication.rollback();
      } catch {
        restored = false;
        snapshotRestored = false;
      }
    }
    if (snapshotRestored && publication !== undefined && start !== undefined) {
      try {
        await restoreNative(start, refreshed, paths, deps.run, ctx);
      } catch {
        restored = false;
      }
    }
    if (restored && marketplaceBefore !== undefined) {
      try {
        await restoreMarketplace(paths, marketplaceBefore);
      } catch {
        restored = false;
      }
    }
    let recoveryPath = marketplaceBefore?.createdRoot
      ? paths.marketplaceRoot
      : paths.pluginsRoot;
    if (!restored) {
      try {
        const leftovers = await leftoverPublicationMaterial(paths);
        recoveryPath =
          leftovers.find((path) =>
            basename(path).startsWith(".superpowers.bak."),
          ) ??
          leftovers[0] ??
          recoveryPath;
      } catch {
        // The parent path still gives the operator a bounded inspection target.
      }
    }
    return failureResult(
      operation,
      "install-failed",
      restored
        ? message
        : `${message}; the previous Claude Code state may not be restored — inspect ${displayPath(recoveryPath)}`,
      [],
      [],
    );
  }
}

export async function removeClaudeCode(
  input: ClaudeCodeRemovalInput,
  ctx: AdapterContext,
  deps: ClaudeCodeInstallDependencies = DEFAULTS,
): Promise<AdapterResult<null>> {
  const operation = "remove-claude-code";
  const paths = claudeCodePaths(ctx.env ?? {}, process.cwd());
  if (input.registration === "foreign")
    return failureResult(
      operation,
      "foreign-marketplace",
      `refusing to remove a foreign ${CLAUDE_CODE_MARKETPLACE} Claude Code marketplace; remove it manually`,
      [],
      [],
    );
  try {
    await assertClaudeCodeStorageSafe(paths);
    // Shared uninstall never consults update control, and deleting the
    // marketplace would destroy retained recovery material.
    if ((await leftoverPublicationMaterial(paths)).length > 0)
      return failureResult(
        operation,
        "recovery-required",
        `Claude Code recovery required; inspect and remove leftover publication material in ${displayPath(paths.pluginsRoot)} before uninstalling`,
        [],
        [],
      );
    const current = await readClaudeCodeState(ctx, deps.run);
    const registration = await marketplaceRegistration(current, paths);
    if (registration === "foreign")
      return failureResult(
        operation,
        "foreign-marketplace",
        `refusing to remove a foreign ${CLAUDE_CODE_MARKETPLACE} Claude Code marketplace; remove it manually`,
        [],
        [],
      );
    const pluginInstalled = managerPlugin(current) !== undefined;
    const published =
      (await classifyPathNoFollow(paths.marketplaceRoot)) !== "missing";
    if (
      registration !== input.registration ||
      pluginInstalled !== input.pluginInstalled ||
      published !== input.published
    )
      return failureResult(
        operation,
        "stale-ownership",
        "Claude Code marketplace or plugin state changed before removal; inspect it and retry",
        [],
        [],
      );
    if (published) {
      const storage = await inspectClaudeCodeMarketplaceStorage(paths);
      if (storage !== "owned")
        return failureResult(
          operation,
          storage === "recovery"
            ? "recovery-required"
            : "unverified-marketplace",
          storage === "recovery"
            ? `Claude Code recovery required; inspect and remove leftover publication material in ${displayPath(paths.pluginsRoot)} before uninstalling`
            : `refusing to remove unverified Claude Code marketplace storage at ${displayPath(paths.marketplaceRoot)}`,
          [],
          [],
        );
    }
    if (input.registration === "owned")
      await native(
        deps.run,
        ["plugin", "marketplace", "remove", CLAUDE_CODE_MARKETPLACE],
        ctx,
      );
    else if (input.pluginInstalled)
      await native(
        deps.run,
        ["plugin", "uninstall", CLAUDE_CODE_PLUGIN_ID, "--scope", "user"],
        ctx,
      );
    if (input.registration === "owned" || input.pluginInstalled) {
      const after = await readClaudeCodeState(ctx, deps.run);
      if (
        (await marketplaceRegistration(after, paths)) !== "absent" ||
        managerPlugin(after) !== undefined
      )
        return failureResult(
          operation,
          "removal-unverified",
          "Claude Code still lists the Manager marketplace or plugin after removal",
          [],
          [],
        );
    }
  } catch (cause) {
    return failureResult(
      operation,
      "remove-failed",
      cause instanceof ClaudeCodeStep
        ? cause.message
        : "cannot remove the Manager-owned Claude Code registration",
      [],
      [],
    );
  }
  try {
    if (input.published) await removeVerifiedMarketplace(paths);
  } catch {
    return failureResult(
      operation,
      "cleanup-pending",
      `removed the Claude Code registration; cleanup pending at ${displayPath(paths.marketplaceRoot)}`,
      [],
      [],
    );
  }
  return successResult(operation, null, []);
}

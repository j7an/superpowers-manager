import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  failureResult,
  successResult,
  type AdapterContext,
  type AdapterResult,
} from "../../adapter-result.ts";
import type { InstallReceipt, PreparedArtifact } from "../../harness.ts";
import { assertNoFollowType } from "../../safe-path.ts";
import { observeSnapshot } from "../../snapshot-package.ts";
import { displayPath } from "../../validator.ts";
import { runHermes, type RunHermes } from "./native.ts";
import { projectPluginsEnabled, readHermesStatus } from "./observe.ts";
import {
  assertHermesStorageSafe,
  hermesPaths,
  type HermesPaths,
} from "./paths.ts";
import { readHermesPackageAssessment, readHermesReceipt } from "./prepare.ts";
import {
  leftoverHermesPublication,
  observeHermesOwnership,
  otherSuperpowersManifests,
  type HermesRemovalInput,
} from "./state.ts";

export interface HermesInstallDependencies {
  readonly run: RunHermes;
}

const DEFAULTS: HermesInstallDependencies = { run: runHermes };

// Only hand-written diagnostics and bounded native exit statuses enter this type.
class HermesStep extends Error {}

async function native(
  run: RunHermes,
  args: readonly string[],
  ctx: AdapterContext,
): Promise<void> {
  const result = await run(args, ctx);
  if (!result.outcome.ok || result.status !== 0) {
    const reported = result.outcome.ok
      ? undefined
      : /^Hermes command exited with status ([0-9]{1,3})$/.exec(
          result.outcome.error.message,
        )?.[1];
    const status =
      reported !== undefined && Number(reported) <= 255
        ? ` (exit status ${reported})`
        : "";
    throw new HermesStep(`hermes ${args.join(" ")} did not complete${status}`);
  }
}

async function checkPublicationState(paths: HermesPaths): Promise<void> {
  const leftovers = await leftoverHermesPublication(paths);
  if (leftovers.length > 0)
    throw new HermesStep(
      `Hermes recovery required; inspect leftover publication material at ${displayPath(leftovers[0]!)}`,
    );
  const conflicts = await otherSuperpowersManifests(paths);
  if (conflicts.length > 0)
    throw new HermesStep(
      `Hermes discovers another plugin named superpowers at ${displayPath(conflicts[0]!)}`,
    );
}

async function requireSnapshot(root: string, digest: string): Promise<void> {
  const snapshot = await observeSnapshot(root, readHermesReceipt);
  if (snapshot.kind !== "owned" || snapshot.digest !== digest)
    throw new HermesStep("the Hermes snapshot changed during publication");
}

async function verifyRemoved(
  paths: HermesPaths,
  ctx: AdapterContext,
): Promise<void> {
  if (
    (await observeHermesOwnership(paths)).kind !== "absent" ||
    (await readHermesStatus(paths, ctx.env ?? {})) !== "not enabled"
  )
    throw new HermesStep(
      "Hermes still lists Superpowers or its plugin directory is still present after removal",
    );
}

interface Publication {
  readonly container: string;
  readonly stage: string;
  readonly backup: string;
  readonly priorDigest: string | undefined;
  movedBackup: boolean;
  published: boolean;
}

async function rollback(
  publication: Publication,
  identity: string,
  previouslyEnabled: boolean,
  paths: HermesPaths,
  ctx: AdapterContext,
  run: RunHermes,
): Promise<void> {
  await assertHermesStorageSafe(paths);
  await assertNoFollowType(publication.container, ["directory"]);
  const status = await readHermesStatus(paths, ctx.env ?? {});
  if (publication.priorDigest !== undefined) {
    if (publication.movedBackup) {
      await requireSnapshot(publication.backup, publication.priorDigest);
      if (publication.published) {
        await requireSnapshot(paths.pluginRoot, identity);
        await assertNoFollowType(publication.stage, ["missing"]);
        await rename(paths.pluginRoot, publication.stage);
        publication.published = false;
      }
      await assertNoFollowType(paths.pluginRoot, ["missing"]);
      await rename(publication.backup, paths.pluginRoot);
      publication.movedBackup = false;
    }
    await requireSnapshot(paths.pluginRoot, publication.priorDigest);
    if (!previouslyEnabled && status === "enabled") {
      if ((await otherSuperpowersManifests(paths)).length > 0)
        throw new HermesStep(
          "Hermes discovers another plugin named superpowers during rollback",
        );
      await native(run, ["plugins", "disable", "superpowers"], ctx);
      if ((await readHermesStatus(paths, ctx.env ?? {})) !== "disabled")
        throw new HermesStep("Hermes still enables Superpowers after rollback");
    }
  } else if (publication.published) {
    await requireSnapshot(paths.pluginRoot, identity);
    if ((await otherSuperpowersManifests(paths)).length > 0)
      throw new HermesStep(
        "Hermes discovers another plugin named superpowers during rollback",
      );
    await native(run, ["plugins", "remove", "superpowers"], ctx);
    await verifyRemoved(paths, ctx);
    publication.published = false;
  }
  await rm(publication.container, { recursive: true, force: false });
}

async function settle(
  operation: string,
  message: string,
  action: () => Promise<void>,
): Promise<AdapterResult<null>> {
  try {
    await action();
    return successResult(operation, null, []);
  } catch {
    return failureResult(operation, "settlement-failed", message, [], []);
  }
}

export async function installHermes(
  artifact: PreparedArtifact,
  ctx: AdapterContext,
  deps: HermesInstallDependencies = DEFAULTS,
): Promise<AdapterResult<InstallReceipt>> {
  const operation = "install-hermes";
  const paths = hermesPaths(ctx.env ?? {}, process.cwd());
  let publication: Publication | undefined;
  let previouslyEnabled = false;
  try {
    const ownership = await observeHermesOwnership(paths);
    if (ownership.kind === "foreign")
      throw new HermesStep(
        "refusing to replace a foreign Hermes plugin directory; remove it manually",
      );
    await checkPublicationState(paths);
    if (projectPluginsEnabled(ctx.env ?? {}))
      throw new HermesStep(
        "HERMES_ENABLE_PROJECT_PLUGINS is set; unset it before installing Superpowers",
      );
    if (artifact.root !== paths.preparedRoot)
      throw new HermesStep("unexpected Hermes prepared root");
    const assessment = await readHermesPackageAssessment(artifact.root);
    if (
      assessment.receipt.digest !== artifact.identity ||
      assessment.receipt.commit !== artifact.commit ||
      assessment.compatibility.kind !== "supported"
    )
      throw new HermesStep(
        "the Hermes prepared artifact changed before activation",
      );
    previouslyEnabled =
      (await readHermesStatus(paths, ctx.env ?? {})) === "enabled";
    await mkdir(paths.pluginsRoot, { recursive: true });
    await assertHermesStorageSafe(paths);
    const container = await mkdtemp(join(paths.managerRoot, "publish."));
    const pending: Publication = {
      container,
      stage: join(container, "stage"),
      backup: join(container, "backup"),
      priorDigest: ownership.kind === "owned" ? ownership.digest : undefined,
      movedBackup: false,
      published: false,
    };
    publication = pending;
    await cp(artifact.root, pending.stage, {
      recursive: true,
      verbatimSymlinks: true,
      force: false,
      errorOnExist: true,
    });
    const staged = await readHermesPackageAssessment(pending.stage);
    if (
      staged.receipt.digest !== artifact.identity ||
      staged.receipt.commit !== artifact.commit ||
      staged.compatibility.kind !== "supported"
    )
      throw new HermesStep("the staged Hermes artifact changed");
    // Keep backups outside plugins so Hermes discovery sees only the live copy.
    if (ownership.kind === "owned") {
      await requireSnapshot(paths.pluginRoot, ownership.digest);
      await rename(paths.pluginRoot, pending.backup);
      pending.movedBackup = true;
    } else await assertNoFollowType(paths.pluginRoot, ["missing"]);
    await rename(pending.stage, paths.pluginRoot);
    pending.published = true;
    if (!previouslyEnabled)
      await native(deps.run, ["plugins", "enable", "superpowers"], ctx);
    let settled = false;
    return successResult(
      operation,
      {
        missingVerificationOutput: {
          stdout: [],
          stderr: [
            "error: the Manager Hermes plugin is absent after activation",
          ],
        },
        mismatchVerificationOutput: {
          stdout: [],
          stderr: [
            "error: the installed Hermes plugin does not match the prepared artifact; run `hermes plugins list` to inspect load errors",
          ],
        },
        transaction: {
          finalize: () =>
            settle(
              operation,
              `Hermes activation succeeded but backup cleanup failed at ${displayPath(container)}`,
              async () => {
                if (settled) return;
                await assertHermesStorageSafe(paths);
                await assertNoFollowType(container, ["directory"]);
                await requireSnapshot(paths.pluginRoot, artifact.identity);
                if (pending.movedBackup)
                  await requireSnapshot(pending.backup, pending.priorDigest!);
                await rm(container, { recursive: true, force: false });
                settled = true;
              },
            ),
          rollback: () =>
            settle(
              operation,
              `Hermes rollback did not complete; the previous state may not be restored — inspect ${displayPath(container)}`,
              async () => {
                if (settled) return;
                await rollback(
                  pending,
                  artifact.identity,
                  previouslyEnabled,
                  paths,
                  ctx,
                  deps.run,
                );
                settled = true;
              },
            ),
        },
      },
      [],
    );
  } catch (cause) {
    const message =
      cause instanceof HermesStep
        ? cause.message
        : "cannot activate the Manager-owned Hermes installation";
    let restored = true;
    if (publication !== undefined) {
      try {
        if (publication.movedBackup || publication.published)
          await rollback(
            publication,
            artifact.identity,
            previouslyEnabled,
            paths,
            ctx,
            deps.run,
          );
        else {
          await assertNoFollowType(publication.container, ["directory"]);
          await rm(publication.container, { recursive: true, force: false });
        }
      } catch {
        restored = false;
      }
    }
    return failureResult(
      operation,
      "install-failed",
      restored
        ? message
        : `${message}; the previous Hermes state may not be restored — inspect ${displayPath(publication!.container)}`,
      [],
      [],
    );
  }
}

export async function removeHermes(
  input: HermesRemovalInput,
  ctx: AdapterContext,
  deps: HermesInstallDependencies = DEFAULTS,
): Promise<AdapterResult<null>> {
  const operation = "remove-hermes";
  const paths = hermesPaths(ctx.env ?? {}, process.cwd());
  try {
    const ownership = await observeHermesOwnership(paths);
    if (input.ownership === "foreign" || ownership.kind === "foreign")
      throw new HermesStep(
        "refusing to remove a foreign Hermes plugin directory; remove it manually",
      );
    await checkPublicationState(paths);
    const listed =
      (await readHermesStatus(paths, ctx.env ?? {})) !== "not enabled";
    if (input.ownership !== ownership.kind || input.listed !== listed)
      return failureResult(
        operation,
        "stale-ownership",
        "Hermes plugin state changed before removal; inspect it and retry",
        [],
        [],
      );
    if (ownership.kind === "absent") {
      if (listed)
        throw new HermesStep(
          "refusing to remove an unverified Hermes activation entry without an owned plugin directory",
        );
      return successResult(operation, null, []);
    }
    await native(deps.run, ["plugins", "remove", "superpowers"], ctx);
    try {
      await verifyRemoved(paths, ctx);
    } catch {
      return failureResult(
        operation,
        "removal-unverified",
        "Hermes still lists Superpowers or its plugin directory is still present after removal",
        [],
        [],
      );
    }
    return successResult(operation, null, []);
  } catch (cause) {
    return failureResult(
      operation,
      "remove-failed",
      cause instanceof HermesStep
        ? cause.message
        : "cannot remove the Manager-owned Hermes plugin",
      [],
      [],
    );
  }
}

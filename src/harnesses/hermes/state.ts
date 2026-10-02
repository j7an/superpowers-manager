import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  inspectionFailure,
  successResult,
  type AdapterContext,
  type AdapterResult,
} from "../../adapter-result.ts";
import type { EffectiveSelection } from "../../effective-selection.ts";
import type {
  Decision,
  InstalledState,
  OwnershipInspection,
  UpdateControlInspection,
} from "../../harness.ts";
import { classifyPathNoFollow } from "../../safe-path.ts";
import { observeSnapshot, sameSnapshotSource } from "../../snapshot-package.ts";
import { displayPath } from "../../validator.ts";
import {
  findSuperpowersManifests,
  projectPluginsEnabled,
  readHermesStatus,
  type HermesStatus,
} from "./observe.ts";
import {
  assertHermesStorageAncestorsSafe,
  hermesPaths,
  type HermesPaths,
} from "./paths.ts";
import {
  readHermesPackageAssessment,
  readHermesReceipt,
  type HermesReceipt,
} from "./prepare.ts";

export const HERMES_PLUGIN_NAME = "superpowers";
export type HermesOwnership = "absent" | "owned" | "foreign";
export interface HermesRemovalInput {
  readonly ownership: HermesOwnership;
  readonly listed: boolean;
}

type OwnershipObservation =
  | { readonly kind: "absent" | "foreign" }
  | {
      readonly kind: "owned";
      readonly digest: string;
      readonly receipt: HermesReceipt;
    };

export async function observeHermesOwnership(
  paths: HermesPaths,
): Promise<OwnershipObservation> {
  await assertHermesStorageAncestorsSafe(paths);
  const snapshot = await observeSnapshot(paths.pluginRoot, readHermesReceipt);
  return snapshot.kind === "unverified" ? { kind: "foreign" } : snapshot;
}

export async function otherSuperpowersManifests(
  paths: HermesPaths,
): Promise<string[]> {
  await assertHermesStorageAncestorsSafe(paths);
  return (await findSuperpowersManifests(paths)).filter(
    (root) => root !== paths.pluginRoot,
  );
}

interface Facts {
  readonly paths: HermesPaths;
  readonly ownership: OwnershipObservation;
  readonly status: HermesStatus;
  readonly manifests: readonly string[];
  readonly conflicts: readonly string[];
}

async function observeFacts(ctx: AdapterContext): Promise<Facts> {
  const env = ctx.env ?? {};
  const paths = hermesPaths(env, process.cwd());
  const ownership = await observeHermesOwnership(paths);
  const status = await readHermesStatus(paths, env);
  // A foreign leaf is already a blocking decision. Do not scan its contents
  // or pass a symlink to the manifest observer.
  const manifests =
    ownership.kind === "foreign" ? [] : await findSuperpowersManifests(paths);
  return {
    paths,
    ownership,
    status,
    manifests,
    conflicts: manifests.filter((root) => root !== paths.pluginRoot),
  };
}

function blocked(...stderr: string[]): Decision {
  return {
    kind: "blocked",
    output: { stdout: [], stderr: stderr.map(displayPath) },
  };
}

function installDecision(facts: Facts, env: NodeJS.ProcessEnv): Decision {
  if (facts.ownership.kind === "foreign")
    return blocked(
      "error: another Superpowers copy is present in Hermes; remove it manually, then retry:",
      "  hermes plugins remove superpowers",
    );
  if (facts.conflicts.length > 0)
    return blocked(
      "error: Hermes discovers another plugin named superpowers; remove it manually, then retry:",
      ...facts.conflicts.map((path) => `  ${path}`),
    );
  if (projectPluginsEnabled(env))
    return blocked(
      "error: HERMES_ENABLE_PROJECT_PLUGINS is set; a project-local Superpowers copy would override the managed one. Unset HERMES_ENABLE_PROJECT_PLUGINS, then retry.",
    );
  return { kind: "allowed" };
}

export async function inspectHermesOwnership(
  ctx: AdapterContext,
): Promise<AdapterResult<OwnershipInspection<HermesRemovalInput>>> {
  const operation = "inspect-hermes-ownership";
  try {
    const facts = await observeFacts(ctx);
    const listed = facts.status !== "not enabled";
    return successResult(
      operation,
      {
        installEligibility: installDecision(facts, ctx.env ?? {}),
        removalInput: { ownership: facts.ownership.kind, listed },
        removalVerification:
          facts.ownership.kind !== "absent" || listed
            ? blocked(
                "error: Hermes still lists Superpowers or its plugin directory is still present after removal",
              )
            : { kind: "allowed" },
        postRemovalOutput: { stdout: [], stderr: [] },
        presentationValue:
          facts.ownership.kind === "owned"
            ? `managed ${facts.ownership.digest}`
            : facts.ownership.kind === "foreign"
              ? "foreign plugin directory"
              : "absent",
        presentationConflicts: facts.conflicts,
      },
      [],
    );
  } catch {
    return inspectionFailure(operation, "Hermes ownership");
  }
}

export async function inspectHermesInstalled(
  selection: EffectiveSelection,
  ctx: AdapterContext,
): Promise<AdapterResult<InstalledState>> {
  const operation = "inspect-hermes-installed";
  let facts: Facts;
  try {
    facts = await observeFacts(ctx);
  } catch {
    return inspectionFailure(operation, "Hermes installed state");
  }
  if (
    facts.ownership.kind === "absent" &&
    facts.status === "not enabled" &&
    facts.manifests.length === 0
  )
    return successResult<InstalledState>(
      operation,
      { kind: "absent", observedIdentity: "" },
      [],
    );
  const observed =
    facts.ownership.kind === "owned"
      ? facts.ownership.digest
      : facts.ownership.kind === "foreign"
        ? "foreign plugin directory"
        : "listed without an installed snapshot";
  const mismatch = () =>
    successResult<InstalledState>(
      operation,
      { kind: "mismatch", observedIdentity: observed },
      [],
    );
  if (
    facts.ownership.kind !== "owned" ||
    facts.status !== "enabled" ||
    !facts.manifests.includes(facts.paths.pluginRoot) ||
    facts.conflicts.length > 0
  )
    return mismatch();
  try {
    const prepared = await readHermesPackageAssessment(
      facts.paths.preparedRoot,
    );
    if (
      prepared.compatibility.kind !== "supported" ||
      prepared.receipt.commit !== selection.desiredCommit ||
      !sameSnapshotSource(prepared.receipt.source, selection.effectiveSource) ||
      facts.ownership.receipt.commit !== selection.desiredCommit ||
      !sameSnapshotSource(
        facts.ownership.receipt.source,
        selection.effectiveSource,
      ) ||
      facts.ownership.digest !== prepared.receipt.digest
    )
      return mismatch();
  } catch {
    return mismatch();
  }
  return successResult<InstalledState>(
    operation,
    { kind: "current", observedIdentity: observed },
    [],
  );
}

export async function leftoverHermesPublication(
  paths: HermesPaths,
): Promise<string[]> {
  await assertHermesStorageAncestorsSafe(paths);
  if ((await classifyPathNoFollow(paths.managerRoot)) === "missing") return [];
  return (await readdir(paths.managerRoot))
    .filter((name) => name.startsWith("publish."))
    .sort()
    .map((name) => join(paths.managerRoot, name));
}

export async function inspectHermesControl(
  ctx: AdapterContext,
): Promise<AdapterResult<UpdateControlInspection>> {
  const operation = "inspect-hermes-control";
  try {
    const paths = hermesPaths(ctx.env ?? {}, process.cwd());
    const leftovers = await leftoverHermesPublication(paths);
    if (leftovers.length === 0)
      return successResult(
        operation,
        {
          probeEligibility: { kind: "allowed" },
          mutationEligibility: { kind: "allowed" },
          presentationValue: "clear",
        },
        [],
      );
    const decision = blocked(
      "error: Hermes recovery required; inspect and remove leftover publication material manually:",
      ...leftovers.map((path) => `  ${path}`),
    );
    return successResult(
      operation,
      {
        probeEligibility: decision,
        mutationEligibility: decision,
        presentationValue: displayPath(
          `recovery required at ${leftovers.join(", ")}`,
        ),
        recoveryState: "required",
      },
      [],
    );
  } catch {
    return inspectionFailure(operation, "Hermes update control");
  }
}

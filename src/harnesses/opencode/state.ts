import { digestArtifactTree } from "../../artifact-tree.ts";
import {
  failureResult,
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
import { displayPath } from "../../validator.ts";
import {
  inspectOpenCodeDiscovery,
  type OpenCodeDiscovery,
} from "./discovery.ts";
import {
  assessOpenCodeCompatibility,
  readOpenCodePackageAssessment,
  readOpenCodeReceipt,
  sameOpenCodeSource,
  type OpenCodeReceipt,
} from "./package.ts";
import { openCodePaths, type OpenCodePaths } from "./paths.ts";

export interface OpenCodeRemovalInput {
  readonly installedRoot: string;
  readonly registration: {
    readonly observation: OpenCodeDiscovery["managedEntries"][number]["observation"];
    readonly entryIndex: number;
    readonly spec: string;
  } | null;
  readonly receiptDigest: string | null;
}

type SnapshotObservation =
  | { readonly kind: "absent" }
  | { readonly kind: "unverified" }
  | {
      readonly kind: "owned";
      readonly receipt: OpenCodeReceipt;
      readonly digest: string;
    };

interface Facts {
  readonly paths: OpenCodePaths;
  readonly discovery: OpenCodeDiscovery;
  readonly snapshot: SnapshotObservation;
  readonly recovery: "absent" | "required";
}

function blocked(...stderr: string[]): Decision {
  return {
    kind: "blocked",
    output: { stdout: [], stderr: stderr.map((line) => displayPath(line)) },
  };
}

function pathsFor(ctx: AdapterContext): OpenCodePaths {
  return openCodePaths(ctx.env ?? {}, process.cwd());
}

function inspectionFailure<T>(
  operation: string,
  subject: string,
): AdapterResult<T> {
  return failureResult(
    operation,
    "invalid-state",
    `cannot inspect ${subject}`,
    [],
    [],
  );
}

async function observeSnapshot(
  paths: OpenCodePaths,
): Promise<SnapshotObservation> {
  const kind = await classifyPathNoFollow(paths.installedRoot);
  if (kind === "missing") return { kind: "absent" };
  if (kind !== "directory") return { kind: "unverified" };
  try {
    const receipt = await readOpenCodeReceipt(paths.installedRoot);
    const digest = await digestArtifactTree(paths.installedRoot);
    return receipt.digest === digest
      ? { kind: "owned", receipt, digest }
      : { kind: "unverified" };
  } catch {
    return { kind: "unverified" };
  }
}

async function observeFacts(ctx: AdapterContext): Promise<Facts> {
  const paths = pathsFor(ctx);
  const [discovery, snapshot, recoveryKind] = await Promise.all([
    inspectOpenCodeDiscovery(paths, ctx.env ?? {}, process.cwd()),
    observeSnapshot(paths),
    classifyPathNoFollow(paths.recoveryRoot),
  ]);
  if (discovery.managedEntries.length > 1)
    throw new Error("ambiguous Manager registration");
  if (snapshot.kind === "unverified")
    throw new Error("unverified Manager snapshot");
  if (discovery.managedEntries.length === 1 && snapshot.kind === "absent")
    throw new Error("unverified Manager registration");
  return {
    paths,
    discovery,
    snapshot,
    recovery: recoveryKind === "missing" ? "absent" : "required",
  };
}

function mutationDecision(facts: Facts): Decision {
  if (facts.recovery === "required")
    return blocked(
      `error: OpenCode recovery required; preserve material at ${facts.paths.recoveryRoot}`,
    );
  if (facts.discovery.blockedInputs.length > 0)
    return blocked(
      "OpenCode configuration activity could not be established read-only:",
      ...facts.discovery.blockedInputs.map((input) => `- ${input}`),
    );
  if (facts.discovery.conflicts.length > 0)
    return blocked(
      "Conflicting unmanaged Superpowers OpenCode resources require manual resolution:",
      ...facts.discovery.conflicts.map((conflict) => `- ${conflict}`),
      "Remove or disable each resource manually, then retry.",
    );
  return { kind: "allowed" };
}

function registrationFor(facts: Facts): OpenCodeRemovalInput["registration"] {
  const managed = facts.discovery.managedEntries[0];
  return managed === undefined
    ? null
    : {
        observation: managed.observation,
        entryIndex: managed.entry.index,
        spec: managed.entry.spec,
      };
}

function hasUnresolvedRemovalInput(facts: Facts): boolean {
  return facts.discovery.registrationUncertain;
}

export async function inspectOpenCodeOwnership(
  ctx: AdapterContext,
): Promise<AdapterResult<OwnershipInspection<OpenCodeRemovalInput>>> {
  const operation = "inspect-opencode-ownership";
  try {
    const facts = await observeFacts(ctx);
    const registration = registrationFor(facts);
    const removalVerification: Decision =
      registration !== null
        ? blocked(
            "error: the Manager OpenCode registration is still present after removal",
          )
        : facts.snapshot.kind === "owned"
          ? blocked(
              "error: the Manager-owned OpenCode snapshot is still present after removal",
            )
          : hasUnresolvedRemovalInput(facts)
            ? blocked(
                "error: unresolved OpenCode configuration remains after removal",
                ...facts.discovery.blockedInputs.map((input) => `- ${input}`),
              )
            : { kind: "allowed" };
    const conflicts = [
      ...facts.discovery.conflicts,
      ...facts.discovery.blockedInputs.map((input) => `${input} is unresolved`),
    ];
    const presentationValue =
      facts.snapshot.kind === "owned"
        ? registration === null
          ? `managed snapshot ${facts.snapshot.digest}`
          : `managed ${facts.snapshot.digest}`
        : hasUnresolvedRemovalInput(facts)
          ? "unresolved configuration"
          : "absent";
    return successResult(
      operation,
      {
        installEligibility: mutationDecision(facts),
        removalInput: {
          installedRoot: facts.paths.installedRoot,
          registration,
          receiptDigest:
            facts.snapshot.kind === "owned"
              ? facts.snapshot.receipt.digest
              : null,
        },
        removalVerification,
        postRemovalOutput: { stdout: [], stderr: [] },
        presentationValue,
        presentationConflicts: conflicts,
      },
      [],
    );
  } catch {
    return inspectionFailure(operation, "OpenCode ownership");
  }
}

function mismatch(
  operation: string,
  observedIdentity: string,
): AdapterResult<InstalledState> {
  return successResult(operation, { kind: "mismatch", observedIdentity }, []);
}

export async function inspectOpenCodeInstalled(
  selection: EffectiveSelection,
  ctx: AdapterContext,
): Promise<AdapterResult<InstalledState>> {
  const operation = "inspect-opencode-installed";
  let facts: Facts;
  try {
    const paths = pathsFor(ctx);
    const [discovery, snapshot, recoveryKind] = await Promise.all([
      inspectOpenCodeDiscovery(paths, ctx.env ?? {}, process.cwd()),
      observeSnapshot(paths),
      classifyPathNoFollow(paths.recoveryRoot),
    ]);
    facts = {
      paths,
      discovery,
      snapshot,
      recovery: recoveryKind === "missing" ? "absent" : "required",
    };
  } catch {
    return inspectionFailure(operation, "OpenCode installed state");
  }
  if (facts.snapshot.kind === "absent") {
    if (facts.discovery.managedEntries.length > 0)
      return mismatch(operation, "registered without an installed snapshot");
    return hasUnresolvedRemovalInput(facts)
      ? mismatch(operation, "unresolved OpenCode configuration")
      : successResult(operation, { kind: "absent", observedIdentity: "" }, []);
  }
  if (facts.snapshot.kind === "unverified")
    return mismatch(operation, "unverified installed snapshot");
  const observed = facts.snapshot.digest;
  if (facts.discovery.managedEntries.length > 1)
    return inspectionFailure(operation, "OpenCode installed state");
  if (
    facts.discovery.managedEntries.length !== 1 ||
    facts.discovery.conflicts.length > 0 ||
    facts.discovery.blockedInputs.length > 0
  )
    return mismatch(operation, observed);
  try {
    const prepared = await readOpenCodePackageAssessment(
      facts.paths.preparedRoot,
    );
    const installedProfile = await assessOpenCodeCompatibility(
      facts.paths.installedRoot,
      { effectiveSource: facts.snapshot.receipt.source },
    );
    if (
      (prepared.compatibility.kind !== "supported" &&
        prepared.compatibility.kind !== "experimental") ||
      (installedProfile.kind !== "supported" &&
        installedProfile.kind !== "experimental") ||
      prepared.receipt.commit !== selection.desiredCommit ||
      !sameOpenCodeSource(prepared.receipt.source, selection.effectiveSource) ||
      facts.snapshot.receipt.commit !== prepared.receipt.commit ||
      !sameOpenCodeSource(
        facts.snapshot.receipt.source,
        prepared.receipt.source,
      ) ||
      facts.snapshot.digest !== prepared.receipt.digest
    )
      return mismatch(operation, observed);
  } catch {
    return mismatch(operation, observed);
  }
  return successResult(
    operation,
    { kind: "current", observedIdentity: observed },
    [],
  );
}

export async function inspectOpenCodeControl(
  ctx: AdapterContext,
): Promise<AdapterResult<UpdateControlInspection>> {
  const operation = "inspect-opencode-control";
  try {
    const facts = await observeFacts(ctx);
    const mutationEligibility = mutationDecision(facts);
    return successResult(
      operation,
      {
        probeEligibility: { kind: "allowed" },
        mutationEligibility,
        presentationValue:
          facts.recovery === "required"
            ? `recovery required at ${facts.paths.recoveryRoot}`
            : facts.discovery.managedEntries.length === 1
              ? "managed local registration"
              : facts.discovery.conflicts.length > 0 ||
                  facts.discovery.blockedInputs.length > 0
                ? "unmanaged or unresolved configuration"
                : "unregistered",
        ...(facts.recovery === "required"
          ? { recoveryState: "required" as const }
          : {}),
      },
      [],
    );
  } catch {
    return inspectionFailure(operation, "OpenCode update control");
  }
}

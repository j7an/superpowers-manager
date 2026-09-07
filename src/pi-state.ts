import { join } from "node:path";

import {
  failureResult,
  successResult,
  type AdapterContext,
  type AdapterResult,
} from "./adapter-result.ts";
import { readArtifactObject } from "./artifact-tree.ts";
import type { EffectiveSelection } from "./effective-selection.ts";
import type {
  Decision,
  InstalledState,
  OwnershipInspection,
  UpdateControlInspection,
} from "./harness.ts";
import { samePiSource } from "./pi-compatibility.ts";
import {
  digestPiTree,
  readPiPackageAssessment,
  readPiReceipt,
  type PiReceipt,
} from "./pi-package.ts";
import { piPaths, type PiPaths } from "./pi-paths.ts";
import {
  readPiSettings,
  resolvePiLocalSource,
  type PiPackageEntry,
  type PiSettings,
} from "./pi-settings.ts";
import { classifyPathNoFollow } from "./safe-path.ts";

export interface PiRemovalInput {
  readonly installedRoot: string;
  readonly registrationIdentity: string | null;
  readonly receiptDigest: string | null;
}

type SnapshotObservation =
  | { readonly kind: "absent" }
  | { readonly kind: "unverified" }
  | {
      readonly kind: "owned";
      readonly receipt: PiReceipt;
      readonly digest: string;
    };

interface SettingsObservation {
  readonly settings: PiSettings;
  readonly registration: PiPackageEntry | null;
}

const KNOWN_UPSTREAM_PI_SOURCES = new Set([
  "git:github.com/obra/superpowers",
  "https://github.com/obra/superpowers",
  "https://github.com/obra/superpowers.git",
  "ssh://git@github.com/obra/superpowers.git",
]);

function blocked(...stderr: string[]): Decision {
  return { kind: "blocked", output: { stdout: [], stderr } };
}

function pathsFor(ctx: AdapterContext): PiPaths {
  return piPaths(ctx.env ?? {}, process.cwd());
}

async function observeSettings(paths: PiPaths): Promise<SettingsObservation> {
  const settings = await readPiSettings(paths.settingsFile, paths.homeDir);
  let registration: PiPackageEntry | null = null;
  for (const entry of settings.packages) {
    if (
      resolvePiLocalSource(entry.source, paths.agentDir, paths.homeDir) ===
      paths.installedRoot
    ) {
      registration = entry;
    }
  }
  return { settings, registration };
}

async function observeSnapshot(paths: PiPaths): Promise<SnapshotObservation> {
  const kind = await classifyPathNoFollow(paths.installedRoot);
  if (kind === "missing") return { kind: "absent" };
  if (kind !== "directory") return { kind: "unverified" };
  try {
    const receipt = await readPiReceipt(paths.installedRoot);
    const digest = await digestPiTree(paths.installedRoot);
    return receipt.digest === digest
      ? { kind: "owned", receipt, digest }
      : { kind: "unverified" };
  } catch {
    return { kind: "unverified" };
  }
}

async function isNamedLocalSuperpowers(
  entry: PiPackageEntry,
  paths: PiPaths,
): Promise<boolean> {
  const root = resolvePiLocalSource(
    entry.source,
    paths.agentDir,
    paths.homeDir,
  );
  if (root === null || root === paths.installedRoot) return false;
  try {
    const pkg = await readArtifactObject(root, join(root, "package.json"));
    return pkg.name === "superpowers";
  } catch {
    return false;
  }
}

async function unmanagedConflicts(
  settings: PiSettings,
  paths: PiPaths,
): Promise<readonly string[]> {
  const conflicts = new Set<string>();
  for (const entry of settings.packages) {
    if (entry.resourceState === "disabled") continue;
    if (KNOWN_UPSTREAM_PI_SOURCES.has(entry.source.trim())) {
      conflicts.add("registered Pi package for obra/superpowers");
    } else if (await isNamedLocalSuperpowers(entry, paths)) {
      conflicts.add("registered local Pi package named superpowers");
    }
  }
  if (
    (await classifyPathNoFollow(
      join(paths.agentDir, "extensions", "superpowers.ts"),
    )) !== "missing"
  ) {
    conflicts.add("native Pi extension superpowers.ts");
  }
  if (
    (await classifyPathNoFollow(
      join(paths.agentDir, "skills", "using-superpowers", "SKILL.md"),
    )) !== "missing"
  ) {
    conflicts.add("native Pi skill using-superpowers");
  }
  return [...conflicts];
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

export async function inspectPiOwnership(
  ctx: AdapterContext,
): Promise<AdapterResult<OwnershipInspection<PiRemovalInput>>> {
  const operation = "inspect-pi-ownership";
  const paths = pathsFor(ctx);
  try {
    const [{ settings, registration }, snapshot] = await Promise.all([
      observeSettings(paths),
      observeSnapshot(paths),
    ]);
    if (snapshot.kind === "unverified") {
      return inspectionFailure(
        operation,
        `Pi ownership at ${paths.installedRoot}`,
      );
    }
    const conflicts = await unmanagedConflicts(settings, paths);
    let installEligibility: Decision = { kind: "allowed" };
    if (registration?.resourceState === "disabled") {
      installEligibility = blocked(
        "error: the Manager Pi registration disables required resources",
        "Enable both Manager-provided Pi resources manually, then retry.",
      );
    } else if (registration?.resourceState === "indeterminate") {
      installEligibility = blocked(
        "error: the Manager Pi registration uses unsupported resource filters",
        "Remove the filters or enable both Manager-provided Pi resources manually, then retry.",
      );
    } else if (conflicts.length > 0) {
      installEligibility = blocked(
        "Conflicting unmanaged Superpowers Pi resources require manual resolution:",
        ...conflicts.map((conflict) => `- ${conflict}`),
        "Remove or disable each resource manually, then retry.",
      );
    }

    let removalVerification: Decision = { kind: "allowed" };
    if (registration !== null) {
      removalVerification = blocked(
        "error: the Manager Pi package registration is still present after removal",
      );
    } else if (snapshot.kind === "owned") {
      removalVerification = blocked(
        "error: the Manager-owned Pi snapshot is still present after removal",
      );
    }

    const presentationValue =
      snapshot.kind === "owned"
        ? registration === null
          ? `managed snapshot ${snapshot.digest}`
          : `managed ${snapshot.digest}`
        : registration === null
          ? "absent"
          : "registered without an installed snapshot";
    return successResult(
      operation,
      {
        installEligibility,
        removalInput: {
          installedRoot: paths.installedRoot,
          registrationIdentity: registration?.source ?? null,
          receiptDigest:
            snapshot.kind === "owned" ? snapshot.receipt.digest : null,
        },
        removalVerification,
        postRemovalOutput: { stdout: [], stderr: [] },
        presentationValue,
        presentationConflicts: conflicts,
      },
      [],
    );
  } catch {
    return inspectionFailure(
      operation,
      `Pi ownership at ${paths.installedRoot}`,
    );
  }
}

export async function inspectPiInstalled(
  selection: EffectiveSelection,
  ctx: AdapterContext,
): Promise<AdapterResult<InstalledState>> {
  const operation = "inspect-pi-installed";
  const paths = pathsFor(ctx);
  let settings: SettingsObservation;
  let snapshot: SnapshotObservation;
  try {
    [settings, snapshot] = await Promise.all([
      observeSettings(paths),
      observeSnapshot(paths),
    ]);
  } catch {
    return inspectionFailure(
      operation,
      `Pi installed state at ${paths.installedRoot}`,
    );
  }

  if (snapshot.kind === "absent") {
    return successResult(
      operation,
      settings.registration === null
        ? { kind: "absent", observedIdentity: "" }
        : {
            kind: "mismatch",
            observedIdentity: "registered without an installed snapshot",
          },
      [],
    );
  }
  if (snapshot.kind === "unverified") {
    return successResult(
      operation,
      { kind: "mismatch", observedIdentity: "unverified installed snapshot" },
      [],
    );
  }
  const mismatch = successResult<InstalledState>(
    operation,
    { kind: "mismatch", observedIdentity: snapshot.digest },
    [],
  );
  if (
    settings.registration === null ||
    settings.registration.resourceState !== "enabled"
  ) {
    return mismatch;
  }

  try {
    const intended = await readPiPackageAssessment(paths.preparedRoot);
    if (
      (intended.compatibility.kind !== "supported" &&
        intended.compatibility.kind !== "experimental") ||
      intended.receipt.commit !== selection.desiredCommit ||
      !samePiSource(intended.receipt.source, selection.effectiveSource) ||
      snapshot.receipt.commit !== intended.receipt.commit ||
      !samePiSource(snapshot.receipt.source, intended.receipt.source) ||
      snapshot.digest !== intended.receipt.digest
    ) {
      return mismatch;
    }
  } catch {
    return mismatch;
  }
  return successResult(
    operation,
    { kind: "current", observedIdentity: snapshot.digest },
    [],
  );
}

export async function inspectPiControl(
  ctx: AdapterContext,
): Promise<AdapterResult<UpdateControlInspection>> {
  const operation = "inspect-pi-control";
  const paths = pathsFor(ctx);
  try {
    const { settings, registration } = await observeSettings(paths);
    const conflicts = await unmanagedConflicts(settings, paths);
    const probeEligibility: Decision = { kind: "allowed" };
    const mutationEligibility: Decision =
      registration?.resourceState === "disabled"
        ? blocked(
            "error: the Manager Pi registration disables required resources",
          )
        : registration?.resourceState === "indeterminate"
          ? blocked(
              "error: the Manager Pi registration uses unsupported resource filters",
            )
          : conflicts.length > 0
            ? blocked(
                "error: unmanaged Superpowers Pi resources prevent managed update control",
              )
            : { kind: "allowed" };
    return successResult(
      operation,
      {
        probeEligibility,
        mutationEligibility,
        presentationValue:
          registration === null
            ? conflicts.length > 0
              ? "unmanaged conflicts"
              : "unregistered"
            : registration.resourceState === "enabled"
              ? "managed local registration"
              : "manual resource configuration",
      },
      [],
    );
  } catch {
    return inspectionFailure(
      operation,
      `Pi update control at ${paths.settingsFile}`,
    );
  }
}

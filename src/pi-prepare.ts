import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  failureResult,
  successResult,
  type AdapterContext,
  type AdapterResult,
} from "./adapter-result.ts";
import type { EffectiveSelection } from "./effective-selection.ts";
import type {
  PreparationLocation,
  PrepareCandidateInput,
  PreparedArtifact,
  PreparedState,
} from "./harness.ts";
import { ARTIFACT_RECEIPT } from "./artifact-tree.ts";
import { piPaths } from "./pi-paths.ts";
import { assessPiCompatibility, samePiSource } from "./pi-compatibility.ts";
import {
  digestPiTree,
  materializePiTree,
  readPiPackageAssessment,
  piReceiptBinding,
  type PiReceipt,
} from "./pi-package.ts";
import { classifyPathNoFollow } from "./safe-path.ts";

export function piPreparationLocation(
  ctx: AdapterContext,
): PreparationLocation {
  return {
    destinationRoot: piPaths(ctx.env ?? {}, process.cwd()).preparedRoot,
    stagingLeaf: "superpowers",
  };
}

export async function preparePiCandidate(
  input: PrepareCandidateInput,
  _ctx: AdapterContext,
): Promise<AdapterResult<PreparedArtifact>> {
  try {
    await materializePiTree(
      input.upstreamRoot,
      input.selection.desiredCommit,
      input.candidateRoot,
    );
    const compatibility = await assessPiCompatibility(
      input.candidateRoot,
      input.selection,
    );
    if (
      compatibility.kind === "unsupported" ||
      compatibility.kind === "unknown"
    )
      return failureResult(
        "prepare",
        "unsupported",
        compatibility.reason,
        [],
        [],
      );
    const digest = await digestPiTree(input.candidateRoot);
    const identity = {
      schema: 1,
      manager: "superpowers-manager",
      harness: "pi",
      source: input.selection.effectiveSource,
      commit: input.selection.desiredCommit,
      digest,
    } as const;
    const receipt: PiReceipt = {
      ...identity,
      binding: piReceiptBinding(identity),
      compatibility,
    };
    await writeFile(
      join(input.candidateRoot, ARTIFACT_RECEIPT),
      JSON.stringify(receipt) + "\n",
      { flag: "wx" },
    );
    return successResult(
      "prepare",
      {
        root: input.candidateRoot,
        commit: receipt.commit,
        identity: digest,
        compatibility,
      },
      [],
    );
  } catch {
    return failureResult(
      "prepare",
      "invalid-package",
      `cannot prepare Pi artifact: ${input.candidateRoot}`,
      [],
      [],
    );
  }
}

async function readArtifactAssessment(root: string): Promise<{
  readonly artifact: PreparedArtifact;
  readonly receipt: PiReceipt;
}> {
  const { receipt, compatibility } = await readPiPackageAssessment(root);
  return {
    receipt,
    artifact: {
      root,
      commit: receipt.commit,
      identity: receipt.digest,
      compatibility,
    },
  };
}

async function readArtifact(root: string): Promise<PreparedArtifact> {
  const { artifact } = await readArtifactAssessment(root);
  const { compatibility } = artifact;
  if (
    compatibility.kind !== "supported" &&
    compatibility.kind !== "experimental"
  )
    throw new Error("unsupported profile");
  return artifact;
}

export async function inspectPiPrepared(
  selection: EffectiveSelection,
  ctx: AdapterContext,
): Promise<AdapterResult<PreparedState>> {
  const root = piPreparationLocation(ctx).destinationRoot;
  const unknown = {
    kind: "unknown",
    reason: "Pi prepared compatibility evidence is missing",
  } as const;
  try {
    if (
      (await classifyPathNoFollow(join(root, ARTIFACT_RECEIPT))) === "missing"
    )
      return successResult(
        "inspect-prepared",
        { kind: "needs-prepare", observedIdentity: "", compatibility: unknown },
        [],
      );
    const { artifact, receipt } = await readArtifactAssessment(root);
    if (
      artifact.commit !== selection.desiredCommit ||
      !samePiSource(receipt.source, selection.effectiveSource)
    )
      return successResult(
        "inspect-prepared",
        {
          kind: "needs-prepare",
          observedIdentity: artifact.identity,
          compatibility: unknown,
        },
        [],
      );
    if (
      artifact.compatibility.kind !== "supported" &&
      artifact.compatibility.kind !== "experimental"
    )
      return successResult(
        "inspect-prepared",
        {
          kind: "needs-prepare",
          observedIdentity: artifact.identity,
          compatibility: artifact.compatibility,
        },
        [],
      );
    return successResult(
      "inspect-prepared",
      {
        kind: "current",
        artifact,
        observedIdentity: artifact.identity,
        compatibility: artifact.compatibility,
      },
      [],
    );
  } catch {
    return failureResult(
      "inspect-prepared",
      "invalid-package",
      `cannot inspect Pi prepared artifact: ${root}`,
      [],
      [],
    );
  }
}

export async function readPiPrepared(
  ctx: AdapterContext,
): Promise<AdapterResult<PreparedArtifact>> {
  const root = piPreparationLocation(ctx).destinationRoot;
  try {
    return successResult("read-prepared", await readArtifact(root), []);
  } catch {
    return failureResult(
      "read-prepared",
      "invalid-package",
      `cannot read Pi prepared artifact: ${root}`,
      [],
      [],
    );
  }
}

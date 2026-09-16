import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  failureResult,
  successResult,
  type AdapterContext,
  type AdapterResult,
} from "../../adapter-result.ts";
import { ARTIFACT_RECEIPT, digestArtifactTree } from "../../artifact-tree.ts";
import type { EffectiveSelection } from "../../effective-selection.ts";
import { materializeGitTree } from "../../git-tree.ts";
import type {
  PreparationLocation,
  PrepareCandidateInput,
  PreparedArtifact,
  PreparedState,
} from "../../harness.ts";
import { classifyPathNoFollow } from "../../safe-path.ts";
import {
  sameSnapshotSource,
  snapshotReceiptBinding,
} from "../../snapshot-package.ts";
import { assertOpenCodePreparationSeparate, openCodePaths } from "./paths.ts";
import {
  assessOpenCodeCompatibility,
  readOpenCodePackageAssessment,
  type OpenCodeReceipt,
} from "./package.ts";

export function openCodePreparationLocation(
  ctx: AdapterContext,
): PreparationLocation {
  return {
    destinationRoot: openCodePaths(ctx.env ?? {}, process.cwd()).preparedRoot,
    stagingLeaf: "superpowers",
  };
}

export async function validateOpenCodePreparationBeforeFetch(
  ctx: AdapterContext,
): Promise<AdapterResult<null>> {
  try {
    const paths = openCodePaths(ctx.env ?? {}, process.cwd());
    await assertOpenCodePreparationSeparate(paths);
    return successResult("prepare", null, []);
  } catch {
    return failureResult(
      "prepare",
      "invalid-package",
      "cannot validate OpenCode artifact storage",
      [],
      [],
    );
  }
}

export async function prepareOpenCodeCandidate(
  input: PrepareCandidateInput,
  _ctx: AdapterContext,
): Promise<AdapterResult<PreparedArtifact>> {
  try {
    await materializeGitTree(
      input.upstreamRoot,
      input.selection.desiredCommit,
      input.candidateRoot,
    );
    const compatibility = await assessOpenCodeCompatibility(
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
    const digest = await digestArtifactTree(input.candidateRoot);
    const identity = {
      schema: 1,
      manager: "superpowers-manager",
      harness: "opencode",
      source: input.selection.effectiveSource,
      commit: input.selection.desiredCommit,
      digest,
    } as const;
    const receipt: OpenCodeReceipt = {
      ...identity,
      binding: snapshotReceiptBinding(identity),
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
      `cannot prepare OpenCode artifact: ${input.candidateRoot}`,
      [],
      [],
    );
  }
}

function artifactFromAssessment(
  root: string,
  assessment: Awaited<ReturnType<typeof readOpenCodePackageAssessment>>,
): PreparedArtifact {
  const { receipt, compatibility } = assessment;
  if (
    compatibility.kind !== "supported" &&
    compatibility.kind !== "experimental"
  )
    throw new Error("unsupported profile");
  return {
    root,
    commit: receipt.commit,
    identity: receipt.digest,
    compatibility,
  };
}
export async function inspectOpenCodePrepared(
  selection: EffectiveSelection,
  ctx: AdapterContext,
): Promise<AdapterResult<PreparedState>> {
  const root = openCodePreparationLocation(ctx).destinationRoot,
    unknown = {
      kind: "unknown",
      reason: "OpenCode prepared compatibility evidence is missing",
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
    const assessment = await readOpenCodePackageAssessment(root);
    const { receipt, compatibility } = assessment;
    if (
      receipt.commit !== selection.desiredCommit ||
      !sameSnapshotSource(receipt.source, selection.effectiveSource)
    )
      return successResult(
        "inspect-prepared",
        {
          kind: "needs-prepare",
          observedIdentity: receipt.digest,
          compatibility: unknown,
        },
        [],
      );
    if (
      compatibility.kind !== "supported" &&
      compatibility.kind !== "experimental"
    )
      return successResult(
        "inspect-prepared",
        {
          kind: "needs-prepare",
          observedIdentity: receipt.digest,
          compatibility,
        },
        [],
      );
    const artifact = artifactFromAssessment(root, assessment);
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
      `cannot inspect OpenCode prepared artifact: ${root}`,
      [],
      [],
    );
  }
}
export async function readOpenCodePrepared(
  ctx: AdapterContext,
): Promise<AdapterResult<PreparedArtifact>> {
  const root = openCodePreparationLocation(ctx).destinationRoot;
  try {
    return successResult(
      "read-prepared",
      artifactFromAssessment(root, await readOpenCodePackageAssessment(root)),
      [],
    );
  } catch {
    return failureResult(
      "read-prepared",
      "invalid-package",
      `cannot read OpenCode prepared artifact: ${root}`,
      [],
      [],
    );
  }
}

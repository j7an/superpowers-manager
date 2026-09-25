import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  failureResult,
  successResult,
  type AdapterContext,
} from "./adapter-result.ts";
import { ARTIFACT_RECEIPT, digestArtifactTree } from "./artifact-tree.ts";
import type { EffectiveSelection } from "./effective-selection.ts";
import type { Compatibility } from "./harness-compatibility.ts";
import type {
  HarnessAdapter,
  PreparationLocation,
  PreparedArtifact,
} from "./harness.ts";
import { materializeGitTree } from "./git-tree.ts";
import { classifyPathNoFollow } from "./safe-path.ts";
import {
  sameSnapshotSource,
  snapshotReceiptBinding,
  type SnapshotReceiptIdentity,
} from "./snapshot-package.ts";

interface Assessment {
  readonly receipt: Pick<
    SnapshotReceiptIdentity,
    "source" | "commit" | "digest"
  >;
  readonly compatibility: Compatibility;
}

interface Bindings {
  readonly harness: "pi" | "opencode" | "claude-code";
  readonly label: "Pi" | "OpenCode" | "Claude Code";
  readonly preparationLocation: (ctx: AdapterContext) => PreparationLocation;
  readonly assessCompatibility: (
    root: string,
    selection: Pick<EffectiveSelection, "effectiveSource">,
  ) => Promise<Compatibility>;
  readonly readAssessment: (root: string) => Promise<Assessment>;
  // Runs after admission and before the digest, so the receipt covers the
  // rewritten bytes. Only Claude Code passes it.
  readonly rewrite?: (
    root: string,
    selection: EffectiveSelection,
  ) => Promise<void>;
}

type Preparation = Pick<
  HarnessAdapter<never>,
  "prepareCandidate" | "inspectPrepared" | "readPrepared"
>;

export function createSnapshotPreparation(b: Bindings): Preparation {
  const artifactFrom = (root: string, a: Assessment): PreparedArtifact => ({
    root,
    commit: a.receipt.commit,
    identity: a.receipt.digest,
    compatibility: a.compatibility,
  });
  return {
    async prepareCandidate(input) {
      try {
        await materializeGitTree(
          input.upstreamRoot,
          input.selection.desiredCommit,
          input.candidateRoot,
        );
        const compatibility = await b.assessCompatibility(
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
        if (b.rewrite !== undefined)
          await b.rewrite(input.candidateRoot, input.selection);
        const digest = await digestArtifactTree(input.candidateRoot);
        const identity: SnapshotReceiptIdentity = {
          schema: 1,
          manager: "superpowers-manager",
          harness: b.harness,
          source: input.selection.effectiveSource,
          commit: input.selection.desiredCommit,
          digest,
        };
        const receipt = {
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
          artifactFrom(input.candidateRoot, { receipt, compatibility }),
          [],
        );
      } catch {
        return failureResult(
          "prepare",
          "invalid-package",
          `cannot prepare ${b.label} artifact: ${input.candidateRoot}`,
          [],
          [],
        );
      }
    },
    async inspectPrepared(selection, ctx) {
      const root = b.preparationLocation(ctx).destinationRoot;
      const unknown = {
        kind: "unknown" as const,
        reason: `${b.label} prepared compatibility evidence is missing`,
      };
      try {
        if (
          (await classifyPathNoFollow(join(root, ARTIFACT_RECEIPT))) ===
          "missing"
        )
          return successResult(
            "inspect-prepared",
            {
              kind: "needs-prepare",
              observedIdentity: "",
              compatibility: unknown,
            },
            [],
          );
        const assessment = await b.readAssessment(root);
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
        return successResult(
          "inspect-prepared",
          {
            kind: "current",
            artifact: artifactFrom(root, assessment),
            observedIdentity: receipt.digest,
            compatibility,
          },
          [],
        );
      } catch {
        return failureResult(
          "inspect-prepared",
          "invalid-package",
          `cannot inspect ${b.label} prepared artifact: ${root}`,
          [],
          [],
        );
      }
    },
    async readPrepared(ctx) {
      const root = b.preparationLocation(ctx).destinationRoot;
      try {
        const assessment = await b.readAssessment(root);
        if (
          assessment.compatibility.kind !== "supported" &&
          assessment.compatibility.kind !== "experimental"
        )
          throw new Error("unsupported profile");
        return successResult(
          "read-prepared",
          artifactFrom(root, assessment),
          [],
        );
      } catch {
        return failureResult(
          "read-prepared",
          "invalid-package",
          `cannot read ${b.label} prepared artifact: ${root}`,
          [],
          [],
        );
      }
    },
  };
}

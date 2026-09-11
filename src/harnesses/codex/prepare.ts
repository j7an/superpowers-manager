import { cp, mkdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  failureResult,
  successResult,
  type AdapterContext,
  type AdapterResult,
} from "../../adapter-result.ts";
import { codexBuild } from "./adapter.ts";
import { ARTIFACT_RECEIPT } from "../../artifact-tree.ts";
import {
  assessCodexCompatibility,
  readCodexAssessment,
  writeCodexAssessment,
} from "./compatibility.ts";
import type { EffectiveSelection } from "../../effective-selection.ts";
import type { Compatibility } from "../../harness-compatibility.ts";
import type {
  PreparationLocation,
  PrepareCandidateInput,
  PreparedArtifact,
  PreparedState,
} from "../../harness.ts";
import { readManifest } from "./hooks.ts";
import {
  readGeneratedCommitLenient,
  readStrictProvenanceField,
  writeProvenance,
} from "../../provenance.ts";
import { classifyPathNoFollow } from "../../safe-path.ts";
import { SafetyError } from "../../safety-error.ts";
import type { ResolutionKind } from "../../upstream-version.ts";
import { manifestVersionForRef } from "../../upstream-version.ts";
import {
  assertCodexPreparationSeparate,
  codexPathFailureDetails,
  codexPaths,
} from "./paths.ts";
import { readCodexRecovery } from "./recovery.ts";

// Order is inherited from the original prepare command; the first miss wins.
const REQUIRED_UPSTREAM = [
  { path: "skills", label: "skills/" },
  { path: "LICENSE", label: "LICENSE" },
  { path: "README.md", label: "README.md" },
  { path: "CODE_OF_CONDUCT.md", label: "CODE_OF_CONDUCT.md" },
] as const;

const COPY_PATHS = [
  "skills",
  "assets",
  "LICENSE",
  "README.md",
  "CODE_OF_CONDUCT.md",
] as const;

const RESOLUTION_KINDS: readonly ResolutionKind[] = [
  "latest-release",
  "tag",
  "ref",
  "raw-commit",
];

function unassessedCompatibility(): Compatibility {
  return {
    kind: "unknown",
    reason: "Codex compatibility assessment is not available",
  };
}

function prepareError(message: string, cause?: unknown): SafetyError {
  return new SafetyError("prepare", message, { cause });
}

function isControlledPreparationError(cause: unknown): cause is SafetyError {
  return (
    cause instanceof SafetyError &&
    (cause.module === "prepare" ||
      cause.module === "hooks" ||
      cause.module === "provenance")
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function regularFileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function owned<T>(message: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (cause) {
    throw prepareError(message, cause);
  }
}

async function copyPathIfPresent(
  source: string,
  destination: string,
): Promise<void> {
  if (!(await pathExists(source))) return;
  await owned(`cannot clear candidate path: ${destination}`, () =>
    rm(destination, { recursive: true, force: true }),
  );
  await owned(`cannot copy upstream path into candidate: ${source}`, () =>
    cp(source, destination, { recursive: true, verbatimSymlinks: true }),
  );
}

export function resolveFromCwd(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolve(cwd, value);
}

function manifestTemplate(ctx: AdapterContext): string {
  const env = ctx.env ?? {};
  return (
    env.SUPERPOWERS_MANIFEST_TEMPLATE ||
    join(
      ctx.root,
      "plugins",
      "superpowers",
      ".codex-plugin",
      "plugin.template.json",
    )
  );
}

export function codexPreparationLocation(
  ctx: AdapterContext,
): PreparationLocation {
  const env = ctx.env ?? {};
  return {
    destinationRoot:
      env.SUPERPOWERS_PLUGIN_ROOT !== undefined &&
      env.SUPERPOWERS_PLUGIN_ROOT.length > 0
        ? resolveFromCwd(env.SUPERPOWERS_PLUGIN_ROOT, process.cwd())
        : codexPaths(env, process.cwd()).preparedRoot,
    stagingLeaf: "superpowers",
  };
}

export async function validateCodexPreparationBeforeFetch(
  ctx: AdapterContext,
): Promise<AdapterResult<null>> {
  const paths = codexPaths(ctx.env ?? {}, process.cwd());
  const preparedRoot = codexPreparationLocation(ctx).destinationRoot;
  try {
    await assertCodexPreparationSeparate(preparedRoot, paths);
  } catch (cause) {
    const failure = codexPathFailureDetails(cause);
    if (failure?.kind === "inspection") {
      if (failure.root === "recovery") {
        return failureResult(
          "prepare",
          "recovery-required",
          `cannot inspect Codex recovery state at ${paths.recoveryRoot}`,
          [],
          [],
        );
      }
      return failureResult(
        "prepare",
        "prepare-failed",
        failure.root === "marketplace"
          ? `cannot inspect Codex marketplace storage at ${paths.marketplaceRoot}`
          : `cannot inspect Codex preparation root at ${preparedRoot}`,
        [],
        [],
      );
    }
    return failureResult(
      "prepare",
      failure?.kind === "overlap" ? "preparation-overlap" : "prepare-failed",
      failure?.kind === "overlap"
        ? `Codex preparation overlaps Codex published or recovery storage: ${preparedRoot}`
        : `cannot validate Codex preparation storage separation at ${preparedRoot}`,
      [],
      [],
    );
  }
  try {
    if ((await readCodexRecovery(paths)) !== null) {
      return failureResult(
        "prepare",
        "recovery-required",
        `Codex recovery is required before preparation; preserve material at ${paths.recoveryRoot}`,
        [],
        [],
      );
    }
  } catch {
    return failureResult(
      "prepare",
      "recovery-required",
      `cannot inspect Codex recovery state at ${paths.recoveryRoot}`,
      [],
      [],
    );
  }
  const template = manifestTemplate(ctx);
  if (!(await regularFileExists(template))) {
    return failureResult(
      "prepare",
      "missing-template",
      `missing fallback manifest template: ${template}`,
      [],
      [],
    );
  }
  return successResult("prepare", null, []);
}

export async function readUpstreamManifestVersion(
  path: string,
): Promise<string> {
  const manifest = await readManifest(path);
  const value = manifest.version;
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw prepareError(`upstream manifest version is not a string: ${path}`);
  }
  return value;
}

function asResolutionKind(value: string): ResolutionKind {
  for (const kind of RESOLUTION_KINDS) {
    if (kind === value) return kind;
  }
  throw prepareError(`unknown upstream resolution kind: ${value}`);
}

export async function prepareCodexCandidate(
  input: PrepareCandidateInput,
  ctx: AdapterContext,
): Promise<AdapterResult<PreparedArtifact>> {
  let upstreamManifestVersion = "";
  let managerVersion = "";
  try {
    for (const required of REQUIRED_UPSTREAM) {
      if (!(await pathExists(join(input.upstreamRoot, required.path)))) {
        return failureResult(
          "prepare",
          "missing-upstream-path",
          `required upstream path missing: ${required.label}`,
          [],
          [],
        );
      }
    }

    await owned(`cannot clear candidate root: ${input.candidateRoot}`, () =>
      rm(input.candidateRoot, { recursive: true, force: true }),
    );
    await owned(`cannot create candidate root: ${input.candidateRoot}`, () =>
      mkdir(join(input.candidateRoot, ".codex-plugin"), { recursive: true }),
    );
    for (const name of COPY_PATHS) {
      await copyPathIfPresent(
        join(input.upstreamRoot, name),
        join(input.candidateRoot, name),
      );
    }

    const upstreamManifest = join(
      input.upstreamRoot,
      ".codex-plugin",
      "plugin.json",
    );
    if (await regularFileExists(upstreamManifest)) {
      upstreamManifestVersion =
        await readUpstreamManifestVersion(upstreamManifest);
    }

    await writeProvenance(
      join(input.candidateRoot, ".superpowers-upstream.json"),
      {
        source: input.selection.effectiveSource,
        requested_ref: input.selection.requestedRef,
        resolved_ref: input.selection.resolvedRef,
        commit: input.selection.desiredCommit,
        upstream_manifest_version: upstreamManifestVersion,
      },
    );

    managerVersion = manifestVersionForRef({
      requestedRef: input.selection.requestedRef,
      resolutionKind: asResolutionKind(input.selection.resolutionKind),
      resolvedRef: input.selection.resolvedRef,
      commit: input.selection.desiredCommit,
    });
  } catch (cause) {
    // owned()/asResolutionKind(), readManifest(), and writeProvenance replace
    // every subordinate failure with controlled preparation, hook, or
    // provenance text. Re-emitting those owned diagnostics is therefore safe.
    // codexBuild stays below this catch because it deliberately rethrows
    // exceptions its native operation does not own; the shared command must
    // hide those.
    if (!isControlledPreparationError(cause)) throw cause;
    return failureResult("prepare", "prepare-failed", cause.message, [], []);
  }

  const built = await codexBuild(
    {
      upstreamRoot: input.upstreamRoot,
      candidateRoot: input.candidateRoot,
      requestedRef: input.selection.requestedRef,
      resolvedRef: input.selection.resolvedRef,
      commit: input.selection.desiredCommit,
      managerVersion,
      upstreamManifestVersion,
      fallbackManifest: manifestTemplate(ctx),
    },
    ctx,
  );
  if (!built.outcome.ok) {
    return { status: built.status, outcome: built.outcome };
  }
  if (built.status !== 0) {
    return failureResult(
      "build",
      "invalid-status",
      "adapter reported failure without an error outcome",
      [],
      built.outcome.messages,
    );
  }
  const compatibility = await assessCodexCompatibility(
    input.upstreamRoot,
    input.selection,
  );
  if (compatibility.kind === "supported") {
    try {
      await writeCodexAssessment(
        input.candidateRoot,
        input.selection,
        (await regularFileExists(
          join(input.upstreamRoot, ".codex-plugin/plugin.json"),
        ))
          ? "upstream"
          : "fallback",
      );
    } catch {
      return failureResult(
        "prepare",
        "assessment-failed",
        `cannot record Codex compatibility assessment: ${input.candidateRoot}`,
        [],
        built.outcome.messages,
      );
    }
  }
  return successResult(
    built.outcome.operation,
    {
      root: input.candidateRoot,
      commit: input.selection.desiredCommit,
      compatibility,
      identity: input.selection.desiredCommit,
    },
    built.outcome.messages,
  );
}

export async function inspectCodexPrepared(
  selection: EffectiveSelection,
  ctx: AdapterContext,
): Promise<AdapterResult<PreparedState>> {
  const root = codexPreparationLocation(ctx).destinationRoot;
  const observedIdentity = await readGeneratedCommitLenient(
    join(root, ".superpowers-upstream.json"),
  );
  const compatibility = unassessedCompatibility();
  try {
    if (
      (await classifyPathNoFollow(join(root, ARTIFACT_RECEIPT))) === "missing"
    )
      return successResult(
        "inspect-prepared",
        {
          kind: "needs-prepare",
          observedIdentity,
          compatibility,
        },
        [],
      );
    const artifact = await readCodexAssessment(root);
    const source = await readStrictProvenanceField(
      join(artifact.root, ".superpowers-upstream.json"),
      "source",
    );
    if (
      artifact.commit === selection.desiredCommit &&
      source === selection.effectiveSource
    ) {
      if (artifact.compatibility.kind === "supported")
        return successResult(
          "inspect-prepared",
          {
            kind: "current",
            artifact,
            observedIdentity,
            compatibility: artifact.compatibility,
          },
          [],
        );
      return successResult(
        "inspect-prepared",
        {
          kind: "needs-prepare",
          observedIdentity,
          compatibility: artifact.compatibility,
        },
        [],
      );
    }
  } catch {
    return failureResult(
      "inspect-prepared",
      "invalid-assessment",
      `cannot inspect Codex prepared artifact: ${root}`,
      [],
      [],
    );
  }
  return successResult(
    "inspect-prepared",
    {
      kind: "needs-prepare",
      observedIdentity,
      compatibility,
    },
    [],
  );
}

export async function readCodexPrepared(
  ctx: AdapterContext,
): Promise<AdapterResult<PreparedArtifact>> {
  let commit = "";
  try {
    const value = await readStrictProvenanceField(
      join(
        codexPreparationLocation(ctx).destinationRoot,
        ".superpowers-upstream.json",
      ),
      "commit",
    );
    if (typeof value === "string") commit = value;
  } catch {
    // The install path treats malformed metadata as an absent commit.
  }
  if (commit.length === 0) {
    return failureResult(
      "read-prepared",
      "missing-commit",
      "generated metadata missing desired commit after prepare",
      [],
      [],
    );
  }
  try {
    const artifact = await readCodexAssessment(
      codexPreparationLocation(ctx).destinationRoot,
    );
    if (artifact.compatibility.kind !== "supported")
      throw new Error("unsupported profile");
    return successResult("read-prepared", artifact, []);
  } catch {
    return failureResult(
      "read-prepared",
      "invalid-assessment",
      "generated Codex compatibility assessment is missing or invalid",
      [],
      [],
    );
  }
}

import { cp, mkdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  failureResult,
  successResult,
  type AdapterContext,
  type AdapterResult,
} from "./adapter-result.ts";
import { codexBuild, type CodexBuildInput } from "./adapter.ts";
import { commitMatches } from "./domain/fingerprint.ts";
import type { EffectiveSelection } from "./effective-selection.ts";
import type {
  PreparationLocation,
  PrepareCandidateInput,
  PreparedArtifact,
  PreparedState,
} from "./harness.ts";
import { readManifest } from "./hooks.ts";
import {
  generatedCommitOrEmpty,
  generatedMetadataPath,
  readStrictProvenanceField,
  writeProvenance,
} from "./provenance.ts";
import { SafetyError } from "./safety-error.ts";
import type { ResolutionKind } from "./upstream-version.ts";
import { manifestVersionForRef } from "./upstream-version.ts";

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

function prepareError(message: string, cause?: unknown): SafetyError {
  return new SafetyError("prepare", message, { cause });
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
    destinationRoot: resolveFromCwd(
      env.SUPERPOWERS_PLUGIN_ROOT || join(ctx.root, "plugins", "superpowers"),
      process.cwd(),
    ),
    stagingLeaf: "superpowers",
  };
}

export async function validateCodexPreparationBeforeFetch(
  ctx: AdapterContext,
): Promise<AdapterResult<null>> {
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
  return prepareCodexCandidateWithBuild(input, ctx, codexBuild);
}

type CodexCandidateBuild = (
  input: CodexBuildInput,
  ctx: AdapterContext,
) => Promise<AdapterResult>;

// Temporary Task 2 compatibility bridge. The public prepare command keeps its
// injected argv adapter until the shared-command cutover removes this export.
export async function prepareCodexCandidateWithBuild(
  input: PrepareCandidateInput,
  ctx: AdapterContext,
  build: CodexCandidateBuild,
): Promise<AdapterResult<PreparedArtifact>> {
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
  let upstreamManifestVersion = "";
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

  const managerVersion = manifestVersionForRef({
    requestedRef: input.selection.requestedRef,
    resolutionKind: asResolutionKind(input.selection.resolutionKind),
    resolvedRef: input.selection.resolvedRef,
    commit: input.selection.desiredCommit,
  });
  const built = await build(
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
  return successResult(
    built.outcome.operation,
    { root: input.candidateRoot, commit: input.selection.desiredCommit },
    built.outcome.messages,
  );
}

export async function inspectCodexPrepared(
  selection: EffectiveSelection,
  ctx: AdapterContext,
): Promise<AdapterResult<PreparedState>> {
  const observedIdentity = await generatedCommitOrEmpty(ctx.root);
  if (!commitMatches(selection.desiredCommit, observedIdentity)) {
    return successResult(
      "inspect-prepared",
      { kind: "needs-prepare", observedIdentity },
      [],
    );
  }
  return successResult(
    "inspect-prepared",
    {
      kind: "current",
      artifact: {
        root: join(ctx.root, "plugins", "superpowers"),
        commit: observedIdentity,
      },
      observedIdentity,
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
      generatedMetadataPath(ctx.root),
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
  return successResult(
    "read-prepared",
    { root: join(ctx.root, "plugins", "superpowers"), commit },
    [],
  );
}

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import {
  failureResult,
  successResult,
  type AdapterContext,
  type AdapterResult,
} from "../../adapter-result.ts";
import {
  readArtifactFile,
  readArtifactObject,
  validateNativeSkill,
} from "../../artifact-tree.ts";
import { SEMVER_RE } from "../../domain/refs.ts";
import type { EffectiveSelection } from "../../effective-selection.ts";
import type { Compatibility } from "../../harness-compatibility.ts";
import type { PreparedState } from "../../harness.ts";
import { classifyPathNoFollow } from "../../safe-path.ts";
import { SafetyError } from "../../safety-error.ts";
import { validateSource } from "../../selection.ts";
import {
  createSnapshotReceipts,
  type SnapshotReceipt,
} from "../../snapshot-package.ts";
import { createSnapshotPreparation } from "../../snapshot-prepare.ts";
import { manifestVersionForRef } from "../../upstream-version.ts";
import { assertClaudeCodeStorageSafe, claudeCodePaths } from "./paths.ts";

const CLAUDE_CODE_MANIFEST = ".claude-plugin/plugin.json";
const GENERATION = "claude-code-native-plugin-v1";

async function assessClaudeCodeCompatibility(
  root: string,
  selection: Pick<EffectiveSelection, "effectiveSource">,
): Promise<Compatibility> {
  try {
    validateSource(selection.effectiveSource);
    const manifest = await readArtifactObject(
      root,
      join(root, CLAUDE_CODE_MANIFEST),
    );
    if (
      manifest.name !== "superpowers" ||
      typeof manifest.version !== "string" ||
      !SEMVER_RE.test(manifest.version)
    )
      throw new Error("manifest");
    await validateNativeSkill(root);
    const hooks = join(root, "hooks", "hooks.json");
    if ((await classifyPathNoFollow(hooks)) !== "missing")
      await readArtifactObject(root, hooks);
    return {
      kind: "supported",
      generation: GENERATION,
      reason: "native Claude Code plugin",
    };
  } catch {
    return {
      kind: "unsupported",
      reason: `Claude Code package does not provide a native Claude Code plugin: ${root}`,
    };
  }
}

// The ref-aware manifest version for this selection. Two selections of the
// same commit (for example a tag and the raw SHA) yield different versions.
export function expectedClaudeCodeVersion(
  selection: EffectiveSelection,
): string {
  return manifestVersionForRef({
    requestedRef: selection.requestedRef,
    resolutionKind: selection.resolutionKind,
    resolvedRef: selection.resolvedRef,
    commit: selection.desiredCommit,
  });
}

// A targeted edit of the one value: every other upstream byte, including
// formatting and unknown fields, is preserved.
async function rewriteClaudeCodeVersion(
  root: string,
  selection: EffectiveSelection,
): Promise<void> {
  const version = expectedClaudeCodeVersion(selection);
  const path = join(root, CLAUDE_CODE_MANIFEST);
  await readArtifactObject(root, path);
  const text = (await readArtifactFile(root, path)).toString("utf8");
  await writeFile(
    path,
    applyEdits(text, modify(text, ["version"], version, {})),
  );
}

export type ClaudeCodeReceipt = SnapshotReceipt<"claude-code">;

const receipts = createSnapshotReceipts({
  harness: "claude-code",
  label: "Claude Code",
  strictGeneration: true,
  assessCompatibility: assessClaudeCodeCompatibility,
});

export const readClaudeCodeReceipt = receipts.readReceipt;
export const readClaudeCodePackageAssessment = receipts.readAssessment;

export async function readClaudeCodeManifestVersion(
  root: string,
): Promise<string> {
  const manifest = await readArtifactObject(
    root,
    join(root, CLAUDE_CODE_MANIFEST),
  );
  if (typeof manifest.version !== "string")
    throw new SafetyError(
      "claude-code-package",
      `Claude Code manifest has no version: ${root}`,
    );
  return manifest.version;
}

export async function validateClaudeCodePreparationBeforeFetch(
  ctx: AdapterContext,
): Promise<AdapterResult<null>> {
  try {
    await assertClaudeCodeStorageSafe(
      claudeCodePaths(ctx.env ?? {}, process.cwd()),
    );
    return successResult("prepare", null, []);
  } catch {
    return failureResult(
      "prepare",
      "invalid-package",
      "cannot validate Claude Code artifact storage",
      [],
      [],
    );
  }
}

const preparation = createSnapshotPreparation({
  harness: "claude-code",
  label: "Claude Code",
  paths: claudeCodePaths,
  assessCompatibility: assessClaudeCodeCompatibility,
  readAssessment: readClaudeCodePackageAssessment,
  rewrite: rewriteClaudeCodeVersion,
});

export const claudeCodePreparationLocation = preparation.preparationLocation;
export const prepareClaudeCodeCandidate = preparation.prepareCandidate;
// The shared check compares only commit and source, so a same-commit ref
// change would otherwise leave a prepared tree carrying the old version.
export async function inspectClaudeCodePrepared(
  selection: EffectiveSelection,
  ctx: AdapterContext,
): Promise<AdapterResult<PreparedState>> {
  const result = await preparation.inspectPrepared(selection, ctx);
  if (!result.outcome.ok || result.outcome.result.kind !== "current")
    return result;
  const root = result.outcome.result.artifact.root;
  try {
    if (
      (await readClaudeCodeManifestVersion(root)) ===
      expectedClaudeCodeVersion(selection)
    )
      return result;
  } catch {
    return failureResult(
      "inspect-prepared",
      "invalid-package",
      `cannot inspect Claude Code prepared artifact: ${root}`,
      [],
      [],
    );
  }
  return successResult<PreparedState>(
    "inspect-prepared",
    {
      kind: "needs-prepare",
      observedIdentity: result.outcome.result.observedIdentity,
      compatibility: {
        kind: "unknown",
        reason: "Claude Code prepared version does not match the selection",
      },
    },
    [],
  );
}
export const readClaudeCodePrepared = preparation.readPrepared;

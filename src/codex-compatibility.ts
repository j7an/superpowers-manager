import type { EffectiveSelection } from "./effective-selection.ts";
import type { Compatibility } from "./harness-compatibility.ts";
import { join } from "node:path";
import { validateNativeSkill } from "./artifact-tree.ts";
import { classifyPathNoFollow, assertExistingContained } from "./safe-path.ts";
import { classifyHooks, readManifest } from "./hooks.ts";
import { SEMVER_RE } from "./domain/refs.ts";
import { validateSource } from "./selection.ts";
import { writeFile } from "node:fs/promises";
import {
  ARTIFACT_DIGEST_RE,
  ARTIFACT_RECEIPT,
  digestArtifactTree,
  readArtifactObject,
} from "./artifact-tree.ts";
import { COMMIT_RE } from "./domain/refs.ts";
import { validateGeneratedPlugin } from "./generated-plugin.ts";
import type { PreparedArtifact } from "./harness.ts";
import { SafetyError } from "./safety-error.ts";

export async function writeCodexAssessment(
  root: string,
  selection: EffectiveSelection,
  manifestSource: "upstream" | "fallback",
): Promise<void> {
  const receipt = {
    schema: 1,
    manager: "superpowers-manager",
    harness: "codex",
    source: selection.effectiveSource,
    commit: selection.desiredCommit,
    generation: "codex-native-skills-v1",
    manifestSource,
    digest: await digestArtifactTree(root),
  };
  await writeFile(
    join(root, ARTIFACT_RECEIPT),
    JSON.stringify(receipt) + "\n",
    { flag: "wx" },
  );
}

export async function readCodexAssessment(
  root: string,
): Promise<PreparedArtifact> {
  try {
    const receipt = await readArtifactObject(
      root,
      join(root, ARTIFACT_RECEIPT),
    );
    const provenance = await readArtifactObject(
      root,
      join(root, ".superpowers-upstream.json"),
    );
    if (
      receipt.schema !== 1 ||
      receipt.manager !== "superpowers-manager" ||
      receipt.harness !== "codex" ||
      receipt.generation !== "codex-native-skills-v1" ||
      typeof receipt.source !== "string" ||
      typeof receipt.commit !== "string" ||
      !COMMIT_RE.test(receipt.commit) ||
      typeof receipt.digest !== "string" ||
      !ARTIFACT_DIGEST_RE.test(receipt.digest) ||
      (receipt.manifestSource !== "upstream" &&
        receipt.manifestSource !== "fallback") ||
      receipt.source !== provenance.source ||
      receipt.commit !== provenance.commit
    )
      throw new Error("assessment fields");
    validateSource(receipt.source);
    if ((await digestArtifactTree(root)) !== receipt.digest)
      throw new Error("assessment digest");
    const manifest = await readManifest(
      join(root, ".codex-plugin/plugin.json"),
    );
    if (
      typeof manifest.version !== "string" ||
      typeof provenance.requested_ref !== "string" ||
      typeof provenance.resolved_ref !== "string" ||
      typeof provenance.upstream_manifest_version !== "string"
    )
      throw new Error("provenance fields");
    const errors = await validateGeneratedPlugin({
      pluginRoot: root,
      source: receipt.source,
      commit: receipt.commit,
      requestedRef: provenance.requested_ref,
      resolvedRef: provenance.resolved_ref,
      upstreamManifestVersion: provenance.upstream_manifest_version,
      manifestVersion: manifest.version,
      manifestSource: receipt.manifestSource as "upstream" | "fallback",
    });
    if (errors.length) throw new Error("generated resources");
    const selection: EffectiveSelection = {
      effectiveSource: receipt.source,
      desiredCommit: receipt.commit,
      requestedRef: provenance.requested_ref,
      resolvedRef: provenance.resolved_ref,
      resolutionKind: "raw-commit",
      selectionOrigin: "package-default",
      selectionMode: "default",
      upstreamSourceOrigin: "package-default",
      saved: {
        saved_mode: "none",
        saved_source: "",
        saved_requested_ref: "",
        saved_resolved_ref: "",
        saved_commit: "",
      },
    };
    const compatibility = await assessCodexCompatibility(root, selection);
    return {
      root,
      commit: receipt.commit,
      identity: receipt.commit,
      compatibility,
    };
  } catch (cause) {
    throw new SafetyError(
      "codex-compatibility",
      `invalid Codex prepared assessment: ${root}`,
      { cause },
    );
  }
}

export async function assessCodexCompatibility(
  root: string,
  selection: EffectiveSelection,
): Promise<Compatibility> {
  try {
    validateSource(selection.effectiveSource);
    await validateNativeSkill(root);
    for (const path of [
      ".codex/superpowers-codex",
      ".codex/superpowers-bootstrap.md",
    ]) {
      if ((await classifyPathNoFollow(join(root, path))) !== "missing")
        throw new Error("legacy bootstrap");
    }
    const path = join(root, ".codex-plugin/plugin.json");
    if ((await classifyPathNoFollow(path)) !== "missing") {
      await assertExistingContained(root, path);
      const manifest = await readManifest(path);
      if (
        manifest.name !== "superpowers" ||
        typeof manifest.version !== "string" ||
        !SEMVER_RE.test(manifest.version)
      )
        throw new Error("manifest");
      await classifyHooks(manifest, "upstream", root);
    }
    return {
      kind: "supported",
      generation: "codex-native-skills-v1",
      reason: "native Codex skill discovery",
    };
  } catch {
    return {
      kind: "unsupported",
      reason: `Codex package does not provide compatible native skill discovery: ${root}`,
    };
  }
}

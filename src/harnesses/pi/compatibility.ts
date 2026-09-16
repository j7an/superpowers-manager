import { join } from "node:path";
import type { EffectiveSelection } from "../../effective-selection.ts";
import type { Compatibility } from "../../harness-compatibility.ts";
import {
  readArtifactObject,
  validateNativeSkill,
} from "../../artifact-tree.ts";
import { SEMVER_RE } from "../../domain/refs.ts";
import { validateSource } from "../../selection.ts";
import {
  isOfficialSnapshotSource,
  requireNoSnapshotDependencies,
  requireSnapshotBootstrap,
} from "../../snapshot-package.ts";

export async function assessPiCompatibility(
  root: string,
  selection: Pick<EffectiveSelection, "effectiveSource">,
): Promise<Compatibility> {
  try {
    validateSource(selection.effectiveSource);
    const official = isOfficialSnapshotSource(selection.effectiveSource);
    const pkg = await readArtifactObject(root, join(root, "package.json"));
    if (
      pkg.name !== "superpowers" ||
      pkg.type !== "module" ||
      typeof pkg.version !== "string" ||
      !SEMVER_RE.test(pkg.version)
    )
      throw new Error("package metadata");
    const pi = pkg.pi;
    if (
      !pi ||
      typeof pi !== "object" ||
      Array.isArray(pi) ||
      Object.keys(pi).length !== 2 ||
      JSON.stringify(pi.extensions) !== '["./.pi/extensions/superpowers.ts"]' ||
      JSON.stringify(pi.skills) !== '["./skills"]'
    )
      throw new Error("resource declaration");
    requireNoSnapshotDependencies(pkg);
    await validateNativeSkill(root);
    await requireSnapshotBootstrap(
      root,
      ".pi/extensions/superpowers.ts",
      4283,
      "39c27000c047f8a1399a76e032e4cd239d7bdb0be168a121f46a2ac719deaae0",
    );
    return {
      kind: official ? "supported" : "experimental",
      generation: "pi-native-bootstrap-v1",
      reason: official
        ? "qualified upstream-native Pi bootstrap"
        : "qualified Pi mechanics from a custom source",
    };
  } catch {
    return {
      kind: "unsupported",
      reason: `Pi package does not match the qualified native bootstrap profile: ${root}`,
    };
  }
}

import { join } from "node:path";
import {
  readArtifactObject,
  validateNativeSkill,
} from "../../artifact-tree.ts";
import { SEMVER_RE } from "../../domain/refs.ts";
import type { EffectiveSelection } from "../../effective-selection.ts";
import type { Compatibility } from "../../harness-compatibility.ts";
import { classifyPathNoFollow } from "../../safe-path.ts";
import { validateSource } from "../../selection.ts";
import {
  createSnapshotReceipts,
  isOfficialSnapshotSource,
  requireNoSnapshotDependencies,
  requireSnapshotBootstrap,
  type SnapshotReceipt,
} from "../../snapshot-package.ts";

const BOOTSTRAP = ".opencode/plugins/superpowers.js";
const ENTRYPOINT = "index.js";
export async function assessOpenCodeCompatibility(
  root: string,
  selection: Pick<EffectiveSelection, "effectiveSource">,
): Promise<Compatibility> {
  try {
    validateSource(selection.effectiveSource);
    const pkg = await readArtifactObject(root, join(root, "package.json"));
    if (
      pkg.name !== "superpowers" ||
      pkg.type !== "module" ||
      pkg.main !== BOOTSTRAP ||
      typeof pkg.version !== "string" ||
      !SEMVER_RE.test(pkg.version)
    )
      throw new Error("package metadata");
    requireNoSnapshotDependencies(pkg);
    await validateNativeSkill(root);
    await requireSnapshotBootstrap(root, BOOTSTRAP);
    const v1 =
      (await classifyPathNoFollow(join(root, ENTRYPOINT))) === "missing";
    if (!v1) await requireSnapshotBootstrap(root, ENTRYPOINT);
    const generation = v1
      ? "opencode-native-bootstrap-v1"
      : "opencode-native-bootstrap-v2";
    const official = isOfficialSnapshotSource(selection.effectiveSource);
    return {
      kind: official ? "supported" : "experimental",
      generation,
      reason: official
        ? "upstream-native OpenCode bootstrap"
        : "upstream-native OpenCode bootstrap from a custom source",
    };
  } catch {
    return {
      kind: "unsupported",
      reason: `OpenCode package does not provide a native OpenCode bootstrap: ${root}`,
    };
  }
}
export type OpenCodeReceipt = SnapshotReceipt<"opencode">;

const receipts = createSnapshotReceipts({
  harness: "opencode",
  label: "OpenCode",
  strictGeneration: true,
  assessCompatibility: assessOpenCodeCompatibility,
});

export const readOpenCodeReceipt = receipts.readReceipt;
export const readOpenCodePackageAssessment = receipts.readAssessment;

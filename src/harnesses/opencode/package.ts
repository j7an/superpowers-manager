import { join } from "node:path";
import {
  readArtifactObject,
  validateNativeSkill,
} from "../../artifact-tree.ts";
import { SEMVER_RE } from "../../domain/refs.ts";
import type { EffectiveSelection } from "../../effective-selection.ts";
import type { Compatibility } from "../../harness-compatibility.ts";
import { assertNoFollowType } from "../../safe-path.ts";
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
// Exact-byte allowlist, matched as a unit: a bootstrap and the V2 entrypoint
// that shipped with it were qualified together in the native container. Adding
// either half alone would admit a combination no container ever ran. Every
// upstream change needs re-qualification before its bytes are added here.
const QUALIFIED_PROFILES = [
  {
    // obra/superpowers v6.0.0-v6.3.0 — no V2 entrypoint shipped
    bootstrap: {
      size: 5464,
      sha256:
        "a5c5e1dbb0abfbd6ec3322b724b9a7b3318bbbb3d83f9a661c56ae0ed0a3adb8",
    },
    entrypoint: null,
  },
  {
    // obra/superpowers v6.4.1
    bootstrap: {
      size: 17617,
      sha256:
        "c979fe5a9fd6fddc9bc9730b34b25989f9d53939eed7d594c4564f6e47495f26",
    },
    entrypoint: {
      size: 536,
      sha256:
        "f0132fd5339befeb99ba903b1619fd9530969e5b4a1ea8cecf0b0a7f0213a099",
    },
  },
] as const;
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
    const matched = await Promise.any(
      QUALIFIED_PROFILES.map(async (profile) => {
        await requireSnapshotBootstrap(
          root,
          BOOTSTRAP,
          profile.bootstrap.size,
          profile.bootstrap.sha256,
        );
        if (profile.entrypoint === null)
          await assertNoFollowType(join(root, ENTRYPOINT), ["missing"]);
        else
          await requireSnapshotBootstrap(
            root,
            ENTRYPOINT,
            profile.entrypoint.size,
            profile.entrypoint.sha256,
          );
        return profile;
      }),
    );
    const generation =
      matched.entrypoint === null
        ? "opencode-native-bootstrap-v1"
        : "opencode-native-bootstrap-v2";
    const official = isOfficialSnapshotSource(selection.effectiveSource);
    return {
      kind: official ? "supported" : "experimental",
      generation,
      reason: official
        ? "qualified upstream-native OpenCode bootstrap"
        : "qualified OpenCode mechanics from a custom source",
    };
  } catch {
    return {
      kind: "unsupported",
      reason: `OpenCode package does not match the qualified native bootstrap profile: ${root}`,
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

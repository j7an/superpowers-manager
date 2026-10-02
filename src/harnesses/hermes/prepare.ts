import { readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  failureResult,
  successResult,
  type AdapterContext,
  type AdapterResult,
} from "../../adapter-result.ts";
import { readArtifactFile, validateNativeSkill } from "../../artifact-tree.ts";
import type { EffectiveSelection } from "../../effective-selection.ts";
import type { Compatibility } from "../../harness-compatibility.ts";
import { assertNoFollowType, classifyPathNoFollow } from "../../safe-path.ts";
import { SafetyError } from "../../safety-error.ts";
import { validateSource } from "../../selection.ts";
import {
  createSnapshotReceipts,
  type SnapshotReceipt,
} from "../../snapshot-package.ts";
import { createSnapshotPreparation } from "../../snapshot-prepare.ts";
import { assertHermesStorageSafe, hermesPaths } from "./paths.ts";

export async function flattenHermesPlugin(root: string): Promise<void> {
  const nativeRoot = join(root, ".hermes-plugin");
  if ((await classifyPathNoFollow(nativeRoot)) !== "directory") return;
  const entries = await readdir(nativeRoot);
  if (entries.some((entry) => entry === "skills" || entry === "LICENSE"))
    throw new SafetyError(
      "hermes-package",
      `Hermes plugin layout collides with shared content: ${root}`,
    );
  for (const entry of await readdir(root))
    if (entry !== ".hermes-plugin" && entry !== "skills" && entry !== "LICENSE")
      await rm(join(root, entry), { recursive: true, force: true });
  for (const entry of entries)
    await rename(join(nativeRoot, entry), join(root, entry));
  await rm(nativeRoot, { recursive: true });
  await writeFile(join(root, "__pycache__"), "", { flag: "wx" });
}

async function assessHermesCompatibility(
  root: string,
  selection: Pick<EffectiveSelection, "effectiveSource">,
): Promise<Compatibility> {
  try {
    validateSource(selection.effectiveSource);
    await readArtifactFile(root, join(root, "__pycache__"), 0);
    for (const relative of [
      "plugin.yaml",
      "__init__.py",
      "skills/using-superpowers/references/hermes-tools.md",
    ])
      await assertNoFollowType(join(root, relative), ["regular-file"]);
    await validateNativeSkill(root);
    return {
      kind: "supported",
      generation: "hermes-flat-plugin-v1",
      reason: "native Hermes plugin",
    };
  } catch {
    return {
      kind: "unsupported",
      reason: `Hermes package does not provide a native Hermes plugin: ${root}`,
    };
  }
}

export type HermesReceipt = SnapshotReceipt<"hermes">;
const receipts = createSnapshotReceipts({
  harness: "hermes",
  label: "Hermes",
  strictGeneration: true,
  assessCompatibility: assessHermesCompatibility,
});
export const readHermesReceipt = receipts.readReceipt;
export const readHermesPackageAssessment = receipts.readAssessment;

export async function validateHermesPreparationBeforeFetch(
  ctx: AdapterContext,
): Promise<AdapterResult<null>> {
  try {
    await assertHermesStorageSafe(hermesPaths(ctx.env ?? {}, process.cwd()));
    return successResult("prepare", null, []);
  } catch {
    return failureResult(
      "prepare",
      "invalid-package",
      "cannot validate Hermes artifact storage",
      [],
      [],
    );
  }
}

const preparation = createSnapshotPreparation({
  harness: "hermes",
  label: "Hermes",
  paths: hermesPaths,
  assessCompatibility: assessHermesCompatibility,
  readAssessment: readHermesPackageAssessment,
  layout: flattenHermesPlugin,
});
export const hermesPreparationLocation = preparation.preparationLocation;
export const prepareHermesCandidate = preparation.prepareCandidate;
export const inspectHermesPrepared = preparation.inspectPrepared;
export const readHermesPrepared = preparation.readPrepared;

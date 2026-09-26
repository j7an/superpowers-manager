import {
  failureResult,
  successResult,
  type AdapterContext,
  type AdapterResult,
} from "../../adapter-result.ts";
import { createSnapshotPreparation } from "../../snapshot-prepare.ts";
import { assertOpenCodePreparationSeparate, openCodePaths } from "./paths.ts";
import {
  assessOpenCodeCompatibility,
  readOpenCodePackageAssessment,
} from "./package.ts";

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

const preparation = createSnapshotPreparation({
  harness: "opencode",
  label: "OpenCode",
  paths: openCodePaths,
  assessCompatibility: assessOpenCodeCompatibility,
  readAssessment: readOpenCodePackageAssessment,
});

export const openCodePreparationLocation = preparation.preparationLocation;
export const prepareOpenCodeCandidate = preparation.prepareCandidate;
export const inspectOpenCodePrepared = preparation.inspectPrepared;
export const readOpenCodePrepared = preparation.readPrepared;

import type { AdapterContext } from "../../adapter-result.ts";
import type { PreparationLocation } from "../../harness.ts";
import { createSnapshotPreparation } from "../../snapshot-prepare.ts";
import { piPaths } from "./paths.ts";
import { assessPiCompatibility } from "./compatibility.ts";
import { readPiPackageAssessment } from "./package.ts";

export function piPreparationLocation(
  ctx: AdapterContext,
): PreparationLocation {
  return {
    destinationRoot: piPaths(ctx.env ?? {}, process.cwd()).preparedRoot,
    stagingLeaf: "superpowers",
  };
}

const preparation = createSnapshotPreparation({
  harness: "pi",
  label: "Pi",
  preparationLocation: piPreparationLocation,
  assessCompatibility: assessPiCompatibility,
  readAssessment: readPiPackageAssessment,
});

export const preparePiCandidate = preparation.prepareCandidate;
export const inspectPiPrepared = preparation.inspectPrepared;
export const readPiPrepared = preparation.readPrepared;

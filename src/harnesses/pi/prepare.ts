import { createSnapshotPreparation } from "../../snapshot-prepare.ts";
import { assessPiCompatibility } from "./compatibility.ts";
import { readPiPackageAssessment } from "./package.ts";
import { piPaths } from "./paths.ts";

const preparation = createSnapshotPreparation({
  harness: "pi",
  label: "Pi",
  paths: piPaths,
  assessCompatibility: assessPiCompatibility,
  readAssessment: readPiPackageAssessment,
});

export const piPreparationLocation = preparation.preparationLocation;
export const preparePiCandidate = preparation.prepareCandidate;
export const inspectPiPrepared = preparation.inspectPrepared;
export const readPiPrepared = preparation.readPrepared;

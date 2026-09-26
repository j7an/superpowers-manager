import {
  createSnapshotReceipts,
  type SnapshotReceipt,
} from "../../snapshot-package.ts";
import { assessPiCompatibility } from "./compatibility.ts";

export type PiReceipt = SnapshotReceipt<"pi">;

const receipts = createSnapshotReceipts({
  harness: "pi",
  label: "Pi",
  strictGeneration: false,
  assessCompatibility: assessPiCompatibility,
});

export const readPiReceipt = receipts.readReceipt;
export const readPiPackageAssessment = receipts.readAssessment;

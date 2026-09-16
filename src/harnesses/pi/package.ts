import { join } from "node:path";
import {
  ARTIFACT_DIGEST_RE,
  ARTIFACT_RECEIPT,
  digestArtifactTree,
  readArtifactObject,
} from "../../artifact-tree.ts";
import { COMMIT_RE } from "../../domain/refs.ts";
import type { Compatibility } from "../../harness-compatibility.ts";
import { SafetyError } from "../../safety-error.ts";
import { validateSource } from "../../selection.ts";
import { assessPiCompatibility } from "./compatibility.ts";
import { snapshotReceiptBinding } from "../../snapshot-package.ts";

export interface PiReceipt {
  readonly schema: 1;
  readonly manager: "superpowers-manager";
  readonly harness: "pi";
  readonly source: string;
  readonly commit: string;
  readonly digest: string;
  readonly binding: string;
  readonly compatibility: Compatibility;
}

export async function readPiReceipt(root: string): Promise<PiReceipt> {
  const path = join(root, ARTIFACT_RECEIPT);
  try {
    const value = await readArtifactObject(root, path);
    if (
      value.schema !== 1 ||
      value.manager !== "superpowers-manager" ||
      value.harness !== "pi" ||
      typeof value.source !== "string" ||
      typeof value.commit !== "string" ||
      !COMMIT_RE.test(value.commit) ||
      typeof value.digest !== "string" ||
      !ARTIFACT_DIGEST_RE.test(value.digest) ||
      typeof value.binding !== "string" ||
      !ARTIFACT_DIGEST_RE.test(value.binding)
    )
      throw new Error("receipt fields");
    validateSource(value.source);
    if (snapshotReceiptBinding(value as unknown as PiReceipt) !== value.binding)
      throw new Error("receipt binding");
    const compatibility = value.compatibility;
    if (
      !compatibility ||
      typeof compatibility !== "object" ||
      Array.isArray(compatibility) ||
      typeof compatibility.reason !== "string" ||
      typeof compatibility.kind !== "string" ||
      !["unknown", "unsupported", "supported", "experimental"].includes(
        compatibility.kind,
      ) ||
      ((compatibility.kind === "supported" ||
        compatibility.kind === "experimental") &&
        typeof compatibility.generation !== "string")
    )
      throw new Error("receipt compatibility");
    return value as unknown as PiReceipt;
  } catch (cause) {
    throw new SafetyError(
      "pi-package",
      `invalid Pi artifact receipt: ${path}`,
      { cause },
    );
  }
}

export async function readPiPackageAssessment(root: string): Promise<{
  readonly receipt: PiReceipt;
  readonly compatibility: Compatibility;
}> {
  const receipt = await readPiReceipt(root);
  if ((await digestArtifactTree(root)) !== receipt.digest)
    throw new SafetyError("pi-package", `Pi artifact digest mismatch: ${root}`);
  const compatibility = await assessPiCompatibility(root, {
    effectiveSource: receipt.source,
  });
  return { receipt, compatibility };
}

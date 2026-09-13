import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  ARTIFACT_DIGEST_RE,
  ARTIFACT_RECEIPT,
  addArtifactHashField,
  digestArtifactTree,
  readArtifactObject,
} from "../../artifact-tree.ts";
import { COMMIT_RE } from "../../domain/refs.ts";
import type { Compatibility } from "../../harness-compatibility.ts";
import { SafetyError } from "../../safety-error.ts";
import { validateSource } from "../../selection.ts";
import { assessPiCompatibility } from "./compatibility.ts";

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

// A consistency checksum, not authentication. A coherent manual rewrite of
// both receipt and bytes remains possible; installed comparison must still use
// an independently validated candidate.
export function piReceiptBinding(
  receipt: Pick<
    PiReceipt,
    "schema" | "manager" | "harness" | "source" | "commit" | "digest"
  >,
): string {
  const hash = createHash("sha256");
  for (const field of [
    String(receipt.schema),
    receipt.manager,
    receipt.harness,
    receipt.source,
    receipt.commit,
    receipt.digest,
  ])
    addArtifactHashField(hash, Buffer.from(field));
  return hash.digest("hex");
}

export async function digestPiTree(root: string): Promise<string> {
  return await digestArtifactTree(root);
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
    if (piReceiptBinding(value as unknown as PiReceipt) !== value.binding)
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
  if ((await digestPiTree(root)) !== receipt.digest)
    throw new SafetyError("pi-package", `Pi artifact digest mismatch: ${root}`);
  const compatibility = await assessPiCompatibility(root, {
    effectiveSource: receipt.source,
  });
  return { receipt, compatibility };
}

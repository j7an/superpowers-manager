import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  ARTIFACT_DIGEST_RE,
  ARTIFACT_RECEIPT,
  addArtifactHashField,
  digestArtifactTree,
  readArtifactFile,
  readArtifactObject,
  validateNativeSkill,
} from "../../artifact-tree.ts";
import { COMMIT_RE, SEMVER_RE } from "../../domain/refs.ts";
import type { EffectiveSelection } from "../../effective-selection.ts";
import type { Compatibility } from "../../harness-compatibility.ts";
import { validateSource } from "../../selection.ts";
import { SafetyError } from "../../safety-error.ts";

const OFFICIAL = new Set([
  "https://github.com/obra/superpowers",
  "https://github.com/obra/superpowers.git",
  "ssh://git@github.com/obra/superpowers.git",
  "git@github.com:obra/superpowers.git",
]);
const BOOTSTRAP = ".opencode/plugins/superpowers.js";
const BOOTSTRAP_SIZE = 5464;
const BOOTSTRAP_SHA256 =
  "a5c5e1dbb0abfbd6ec3322b724b9a7b3318bbbb3d83f9a661c56ae0ed0a3adb8";
export interface OpenCodeReceipt {
  readonly schema: 1;
  readonly manager: "superpowers-manager";
  readonly harness: "opencode";
  readonly source: string;
  readonly commit: string;
  readonly digest: string;
  readonly binding: string;
  readonly compatibility: Compatibility;
}

function isReceiptCompatibility(value: unknown): value is Compatibility {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const compatibility = value as Record<string, unknown>;
  if (typeof compatibility.reason !== "string") return false;
  if (
    compatibility.kind === "supported" ||
    compatibility.kind === "experimental"
  )
    return typeof compatibility.generation === "string";
  return (
    (compatibility.kind === "unknown" ||
      compatibility.kind === "unsupported") &&
    compatibility.generation === undefined
  );
}
export function openCodeReceiptBinding(
  receipt: Pick<
    OpenCodeReceipt,
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
export function sameOpenCodeSource(left: string, right: string): boolean {
  validateSource(left);
  validateSource(right);
  return left === right || (OFFICIAL.has(left) && OFFICIAL.has(right));
}
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
    for (const key of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
      "bundleDependencies",
      "bundledDependencies",
    ]) {
      const value = pkg[key];
      if (
        value !== undefined &&
        (value === null ||
          typeof value !== "object" ||
          Object.keys(value).length !== 0)
      )
        throw new Error("runtime dependencies");
    }
    await validateNativeSkill(root);
    const bootstrap = join(root, BOOTSTRAP),
      bytes = await readArtifactFile(root, bootstrap, BOOTSTRAP_SIZE);
    if (
      (await lstat(bootstrap)).mode & 0o111 ||
      bytes.length !== BOOTSTRAP_SIZE ||
      createHash("sha256").update(bytes).digest("hex") !== BOOTSTRAP_SHA256
    )
      throw new Error("bootstrap implementation");
    const official = OFFICIAL.has(selection.effectiveSource);
    return {
      kind: official ? "supported" : "experimental",
      generation: "opencode-native-bootstrap-v1",
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
export async function readOpenCodeReceipt(
  root: string,
): Promise<OpenCodeReceipt> {
  const path = join(root, ARTIFACT_RECEIPT);
  try {
    const value = await readArtifactObject(root, path);
    if (
      value.schema !== 1 ||
      value.manager !== "superpowers-manager" ||
      value.harness !== "opencode" ||
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
    if (
      openCodeReceiptBinding(value as unknown as OpenCodeReceipt) !==
      value.binding
    )
      throw new Error("receipt binding");
    if (!isReceiptCompatibility(value.compatibility))
      throw new Error("receipt compatibility");
    return value as unknown as OpenCodeReceipt;
  } catch (cause) {
    throw new SafetyError(
      "opencode-package",
      `invalid OpenCode artifact receipt: ${path}`,
      { cause },
    );
  }
}
export async function readOpenCodePackageAssessment(
  root: string,
): Promise<{ receipt: OpenCodeReceipt; compatibility: Compatibility }> {
  const receipt = await readOpenCodeReceipt(root);
  if ((await digestArtifactTree(root)) !== receipt.digest)
    throw new SafetyError(
      "opencode-package",
      `OpenCode artifact digest mismatch: ${root}`,
    );
  return {
    receipt,
    compatibility: await assessOpenCodeCompatibility(root, {
      effectiveSource: receipt.source,
    }),
  };
}

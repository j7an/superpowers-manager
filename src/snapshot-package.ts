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
} from "./artifact-tree.ts";
import { COMMIT_RE } from "./domain/refs.ts";
import type { EffectiveSelection } from "./effective-selection.ts";
import type { Compatibility } from "./harness-compatibility.ts";
import { classifyPathNoFollow } from "./safe-path.ts";
import { SafetyError } from "./safety-error.ts";
import { validateSource } from "./selection.ts";
import type { JsonValue } from "./strict-json.ts";

const OFFICIAL_SOURCES = new Set([
  "https://github.com/obra/superpowers",
  "https://github.com/obra/superpowers.git",
  "ssh://git@github.com/obra/superpowers.git",
  "git@github.com:obra/superpowers.git",
]);

export interface SnapshotReceiptIdentity {
  readonly schema: 1;
  readonly manager: "superpowers-manager";
  readonly harness: "pi" | "opencode" | "claude-code";
  readonly source: string;
  readonly commit: string;
  readonly digest: string;
}

export type SnapshotObservation<R> =
  | { readonly kind: "absent" }
  | { readonly kind: "unverified" }
  | { readonly kind: "owned"; readonly receipt: R; readonly digest: string };

export async function observeSnapshot<R extends { readonly digest: string }>(
  root: string,
  readReceipt: (root: string) => Promise<R>,
): Promise<SnapshotObservation<R>> {
  const kind = await classifyPathNoFollow(root);
  if (kind === "missing") return { kind: "absent" };
  if (kind !== "directory") return { kind: "unverified" };
  try {
    const receipt = await readReceipt(root);
    const digest = await digestArtifactTree(root);
    return receipt.digest === digest
      ? { kind: "owned", receipt, digest }
      : { kind: "unverified" };
  } catch {
    return { kind: "unverified" };
  }
}

export function isOfficialSnapshotSource(source: string): boolean {
  return OFFICIAL_SOURCES.has(source);
}

export function sameSnapshotSource(left: string, right: string): boolean {
  validateSource(left);
  validateSource(right);
  return (
    left === right ||
    (isOfficialSnapshotSource(left) && isOfficialSnapshotSource(right))
  );
}

// A consistency checksum, not authentication. A coherent manual rewrite of
// both receipt and bytes remains possible; installed comparison must still use
// an independently validated candidate.
export function snapshotReceiptBinding(
  receipt: SnapshotReceiptIdentity,
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

export function requireNoSnapshotDependencies(
  pkg: Record<string, JsonValue>,
): void {
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
}

export async function requireSnapshotBootstrap(
  root: string,
  relativePath: string,
  expectedSize: number,
  expectedDigest: string,
): Promise<void> {
  const bootstrap = join(root, relativePath);
  const bytes = await readArtifactFile(root, bootstrap, expectedSize);
  if (
    (await lstat(bootstrap)).mode & 0o111 ||
    bytes.length !== expectedSize ||
    createHash("sha256").update(bytes).digest("hex") !== expectedDigest
  )
    throw new Error("bootstrap implementation");
}

export interface SnapshotReceipt<
  H extends SnapshotReceiptIdentity["harness"],
> extends SnapshotReceiptIdentity {
  readonly harness: H;
  readonly binding: string;
  readonly compatibility: Compatibility;
}

// strictGeneration=false admits a generation on unknown/unsupported
// compatibility. Only Pi passes false: its readers keep that recorded policy
// (tests/unit/harnesses/pi/package.test.ts, "receipt readers retain their
// distinct unsupported-generation policy").
function isReceiptCompatibility(
  value: unknown,
  strictGeneration: boolean,
): value is Compatibility {
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
    (!strictGeneration || compatibility.generation === undefined)
  );
}

export function createSnapshotReceipts<
  H extends SnapshotReceiptIdentity["harness"],
>(rules: {
  readonly harness: H;
  readonly label: "Pi" | "OpenCode" | "Claude Code";
  readonly strictGeneration: boolean;
  readonly assessCompatibility: (
    root: string,
    selection: Pick<EffectiveSelection, "effectiveSource">,
  ) => Promise<Compatibility>;
}): {
  readonly readReceipt: (root: string) => Promise<SnapshotReceipt<H>>;
  readonly readAssessment: (root: string) => Promise<{
    readonly receipt: SnapshotReceipt<H>;
    readonly compatibility: Compatibility;
  }>;
} {
  const module = `${rules.harness}-package`;
  async function readReceipt(root: string): Promise<SnapshotReceipt<H>> {
    const path = join(root, ARTIFACT_RECEIPT);
    try {
      const value = await readArtifactObject(root, path);
      if (
        value.schema !== 1 ||
        value.manager !== "superpowers-manager" ||
        value.harness !== rules.harness ||
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
        snapshotReceiptBinding(value as unknown as SnapshotReceipt<H>) !==
        value.binding
      )
        throw new Error("receipt binding");
      if (!isReceiptCompatibility(value.compatibility, rules.strictGeneration))
        throw new Error("receipt compatibility");
      return value as unknown as SnapshotReceipt<H>;
    } catch (cause) {
      throw new SafetyError(
        module,
        `invalid ${rules.label} artifact receipt: ${path}`,
        { cause },
      );
    }
  }
  async function readAssessment(root: string): Promise<{
    readonly receipt: SnapshotReceipt<H>;
    readonly compatibility: Compatibility;
  }> {
    const receipt = await readReceipt(root);
    if ((await digestArtifactTree(root)) !== receipt.digest)
      throw new SafetyError(
        module,
        `${rules.label} artifact digest mismatch: ${root}`,
      );
    return {
      receipt,
      compatibility: await rules.assessCompatibility(root, {
        effectiveSource: receipt.source,
      }),
    };
  }
  return { readReceipt, readAssessment };
}

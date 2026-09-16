import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  addArtifactHashField,
  digestArtifactTree,
  readArtifactFile,
} from "./artifact-tree.ts";
import { classifyPathNoFollow } from "./safe-path.ts";
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
  readonly harness: "pi" | "opencode";
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

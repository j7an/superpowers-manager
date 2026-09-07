import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  ARTIFACT_DIGEST_RE,
  ARTIFACT_RECEIPT,
  addArtifactHashField,
  digestArtifactTree,
  readArtifactObject,
} from "./artifact-tree.ts";
import { COMMIT_RE } from "./domain/refs.ts";
import type { Compatibility } from "./harness-compatibility.ts";
import {
  assertNoFollowType,
  assertSymlinkTargetContained,
} from "./safe-path.ts";
import { SafetyError } from "./safety-error.ts";
import { validateSource } from "./selection.ts";
import { assessPiCompatibility } from "./pi-compatibility.ts";

const exec = promisify(execFile);
const DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

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

async function gitBytes(repository: string, args: string[]): Promise<Buffer> {
  try {
    return (
      await exec("git", ["--no-replace-objects", "-C", repository, ...args], {
        encoding: null,
        maxBuffer: 256 * 1024 * 1024,
      })
    ).stdout;
  } catch (cause) {
    throw new SafetyError(
      "pi-package",
      `cannot read Pi tree objects from repository: ${repository}`,
      { cause },
    );
  }
}

export async function materializePiTree(
  repository: string,
  commit: string,
  destination: string,
): Promise<void> {
  try {
    if (!COMMIT_RE.test(commit)) throw new Error("commit");
    if (
      !(await gitBytes(repository, ["cat-file", "-t", commit])).equals(
        Buffer.from("commit\n"),
      )
    )
      throw new Error("not a commit");
    await assertNoFollowType(destination, ["missing"]);
    const bytes = await gitBytes(repository, [
      "ls-tree",
      "-rz",
      "--full-tree",
      commit,
    ]);
    const entries: { mode: string; oid: string; path: string }[] = [];
    let offset = 0;
    while (offset < bytes.length) {
      const end = bytes.indexOf(0, offset);
      if (end < 0) throw new Error("tree framing");
      const record = DECODER.decode(bytes.subarray(offset, end));
      offset = end + 1;
      const match =
        /^(100644|100755|120000) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(record);
      if (!match) throw new Error("tree entry");
      const path = match[3]!;
      if (
        path
          .split("/")
          .some(
            (part) =>
              !part ||
              part === "." ||
              part === ".." ||
              part.toLowerCase() === ".git",
          ) ||
        isAbsolute(path) ||
        path.includes("\\") ||
        path.split("/")[0] === ARTIFACT_RECEIPT
      )
        throw new Error("tree path");
      entries.push({ mode: match[1]!, oid: match[2]!, path });
    }
    await mkdir(destination, { recursive: true });
    for (const entry of entries) {
      await mkdir(dirname(join(destination, entry.path)), { recursive: true });
    }
    for (const entry of entries.filter((entry) => entry.mode !== "120000")) {
      const path = join(destination, entry.path);
      await writeFile(
        path,
        await gitBytes(repository, ["cat-file", "blob", entry.oid]),
        { flag: "wx", mode: entry.mode === "100755" ? 0o755 : 0o644 },
      );
      await chmod(path, entry.mode === "100755" ? 0o755 : 0o644);
    }
    for (const entry of entries.filter((entry) => entry.mode === "120000")) {
      const target = DECODER.decode(
        await gitBytes(repository, ["cat-file", "blob", entry.oid]),
      );
      const path = join(destination, entry.path);
      const suffix = relative(
        resolve(destination),
        resolve(dirname(path), target),
      );
      if (
        !target ||
        target.includes("\0") ||
        isAbsolute(target) ||
        suffix === ".." ||
        suffix.startsWith("../") ||
        isAbsolute(suffix)
      )
        throw new Error("link escape");
      await symlink(target, path);
    }
    for (const entry of entries.filter((entry) => entry.mode === "120000"))
      await assertSymlinkTargetContained(
        destination,
        join(destination, entry.path),
      );
  } catch (cause) {
    throw new SafetyError(
      "pi-package",
      `cannot materialize Pi tree from ${repository} into ${destination}`,
      { cause },
    );
  }
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

export async function validatePiPackage(root: string): Promise<void> {
  const receipt = await readPiReceipt(root);
  if ((await digestPiTree(root)) !== receipt.digest)
    throw new SafetyError("pi-package", `Pi artifact digest mismatch: ${root}`);
  const compatibility = await assessPiCompatibility(root, {
    effectiveSource: receipt.source,
  });
  if (
    compatibility.kind !== "supported" &&
    compatibility.kind !== "experimental"
  )
    throw new SafetyError(
      "pi-package",
      `Pi package no longer matches the qualified profile: ${root}`,
    );
}

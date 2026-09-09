import { createHash, type Hash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import {
  assertExistingContained,
  assertNoFollowType,
  assertSymlinkTargetContained,
} from "./safe-path.ts";
import { SafetyError } from "./safety-error.ts";
import { parseStrictJson, type JsonValue } from "./strict-json.ts";
import { compareByCodePoint } from "./python-text.ts";
import {
  DEFAULT_FS_DEPS,
  validateSkillFrontmatter,
} from "./skill-validation.ts";

export const ARTIFACT_RECEIPT = ".superpowers-manager.json";
export const ARTIFACT_DIGEST_RE = /^[a-f0-9]{64}$/;
const DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function addArtifactHashField(hash: Hash, bytes: Uint8Array): void {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(length);
  hash.update(bytes);
}

export async function readArtifactFile(
  root: string,
  path: string,
  limit = 1024 * 1024,
): Promise<Buffer> {
  try {
    await assertExistingContained(root, path);
    await assertNoFollowType(path, ["regular-file"]);
    if ((await lstat(path)).size > limit) throw new Error("size");
    const bytes = await readFile(path);
    if (bytes.length > limit) throw new Error("size");
    return bytes;
  } catch (cause) {
    throw new SafetyError(
      "artifact",
      `cannot read bounded artifact file: ${path}`,
      { cause },
    );
  }
}

export async function readArtifactObject(
  root: string,
  path: string,
): Promise<Record<string, JsonValue>> {
  try {
    const value = parseStrictJson(await readArtifactFile(root, path), {
      duplicateKeys: "reject",
      nonStandardConstants: "reject",
      maxDepth: 64,
    });
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error("object");
    return value;
  } catch (cause) {
    throw new SafetyError("artifact", `invalid artifact JSON object: ${path}`, {
      cause,
    });
  }
}

export async function validateNativeSkill(root: string): Promise<void> {
  const path = join(root, "skills", "using-superpowers", "SKILL.md");
  await readArtifactFile(root, path);
  const errors: string[] = [];
  await validateSkillFrontmatter(
    path,
    "using-superpowers",
    errors,
    DEFAULT_FS_DEPS,
  );
  if (errors.length)
    throw new SafetyError(
      "artifact",
      `invalid native bootstrap skill: ${path}`,
    );
}

export async function digestArtifactTree(root: string): Promise<string> {
  try {
    await assertNoFollowType(root, ["directory"]);
    const paths: string[] = [];
    async function visit(relative: string): Promise<void> {
      for (const bytes of await readdir(join(root, relative), {
        encoding: "buffer",
      })) {
        const name = DECODER.decode(bytes);
        const path = relative ? `${relative}/${name}` : name;
        if (path === ARTIFACT_RECEIPT) continue;
        paths.push(path);
        if ((await lstat(join(root, path))).isDirectory()) await visit(path);
      }
    }
    await visit("");
    const hash = createHash("sha256");
    for (const path of paths.sort(compareByCodePoint)) {
      const absolute = join(root, path),
        info = await lstat(absolute);
      let kind: string, contents: Buffer;
      if (info.isDirectory()) {
        kind = "directory";
        contents = Buffer.alloc(0);
      } else if (info.isFile()) {
        kind = "file";
        contents = await readFile(absolute);
      } else if (info.isSymbolicLink()) {
        await assertSymlinkTargetContained(root, absolute);
        kind = "link";
        contents = await readlink(absolute, { encoding: "buffer" });
        DECODER.decode(contents);
      } else throw new Error("entry type");
      for (const bytes of [
        Buffer.from(kind),
        Buffer.from(path),
        Buffer.from(String(info.isFile() ? info.mode & 0o111 : 0)),
        contents,
      ])
        addArtifactHashField(hash, bytes);
    }
    return hash.digest("hex");
  } catch (cause) {
    throw new SafetyError("artifact", `cannot digest artifact tree: ${root}`, {
      cause,
    });
  }
}

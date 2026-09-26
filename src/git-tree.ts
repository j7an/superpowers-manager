import { execFile } from "node:child_process";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { ARTIFACT_RECEIPT } from "./artifact-tree.ts";
import { COMMIT_RE } from "./domain/refs.ts";
import {
  assertNoFollowType,
  assertSymlinkTargetContained,
  isContained,
} from "./safe-path.ts";
import { SafetyError } from "./safety-error.ts";

const exec = promisify(execFile);
const DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

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
      "git-tree",
      `cannot read Git tree objects from repository: ${repository}`,
      { cause },
    );
  }
}

export async function materializeGitTree(
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
    for (const entry of entries)
      await mkdir(dirname(join(destination, entry.path)), { recursive: true });
    for (const entry of entries.filter((entry) => entry.mode !== "120000")) {
      const path = join(destination, entry.path),
        mode = entry.mode === "100755" ? 0o755 : 0o644;
      await writeFile(
        path,
        await gitBytes(repository, ["cat-file", "blob", entry.oid]),
        { flag: "wx", mode },
      );
      await chmod(path, mode);
    }
    for (const entry of entries.filter((entry) => entry.mode === "120000")) {
      const target = DECODER.decode(
        await gitBytes(repository, ["cat-file", "blob", entry.oid]),
      );
      const path = join(destination, entry.path);
      if (
        !target ||
        target.includes("\0") ||
        isAbsolute(target) ||
        !isContained(resolve(destination), resolve(dirname(path), target))
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
      "git-tree",
      `cannot materialize Git tree from ${repository} into ${destination}`,
      { cause },
    );
  }
}

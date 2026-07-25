import { lstat, readlink, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { SafetyError } from "./safety-error.js";

export type NoFollowPathType =
  "missing" | "regular-file" | "directory" | "symlink" | "other";

function isErrno(value: unknown, code: string): boolean {
  return (
    value instanceof Error &&
    "code" in value &&
    (value as NodeJS.ErrnoException).code === code
  );
}

function isContained(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return (
    suffix === "" ||
    (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`))
  );
}

function requireContained(root: string, candidate: string): void {
  if (!isContained(root, candidate)) {
    throw new SafetyError(
      "safe-path",
      `path escapes containment root: ${candidate}`,
    );
  }
}

export async function classifyPathNoFollow(
  path: string,
): Promise<NoFollowPathType> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return "symlink";
    if (info.isFile()) return "regular-file";
    if (info.isDirectory()) return "directory";
    return "other";
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) return "missing";
    throw new SafetyError("safe-path", `cannot inspect path: ${path}`, {
      cause,
    });
  }
}

export async function assertNoFollowType(
  path: string,
  allowed: readonly NoFollowPathType[],
): Promise<NoFollowPathType> {
  const actual = await classifyPathNoFollow(path);
  if (!allowed.includes(actual)) {
    throw new SafetyError(
      "safe-path",
      `path has disallowed type ${actual}: ${path}`,
    );
  }
  return actual;
}

export async function assertDesignatedParentDirectory(
  target: string,
): Promise<void> {
  const parent = dirname(resolve(target));
  const actual = await classifyPathNoFollow(parent);
  if (actual !== "missing" && actual !== "directory") {
    throw new SafetyError(
      "safe-path",
      `designated parent must be a directory without following symlinks: ${parent}`,
    );
  }
}

export async function assertExistingContained(
  root: string,
  candidate: string,
): Promise<string> {
  const lexicalRoot = resolve(root);
  const lexicalCandidate = resolve(candidate);
  requireContained(lexicalRoot, lexicalCandidate);
  try {
    const [resolvedRoot, resolvedCandidate] = await Promise.all([
      realpath(lexicalRoot),
      realpath(lexicalCandidate),
    ]);
    requireContained(resolvedRoot, resolvedCandidate);
    return lexicalCandidate;
  } catch (cause) {
    if (cause instanceof SafetyError) throw cause;
    throw new SafetyError(
      "safe-path",
      `cannot resolve existing path: ${lexicalCandidate}`,
      { cause },
    );
  }
}

export async function assertProspectiveContained(
  root: string,
  candidate: string,
): Promise<string> {
  const lexicalRoot = resolve(root);
  const lexicalCandidate = resolve(candidate);
  requireContained(lexicalRoot, lexicalCandidate);
  try {
    const resolvedRoot = await realpath(lexicalRoot);
    const missing: string[] = [];
    let cursor = lexicalCandidate;
    let resolvedAncestor: string;
    for (;;) {
      try {
        resolvedAncestor = await realpath(cursor);
        break;
      } catch (cause) {
        if (!isErrno(cause, "ENOENT")) throw cause;
        let symlinkTarget: string | undefined;
        try {
          if ((await lstat(cursor)).isSymbolicLink()) {
            symlinkTarget = await readlink(cursor);
          }
        } catch (inspectionCause) {
          if (!isErrno(inspectionCause, "ENOENT")) throw inspectionCause;
        }
        if (symlinkTarget !== undefined) {
          cursor = resolve(dirname(cursor), symlinkTarget);
          continue;
        }
        const parent = dirname(cursor);
        if (parent === cursor) throw cause;
        missing.unshift(basename(cursor));
        cursor = parent;
      }
    }
    const resolvedCandidate = resolve(resolvedAncestor, ...missing);
    requireContained(resolvedRoot, resolvedCandidate);
    return lexicalCandidate;
  } catch (cause) {
    if (cause instanceof SafetyError) throw cause;
    throw new SafetyError(
      "safe-path",
      `cannot resolve prospective path: ${lexicalCandidate}`,
      { cause },
    );
  }
}

export async function assertSymlinkTargetContained(
  root: string,
  candidate: string,
): Promise<void> {
  await assertNoFollowType(candidate, ["symlink"]);
  try {
    const [resolvedRoot, resolvedTarget] = await Promise.all([
      realpath(resolve(root)),
      realpath(resolve(candidate)),
    ]);
    requireContained(resolvedRoot, resolvedTarget);
  } catch (cause) {
    if (cause instanceof SafetyError) throw cause;
    throw new SafetyError(
      "safe-path",
      `cannot resolve symlink target: ${candidate}`,
      { cause },
    );
  }
}

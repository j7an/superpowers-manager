import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { canonicalizeProspectivePath } from "./safe-path.ts";
import { SafetyError } from "./safety-error.ts";

export interface ResourceCoordinator {
  withResources<T>(
    paths: readonly string[],
    action: () => Promise<T>,
  ): Promise<T>;
}

interface HeldResource {
  readonly resource: string;
  readonly lockPath: string;
  readonly token: string;
  count: number;
}

interface AcquiredResource {
  readonly held: HeldResource;
}

interface ReleaseOutcome {
  readonly keepHeld: boolean;
  readonly failure: SafetyError | null;
}

function errnoIs(cause: unknown, code: string): boolean {
  return (
    cause instanceof Error &&
    "code" in cause &&
    (cause as NodeJS.ErrnoException).code === code
  );
}

async function nearestExistingDirectory(path: string): Promise<string> {
  let cursor = path;
  for (;;) {
    try {
      return await realpath(cursor);
    } catch (cause) {
      if (!errnoIs(cause, "ENOENT")) throw cause;
      const parent = dirname(cursor);
      if (parent === cursor) throw cause;
      cursor = parent;
    }
  }
}

async function resourceLock(resource: string): Promise<{
  readonly resource: string;
  readonly lockPath: string;
}> {
  const canonical = await canonicalizeProspectivePath(resource);
  let lockParent: string;
  try {
    lockParent = await nearestExistingDirectory(dirname(canonical));
  } catch (cause) {
    throw new SafetyError(
      "resource-lock",
      `cannot locate resource lock parent: ${canonical}`,
      { cause },
    );
  }
  const digest = createHash("sha256").update(canonical).digest("hex");
  const lockName = `.superpowers-manager.${digest}.resource-lock`;
  let cursor = lockParent;
  for (;;) {
    const candidate = join(cursor, lockName);
    try {
      await lstat(candidate);
      return { resource: canonical, lockPath: candidate };
    } catch (cause) {
      if (!errnoIs(cause, "ENOENT")) {
        throw new SafetyError(
          "resource-lock",
          `cannot inspect resource lock: ${canonical}`,
          { cause },
        );
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return {
    resource: canonical,
    lockPath: join(lockParent, lockName),
  };
}

function ownerRecord(
  value: unknown,
): { readonly token: string; readonly resource: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  if (
    !("token" in value) ||
    typeof value.token !== "string" ||
    !("resource" in value) ||
    typeof value.resource !== "string"
  ) {
    return undefined;
  }
  return { token: value.token, resource: value.resource };
}

function releaseFailure(resource: string, cause?: unknown): SafetyError {
  return new SafetyError(
    "resource-lock",
    `cannot release resource lock: ${resource}`,
    { cause },
  );
}

async function releaseOwned(held: HeldResource): Promise<ReleaseOutcome> {
  if (held.count > 1) {
    held.count -= 1;
    return { keepHeld: true, failure: null };
  }
  const metadataPath = join(held.lockPath, "owner.json");
  let owner: ReturnType<typeof ownerRecord>;
  try {
    owner = ownerRecord(JSON.parse(await readFile(metadataPath, "utf8")));
  } catch (cause) {
    return {
      keepHeld: false,
      failure: releaseFailure(held.resource, cause),
    };
  }
  if (
    owner === undefined ||
    owner.token !== held.token ||
    owner.resource !== held.resource
  ) {
    return {
      keepHeld: false,
      failure: releaseFailure(held.resource),
    };
  }
  try {
    await unlink(metadataPath);
    await rmdir(held.lockPath);
  } catch (cause) {
    // A lock whose contents changed or cannot be inspected is not ours to
    // clear. Leaving it busy is safer than guessing at stale ownership.
    return {
      keepHeld: false,
      failure: releaseFailure(held.resource, cause),
    };
  }
  return { keepHeld: false, failure: null };
}

class FilesystemResourceCoordinator implements ResourceCoordinator {
  readonly #held = new Map<string, HeldResource>();

  async withResources<T>(
    paths: readonly string[],
    action: () => Promise<T>,
  ): Promise<T> {
    const resolved = await Promise.all(paths.map(resourceLock));
    const locks = [
      ...new Map(resolved.map((entry) => [entry.lockPath, entry])).values(),
    ].sort((left, right) =>
      left.lockPath < right.lockPath
        ? -1
        : left.lockPath > right.lockPath
          ? 1
          : 0,
    );
    const acquired: AcquiredResource[] = [];
    let completion:
      | { readonly kind: "returned"; readonly value: T }
      | { readonly kind: "threw"; readonly cause: unknown };
    try {
      for (const lock of locks) {
        const existing = this.#held.get(lock.lockPath);
        if (existing !== undefined) {
          existing.count += 1;
          acquired.push({ held: existing });
          continue;
        }

        const token = randomUUID();
        try {
          await mkdir(lock.lockPath);
        } catch (cause) {
          if (errnoIs(cause, "EEXIST")) {
            throw new SafetyError(
              "resource-lock",
              `resource is busy: ${lock.resource}`,
              { cause },
            );
          }
          throw new SafetyError(
            "resource-lock",
            `cannot acquire resource lock: ${lock.resource}`,
            { cause },
          );
        }
        const held: HeldResource = { ...lock, token, count: 1 };
        try {
          await writeFile(
            join(lock.lockPath, "owner.json"),
            JSON.stringify({
              token,
              pid: process.pid,
              resource: lock.resource,
            }),
            { flag: "wx" },
          );
        } catch (cause) {
          throw new SafetyError(
            "resource-lock",
            `cannot record resource lock ownership: ${lock.resource}`,
            { cause },
          );
        }
        this.#held.set(lock.lockPath, held);
        acquired.push({ held });
      }
      completion = { kind: "returned", value: await action() };
    } catch (cause) {
      completion = { kind: "threw", cause };
    }

    let firstReleaseFailure: SafetyError | null = null;
    for (const entry of acquired.reverse()) {
      const released = await releaseOwned(entry.held);
      if (!released.keepHeld) {
        this.#held.delete(entry.held.lockPath);
      }
      firstReleaseFailure ??= released.failure;
    }
    if (completion.kind === "threw") throw completion.cause;
    if (firstReleaseFailure !== null) throw firstReleaseFailure;
    return completion.value;
  }
}

export function createResourceCoordinator(): ResourceCoordinator {
  return new FilesystemResourceCoordinator();
}

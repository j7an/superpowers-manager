import { randomBytes } from "node:crypto";
import {
  constants,
  lstat,
  open,
  readFile,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { SafetyError } from "./safety-error.ts";

export interface AtomicErrorDetails {
  readonly phase: "pre-replacement" | "post-replacement";
  readonly finalBytes?: Uint8Array;
}

export interface AtomicWriteHooks {
  readonly rename?: typeof rename;
  readonly afterReplace?: (target: string) => void | Promise<void>;
}

export interface AtomicWriteOptions {
  readonly validate: (temporary: string) => void | Promise<void>;
  readonly hooks?: AtomicWriteHooks;
}

export async function atomicWriteFile(
  path: string,
  bytes: Uint8Array,
  options: AtomicWriteOptions,
): Promise<void> {
  const renamePath = options.hooks?.rename ?? rename;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporary: string | undefined;
  let phase: AtomicErrorDetails["phase"] = "pre-replacement";
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const suffix = randomBytes(8).toString("hex");
      const candidate = join(
        dirname(path),
        `.${basename(path)}.tmp.${process.pid}.${suffix}`,
      );
      try {
        handle = await open(
          candidate,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o600,
        );
        temporary = candidate;
        break;
      } catch (cause) {
        if (
          cause instanceof Error &&
          "code" in cause &&
          (cause as NodeJS.ErrnoException).code === "EEXIST"
        ) {
          continue;
        }
        throw cause;
      }
    }
    if (handle === undefined || temporary === undefined) {
      throw new Error("cannot create unique temporary file");
    }
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await options.validate(temporary);
    await renamePath(temporary, path);
    temporary = undefined;
    phase = "post-replacement";
    await options.hooks?.afterReplace?.(path);
    await fsyncDirectoryBestEffort(dirname(path));
  } catch (cause) {
    let finalBytes: Uint8Array | undefined;
    if (phase === "post-replacement") {
      finalBytes = await readFile(path).catch(() => undefined);
    }
    const details: AtomicErrorDetails =
      finalBytes === undefined ? { phase } : { phase, finalBytes };
    throw new SafetyError<AtomicErrorDetails>(
      "atomic",
      `atomic file write failed during ${phase}`,
      { cause, details },
    );
  } finally {
    if (handle !== undefined) {
      await handle.close().catch(() => {});
    }
    if (temporary !== undefined) {
      await unlink(temporary).catch(() => {});
    }
  }
}

async function fsyncDirectoryBestEffort(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch {
    // The frozen baseline treats directory fsync as best effort.
  } finally {
    await handle?.close().catch(() => {});
  }
}

export interface AtomicReplaceDirHooks {
  readonly rename?: typeof rename;
  readonly rm?: typeof rm;
}

export interface AtomicReplaceDirOptions {
  readonly hooks?: AtomicReplaceDirHooks;
  readonly backupPath?: string;
}

export interface DirectoryPublication {
  readonly live: string;
  readonly backup: string | null;
  finalize(): Promise<void>;
  rollback(): Promise<void>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      (cause as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw cause;
  }
}

async function chooseBackup(live: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = join(
      dirname(live),
      `.${basename(live)}.bak.${process.pid}.${randomBytes(8).toString("hex")}`,
    );
    if (!(await exists(candidate))) return candidate;
  }
  throw new SafetyError("atomic", "cannot choose unique backup path");
}

async function validateRequestedBackup(
  backup: string,
  candidate: string,
  live: string,
): Promise<void> {
  const resolvedBackup = resolve(backup);
  const resolvedCandidate = resolve(candidate);
  const resolvedLive = resolve(live);
  const prefix = `.${basename(resolvedLive)}.bak.`;
  if (
    dirname(resolvedBackup) !== dirname(resolvedLive) ||
    !basename(resolvedBackup).startsWith(prefix) ||
    basename(resolvedBackup).length === prefix.length ||
    resolvedBackup === resolvedCandidate ||
    resolvedBackup === resolvedLive ||
    (await exists(backup))
  ) {
    throw new Error("invalid directory backup path");
  }
}

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

async function directoryIdentity(path: string): Promise<DirectoryIdentity> {
  const details = await lstat(path);
  return { dev: details.dev, ino: details.ino };
}

function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity) {
  return left.dev === right.dev && left.ino === right.ino;
}

function publicationFailure(
  message: string,
  cause: unknown,
): SafetyError<AtomicErrorDetails> {
  return new SafetyError<AtomicErrorDetails>("atomic", message, {
    cause,
    details: { phase: "post-replacement" },
  });
}

export async function beginDirectoryPublication(
  candidate: string,
  live: string,
  options: AtomicReplaceDirOptions = {},
): Promise<DirectoryPublication> {
  const renamePath = options.hooks?.rename ?? rename;
  const removePath = options.hooks?.rm ?? rm;
  let backupCreated = false;
  let phase: AtomicErrorDetails["phase"] = "pre-replacement";
  try {
    const backup = options.backupPath ?? (await chooseBackup(live));
    if (options.backupPath !== undefined) {
      await validateRequestedBackup(backup, candidate, live);
    }
    if (await exists(live)) {
      await renamePath(live, backup);
      backupCreated = true;
    }
    let publishedIdentity: DirectoryIdentity;
    try {
      publishedIdentity = await directoryIdentity(candidate);
      await renamePath(candidate, live);
      phase = "post-replacement";
    } catch (cause) {
      if (!backupCreated) {
        await removePath(candidate, { recursive: true, force: true });
        throw new SafetyError<AtomicErrorDetails>(
          "atomic",
          "directory activation failed with no prior tree",
          { cause, details: { phase: "pre-replacement" } },
        );
      }
      try {
        await renamePath(backup, live);
      } catch (rollbackCause) {
        await removePath(candidate, { recursive: true, force: true }).catch(
          () => {},
        );
        throw new SafetyError<AtomicErrorDetails>(
          "atomic",
          `directory activation and rollback failed; backup preserved at ${backup}`,
          {
            cause: new AggregateError([cause, rollbackCause]),
            details: { phase: "pre-replacement" },
          },
        );
      }
      await removePath(candidate, { recursive: true, force: true });
      throw new SafetyError<AtomicErrorDetails>(
        "atomic",
        "directory activation failed; previous tree restored",
        { cause, details: { phase: "pre-replacement" } },
      );
    }

    const retainedBackup = backupCreated ? backup : null;
    let settled = false;
    const claimSettlement = () => {
      if (settled) {
        throw publicationFailure(
          "directory publication already settled",
          new Error("publication already settled"),
        );
      }
      settled = true;
    };

    return {
      live,
      backup: retainedBackup,
      async finalize() {
        claimSettlement();
        if (retainedBackup === null) return;
        try {
          await removePath(retainedBackup, { recursive: true, force: true });
        } catch (cause) {
          throw publicationFailure(
            `directory replacement succeeded but backup cleanup failed at ${retainedBackup}`,
            cause,
          );
        }
      },
      async rollback() {
        claimSettlement();
        let currentIdentity: DirectoryIdentity;
        try {
          currentIdentity = await directoryIdentity(live);
        } catch (cause) {
          throw publicationFailure(
            `directory rollback refused because live tree changed unexpectedly at ${live}`,
            cause,
          );
        }
        if (!sameIdentity(currentIdentity, publishedIdentity)) {
          throw publicationFailure(
            `directory rollback refused because live tree changed unexpectedly at ${live}`,
            new Error("published directory identity changed"),
          );
        }
        try {
          await removePath(live, { recursive: true, force: true });
          if (retainedBackup !== null) {
            await renamePath(retainedBackup, live);
          }
        } catch (cause) {
          const message =
            retainedBackup === null
              ? "directory rollback failed with no prior tree"
              : `directory rollback failed; backup preserved at ${retainedBackup}`;
          throw publicationFailure(message, cause);
        }
      },
    };
  } catch (cause) {
    if (cause instanceof SafetyError) throw cause;
    throw new SafetyError<AtomicErrorDetails>(
      "atomic",
      "directory replacement failed",
      { cause, details: { phase } },
    );
  }
}

export async function atomicReplaceDir(
  candidate: string,
  live: string,
  options: AtomicReplaceDirOptions = {},
): Promise<void> {
  const pending = await beginDirectoryPublication(candidate, live, options);
  await pending.finalize();
}

import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rmdir,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { ARTIFACT_DIGEST_RE } from "../../artifact-tree.ts";
import {
  assertDesignatedParentDirectory,
  assertNoFollowType,
  canonicalizeProspectivePath,
} from "../../safe-path.ts";
import { SafetyError } from "../../safety-error.ts";
import {
  parseStrictJson,
  type JsonValue,
  type StrictJsonProfile,
} from "../../strict-json.ts";
import type { CodexNativeState } from "./adapter.ts";
import type { CodexPaths } from "./paths.ts";

export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface RecoveryRecord {
  readonly schema: 2;
  readonly operation: "install" | "uninstall";
  readonly token: string;
  readonly marketplaceRoot: string;
  readonly priorNative: CodexNativeState;
  readonly oldDigest: string | null;
  readonly oldIdentity: FileIdentity | null;
}

export interface PendingCodexPublication {
  readonly paths: CodexPaths;
  readonly stage: string;
  readonly backup: string;
  readonly recoveryIdentity: FileIdentity;
  readonly journalIdentity: FileIdentity;
  readonly record: RecoveryRecord;
  newDigest: string | null;
  stageIdentity: FileIdentity | null;
  publishedIdentity: FileIdentity | null;
  settled: boolean;
}

export type RecoveryInput = Pick<
  RecoveryRecord,
  "operation" | "marketplaceRoot" | "priorNative" | "oldDigest" | "oldIdentity"
>;

const JOURNAL = "transaction.json";
const TOKEN_RE = /^[a-f0-9]{32}$/u;
const PROFILE: StrictJsonProfile = {
  duplicateKeys: "reject",
  nonStandardConstants: "reject",
  integerNumbersOnly: true,
  maxDepth: 8,
  maxBytes: 64 * 1024,
};
const RECORD_KEYS = [
  "schema",
  "operation",
  "token",
  "marketplaceRoot",
  "priorNative",
  "oldDigest",
  "oldIdentity",
].sort();
const NATIVE_KEYS = [
  "marketplaceRoot",
  "pluginPresent",
  "pluginEnabled",
  "activeVersion",
  "activeRoot",
].sort();
const IDENTITY_KEYS = ["dev", "ino"];

function recoveryError(message: string, cause?: unknown): SafetyError {
  return new SafetyError("codex-recovery", message, { cause });
}

function recordPath(paths: CodexPaths): string {
  return join(paths.recoveryRoot, JOURNAL);
}

function stagePath(paths: CodexPaths, token: string): string {
  return join(paths.managerRoot, `.stage-${token}`);
}

function backupPath(paths: CodexPaths, token: string): string {
  return join(paths.managerRoot, `.marketplace.bak.${token}`);
}

function object(value: JsonValue): Record<string, JsonValue> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function exactKeys(value: Record<string, JsonValue>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error("unexpected recovery fields");
  }
}

function nullableString(value: JsonValue): string | null {
  if (value === null || typeof value === "string") return value;
  throw new Error("invalid nullable string");
}

function identityValue(value: JsonValue): FileIdentity | null {
  if (value === null) return null;
  const candidate = object(value);
  if (candidate === null) throw new Error("invalid identity");
  exactKeys(candidate, IDENTITY_KEYS);
  const dev = candidate.dev;
  const ino = candidate.ino;
  if (
    typeof dev !== "number" ||
    typeof ino !== "number" ||
    !Number.isSafeInteger(dev) ||
    !Number.isSafeInteger(ino) ||
    dev < 0 ||
    ino < 0
  ) {
    throw new Error("invalid identity");
  }
  return { dev, ino };
}

function nativeValue(value: JsonValue): CodexNativeState {
  const candidate = object(value);
  if (candidate === null) throw new Error("invalid native state");
  exactKeys(candidate, NATIVE_KEYS);
  const marketplaceRoot = nullableString(candidate.marketplaceRoot!);
  const activeVersion = nullableString(candidate.activeVersion!);
  const activeRoot = nullableString(candidate.activeRoot!);
  if (
    typeof candidate.pluginPresent !== "boolean" ||
    typeof candidate.pluginEnabled !== "boolean" ||
    (candidate.pluginPresent === false && activeVersion !== null) ||
    (activeVersion === null) !== (activeRoot === null)
  ) {
    throw new Error("invalid native state");
  }
  return {
    marketplaceRoot,
    pluginPresent: candidate.pluginPresent,
    pluginEnabled: candidate.pluginEnabled,
    activeVersion,
    activeRoot,
  };
}

function digestValue(value: JsonValue): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !ARTIFACT_DIGEST_RE.test(value)) {
    throw new Error("invalid recovery digest");
  }
  return value;
}

function validateEvidenceShape(record: RecoveryRecord): void {
  if ((record.oldDigest === null) !== (record.oldIdentity === null)) {
    throw new Error("incomplete old recovery evidence");
  }
}

async function decodeRecord(
  bytes: Uint8Array,
  paths: CodexPaths,
): Promise<RecoveryRecord> {
  const parsed = object(parseStrictJson(bytes, PROFILE));
  if (parsed === null) throw new Error("recovery journal is not an object");
  exactKeys(parsed, RECORD_KEYS);
  if (parsed.schema !== 2) throw new Error("invalid recovery schema");
  if (parsed.operation !== "install" && parsed.operation !== "uninstall") {
    throw new Error("invalid recovery operation");
  }
  if (typeof parsed.token !== "string" || !TOKEN_RE.test(parsed.token)) {
    throw new Error("invalid recovery token");
  }
  if (
    typeof parsed.marketplaceRoot !== "string" ||
    !isAbsolute(parsed.marketplaceRoot) ||
    resolve(parsed.marketplaceRoot) !== parsed.marketplaceRoot
  ) {
    throw new Error("invalid recovery marketplace root");
  }
  if (parsed.marketplaceRoot !== paths.marketplaceRoot) {
    throw new Error("foreign recovery marketplace root");
  }
  const record: RecoveryRecord = {
    schema: 2,
    operation: parsed.operation,
    token: parsed.token,
    marketplaceRoot: parsed.marketplaceRoot,
    priorNative: nativeValue(parsed.priorNative!),
    oldDigest: digestValue(parsed.oldDigest!),
    oldIdentity: identityValue(parsed.oldIdentity!),
  };
  validateEvidenceShape(record);
  return record;
}

function recordBytes(record: RecoveryRecord): Buffer {
  return Buffer.from(`${JSON.stringify(record)}\n`);
}

function sameIdentity(
  left: FileIdentity | null,
  right: FileIdentity | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

async function identity(path: string): Promise<FileIdentity> {
  await assertNoFollowType(path, ["directory"]);
  const details = await lstat(path);
  return { dev: details.dev, ino: details.ino };
}

async function optionalIdentity(path: string): Promise<FileIdentity | null> {
  const kind = await assertNoFollowType(path, ["directory", "missing"]);
  return kind === "missing" ? null : await identity(path);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readOwnedRecord(paths: CodexPaths): Promise<RecoveryRecord> {
  await assertNoFollowType(paths.recoveryRoot, ["directory"]);
  const entries = await readdir(paths.recoveryRoot);
  if (entries.length !== 1 || entries[0] !== JOURNAL) {
    throw new Error("unexpected Codex recovery material");
  }
  const path = recordPath(paths);
  await assertNoFollowType(path, ["regular-file"]);
  return await decodeRecord(await readFile(path), paths);
}

export async function readCodexRecovery(
  paths: CodexPaths,
): Promise<RecoveryRecord | null> {
  try {
    const kind = await assertNoFollowType(paths.recoveryRoot, [
      "directory",
      "missing",
    ]);
    if (kind === "missing") return null;
    return await readOwnedRecord(paths);
  } catch (cause) {
    throw recoveryError(
      `cannot inspect Codex recovery state: ${paths.recoveryRoot}`,
      cause,
    );
  }
}

async function requireInitialSnapshot(
  paths: CodexPaths,
  input: RecoveryInput,
): Promise<void> {
  if (input.marketplaceRoot !== paths.marketplaceRoot) {
    throw new Error("unexpected marketplace root");
  }
  await assertNoFollowType(paths.codexHome, ["directory", "missing"]);
  await assertNoFollowType(paths.managerRoot, ["directory", "missing"]);
  await canonicalizeProspectivePath(paths.marketplaceRoot);
  const current = await optionalIdentity(paths.marketplaceRoot);
  if (
    (current === null) !== (input.oldIdentity === null) ||
    (current !== null && !sameIdentity(current, input.oldIdentity)) ||
    (input.oldDigest === null) !== (input.oldIdentity === null)
  ) {
    throw new Error("previous marketplace changed");
  }
}

export async function beginCodexRecovery(
  paths: CodexPaths,
  input: RecoveryInput,
): Promise<PendingCodexPublication> {
  try {
    const homeKind = await assertNoFollowType(paths.codexHome, [
      "directory",
      "missing",
    ]);
    if (homeKind === "missing") {
      await assertDesignatedParentDirectory(paths.codexHome);
      await mkdir(paths.codexHome, { mode: 0o700 });
    }
    await requireInitialSnapshot(paths, input);
    const managerKind = await assertNoFollowType(paths.managerRoot, [
      "directory",
      "missing",
    ]);
    if (managerKind === "missing")
      await mkdir(paths.managerRoot, { mode: 0o700 });
    if (
      (await assertNoFollowType(paths.recoveryRoot, [
        "directory",
        "missing",
      ])) !== "missing"
    ) {
      throw new Error("unresolved Codex recovery state");
    }
    await mkdir(paths.recoveryRoot, { mode: 0o700 });
    const recoveryIdentity = await identity(paths.recoveryRoot);
    const token = randomBytes(16).toString("hex");
    const record: RecoveryRecord = {
      schema: 2,
      operation: input.operation,
      token,
      marketplaceRoot: input.marketplaceRoot,
      priorNative: input.priorNative,
      oldDigest: input.oldDigest,
      oldIdentity: input.oldIdentity,
    };
    await decodeRecord(recordBytes(record), paths);
    const path = recordPath(paths);
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(recordBytes(record));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(paths.recoveryRoot);
    const journal = await lstat(path);
    return {
      paths,
      stage: stagePath(paths, token),
      backup: backupPath(paths, token),
      recoveryIdentity,
      journalIdentity: { dev: journal.dev, ino: journal.ino },
      record,
      newDigest: null,
      stageIdentity: null,
      publishedIdentity: null,
      settled: false,
    };
  } catch (cause) {
    const suffix =
      cause instanceof Error &&
      cause.message === "unresolved Codex recovery state"
        ? ": unresolved Codex recovery state"
        : "";
    throw recoveryError(`cannot begin Codex recovery journal${suffix}`, cause);
  }
}

export async function verifyCodexRecovery(
  pending: PendingCodexPublication,
): Promise<void> {
  try {
    await requirePending(pending);
  } catch (cause) {
    const message =
      cause instanceof Error &&
      (cause.message === "Codex recovery journal changed" ||
        cause.message === "Codex recovery journal is already settled")
        ? cause.message
        : "cannot verify Codex recovery journal";
    throw recoveryError(message, cause);
  }
}

async function requirePending(pending: PendingCodexPublication): Promise<void> {
  if (pending.settled) {
    throw new Error("Codex recovery journal is already settled");
  }
  if (
    pending.stage !== stagePath(pending.paths, pending.record.token) ||
    pending.backup !== backupPath(pending.paths, pending.record.token)
  ) {
    throw new Error("Codex recovery paths changed");
  }
  if (
    !sameIdentity(
      await identity(pending.paths.recoveryRoot),
      pending.recoveryIdentity,
    )
  ) {
    throw new Error("Codex recovery directory changed");
  }
  const path = recordPath(pending.paths);
  await assertNoFollowType(path, ["regular-file"]);
  const journal = await lstat(path);
  if (
    !sameIdentity(
      { dev: journal.dev, ino: journal.ino },
      pending.journalIdentity,
    ) ||
    !(await readFile(path)).equals(recordBytes(pending.record))
  ) {
    throw new Error("Codex recovery journal changed");
  }
  await decodeRecord(recordBytes(pending.record), pending.paths);
}

export async function finishCodexRecovery(
  pending: PendingCodexPublication,
): Promise<void> {
  try {
    await requirePending(pending);
    const entries = await readdir(pending.paths.recoveryRoot);
    if (entries.length !== 1 || entries[0] !== JOURNAL) {
      throw new Error("unexpected Codex recovery material");
    }
    pending.settled = true;
    await unlink(recordPath(pending.paths));
    if (
      !sameIdentity(
        await identity(pending.paths.recoveryRoot),
        pending.recoveryIdentity,
      )
    ) {
      throw new Error("Codex recovery directory changed");
    }
    await rmdir(pending.paths.recoveryRoot);
  } catch (cause) {
    const message =
      cause instanceof Error &&
      (cause.message === "unexpected Codex recovery material" ||
        cause.message === "Codex recovery journal is already settled")
        ? cause.message
        : "cannot finish Codex recovery journal";
    throw recoveryError(message, cause);
  }
}

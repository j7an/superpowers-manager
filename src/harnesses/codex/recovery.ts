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

import { atomicWriteFile } from "../../atomic.ts";
import { ARTIFACT_DIGEST_RE, digestArtifactTree } from "../../artifact-tree.ts";
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

export type RecoveryPhase =
  | "staging"
  | "publishing"
  | "published"
  | "activating"
  | "ready"
  | "finalizing"
  | "rolling-back"
  | "restored"
  | "removing"
  | "deregistered";

export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface RecoveryRecord {
  readonly schema: 1;
  readonly token: string;
  readonly phase: RecoveryPhase;
  readonly marketplaceRoot: string;
  readonly priorNative: CodexNativeState;
  readonly oldDigest: string | null;
  readonly newDigest: string | null;
  readonly oldIdentity: FileIdentity | null;
  readonly stageIdentity: FileIdentity | null;
  readonly publishedIdentity: FileIdentity | null;
}

export interface PendingCodexPublication {
  readonly paths: CodexPaths;
  readonly stage: string;
  readonly backup: string;
  readonly recoveryIdentity: FileIdentity;
  journalIdentity: FileIdentity;
  record: RecoveryRecord;
  settled: boolean;
}

export type RecoveryInput = Pick<
  RecoveryRecord,
  "marketplaceRoot" | "priorNative" | "oldDigest" | "oldIdentity"
>;
export type RecoveryEvidence = Partial<
  Pick<RecoveryRecord, "newDigest" | "stageIdentity" | "publishedIdentity">
>;

const JOURNAL = "transaction.json";
const TOKEN_RE = /^[a-f0-9]{32}$/u;
const PHASES: readonly RecoveryPhase[] = [
  "staging",
  "publishing",
  "published",
  "activating",
  "ready",
  "finalizing",
  "rolling-back",
  "restored",
  "removing",
  "deregistered",
];
const PROFILE: StrictJsonProfile = {
  duplicateKeys: "reject",
  nonStandardConstants: "reject",
  integerNumbersOnly: true,
  maxDepth: 8,
  maxBytes: 64 * 1024,
};
const RECORD_KEYS = [
  "schema",
  "token",
  "phase",
  "marketplaceRoot",
  "priorNative",
  "oldDigest",
  "newDigest",
  "oldIdentity",
  "stageIdentity",
  "publishedIdentity",
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

function phaseValue(value: JsonValue): RecoveryPhase {
  if (typeof value !== "string" || !PHASES.includes(value as RecoveryPhase)) {
    throw new Error("invalid recovery phase");
  }
  return value as RecoveryPhase;
}

function validateEvidenceShape(record: RecoveryRecord): void {
  if ((record.oldDigest === null) !== (record.oldIdentity === null)) {
    throw new Error("incomplete old recovery evidence");
  }
  if ((record.newDigest === null) !== (record.stageIdentity === null)) {
    throw new Error("incomplete stage recovery evidence");
  }
  if (record.publishedIdentity !== null && record.stageIdentity === null) {
    throw new Error("incomplete published recovery evidence");
  }
  if (
    [
      "publishing",
      "published",
      "activating",
      "ready",
      "finalizing",
      "rolling-back",
      "restored",
    ].includes(record.phase) &&
    record.stageIdentity === null
  ) {
    throw new Error("recovery phase lacks staged evidence");
  }
  if (
    ["published", "activating", "ready", "finalizing"].includes(record.phase) &&
    record.publishedIdentity === null
  ) {
    throw new Error("recovery phase lacks published evidence");
  }
}

async function decodeRecord(
  bytes: Uint8Array,
  paths: CodexPaths,
): Promise<RecoveryRecord> {
  const parsed = object(parseStrictJson(bytes, PROFILE));
  if (parsed === null) throw new Error("recovery journal is not an object");
  exactKeys(parsed, RECORD_KEYS);
  if (parsed.schema !== 1) throw new Error("invalid recovery schema");
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
  const expectedRoot = await canonicalizeProspectivePath(paths.marketplaceRoot);
  const recordedRoot = await canonicalizeProspectivePath(
    parsed.marketplaceRoot,
  );
  if (
    parsed.marketplaceRoot !== paths.marketplaceRoot ||
    recordedRoot !== expectedRoot
  ) {
    throw new Error("foreign recovery marketplace root");
  }
  const record: RecoveryRecord = {
    schema: 1,
    token: parsed.token,
    phase: phaseValue(parsed.phase!),
    marketplaceRoot: parsed.marketplaceRoot,
    priorNative: nativeValue(parsed.priorNative!),
    oldDigest: digestValue(parsed.oldDigest!),
    newDigest: digestValue(parsed.newDigest!),
    oldIdentity: identityValue(parsed.oldIdentity!),
    stageIdentity: identityValue(parsed.stageIdentity!),
    publishedIdentity: identityValue(parsed.publishedIdentity!),
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

async function validateObservedObjects(
  paths: CodexPaths,
  record: RecoveryRecord,
): Promise<void> {
  await assertNoFollowType(paths.managerRoot, ["directory"]);
  const stage = await optionalIdentity(stagePath(paths, record.token));
  const backup = await optionalIdentity(backupPath(paths, record.token));
  const live = await optionalIdentity(paths.marketplaceRoot);

  if (stage !== null && !sameIdentity(stage, record.stageIdentity)) {
    throw new Error("staged marketplace identity changed");
  }
  if (
    stage !== null &&
    (record.newDigest === null ||
      (await digestArtifactTree(stagePath(paths, record.token))) !==
        record.newDigest)
  ) {
    throw new Error("staged marketplace content changed");
  }
  const backupAllowed = [
    "publishing",
    "published",
    "activating",
    "ready",
    "finalizing",
    "rolling-back",
  ].includes(record.phase);
  if (
    backup !== null &&
    (!backupAllowed || !sameIdentity(backup, record.oldIdentity))
  ) {
    throw new Error("retained marketplace backup changed");
  }
  if (
    backup !== null &&
    (record.oldDigest === null ||
      (await digestArtifactTree(backupPath(paths, record.token))) !==
        record.oldDigest)
  ) {
    throw new Error("retained marketplace backup content changed");
  }
  if (
    record.oldIdentity !== null &&
    ["published", "activating", "ready"].includes(record.phase) &&
    backup === null
  ) {
    throw new Error("retained marketplace backup is missing");
  }

  let liveAllowed: readonly (FileIdentity | null)[];
  switch (record.phase) {
    case "staging":
    case "removing":
      liveAllowed = [record.oldIdentity];
      break;
    case "publishing":
      liveAllowed = [record.oldIdentity, record.stageIdentity, null];
      break;
    case "rolling-back":
      liveAllowed = [
        record.publishedIdentity,
        record.stageIdentity,
        record.oldIdentity,
        null,
      ];
      break;
    case "restored":
      liveAllowed = [record.oldIdentity];
      break;
    case "deregistered":
      liveAllowed = [record.oldIdentity, null];
      break;
    default:
      liveAllowed = [record.publishedIdentity];
  }
  if (
    !liveAllowed.some((allowed) =>
      live === null ? allowed === null : sameIdentity(live, allowed),
    )
  ) {
    throw new Error("published marketplace identity changed");
  }
  if (live !== null) {
    const expectedDigest = sameIdentity(live, record.oldIdentity)
      ? record.oldDigest
      : sameIdentity(live, record.stageIdentity) ||
          sameIdentity(live, record.publishedIdentity)
        ? record.newDigest
        : null;
    if (
      expectedDigest === null ||
      (await digestArtifactTree(paths.marketplaceRoot)) !== expectedDigest
    ) {
      throw new Error("published marketplace content changed");
    }
  }
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
  const record = await decodeRecord(await readFile(path), paths);
  await validateObservedObjects(paths, record);
  return record;
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
      schema: 1,
      token,
      phase: "staging",
      marketplaceRoot: input.marketplaceRoot,
      priorNative: input.priorNative,
      oldDigest: input.oldDigest,
      newDigest: null,
      oldIdentity: input.oldIdentity,
      stageIdentity: null,
      publishedIdentity: null,
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

function transitionAllowed(from: RecoveryPhase, to: RecoveryPhase): boolean {
  if (from === "staging" && to === "staging") return true;
  switch (from) {
    case "staging":
      return to === "publishing" || to === "removing";
    case "publishing":
      return to === "published" || to === "rolling-back";
    case "published":
      return to === "activating" || to === "rolling-back";
    case "activating":
      return to === "ready" || to === "rolling-back";
    case "ready":
      return to === "finalizing" || to === "rolling-back";
    case "rolling-back":
      return to === "restored";
    case "removing":
      return to === "deregistered";
    default:
      return false;
  }
}

export async function advanceCodexRecovery(
  pending: PendingCodexPublication,
  phase: RecoveryPhase,
  evidence: RecoveryEvidence = {},
): Promise<void> {
  try {
    await requirePending(pending);
    if (!transitionAllowed(pending.record.phase, phase)) {
      throw new Error("invalid Codex recovery phase transition");
    }
    const record: RecoveryRecord = {
      ...pending.record,
      ...evidence,
      phase,
    };
    const bytes = recordBytes(record);
    await decodeRecord(bytes, pending.paths);
    await atomicWriteFile(recordPath(pending.paths), bytes, {
      validate: async (temporary) => {
        await assertNoFollowType(temporary, ["regular-file"]);
        await decodeRecord(await readFile(temporary), pending.paths);
      },
    });
    await syncDirectory(pending.paths.recoveryRoot);
    const journal = await lstat(recordPath(pending.paths));
    pending.record = record;
    pending.journalIdentity = { dev: journal.dev, ino: journal.ino };
  } catch (cause) {
    const message =
      cause instanceof Error &&
      (cause.message === "Codex recovery journal changed" ||
        cause.message === "Codex recovery journal is already settled")
        ? cause.message
        : "cannot advance Codex recovery journal";
    throw recoveryError(message, cause);
  }
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

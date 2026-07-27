import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import {
  atomicWriteFile,
  type AtomicErrorDetails,
  type AtomicWriteHooks,
} from "./atomic.js";
import { classifyPathNoFollow, type NoFollowPathType } from "./safe-path.js";
import { SafetyError } from "./safety-error.js";
import {
  selectionError,
  serializeRecord,
  validateRecord,
  type SelectionRecord,
} from "./selection.js";
import { parseStrictJson, type StrictJsonProfile } from "./strict-json.js";

const SELECTION_JSON_PROFILE: StrictJsonProfile = {
  duplicateKeys: "reject",
  nonStandardConstants: "reject",
  maxDepth: 256,
  // integerNumbersOnly owns lexical 1.0/1e0 rejection.
  integerNumbersOnly: true,
};

export interface SelectionWriteOptions {
  readonly hooks?: AtomicWriteHooks;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function causedErrorText(cause: unknown): string {
  return cause instanceof SafetyError && cause.cause !== undefined
    ? errorText(cause.cause)
    : errorText(cause);
}

async function classify(
  path: string,
  label: string,
): Promise<NoFollowPathType> {
  try {
    return await classifyPathNoFollow(path);
  } catch (cause) {
    throw selectionError(
      `cannot inspect ${label} ${path}: ${causedErrorText(cause)}`,
      cause,
    );
  }
}

function translateParseFailure(
  path: string,
  text: string,
  cause: unknown,
): never {
  if (cause instanceof SafetyError && cause.module === "selection") throw cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.startsWith("container depth exceeds ")) {
    throw selectionError(`JSON nesting exceeds limit in ${path}`, cause);
  }
  const duplicate = /^duplicate object key (".*") at character \d+$/.exec(
    message,
  );
  if (duplicate?.[1] !== undefined) {
    const key = JSON.parse(duplicate[1]) as string;
    throw selectionError(`duplicate JSON key: ${key}`, cause);
  }
  const objectKey = /^object key must be a string at character (\d+)$/.exec(
    message,
  );
  if (objectKey?.[1] !== undefined) {
    const index = Number(objectKey[1]);
    const prefix = text.slice(0, index);
    const lines = prefix.split("\n");
    const line = lines.length;
    const column = (lines.at(-1)?.length ?? 0) + 1;
    throw selectionError(
      `invalid JSON in ${path}: line ${line} column ${column}: Expecting property name enclosed in double quotes`,
      cause,
    );
  }
  throw selectionError(`invalid JSON in ${path}: ${message}`, cause);
}

function parseRecordBytes(path: string, bytes: Uint8Array): SelectionRecord {
  let text: string;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch (cause) {
    throw selectionError(
      `cannot read selection state ${path}: ${errorText(cause)}`,
      cause,
    );
  }
  try {
    return validateRecord(parseStrictJson(text, SELECTION_JSON_PROFILE));
  } catch (cause) {
    translateParseFailure(path, text, cause);
  }
}

async function readOpenedRecord(path: string): Promise<SelectionRecord> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const noFollow =
      typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    handle = await open(path, constants.O_RDONLY | noFollow);
    if (!(await handle.stat()).isFile()) {
      throw selectionError(`selection state must be a regular file: ${path}`);
    }
    return parseRecordBytes(path, await handle.readFile());
  } catch (cause) {
    if (cause instanceof SafetyError && cause.module === "selection") {
      throw cause;
    }
    throw selectionError(
      `cannot read selection state ${path}: ${errorText(cause)}`,
      cause,
    );
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function classifyStateDirectory(
  path: string,
): Promise<"missing" | "directory"> {
  const current = await classify(path, "selection state directory");
  if (current === "symlink") {
    throw selectionError(
      `selection state directory must not be a symlink: ${path}`,
    );
  }
  if (current !== "missing" && current !== "directory") {
    throw selectionError(
      `selection state directory must be a directory: ${path}`,
    );
  }
  return current;
}

export async function readSelectionState(
  path: string,
): Promise<SelectionRecord | null> {
  const parent = dirname(path);
  await classifyStateDirectory(parent);
  const targetType = await classify(path, "selection state");
  if (targetType === "missing") return null;
  if (targetType === "symlink") {
    throw selectionError(`selection state must not be a symlink: ${path}`);
  }
  if (targetType !== "regular-file") {
    throw selectionError(`selection state must be a regular file: ${path}`);
  }
  return readOpenedRecord(path);
}

async function ensureStateDirectory(path: string): Promise<void> {
  if ((await classifyStateDirectory(path)) !== "missing") return;
  const previousUmask = process.umask(0o077);
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
  } catch (cause) {
    throw selectionError(
      `cannot create selection state directory ${path}: ${errorText(cause)}`,
      cause,
    );
  } finally {
    process.umask(previousUmask);
  }
  const created = await classify(path, "selection state directory");
  if (created !== "directory") {
    throw selectionError(`selection state directory is not usable: ${path}`);
  }
}

async function finalStateDiagnostic(
  path: string,
  finalBytes: Uint8Array | undefined,
): Promise<string> {
  try {
    const record =
      finalBytes === undefined
        ? await readSelectionState(path)
        : parseRecordBytes(path, finalBytes);
    return record === null
      ? "selection state is now absent"
      : `selection state is now ${record.mode}`;
  } catch (cause) {
    return `final selection state cannot be validated: ${errorText(cause)}`;
  }
}

export async function writeSelectionState(
  path: string,
  proposed: SelectionRecord,
  options: SelectionWriteOptions = {},
): Promise<void> {
  await ensureStateDirectory(dirname(path));
  // Invalid existing state must block overwrite.
  await readSelectionState(path);
  const record = validateRecord(proposed);
  const bytes = new TextEncoder().encode(serializeRecord(record));
  try {
    await atomicWriteFile(path, bytes, {
      hooks: options.hooks,
      validate: async (temporary) => {
        await readOpenedRecord(temporary);
      },
    });
  } catch (cause) {
    const details =
      cause instanceof SafetyError && cause.module === "atomic"
        ? (cause.details as AtomicErrorDetails | undefined)
        : undefined;
    if (details?.phase !== "post-replacement") {
      throw selectionError(
        `cannot write selection state: ${causedErrorText(cause)}`,
        cause,
      );
    }
    const diagnostic = await finalStateDiagnostic(path, details.finalBytes);
    throw selectionError(
      `cannot complete selection state write: ${causedErrorText(cause)}; ${diagnostic}`,
      cause,
    );
  }
}

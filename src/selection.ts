import { isIP } from "node:net";
import { COMMIT_RE, TAG_RE, normalizeCommitInput } from "./domain/refs.ts";
import { escapePythonJsonString } from "./python-json.ts";
import { SafetyError } from "./safety-error.ts";

export interface PinnedSelectionRecord {
  readonly schema_version: 1;
  readonly mode: "pinned";
  readonly source: string;
  readonly requested_ref: string;
  readonly resolved_ref: string;
  readonly commit: string;
}

export interface TrackLatestSelectionRecord {
  readonly schema_version: 1;
  readonly mode: "track-latest";
  readonly source: string;
}

export type SelectionRecord =
  PinnedSelectionRecord | TrackLatestSelectionRecord;

export interface NormalizedSavedSelection {
  readonly saved_mode: "none" | SelectionRecord["mode"];
  readonly saved_source: string;
  readonly saved_requested_ref: string;
  readonly saved_resolved_ref: string;
  readonly saved_commit: string;
}

interface PinnedArguments {
  readonly source: string;
  readonly requestedRef: string;
  readonly resolvedRef: string;
  readonly commit: string;
}

type JsonObject = Record<string, unknown>;

export function selectionError(message: string, cause?: unknown): SafetyError {
  return new SafetyError("selection", message, { cause });
}

function requireObject(raw: unknown, label: string): JsonObject {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw selectionError(`${label} must be a JSON object`);
  }
  return raw as JsonObject;
}

function requireExactKeys(
  record: JsonObject,
  expected: readonly string[],
): void {
  const expectedSet = new Set(expected);
  const actual = Object.keys(record);
  const missing = expected.filter((key) => !Object.hasOwn(record, key)).sort();
  const unknown = actual.filter((key) => !expectedSet.has(key)).sort();
  if (missing.length === 0 && unknown.length === 0) return;
  const details: string[] = [];
  if (missing.length > 0) details.push(`missing ${missing.join(", ")}`);
  if (unknown.length > 0) details.push(`unknown ${unknown.join(", ")}`);
  throw selectionError(
    `selection state keys are invalid: ${details.join("; ")}`,
  );
}

function requireSingleLineString(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\r") ||
    value.includes("\n") ||
    value.includes("\0")
  ) {
    throw selectionError(`${label} must be a non-empty single-line string`);
  }
  return value;
}

// Bounded CPython urllib.parse bracket/NFKC emulation preserves version compatibility.
function bracketedHostIsInvalid(host: string): boolean {
  if (host.startsWith("v")) return !/^v[0-9A-Fa-f]+\..+$/.test(host);
  return isIP(host) !== 6;
}

function authorityHasMalformedBrackets(authority: string): boolean {
  const hasOpening = authority.includes("[");
  const hasClosing = authority.includes("]");
  if (hasOpening !== hasClosing) return true;
  if (!hasOpening) return false;

  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  const opening = hostPort.indexOf("[");
  let host: string;
  if (opening !== -1) {
    if (opening !== 0) return true;
    const bracketed = hostPort.slice(1);
    const closing = bracketed.indexOf("]");
    host = closing === -1 ? bracketed : bracketed.slice(0, closing);
    const suffix = closing === -1 ? "" : bracketed.slice(closing + 1);
    if (suffix !== "" && !suffix.startsWith(":")) return true;
  } else {
    host = hostPort.split(":", 1)[0];
  }
  return bracketedHostIsInvalid(host);
}

function authorityFailsNfkc(authority: string): boolean {
  const checked = authority.replace(/[@:#?]/g, "");
  const normalized = checked.normalize("NFKC");
  return normalized !== checked && /[/?#@:]/.test(normalized);
}

export function validateSource(raw: unknown): string {
  const source = requireSingleLineString(raw, "source");
  let leadingWhitespaceEnd = 0;
  while (
    leadingWhitespaceEnd < source.length &&
    source.charCodeAt(leadingWhitespaceEnd) <= 0x20
  ) {
    leadingWhitespaceEnd += 1;
  }
  const parsed = source.slice(leadingWhitespaceEnd).replaceAll("\t", "");
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s.exec(parsed);
  const scheme = schemeMatch?.[1]?.toLowerCase() ?? "";
  const remainder = schemeMatch?.[2] ?? parsed;
  let authority = "";
  if (remainder.startsWith("//")) {
    authority = remainder.slice(2).split(/[/?#]/, 1)[0];
  }
  if (
    authorityHasMalformedBrackets(authority) ||
    authorityFailsNfkc(authority)
  ) {
    throw selectionError("source URL is malformed");
  }
  if ((scheme === "http" || scheme === "https") && authority.includes("@")) {
    throw selectionError("HTTP(S) source must not include userinfo");
  }
  return source;
}

export function displaySource(raw: unknown): string {
  try {
    return validateSource(raw);
  } catch (cause) {
    if (!(cause instanceof SafetyError) || cause.module !== "selection") {
      throw cause;
    }
    return "<redacted-source>";
  }
}

function validatePinnedRecord(
  record: JsonObject,
  source: string,
): PinnedSelectionRecord {
  const requestedRef = requireSingleLineString(
    record.requested_ref,
    "requested_ref",
  );
  const resolvedRef = requireSingleLineString(
    record.resolved_ref,
    "resolved_ref",
  );
  const commit = requireSingleLineString(record.commit, "commit");
  if (!COMMIT_RE.test(commit)) {
    throw selectionError("commit must be a lowercase 40-hex value");
  }
  if (TAG_RE.test(requestedRef)) {
    if (resolvedRef !== requestedRef) {
      throw selectionError("tag resolved_ref must equal requested_ref");
    }
  } else if (COMMIT_RE.test(requestedRef)) {
    if (resolvedRef !== requestedRef || commit !== requestedRef) {
      throw selectionError(
        "raw commit requested_ref, resolved_ref, and commit must be equal",
      );
    }
  } else {
    throw selectionError("requested_ref must be an exact tag or full commit");
  }
  return {
    schema_version: 1,
    mode: "pinned",
    source,
    requested_ref: requestedRef,
    resolved_ref: resolvedRef,
    commit,
  };
}

export function validateRecord(raw: unknown): SelectionRecord {
  const record = requireObject(raw, "selection state");
  if (record.schema_version !== 1) {
    throw selectionError("schema_version must equal integer 1");
  }
  if (record.mode === "track-latest") {
    requireExactKeys(record, ["schema_version", "mode", "source"]);
    return {
      schema_version: 1,
      mode: "track-latest",
      source: validateSource(record.source),
    };
  }
  if (record.mode === "pinned") {
    requireExactKeys(record, [
      "schema_version",
      "mode",
      "source",
      "requested_ref",
      "resolved_ref",
      "commit",
    ]);
    return validatePinnedRecord(record, validateSource(record.source));
  }
  throw selectionError("mode must be pinned or track-latest");
}

export function normalizeSaved(
  record: SelectionRecord | null,
): NormalizedSavedSelection {
  if (record === null) {
    return {
      saved_mode: "none",
      saved_source: "",
      saved_requested_ref: "",
      saved_resolved_ref: "",
      saved_commit: "",
    };
  }
  return {
    saved_mode: record.mode,
    saved_source: record.source,
    saved_requested_ref: record.mode === "pinned" ? record.requested_ref : "",
    saved_resolved_ref: record.mode === "pinned" ? record.resolved_ref : "",
    saved_commit: record.mode === "pinned" ? record.commit : "",
  };
}

export function normalizePinnedArguments(
  arguments_: PinnedArguments,
): PinnedSelectionRecord {
  const requestedRef =
    normalizeCommitInput(arguments_.requestedRef) ?? arguments_.requestedRef;
  const resolvedRef =
    normalizeCommitInput(arguments_.resolvedRef) ?? arguments_.resolvedRef;
  const commit = arguments_.commit.toLowerCase();
  return {
    schema_version: 1,
    mode: "pinned",
    source: arguments_.source,
    requested_ref: requestedRef,
    resolved_ref: resolvedRef,
    commit,
  };
}

export function serializeRecord(record: SelectionRecord): string {
  if (record.mode === "track-latest") {
    return `{\n  "schema_version": 1,\n  "mode": "track-latest",\n  "source": "${escapePythonJsonString(record.source)}"\n}\n`;
  }
  return `{\n  "schema_version": 1,\n  "mode": "pinned",\n  "source": "${escapePythonJsonString(record.source)}",\n  "requested_ref": "${escapePythonJsonString(record.requested_ref)}",\n  "resolved_ref": "${escapePythonJsonString(record.resolved_ref)}",\n  "commit": "${escapePythonJsonString(record.commit)}"\n}\n`;
}

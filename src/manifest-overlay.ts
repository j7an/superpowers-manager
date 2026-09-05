import { escapeNonAscii, formatPythonNumber } from "./python-json-format.ts";
import { SafetyError } from "./safety-error.ts";
import {
  isRawNumber,
  isRawObject,
  parseStrictJsonPreservingNumbers,
  type RawJsonValue,
  type StrictJsonProfile,
} from "./strict-json.ts";

const OVERLAY_PROFILE: StrictJsonProfile = {
  duplicateKeys: "last-wins",
  nonStandardConstants: "reject",
  maxDepth: 256,
};

/**
 * Apply the manager's manifest overlay to a Codex plugin manifest.
 *
 * Byte-for-byte equivalent to the CPython implementation this replaces:
 * `json.dump(data, f, indent=2, allow_nan=False)` plus a trailing newline.
 * The byte-parity evidence lives in
 * `tests/baseline/manifest-overlay-parity.test.js` (tracked as
 * `MANIFEST-READER-OVERLAY-01` in `docs/baseline/traceability.md`) against
 * the fixtures under `tests/fixtures/baseline/overlay-parity/`. Known,
 * deliberate divergences from strict byte parity are recorded in
 * `tests/fixtures/baseline/overlay-parity/divergent/README.md`.
 */
export function applyManifestOverlay(
  source: string,
  version: string,
  path: string,
): string {
  let parsed: RawJsonValue;
  try {
    parsed = parseStrictJsonPreservingNumbers(source, OVERLAY_PROFILE);
  } catch (cause) {
    throw translate(cause, source, path);
  }
  if (!isRawObject(parsed)) {
    throw new SafetyError(
      "manifest-overlay",
      `manifest must be a JSON object: ${path}`,
    );
  }
  // CPython assigns into a dict: an existing key keeps its position and a new
  // key is appended in assignment order. Verified 2026-07-31 —
  // {"version":"old","b":2} becomes {"version": ..., "b": 2, "skills": ...},
  // while {"b":2} becomes {"b": 2, "version": ..., "skills": ...}.
  const entries: [string, RawJsonValue][] = parsed.entries.map(
    ([key, value]) => [key, value],
  );
  setMember(entries, "version", version);
  setMember(entries, "skills", "./skills/");
  try {
    return `${emitObject(entries, 0)}\n`;
  } catch (cause) {
    throw rewrapNumberOutOfRange(cause, path);
  }
}

// formatPythonNumber (src/python-json-format.ts) has no notion of a manifest
// path — it is a general CPython-`json.dump`-equivalent number formatter,
// exercised on its own in tests/unit/python-json-format.test.js — so it
// throws a bare `JSON number out of range: ${raw}`. That left the operator
// with no indication of which manifest produced the diagnostic, unlike every
// other overlay failure. This rewrap adds the path without touching
// formatPythonNumber's own contract, and is scoped to exactly this message so
// it cannot swallow or reword any other overlay throw.
const NUMBER_OUT_OF_RANGE_PREFIX = "JSON number out of range: ";

function rewrapNumberOutOfRange(cause: unknown, path: string): unknown {
  if (
    cause instanceof SafetyError &&
    cause.message.startsWith(NUMBER_OUT_OF_RANGE_PREFIX)
  ) {
    const raw = cause.message.slice(NUMBER_OUT_OF_RANGE_PREFIX.length);
    return new SafetyError(
      "manifest-overlay",
      `JSON number out of range in ${path}: ${raw}`,
      { cause },
    );
  }
  return cause;
}

function setMember(
  entries: [string, RawJsonValue][],
  key: string,
  value: RawJsonValue,
): void {
  const index = entries.findIndex(([existing]) => existing === key);
  if (index === -1) entries.push([key, value]);
  else entries[index] = [key, value];
}

/**
 * Map strict-json's diagnostics onto the CPython wording the callers assert.
 * Repository policy at `AGENTS.md:91::most diagnostics are asserted as`
 * freezes most of these diagnostics as complete-string contracts.
 */
function translate(cause: unknown, source: string, path: string): SafetyError {
  const text = cause instanceof Error ? cause.message : String(cause);
  const token = /^non-standard JSON constant (\S+)/.exec(text)?.[1];
  if (token !== undefined) {
    return new SafetyError(
      "manifest-overlay",
      `invalid manifest JSON in ${path}: non-standard numeric constant: ${token}`,
      { cause },
    );
  }
  if (/container depth exceeds/.test(text)) {
    return new SafetyError(
      "manifest-overlay",
      `JSON nesting exceeds limit in ${path}`,
      { cause },
    );
  }
  // strict-json reports `… at character N`
  // (`src/strict-json.ts:312::at character ${this.index}`), a zero-based offset. CPython reports
  // one-based line and column. Convert so the message keeps CPython's shape.
  // This does NOT claim the two parsers fail at the same place on the same
  // malformed input — see the spec.
  const match = /^(.*) at character (\d+)$/.exec(text);
  const reason = match?.[1] ?? text;
  const offset = match === null ? 0 : Number(match[2]);
  const preceding = source.slice(0, offset);
  const newlines = preceding.split("\n");
  const line = newlines.length;
  const column = (newlines[newlines.length - 1]?.length ?? 0) + 1;
  return new SafetyError(
    "manifest-overlay",
    `invalid manifest JSON in ${path}: line ${line} column ${column}: ${reason}`,
    { cause },
  );
}

function emit(value: RawJsonValue, depth: number): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return escapeNonAscii(JSON.stringify(value));
  // Order matters: isRawNumber before isRawObject, and both before Array —
  // the branded records are objects too.
  if (isRawNumber(value)) return formatPythonNumber(value.source);
  if (isRawObject(value)) return emitObject(value.entries, depth);

  const inner = "  ".repeat(depth + 1);
  const outer = "  ".repeat(depth);
  if (value.length === 0) return "[]";
  const items = value.map((item) => `${inner}${emit(item, depth + 1)}`);
  return `[\n${items.join(",\n")}\n${outer}]`;
}

function emitObject(
  entries: readonly (readonly [string, RawJsonValue])[],
  depth: number,
): string {
  if (entries.length === 0) return "{}";
  const inner = "  ".repeat(depth + 1);
  const outer = "  ".repeat(depth);
  const members = entries.map(
    ([key, item]) =>
      `${inner}${escapeNonAscii(JSON.stringify(key))}: ${emit(item, depth + 1)}`,
  );
  return `{\n${members.join(",\n")}\n${outer}}`;
}

import { readFile, writeFile } from "node:fs/promises";
import { COMMIT_INPUT_RE } from "./domain/refs.js";
import { SafetyError } from "./safety-error.js";
import {
  parseStrictJson,
  type JsonValue,
  type StrictJsonProfile,
} from "./strict-json.js";

export interface ProvenanceRecord {
  readonly source: string;
  readonly requested_ref: string;
  readonly resolved_ref: string;
  readonly commit: string;
  readonly upstream_manifest_version: string;
}

export const PROVENANCE_STRICT_PROFILE: StrictJsonProfile = {
  duplicateKeys: "last-wins",
  maxDepth: 256,
};

export const PROVENANCE_LENIENT_PROFILE: StrictJsonProfile = {
  duplicateKeys: "last-wins",
};

function asObject(value: JsonValue): { [key: string]: JsonValue } | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

export async function readStrictProvenanceField(
  path: string,
  dottedKey: string,
): Promise<JsonValue | undefined> {
  try {
    const parsed = parseStrictJson(
      await readFile(path),
      PROVENANCE_STRICT_PROFILE,
    );
    let current: JsonValue | undefined = parsed;
    if (asObject(current) === undefined) {
      throw new SafetyError(
        "provenance",
        `provenance value must be an object: ${path}`,
      );
    }
    for (const part of dottedKey.split(".")) {
      const object: { [key: string]: JsonValue } | undefined =
        current === undefined ? undefined : asObject(current);
      if (object === undefined || !Object.hasOwn(object, part))
        return undefined;
      current = object[part];
    }
    return current === null ? undefined : current;
  } catch (cause) {
    if (cause instanceof SafetyError && cause.module === "provenance") {
      throw cause;
    }
    throw new SafetyError(
      "provenance",
      `cannot read strict provenance field from ${path}`,
      { cause },
    );
  }
}

export async function readGeneratedCommitLenient(
  path: string,
): Promise<string> {
  try {
    const parsed = parseStrictJson(
      await readFile(path),
      PROVENANCE_LENIENT_PROFILE,
    );
    const object = asObject(parsed);
    const commit = object?.commit;
    return typeof commit === "string" && COMMIT_INPUT_RE.test(commit)
      ? commit
      : "";
  } catch {
    return "";
  }
}

const PROVENANCE_KEYS = [
  "source",
  "requested_ref",
  "resolved_ref",
  "commit",
  "upstream_manifest_version",
] as const;

function escapePythonJsonString(value: string): string {
  let escaped = "";
  const shortEscapes: Record<number, string> = {
    0x08: "\\b",
    0x09: "\\t",
    0x0a: "\\n",
    0x0c: "\\f",
    0x0d: "\\r",
  };
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22) {
      escaped += '\\"';
    } else if (code === 0x5c) {
      escaped += "\\\\";
    } else if (Object.hasOwn(shortEscapes, code)) {
      escaped += shortEscapes[code];
    } else if (code < 0x20 || code >= 0x7f) {
      escaped += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      escaped += value[index];
    }
  }
  return escaped;
}

export function serializeProvenance(record: ProvenanceRecord): string {
  const lines = PROVENANCE_KEYS.map(
    (key) => `  "${key}": "${escapePythonJsonString(record[key])}"`,
  );
  return `{\n${lines.join(",\n")}\n}\n`;
}

export async function writeProvenance(
  path: string,
  record: ProvenanceRecord,
): Promise<void> {
  try {
    await writeFile(path, serializeProvenance(record), "utf8");
  } catch (cause) {
    throw new SafetyError("provenance", `cannot write provenance ${path}`, {
      cause,
    });
  }
}

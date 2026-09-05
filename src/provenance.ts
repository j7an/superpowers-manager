import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { COMMIT_INPUT_RE } from "./domain/refs.ts";
import { escapePythonJsonString } from "./python-json.ts";
import { SafetyError } from "./safety-error.ts";
import {
  parseStrictJson,
  type JsonValue,
  type StrictJsonProfile,
} from "./strict-json.ts";

export interface ProvenanceRecord {
  readonly source: string;
  readonly requested_ref: string;
  readonly resolved_ref: string;
  readonly commit: string;
  readonly upstream_manifest_version: string;
}

export const PROVENANCE_STRICT_PROFILE: StrictJsonProfile = {
  duplicateKeys: "last-wins",
  nonStandardConstants: "reject",
  maxDepth: 256,
};

export const PROVENANCE_LENIENT_PROFILE: StrictJsonProfile = {
  duplicateKeys: "last-wins",
  nonStandardConstants: "reject",
};

export const PROVENANCE_CODEX_SOURCE_PROFILE: StrictJsonProfile = {
  duplicateKeys: "last-wins",
  nonStandardConstants: "accept",
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

// Ported from
// `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/lifecycle.sh:28-31::spw_generated_metadata_path(`.
// The path the generated tree's provenance lives at, relative to a package
// root.
export function generatedMetadataPath(root: string): string {
  return join(root, "plugins", "superpowers", ".superpowers-upstream.json");
}

// Ported from
// `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/lifecycle.sh:33-37::spw_generated_commit_or_empty`.
// Lenient by design: a missing or malformed generated provenance file yields
// "", which `statusForCommits` reads as "needs prepare". Aborting here would
// deny the operator the remediation path.
export async function generatedCommitOrEmpty(root: string): Promise<string> {
  return readGeneratedCommitLenient(generatedMetadataPath(root));
}

export async function readCodexBuildSource(path: string): Promise<string> {
  try {
    const parsed = parseStrictJson(
      await readFile(path),
      PROVENANCE_CODEX_SOURCE_PROFILE,
    );
    const source = asObject(parsed)?.source;
    if (typeof source !== "string" || source.length === 0) {
      throw new SafetyError("provenance", `invalid Codex source in ${path}`);
    }
    return source;
  } catch (cause) {
    if (cause instanceof SafetyError && cause.module === "provenance") {
      throw cause;
    }
    throw new SafetyError(
      "provenance",
      `cannot read Codex source from ${path}`,
      { cause },
    );
  }
}

const PROVENANCE_KEYS = [
  "source",
  "requested_ref",
  "resolved_ref",
  "commit",
  "upstream_manifest_version",
] as const;

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

import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { COMMIT_INPUT_RE } from "./domain/refs.js";
import { SafetyError } from "./safety-error.js";
import {
  parseStrictJson,
  type JsonValue,
  type StrictJsonProfile,
} from "./strict-json.js";

const INSTALLED_PROFILE: StrictJsonProfile = {
  duplicateKeys: "last-wins",
  nonStandardConstants: "reject",
  maxDepth: 256,
};
type JsonObject = { [key: string]: JsonValue };

function fail(message: string, cause?: unknown): never {
  throw new SafetyError("codex-state", message, { cause });
}

function object(value: JsonValue): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

async function jsonStringField(path: string, key: string): Promise<string> {
  let parsed: JsonValue;
  try {
    parsed = parseStrictJson(await readFile(path), INSTALLED_PROFILE);
  } catch (cause) {
    fail(`cannot read installed Codex JSON ${path}`, cause);
  }
  const record = object(parsed);
  if (record === undefined) fail(`invalid installed Codex JSON ${path}`);
  const value = record[key];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") fail(`invalid installed Codex JSON ${path}`);
  return value;
}

export function installedRootForVersion(
  searchRoot: string,
  marketplace: string,
  plugin: string,
  version: string,
): string {
  return join(searchRoot, "plugins", "cache", marketplace, plugin, version);
}

export async function codexMetadataCommit(path: string): Promise<string> {
  const commit = await jsonStringField(path, "commit");
  if (!COMMIT_INPUT_RE.test(commit) && !/^[0-9a-fA-F]{7}$/.test(commit)) {
    fail(`invalid installed Codex commit in ${path}`);
  }
  return commit;
}

export async function manifestShortSha(path: string): Promise<string> {
  const version = await jsonStringField(path, "version");
  if (!version.includes("+manager.")) return "";
  const short = version.slice(version.lastIndexOf(".") + 1);
  return /^[0-9a-fA-F]{7}$/.test(short) ? short : "";
}

export async function installedCommitFromRoot(
  activeRoot: string,
): Promise<string> {
  try {
    return await codexMetadataCommit(
      join(activeRoot, ".superpowers-upstream.json"),
    );
  } catch {
    // The shell predecessor deliberately fell back to the generated manifest.
  }
  try {
    return await manifestShortSha(
      join(activeRoot, ".codex-plugin", "plugin.json"),
    );
  } catch {
    return "";
  }
}

async function comparablePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

export async function pathsEqual(a: string, b: string): Promise<boolean> {
  return (await comparablePath(a)) === (await comparablePath(b));
}

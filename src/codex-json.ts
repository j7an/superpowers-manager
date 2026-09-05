import { SafetyError } from "./safety-error.ts";
import {
  parseStrictJson,
  type JsonValue,
  type StrictJsonProfile,
} from "./strict-json.ts";

const ACCEPT_CONSTANTS: StrictJsonProfile = {
  duplicateKeys: "last-wins",
  nonStandardConstants: "accept",
};
const REJECT_CONSTANTS: StrictJsonProfile = {
  duplicateKeys: "last-wins",
  nonStandardConstants: "reject",
};

type JsonObject = { [key: string]: JsonValue };

function fail(message: string, cause?: unknown): never {
  throw new SafetyError("codex-json", message, { cause });
}

function object(value: JsonValue): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function parseObject(
  raw: string | Uint8Array,
  profile: StrictJsonProfile,
): JsonObject {
  let parsed: JsonValue;
  try {
    parsed = parseStrictJson(raw, profile);
  } catch (cause) {
    fail("cannot parse Codex JSON", cause);
  }
  const result = object(parsed);
  if (result === undefined) fail("Codex JSON must be an object");
  return result;
}

function checkedItems(
  raw: string | Uint8Array,
  profile: StrictJsonProfile,
  arrayKey: string,
  field: string,
): JsonObject[] {
  const items = parseObject(raw, profile)[arrayKey];
  if (!Array.isArray(items)) fail(`Codex JSON ${arrayKey} must be an array`);
  return items.map((item) => {
    const candidate = object(item);
    if (candidate === undefined) {
      fail(`Codex JSON ${arrayKey} item must be an object`);
    }
    const fieldValue = candidate[field];
    if (typeof fieldValue !== "string" || fieldValue.length === 0) {
      fail(`Codex JSON ${arrayKey} item needs non-empty ${field}`);
    }
    return candidate;
  });
}

function hasTerminalControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0xd800 && code <= 0xdfff)
    ) {
      return true;
    }
  }
  return false;
}

export function installedListingHas(
  raw: string | Uint8Array,
  arrayKey: string,
  field: string,
  value: string,
): boolean {
  return checkedItems(raw, ACCEPT_CONSTANTS, arrayKey, field).some(
    (item) => item[field] === value,
  );
}

export function marketplaceRootFromJson(
  raw: string | Uint8Array,
  marketplaceName: string,
): string {
  const items = checkedItems(raw, ACCEPT_CONSTANTS, "marketplaces", "name");
  const match = items.find((item) => item.name === marketplaceName);
  if (match === undefined) return "";
  if (typeof match.root !== "string" || match.root.length === 0) {
    fail("matching marketplace needs a non-empty root");
  }
  return match.root;
}

export function activePluginVersionFromJson(
  raw: string | Uint8Array,
  pluginId: string,
): string {
  const matches = checkedItems(
    raw,
    REJECT_CONSTANTS,
    "installed",
    "pluginId",
  ).filter((item) => item.pluginId === pluginId);
  if (matches.length > 1) fail("active plugin appears more than once");
  if (matches.length === 0) return "";
  const version = matches[0]!.version;
  if (
    typeof version !== "string" ||
    version.length === 0 ||
    version === "." ||
    version === ".." ||
    version.includes("/") ||
    version.includes("\\") ||
    hasTerminalControl(version)
  ) {
    fail("active plugin version is invalid");
  }
  return version;
}

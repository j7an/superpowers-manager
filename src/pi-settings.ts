import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeProspectivePath } from "./safe-path.ts";
import { SafetyError } from "./safety-error.ts";
import {
  parseStrictJson,
  type JsonValue,
  type StrictJsonProfile,
} from "./strict-json.ts";

export interface PiPackageEntry {
  readonly source: string;
  readonly resourceState: "enabled" | "disabled" | "indeterminate";
}

export interface PiSettings {
  readonly packages: readonly PiPackageEntry[];
  readonly skills?: readonly string[];
}

type JsonObject = { [key: string]: JsonValue };

const SETTINGS_PROFILE: StrictJsonProfile = {
  duplicateKeys: "last-wins",
  nonStandardConstants: "reject",
  maxDepth: 256,
};

// Pi 0.85.1's preliminary isLocalPath check excludes github:, but parseGitUrl
// does not recognize that shorthand and parseSource falls back to local. Keep
// that verified case locally inspectable; the remaining exact, case-sensitive
// prefix policy stays bounded because widening it changes which settings
// identities compare as paths.
const REMOTE_SOURCE_PREFIXES = [
  "npm:",
  "git:",
  "http:",
  "https:",
  "ssh:",
] as const;

function invalid(path: string, detail: string, cause?: unknown): never {
  throw new SafetyError(
    "pi-settings",
    `invalid Pi settings ${path}: ${detail}`,
    {
      cause,
    },
  );
}

function object(value: JsonValue): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function stringArray(value: JsonValue | undefined): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function requiredResourceState(entry: {
  readonly autoload?: boolean;
  readonly skills?: string[];
  readonly extensions?: string[];
}): PiPackageEntry["resourceState"] {
  if (
    entry.autoload !== false &&
    entry.skills === undefined &&
    entry.extensions === undefined
  ) {
    return "enabled";
  }
  if (entry.skills?.length === 0 && entry.extensions?.length === 0) {
    return "disabled";
  }
  if (
    entry.autoload === false &&
    entry.skills === undefined &&
    entry.extensions === undefined
  ) {
    return "disabled";
  }
  return "indeterminate";
}

function parsePackage(
  value: JsonValue,
  index: number,
  path: string,
): PiPackageEntry {
  if (typeof value === "string") {
    if (value.trim().length === 0) {
      invalid(path, `package ${index} source must be a nonempty string`);
    }
    return { source: value, resourceState: "enabled" };
  }

  const entry = object(value);
  if (entry === undefined) {
    invalid(path, `package ${index} must be a string or object`);
  }
  if (typeof entry.source !== "string" || entry.source.trim().length === 0) {
    invalid(path, `package ${index} source must be a nonempty string`);
  }
  if (entry.autoload !== undefined && typeof entry.autoload !== "boolean") {
    invalid(path, `package ${index} autoload must be a boolean`);
  }
  if (entry.skills !== undefined && !stringArray(entry.skills)) {
    invalid(path, `package ${index} skills must be an array of strings`);
  }
  if (entry.extensions !== undefined && !stringArray(entry.extensions)) {
    invalid(path, `package ${index} extensions must be an array of strings`);
  }

  return {
    source: entry.source,
    resourceState: requiredResourceState({
      ...(entry.autoload === undefined ? {} : { autoload: entry.autoload }),
      ...(entry.skills === undefined ? {} : { skills: entry.skills }),
      ...(entry.extensions === undefined
        ? {}
        : { extensions: entry.extensions }),
    }),
  };
}

function isMissing(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}

export function resolvePiLocalSource(
  source: string,
  agentDir: string,
  homeDir?: string,
): string | null {
  let normalized = source.trim();
  if (
    normalized.length === 0 ||
    REMOTE_SOURCE_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  ) {
    return null;
  }
  if (normalized === "~" || normalized.startsWith("~/")) {
    if (homeDir === undefined || homeDir.length === 0) {
      throw new SafetyError(
        "pi-settings",
        "cannot resolve Pi local source containing ~ without HOME",
      );
    }
    normalized =
      normalized === "~" ? homeDir : join(homeDir, normalized.slice(2));
  } else if (normalized.startsWith("file://")) {
    try {
      normalized = fileURLToPath(normalized);
    } catch (cause) {
      throw new SafetyError(
        "pi-settings",
        "cannot resolve Pi local source from invalid file URL",
        { cause },
      );
    }
  }
  return resolve(agentDir, normalized);
}

export async function resolveCanonicalPiLocalSource(
  source: string,
  agentDir: string,
  homeDir?: string,
): Promise<string | null> {
  const resolved = resolvePiLocalSource(source, agentDir, homeDir);
  return resolved === null ? null : canonicalizeProspectivePath(resolved);
}

export async function readPiSettings(
  path: string,
  homeDir?: string,
): Promise<PiSettings> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (cause) {
    if (isMissing(cause)) return { packages: [] };
    throw new SafetyError("pi-settings", `cannot read Pi settings ${path}`, {
      cause,
    });
  }

  let parsed: JsonValue;
  try {
    parsed = parseStrictJson(bytes, SETTINGS_PROFILE);
  } catch (cause) {
    throw new SafetyError("pi-settings", `cannot parse Pi settings ${path}`, {
      cause,
    });
  }

  const settings = object(parsed);
  if (settings === undefined) invalid(path, "settings must be an object");
  if (settings.skills !== undefined && !stringArray(settings.skills)) {
    invalid(path, "skills must be an array of strings");
  }
  if (settings.packages !== undefined && !Array.isArray(settings.packages)) {
    invalid(path, "packages must be an array");
  }

  const packages = (settings.packages ?? []).map((entry, index) =>
    parsePackage(entry, index, path),
  );
  const agentDir = dirname(resolve(path));
  const managerInstallation = await canonicalizeProspectivePath(
    resolve(agentDir, join("superpowers-manager", "installed")),
  );
  const managerRegistrations: PiPackageEntry[] = [];
  for (const entry of packages) {
    if (
      (await resolveCanonicalPiLocalSource(entry.source, agentDir, homeDir)) ===
      managerInstallation
    ) {
      managerRegistrations.push(entry);
    }
  }
  if (managerRegistrations.length > 1) {
    invalid(path, "duplicate Manager package registrations");
  }

  return {
    packages,
    ...(settings.skills === undefined ? {} : { skills: settings.skills }),
  };
}

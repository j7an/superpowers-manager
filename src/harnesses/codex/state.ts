import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  failureResult,
  successResult,
  type AdapterContext,
  type AdapterResult,
} from "../../adapter-result.ts";
import { digestArtifactTree, readArtifactObject } from "../../artifact-tree.ts";
import { COMMIT_INPUT_RE } from "../../domain/refs.ts";
import type { EffectiveSelection } from "../../effective-selection.ts";
import type { InstalledState } from "../../harness.ts";
import { SafetyError } from "../../safety-error.ts";
import {
  parseStrictJson,
  type JsonValue,
  type StrictJsonProfile,
} from "../../strict-json.ts";
import { codexReadNativeState } from "./adapter.ts";
import { readCodexAssessment } from "./compatibility.ts";
import { readCodexMarketplace } from "./marketplace.ts";
import { codexPaths } from "./paths.ts";
import { classifyPathNoFollow } from "../../safe-path.ts";

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

function preserveFailure<T, U>(result: AdapterResult<U>): AdapterResult<T> {
  if (result.outcome.ok) throw new Error("expected adapter failure");
  return failureResult(
    result.outcome.operation,
    result.outcome.error.code,
    result.outcome.error.message,
    result.outcome.error.hints,
    result.outcome.messages,
  );
}

function mismatch(
  reason: string,
  messages: AdapterResult["outcome"]["messages"] = [],
  observedIdentity = "",
): AdapterResult<InstalledState> {
  return successResult(
    "inspect-codex-installed",
    { kind: "mismatch", observedIdentity },
    [
      ...messages,
      { channel: "stderr", text: `Codex installation state: ${reason}` },
    ],
  );
}

async function matchesSelection(
  root: string,
  selection: EffectiveSelection,
): Promise<boolean> {
  const provenance = await readArtifactObject(
    root,
    join(root, ".superpowers-upstream.json"),
  );
  return provenance.source === selection.effectiveSource;
}

export function hasFilesystemAccessFailure(cause: unknown): boolean {
  let current = cause;
  for (
    let depth = 0;
    depth < 8 && current !== null && typeof current === "object";
    depth += 1
  ) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code !== "ENOENT" && code !== "ENOTDIR") {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function activeInspectionFailure(
  operation: string,
  root: string,
  messages: AdapterResult["outcome"]["messages"],
): AdapterResult<InstalledState> {
  return failureResult(
    operation,
    "inspect-failed",
    `cannot inspect active Codex plugin payload at ${root}`,
    [],
    messages,
  );
}

export async function inspectCodexInstallation(
  selection: EffectiveSelection,
  ctx: AdapterContext,
  readNative: typeof codexReadNativeState = codexReadNativeState,
): Promise<AdapterResult<InstalledState>> {
  const operation = "inspect-codex-installed";
  const native = await readNative(ctx);
  if (!native.outcome.ok) return preserveFailure(native);
  const messages = native.outcome.messages;
  const paths = codexPaths(ctx.env ?? {}, process.cwd());
  let marketplace;
  try {
    marketplace = await readCodexMarketplace(paths.marketplaceRoot);
  } catch {
    return failureResult(
      operation,
      "inspect-failed",
      `cannot inspect owned Codex marketplace at ${paths.marketplaceRoot}`,
      [],
      messages,
    );
  }
  const observed = native.outcome.result;
  const observedIdentity =
    observed.pluginPresent && observed.activeRoot !== null
      ? await installedCommitFromRoot(observed.activeRoot)
      : "";
  if (!observed.pluginPresent && observed.marketplaceRoot === null) {
    return successResult(
      operation,
      { kind: "absent", observedIdentity: "" },
      messages,
    );
  }
  if (
    observed.marketplaceRoot !== null &&
    !(await pathsEqual(observed.marketplaceRoot, paths.marketplaceRoot))
  ) {
    return mismatch(
      "legacy Codex marketplace source",
      messages,
      observedIdentity,
    );
  }
  if (marketplace === null)
    return mismatch(
      "durable Codex marketplace is missing",
      messages,
      observedIdentity,
    );
  try {
    if (
      marketplace.artifact.commit !== selection.desiredCommit ||
      marketplace.artifact.compatibility.kind !== "supported" ||
      !(await matchesSelection(marketplace.artifact.root, selection))
    ) {
      return mismatch(
        "durable Codex marketplace differs from selection",
        messages,
        observedIdentity,
      );
    }
  } catch {
    return failureResult(
      operation,
      "inspect-failed",
      `cannot inspect owned Codex marketplace at ${paths.marketplaceRoot}`,
      [],
      messages,
    );
  }
  if (
    !observed.pluginPresent ||
    !observed.pluginEnabled ||
    observed.activeRoot === null
  ) {
    return mismatch(
      "Codex manager plugin needs repair",
      messages,
      observedIdentity,
    );
  }
  let activeKind;
  try {
    activeKind = await classifyPathNoFollow(observed.activeRoot);
  } catch {
    return activeInspectionFailure(operation, observed.activeRoot, messages);
  }
  if (activeKind === "missing") {
    return mismatch(
      "active Codex plugin payload is missing",
      messages,
      observedIdentity,
    );
  }
  if (activeKind !== "directory") {
    return activeInspectionFailure(operation, observed.activeRoot, messages);
  }
  let active;
  let activeDigest: string;
  try {
    active = await readCodexAssessment(observed.activeRoot);
    activeDigest = await digestArtifactTree(active.root);
  } catch (cause) {
    if (hasFilesystemAccessFailure(cause)) {
      return activeInspectionFailure(operation, observed.activeRoot, messages);
    }
    return mismatch(
      "active Codex plugin payload is invalid",
      messages,
      observedIdentity,
    );
  }
  let durableDigest: string;
  try {
    durableDigest = await digestArtifactTree(marketplace.artifact.root);
  } catch {
    return failureResult(
      operation,
      "inspect-failed",
      `cannot inspect owned Codex marketplace at ${paths.marketplaceRoot}`,
      [],
      messages,
    );
  }
  try {
    if (
      active.commit !== selection.desiredCommit ||
      active.compatibility.kind !== "supported" ||
      !(await matchesSelection(active.root, selection)) ||
      activeDigest !== durableDigest
    ) {
      return mismatch(
        "active Codex plugin payload differs from durable marketplace",
        messages,
        active.commit,
      );
    }
  } catch (cause) {
    if (hasFilesystemAccessFailure(cause)) {
      return activeInspectionFailure(operation, observed.activeRoot, messages);
    }
    return mismatch(
      "active Codex plugin payload is invalid",
      messages,
      observedIdentity,
    );
  }
  return successResult(
    operation,
    {
      kind: "current",
      observedIdentity: active.commit,
    },
    messages,
  );
}

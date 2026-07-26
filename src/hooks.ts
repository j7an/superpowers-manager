import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertExistingContained,
  assertProspectiveContained,
  classifyPathNoFollow,
} from "./safe-path.js";
import type { NoFollowPathType } from "./safe-path.js";
import { SafetyError } from "./safety-error.js";
import { parseStrictJson } from "./strict-json.js";
import type { JsonValue, StrictJsonProfile } from "./strict-json.js";

export type ManifestSource = "upstream" | "fallback";

export interface HookPlan {
  readonly copyHooksSubtree: boolean;
  readonly declaredPaths: readonly string[];
}

// Annotated, not `as const`, matching src/provenance.ts:19 and
// src/selection-store.ts:19. The annotation rejects a misspelled or
// unsupported profile field here rather than at the parseStrictJson call.
const MANIFEST_PROFILE: StrictJsonProfile = {
  duplicateKeys: "last-wins",
  maxDepth: 256,
};

// Private helper, matching src/selection.ts:42 and src/upstream.ts:35.
// No new exported error class: SafetyError already carries module and cause.
function hookError(message: string, cause?: unknown): SafetyError {
  return new SafetyError("hooks", message, { cause });
}

// One frozen template for every owned safe-path failure. The three wrappers
// below stay separate because they perform different operations; only the
// message is shared.
function ownedPathError(
  label: string,
  path: string,
  cause: unknown,
): SafetyError {
  return hookError(`${label} escapes or could not be resolved: ${path}`, cause);
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// Every safe-path call goes through here. Calling classifyPathNoFollow
// directly would let a SafetyError with module "safe-path" escape to the CLI,
// breaking the promise that this module owns its diagnostics.
async function classifyOwned(
  path: string,
  label: string,
): Promise<NoFollowPathType> {
  try {
    return await classifyPathNoFollow(path);
  } catch (cause) {
    throw ownedPathError(label, path, cause);
  }
}

async function isRegularFileFollowing(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectoryFollowing(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function requireExistingContained(
  root: string,
  path: string,
  label: string,
): Promise<void> {
  try {
    await assertExistingContained(root, path);
  } catch (cause) {
    throw ownedPathError(label, path, cause);
  }
}

async function requireProspectiveContained(
  root: string,
  path: string,
  label: string,
): Promise<void> {
  try {
    await assertProspectiveContained(root, path);
  } catch (cause) {
    throw ownedPathError(label, path, cause);
  }
}

export async function readManifest(
  path: string,
): Promise<Record<string, JsonValue>> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (cause) {
    throw hookError(
      `cannot read manifest JSON in ${path}: ${detail(cause)}`,
      cause,
    );
  }
  let parsed: JsonValue;
  try {
    parsed = parseStrictJson(bytes, MANIFEST_PROFILE);
  } catch (cause) {
    throw hookError(
      `invalid manifest JSON in ${path}: ${detail(cause)}`,
      cause,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw hookError(`manifest must be a JSON object: ${path}`);
  }
  return parsed;
}

function isPlainObject(value: JsonValue): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEmptyArray(value: JsonValue): boolean {
  return Array.isArray(value) && value.length === 0;
}

function isEmptyObject(value: JsonValue): boolean {
  return isPlainObject(value) && Object.keys(value as object).length === 0;
}

async function checkedFile(
  root: string,
  relativePath: string,
): Promise<string> {
  const source = resolve(root, relativePath);
  await requireExistingContained(root, source, "declared hook source");
  if (!(await isRegularFileFollowing(source))) {
    throw hookError(`declared hook source is not a regular file: ${source}`);
  }
  return source;
}

async function validateDeclaredFile(
  upstreamRoot: string,
  raw: string,
  index: number,
): Promise<void> {
  if (!raw.startsWith("./")) {
    throw hookError(
      `declared hook path must start with ./: hooks declaration index ${index}`,
    );
  }
  await checkedFile(upstreamRoot, raw.slice(2));
}

export async function classifyHooks(
  manifest: Readonly<Record<string, JsonValue>>,
  source: ManifestSource,
  upstreamRoot: string,
): Promise<HookPlan> {
  if (source === "fallback") {
    if (Object.hasOwn(manifest, "hooks")) {
      throw hookError("fallback manifest must not declare hooks");
    }
    return { copyHooksSubtree: false, declaredPaths: [] };
  }

  const declared = Object.hasOwn(manifest, "hooks");
  const hooksRoot = resolve(upstreamRoot, "hooks");
  const defaultConfig = resolve(hooksRoot, "hooks.json");
  const hooksRootPresent =
    (await classifyOwned(hooksRoot, "hook subtree")) !== "missing";

  if (!declared) {
    return {
      copyHooksSubtree: await isRegularFileFollowing(defaultConfig),
      declaredPaths: [],
    };
  }
  const hooks = manifest.hooks as JsonValue;
  if (isEmptyArray(hooks)) {
    return {
      copyHooksSubtree: await isRegularFileFollowing(defaultConfig),
      declaredPaths: [],
    };
  }
  if (isEmptyObject(hooks)) {
    return { copyHooksSubtree: false, declaredPaths: [] };
  }

  let paths: readonly string[];
  if (typeof hooks === "string") {
    paths = [hooks];
  } else if (
    Array.isArray(hooks) &&
    hooks.length > 0 &&
    hooks.every((value) => typeof value === "string")
  ) {
    paths = hooks as string[];
  } else if (
    isPlainObject(hooks) ||
    (Array.isArray(hooks) && hooks.length > 0 && hooks.every(isPlainObject))
  ) {
    return { copyHooksSubtree: hooksRootPresent, declaredPaths: [] };
  } else {
    throw hookError("unsupported or mixed hooks declaration");
  }

  for (const [index, raw] of paths.entries()) {
    await validateDeclaredFile(upstreamRoot, raw, index);
  }
  return { copyHooksSubtree: hooksRootPresent, declaredPaths: paths };
}

import {
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  readlink,
  stat,
  symlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  assertExistingContained,
  assertProspectiveContained,
  classifyPathNoFollow,
} from "./safe-path.ts";
import type { NoFollowPathType } from "./safe-path.ts";
import { SafetyError } from "./safety-error.ts";
import { parseStrictJson } from "./strict-json.ts";
import type { JsonValue, StrictJsonProfile } from "./strict-json.ts";

export type ManifestSource = "upstream" | "fallback";

export interface HookPlan {
  readonly copyHooksSubtree: boolean;
  readonly declaredPaths: readonly string[];
}

// Annotated, not `as const`, matching
// `src/provenance.ts:20::export const PROVENANCE_STRICT_PROFILE` and
// `src/selection-store.ts:19::const SELECTION_JSON_PROFILE`. The annotation
// rejects a misspelled or unsupported profile field here rather than at the
// parseStrictJson call.
const MANIFEST_PROFILE: StrictJsonProfile = {
  duplicateKeys: "last-wins",
  nonStandardConstants: "reject",
  maxDepth: 256,
};

// Private helper, matching
// `src/selection.ts:42::return new SafetyError("selection"` and
// `src/upstream.ts:35::function upstreamError`. No new exported error class:
// SafetyError already carries module and cause.
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
  } catch {
    // Deliberately drops the cause on both branches. `detail(cause)` on the
    // read branch surfaced a raw errno (`ENOENT: … open '<path>'`), which the
    // `hook classification failed:` site in src/adapter.ts re-emits onto the
    // terminal these commands write to; the parse branch surfaced
    // strict-json's own wording under a prefix src/manifest-overlay.ts also
    // uses with CPython wording.
    // Same text as the `cannot read manifest JSON in` site in src/adapter.ts.
    throw hookError(`cannot read manifest JSON in ${path}`);
  }
  let parsed: JsonValue;
  try {
    parsed = parseStrictJson(bytes, MANIFEST_PROFILE);
  } catch {
    throw hookError(`invalid manifest JSON in ${path}`);
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

async function checkedDestination(
  root: string,
  relativePath: string,
): Promise<string> {
  const destination = resolve(root, relativePath);
  await requireProspectiveContained(
    root,
    dirname(destination),
    "declared hook destination parent",
  );
  const kind = await classifyOwned(destination, "declared hook destination");
  if (kind === "symlink") {
    throw hookError(
      `declared hook destination must not be a symlink: ${destination}`,
    );
  }
  if (kind === "missing") {
    await requireProspectiveContained(
      root,
      destination,
      "declared hook destination",
    );
    return destination;
  }
  await requireExistingContained(
    root,
    destination,
    "declared hook destination",
  );
  if (!(await isRegularFileFollowing(destination))) {
    throw hookError(
      `declared hook destination is not a regular file: ${destination}`,
    );
  }
  return destination;
}

async function collectEntries(tree: string): Promise<string[]> {
  const found: string[] = [];
  const pending: string[] = [tree];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (cause) {
      throw hookError(`hook subtree escapes or is broken: ${current}`, cause);
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      found.push(path);
      // Never descend through a symlink; isDirectory() is lstat-based here.
      if (entry.isDirectory()) pending.push(path);
    }
  }
  return found;
}

async function validateSubtreeSymlinks(
  tree: string,
  containmentRoot: string,
): Promise<void> {
  if ((await classifyOwned(tree, "hook subtree")) === "symlink") {
    if (isAbsolute(await readlink(tree))) {
      throw hookError(`absolute subtree symlink is not allowed: ${tree}`);
    }
  }
  try {
    await assertExistingContained(containmentRoot, tree);
  } catch (cause) {
    throw hookError(`hook subtree escapes or is broken: ${tree}`, cause);
  }
  if (!(await isDirectoryFollowing(tree))) {
    throw hookError(`hook subtree is not a directory: ${tree}`);
  }
  for (const path of await collectEntries(tree)) {
    if ((await classifyOwned(path, "hook subtree entry")) !== "symlink")
      continue;
    if (isAbsolute(await readlink(path))) {
      throw hookError(`absolute symlink is not allowed: ${path}`);
    }
    try {
      await assertExistingContained(containmentRoot, path);
    } catch (cause) {
      throw hookError(`symlink escapes or is broken: ${path}`, cause);
    }
  }
}

async function copyPreservingSymlink(
  source: string,
  destination: string,
): Promise<void> {
  if ((await classifyOwned(source, "declared hook source")) === "symlink") {
    await symlink(await readlink(source), destination);
    return;
  }
  await copyFile(source, destination);
}

async function validateMaterializedDestination(
  destination: string,
  candidateRoot: string,
): Promise<void> {
  const message = `materialized hook destination escapes or is broken: ${destination}`;
  try {
    await assertExistingContained(candidateRoot, destination);
  } catch (cause) {
    // Retain the safe-path error as `cause`; only the message and module are
    // re-owned. Discarding it would erase why containment failed.
    throw hookError(message, cause);
  }
  if (!(await isRegularFileFollowing(destination))) {
    throw hookError(message);
  }
}

export async function materializeHooks(
  plan: HookPlan,
  sourceRoot: string,
  candidateRoot: string,
): Promise<void> {
  if (plan.copyHooksSubtree) {
    const sourceHooks = resolve(sourceRoot, "hooks");
    const candidateHooks = resolve(candidateRoot, "hooks");
    await validateSubtreeSymlinks(sourceHooks, sourceRoot);
    if ((await classifyOwned(sourceHooks, "hook subtree")) === "symlink") {
      await symlink(await readlink(sourceHooks), candidateHooks);
    } else {
      await cp(sourceHooks, candidateHooks, {
        recursive: true,
        verbatimSymlinks: true,
      });
    }
    await validateSubtreeSymlinks(candidateHooks, candidateRoot);
  }

  const destinations: string[] = [];
  for (const raw of plan.declaredPaths) {
    const relativePath = raw.slice(2);
    const source = await checkedFile(sourceRoot, relativePath);
    const destination = await checkedDestination(candidateRoot, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    if (
      (await classifyOwned(destination, "declared hook destination")) ===
      "missing"
    ) {
      await copyPreservingSymlink(source, destination);
    }
    destinations.push(destination);
  }
  for (const destination of destinations) {
    await validateMaterializedDestination(destination, candidateRoot);
  }
}

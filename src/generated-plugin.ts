import type { Buffer } from "node:buffer";
import { lstat, readdir, readFile, readlink, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix } from "node:path";
import { pythonStrip } from "./python-text.js";
import { parseStrictJson, type JsonValue } from "./strict-json.js";

export interface GeneratedPluginValidationOptions {
  readonly pluginRoot: string;
  readonly source: string;
  readonly requestedRef: string;
  readonly resolvedRef: string;
  readonly commit: string;
  readonly manifestVersion: string;
  readonly manifestSource: "upstream" | "fallback";
  readonly upstreamManifestVersion: string;
}

export interface GeneratedPluginFsDeps {
  readonly lstat: typeof lstat;
  readonly stat: typeof stat;
  readonly readdir: typeof readdir;
  readonly readlink: typeof readlink;
  readonly readFile: typeof readFile;
}

export const DEFAULT_FS_DEPS: GeneratedPluginFsDeps = {
  lstat,
  stat,
  readdir,
  readlink,
  readFile,
};

// The Python's own SEMVER_RE (:15-22). Deliberately not SEMVER_BASE_SOURCE
// from src/domain/refs.ts, which omits the `+build` component; widening the
// shared constant would change TAG_RE and is out of scope.
const SEMVER_RE =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const MANIFEST_JSON_PROFILE = {
  duplicateKeys: "last-wins",
  nonStandardConstants: "reject",
  maxDepth: 256,
} as const;

/** Resolution failed. The caller supplies its own site diagnostic. */
class ResolutionFailure extends Error {}
/** A non-absence error from an existence/type probe. */
class InspectionFailure extends Error {}

type Presence = "missing" | "file" | "directory" | "other";

/**
 * `ENOENT`/`ENOTDIR` mean *missing*; every other error rejects. This is the
 * only place the absence set is defined.
 */
function isAbsenceError(cause: unknown): boolean {
  const code = (cause as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

const STRICT_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

/** Decode a raw pathname. Throws when the bytes are not valid UTF-8. */
function decodePathBytes(bytes: Uint8Array): string {
  return STRICT_DECODER.decode(bytes);
}

/**
 * Node silently maps an unpaired surrogate to U+FFFD on the way to the
 * syscall, so a string carrying one would open a different file than the
 * caller named. CPython raises `UnicodeEncodeError` instead.
 */
export function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * CPython `Path.expanduser`, minus `~user`, which stays unexpanded.
 * Concatenates rather than joining: `join` normalizes, and normalization
 * anywhere upstream of `resolvePath` defeats component-wise resolution just as
 * thoroughly as normalization inside it.
 */
function expandUser(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return `${homedir()}/${value.slice(2)}`;
  return value;
}

interface ResolveOptions {
  /** Every component must exist (`Path.resolve(strict=True)`). */
  readonly strict: boolean;
}

/**
 * Makes `value` absolute **without collapsing `..`**. `node:path`'s `resolve`
 * and `join` both normalize, which would erase a `..` before its preceding
 * component is ever resolved.
 */
function absolutize(value: string): string {
  return posix.isAbsolute(value) ? value : `${process.cwd()}/${value}`;
}

/**
 * A component-wise port of `posixpath._joinrealpath`, with this PR's frozen
 * fail-closed policy substituted for CPython's version-divergent suppression.
 */
async function resolvePath(
  target: string,
  deps: GeneratedPluginFsDeps,
  { strict }: ResolveOptions,
): Promise<string> {
  if (hasUnpairedSurrogate(target)) throw new ResolutionFailure(target);
  const start = absolutize(target);
  const seen = new Map<string, string | null>();
  /**
   * Paths left unresolved because resolving them re-entered a link already in
   * progress. Membership is a property of the path, not of the walk, so a
   * later `..` cancels a cycle simply by moving `current` off the marked path
   * — which is the 3.13+ behavior this port freezes. A boolean latch would
   * instead mean "a cycle occurred somewhere" and would reject
   * `outer -> loop/../real`, where the cycle is cancelled before the end.
   */
  const liveComponents = new Set<string>();

  const walk = async (base: string, rest: string): Promise<string> => {
    let current = base;
    for (const name of rest.split("/")) {
      if (name === "" || name === ".") continue;
      if (name === "..") {
        // Pops the already-resolved prefix textually, before any lstat.
        current = posix.dirname(current);
        continue;
      }
      const child = posix.join(current, name);
      let link = false;
      try {
        link = (await deps.lstat(child)).isSymbolicLink();
      } catch (cause) {
        if (!isAbsenceError(cause)) throw new ResolutionFailure(child);
        if (strict) throw new ResolutionFailure(child);
        current = child;
        continue;
      }
      if (!link) {
        current = child;
        continue;
      }
      if (seen.has(child)) {
        const memo = seen.get(child);
        if (memo != null) {
          current = memo;
          continue;
        }
        // A live cycle: leave this component unresolved and keep resolving the
        // remainder. Marking the path is what makes it rejectable if it turns
        // out to be where resolution ends.
        liveComponents.add(child);
        current = child;
        continue;
      }
      seen.set(child, null);
      let raw: Buffer;
      try {
        raw = (await deps.readlink(child, { encoding: "buffer" })) as Buffer;
      } catch {
        // Every readlink error rejects, absence-like errnos included.
        throw new ResolutionFailure(child);
      }
      let linkTarget: string;
      try {
        linkTarget = decodePathBytes(raw);
      } catch {
        throw new ResolutionFailure(child);
      }
      const resolvedLink = await walk(
        posix.isAbsolute(linkTarget) ? "/" : current,
        linkTarget,
      );
      seen.set(child, resolvedLink);
      current = resolvedLink;
    }
    return current;
  };

  const resolved = await walk("/", start);
  // Reject only when resolution *ends* on an unresolved cycle. A cycle that a
  // later component or `..` moved away from is not a live cycle.
  if (liveComponents.has(resolved)) throw new ResolutionFailure(resolved);
  return resolved;
}

/**
 * An existence/type probe under the inspection-failure rule. `follow` picks
 * `stat` (symlink-following, as `exists`/`is_dir`/`is_file` do) or `lstat`
 * (`os.path.lexists`).
 */
async function inspectPath(
  path: string,
  deps: GeneratedPluginFsDeps,
  follow: boolean,
): Promise<Presence> {
  if (hasUnpairedSurrogate(path)) throw new InspectionFailure(path);
  try {
    const info = follow ? await deps.stat(path) : await deps.lstat(path);
    if (info.isDirectory()) return "directory";
    if (info.isFile()) return "file";
    return "other";
  } catch (cause) {
    if (isAbsenceError(cause)) return "missing";
    throw new InspectionFailure(path);
  }
}

async function loadJsonObject(
  path: string,
  label: string,
  errors: string[],
  deps: GeneratedPluginFsDeps,
): Promise<Record<string, JsonValue> | null> {
  let text: string;
  try {
    // Read bytes and decode explicitly: `ignoreBOM: true` keeps a BOM in the
    // text so the parser rejects it, matching Python. A default decoder would
    // strip it and accept a manifest Python rejects.
    text = STRICT_DECODER.decode(await deps.readFile(path));
  } catch {
    // `read_text` failures and decode failures share one branch at :74.
    errors.push(`${label} is unreadable UTF-8`);
    return null;
  }
  let value: JsonValue;
  try {
    value = parseStrictJson(text, MANIFEST_JSON_PROFILE);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    errors.push(
      message.startsWith("container depth exceeds ")
        ? `${label} exceeds maximum JSON nesting`
        : `${label} must contain valid JSON`,
    );
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must contain a JSON object`);
    return null;
  }
  return value;
}

interface LocalPathRequirements {
  readonly requireDirectory?: boolean;
  readonly requireFile?: boolean;
}

async function validateLocalPath(
  pluginRoot: string,
  rawValue: JsonValue | undefined,
  label: string,
  errors: string[],
  deps: GeneratedPluginFsDeps,
  { requireDirectory = false, requireFile = false }: LocalPathRequirements = {},
): Promise<void> {
  if (typeof rawValue !== "string" || pythonStrip(rawValue) === "") {
    errors.push(`${label} must be a non-empty relative path`);
    return;
  }
  if (posix.isAbsolute(rawValue)) {
    errors.push(`${label} must be a relative path`);
    return;
  }
  let root: string;
  let target: string;
  try {
    root = await resolvePath(pluginRoot, deps, { strict: false });
    // Concatenate — `posix.join` would collapse a `..` inside `rawValue`
    // before `resolvePath` ever sees it, which is the same accept-side
    // containment bypass the hand-written resolver exists to avoid.
    target = await resolvePath(`${root}/${rawValue}`, deps, {
      strict: false,
    });
  } catch {
    errors.push(`${label} could not be resolved`);
    return;
  }
  if (target !== root && !target.startsWith(`${root}/`)) {
    errors.push(`${label} escapes the plugin root`);
    return;
  }
  let presence: Presence;
  try {
    presence = await inspectPath(target, deps, true);
  } catch {
    errors.push(`${label} target \`${rawValue}\` could not be inspected`);
    return;
  }
  if (presence === "missing") {
    errors.push(`${label} target \`${rawValue}\` does not exist`);
  } else if (requireDirectory && presence !== "directory") {
    errors.push(`${label} target \`${rawValue}\` must be a directory`);
  } else if (requireFile && presence !== "file") {
    errors.push(`${label} target \`${rawValue}\` must be a file`);
  }
}

type HookPolicy = "forbid" | "default" | "allow";

async function validateHookPath(
  pluginRoot: string,
  value: JsonValue | undefined,
  label: string,
  errors: string[],
  deps: GeneratedPluginFsDeps,
): Promise<void> {
  if (typeof value !== "string" || !value.startsWith("./")) {
    errors.push(`${label} must start with \`./\``);
    return;
  }
  await validateLocalPath(pluginRoot, value, label, errors, deps, {
    requireFile: true,
  });
}

async function validateHooks(
  pluginRoot: string,
  manifest: Record<string, JsonValue>,
  manifestSource: string,
  errors: string[],
  deps: GeneratedPluginFsDeps,
): Promise<HookPolicy> {
  if (manifestSource === "fallback") {
    if (Object.hasOwn(manifest, "hooks")) {
      errors.push("fallback plugin manifest field `hooks` must be absent");
    }
    return "forbid";
  }
  if (!Object.hasOwn(manifest, "hooks")) return "default";
  const hooks = manifest.hooks;
  if (
    hooks !== null &&
    typeof hooks === "object" &&
    !Array.isArray(hooks) &&
    Object.keys(hooks).length === 0
  ) {
    return "forbid";
  }
  if (typeof hooks === "string") {
    await validateHookPath(
      pluginRoot,
      hooks,
      "plugin manifest field `hooks`",
      errors,
      deps,
    );
    return "allow";
  }
  if (hooks !== null && typeof hooks === "object" && !Array.isArray(hooks)) {
    return "allow";
  }
  if (!Array.isArray(hooks)) {
    errors.push("plugin manifest field `hooks` has an unsupported type");
    return "allow";
  }
  if (hooks.length === 0) return "default";
  if (hooks.every((value) => typeof value === "string")) {
    for (const [index, value] of hooks.entries()) {
      await validateHookPath(
        pluginRoot,
        value,
        `plugin manifest field \`hooks[${index}]\``,
        errors,
        deps,
      );
    }
    return "allow";
  }
  if (
    hooks.every(
      (value) =>
        value !== null && typeof value === "object" && !Array.isArray(value),
    )
  ) {
    return "allow";
  }
  errors.push(
    "plugin manifest field `hooks` array must contain only paths or only objects",
  );
  return "allow";
}

async function validateManifest(
  pluginRoot: string,
  expectedVersion: string,
  manifestSource: string,
  errors: string[],
  deps: GeneratedPluginFsDeps,
): Promise<HookPolicy> {
  const path = posix.join(pluginRoot, ".codex-plugin", "plugin.json");
  let presence: Presence;
  try {
    presence = await inspectPath(path, deps, true);
  } catch {
    errors.push(
      "required file `.codex-plugin/plugin.json` could not be inspected",
    );
    return "forbid";
  }
  if (presence !== "file") {
    errors.push("missing required file `.codex-plugin/plugin.json`");
    return "forbid";
  }
  const manifest = await loadJsonObject(path, "plugin manifest", errors, deps);
  if (manifest === null) return "forbid";

  const hookPolicy = await validateHooks(
    pluginRoot,
    manifest,
    manifestSource,
    errors,
    deps,
  );

  if (manifest.name !== "superpowers") {
    errors.push("plugin manifest field `name` must equal `superpowers`");
  }
  const version = manifest.version;
  if (version !== expectedVersion) {
    errors.push("plugin manifest field `version` must equal expected version");
  }
  if (typeof version !== "string" || !SEMVER_RE.test(version)) {
    errors.push("plugin manifest field `version` must be SemVer 2.0.0");
  }
  const description = manifest.description;
  if (typeof description !== "string" || pythonStrip(description) === "") {
    errors.push("plugin manifest field `description` must be non-empty");
  }
  if (manifest.skills !== "./skills/") {
    errors.push("plugin manifest field `skills` must equal `./skills/`");
  }

  await validateLocalPath(
    pluginRoot,
    manifest.skills,
    "plugin manifest field `skills`",
    errors,
    deps,
    { requireDirectory: true },
  );
  if (Object.hasOwn(manifest, "apps")) {
    await validateLocalPath(
      pluginRoot,
      manifest.apps,
      "plugin manifest field `apps`",
      errors,
      deps,
    );
  }
  if (Object.hasOwn(manifest, "mcpServers")) {
    const mcpServers = manifest.mcpServers;
    if (typeof mcpServers === "string") {
      await validateLocalPath(
        pluginRoot,
        mcpServers,
        "plugin manifest field `mcpServers`",
        errors,
        deps,
      );
    } else if (
      mcpServers === null ||
      typeof mcpServers !== "object" ||
      Array.isArray(mcpServers)
    ) {
      errors.push(
        "plugin manifest field `mcpServers` must be a string or object",
      );
    }
  }

  if (!Object.hasOwn(manifest, "interface")) return hookPolicy;
  const iface = manifest.interface;
  if (iface === null || typeof iface !== "object" || Array.isArray(iface)) {
    errors.push("plugin manifest field `interface` must be an object");
    return hookPolicy;
  }
  for (const field of ["composerIcon", "logo", "logoDark"] as const) {
    if (Object.hasOwn(iface, field)) {
      await validateLocalPath(
        pluginRoot,
        iface[field],
        `plugin manifest field \`interface.${field}\``,
        errors,
        deps,
      );
    }
  }
  if (Object.hasOwn(iface, "screenshots")) {
    const screenshots = iface.screenshots;
    if (!Array.isArray(screenshots)) {
      errors.push(
        "plugin manifest field `interface.screenshots` must be an array",
      );
    } else {
      for (const [index, value] of screenshots.entries()) {
        await validateLocalPath(
          pluginRoot,
          value,
          `plugin manifest field \`interface.screenshots[${index}]\``,
          errors,
          deps,
        );
      }
    }
  }
  return hookPolicy;
}

export async function validateGeneratedPlugin(
  options: GeneratedPluginValidationOptions,
  deps: GeneratedPluginFsDeps = DEFAULT_FS_DEPS,
): Promise<string[]> {
  const errors: string[] = [];
  let pluginRoot: string;
  try {
    pluginRoot = await resolvePath(expandUser(options.pluginRoot), deps, {
      strict: false,
    });
  } catch {
    errors.push("plugin root could not be resolved");
    return errors;
  }
  const hookPolicy = await validateManifest(
    pluginRoot,
    options.manifestVersion,
    options.manifestSource,
    errors,
    deps,
  );
  void hookPolicy;
  return errors;
}

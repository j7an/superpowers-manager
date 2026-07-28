import type { Buffer } from "node:buffer";
import { lstat, readdir, readFile, readlink, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix } from "node:path";
import { COMMIT_RE } from "./domain/refs.js";
import { pythonSplitlines, pythonStrip } from "./python-text.js";
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
/** Any error from a directory enumeration, absence-like included. */
class EnumerationFailure extends Error {}

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

/** `Path.is_symlink()` under the inspection-failure rule. */
async function inspectLink(
  path: string,
  deps: GeneratedPluginFsDeps,
): Promise<"symlink" | "other" | "missing"> {
  if (hasUnpairedSurrogate(path)) throw new InspectionFailure(path);
  try {
    return (await deps.lstat(path)).isSymbolicLink() ? "symlink" : "other";
  } catch (cause) {
    if (isAbsenceError(cause)) return "missing";
    throw new InspectionFailure(path);
  }
}

/**
 * Buffer-mode enumeration. Every error rejects — absence included — and an
 * entry whose bytes are not valid UTF-8 rejects rather than being silently
 * mapped to U+FFFD and then vanishing behind a later `ENOENT`.
 */
async function listDirectory(
  path: string,
  deps: GeneratedPluginFsDeps,
): Promise<string[]> {
  let entries: Buffer[];
  try {
    entries = (await deps.readdir(path, { encoding: "buffer" })) as Buffer[];
  } catch {
    throw new EnumerationFailure(path);
  }
  return entries.map((entry) => {
    try {
      return decodePathBytes(entry);
    } catch {
      throw new EnumerationFailure(path);
    }
  });
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

const REQUIRED_FILES = [
  ".codex-plugin/plugin.template.json",
  ".superpowers-upstream.json",
  "LICENSE",
  "README.md",
  "CODE_OF_CONDUCT.md",
] as const;

/** Python `sorted()` orders by code point; JavaScript's default sort does not. */
function compareByCodePoint(left: string, right: string): number {
  // `Array.from` splits by code point, exactly as spreading would; oxlint's
  // `no-misused-spread` rejects the spread form, and grapheme segmentation is
  // the wrong unit here — Python compares code points.
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const shared = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < shared; index += 1) {
    const a = leftPoints[index]!.codePointAt(0)!;
    const b = rightPoints[index]!.codePointAt(0)!;
    if (a !== b) return a - b;
  }
  return leftPoints.length - rightPoints.length;
}

async function validateSkillFrontmatter(
  skillMd: string,
  skillName: string,
  errors: string[],
  deps: GeneratedPluginFsDeps,
): Promise<void> {
  let contents: string;
  try {
    contents = STRICT_DECODER.decode(await deps.readFile(skillMd));
  } catch {
    errors.push(`skill \`${skillName}\` has unreadable UTF-8 \`SKILL.md\``);
    return;
  }
  if (contents === "") {
    errors.push(`skill \`${skillName}\` has empty \`SKILL.md\``);
    return;
  }
  const lines = pythonSplitlines(contents);
  if (lines.length === 0 || lines[0] !== "---") {
    errors.push(`skill \`${skillName}\` must start with \`---\``);
    return;
  }
  const closingIndex = lines.indexOf("---", 1);
  if (closingIndex === -1) {
    errors.push(`skill \`${skillName}\` frontmatter is not closed`);
    return;
  }
  const frontmatter = lines.slice(1, closingIndex);
  for (const key of ["name", "description"] as const) {
    const matches = frontmatter.filter((line) => line.startsWith(`${key}:`));
    if (matches.length !== 1) {
      errors.push(
        `skill \`${skillName}\` frontmatter must contain exactly one top-level \`${key}:\``,
      );
      continue;
    }
    const value = pythonStrip(matches[0]!.slice(matches[0]!.indexOf(":") + 1));
    if (
      value === "" ||
      value === "''" ||
      value === '""' ||
      value.startsWith("#")
    ) {
      errors.push(
        `skill \`${skillName}\` frontmatter field \`${key}\` must be non-empty`,
      );
    }
  }
}

async function validateHookSubtree(
  pluginRoot: string,
  hooksRoot: string,
  errors: string[],
  deps: GeneratedPluginFsDeps,
): Promise<void> {
  let resolvedRoot: string;
  try {
    resolvedRoot = await resolvePath(pluginRoot, deps, { strict: true });
  } catch {
    errors.push("generated plugin root could not be resolved");
    return;
  }

  const validateSymlink = async (path: string): Promise<boolean> => {
    let isLink: boolean;
    try {
      isLink = (await inspectLink(path, deps)) === "symlink";
    } catch {
      // `:300` reaches `:305`, the same site-specific text as the `:303`
      // readlink below. The three probes sharing the *subtree* string are
      // `:324`/`:332`/`:340`, not this one.
      errors.push(`generated hook symlink could not be inspected: ${path}`);
      return false;
    }
    if (!isLink) return true;
    let rawTarget: string;
    try {
      rawTarget = decodePathBytes(
        (await deps.readlink(path, { encoding: "buffer" })) as Buffer,
      );
    } catch {
      errors.push(`generated hook symlink could not be inspected: ${path}`);
      return false;
    }
    if (posix.isAbsolute(rawTarget)) {
      errors.push(`generated hook symlink must be relative: ${path}`);
      return false;
    }
    try {
      const resolved = await resolvePath(path, deps, { strict: true });
      if (
        resolved !== resolvedRoot &&
        !resolved.startsWith(`${resolvedRoot}/`)
      ) {
        throw new ResolutionFailure(resolved);
      }
    } catch {
      errors.push(`generated hook symlink escapes or is broken: ${path}`);
      return false;
    }
    return true;
  };

  if (!(await validateSymlink(hooksRoot))) return;
  const pending = [hooksRoot];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let resolvedDirectory: string;
    try {
      resolvedDirectory = await resolvePath(directory, deps, { strict: true });
    } catch {
      errors.push("generated hook subtree could not be inspected");
      continue;
    }
    if (visited.has(resolvedDirectory)) continue;
    visited.add(resolvedDirectory);
    let children: string[];
    try {
      // Unsorted on purpose: error order here is filesystem order.
      children = await listDirectory(directory, deps);
    } catch {
      errors.push("generated hook subtree could not be inspected");
      continue;
    }
    for (const name of children) {
      const child = posix.join(directory, name);
      if (!(await validateSymlink(child))) continue;
      try {
        if ((await inspectPath(child, deps, true)) === "directory") {
          pending.push(child);
        }
      } catch {
        errors.push("generated hook subtree could not be inspected");
      }
    }
  }
}

async function validateTree(
  pluginRoot: string,
  hookPolicy: HookPolicy,
  errors: string[],
  deps: GeneratedPluginFsDeps,
): Promise<void> {
  for (const relative of REQUIRED_FILES) {
    let presence: Presence;
    try {
      presence = await inspectPath(
        posix.join(pluginRoot, relative),
        deps,
        true,
      );
    } catch {
      errors.push(`required file \`${relative}\` could not be inspected`);
      continue;
    }
    if (presence !== "file")
      errors.push(`missing required file \`${relative}\``);
  }

  const hooksRoot = posix.join(pluginRoot, "hooks");
  let hooksExists: boolean;
  try {
    // `os.path.lexists`: a broken `hooks` symlink counts as present.
    hooksExists = (await inspectPath(hooksRoot, deps, false)) !== "missing";
  } catch {
    errors.push("generated plugin path `hooks/` could not be inspected");
    hooksExists = false;
  }
  if (hookPolicy === "forbid" && hooksExists) {
    errors.push(
      "generated plugin must not contain `hooks/` for this manifest source",
    );
  } else if (hooksExists) {
    await validateLocalPath(
      pluginRoot,
      "./hooks",
      "generated plugin path `hooks/`",
      errors,
      deps,
      { requireDirectory: true },
    );
    await validateHookSubtree(pluginRoot, hooksRoot, errors, deps);
    if (hookPolicy === "default") {
      let presence: Presence;
      try {
        presence = await inspectPath(
          posix.join(hooksRoot, "hooks.json"),
          deps,
          true,
        );
      } catch {
        errors.push("`hooks/hooks.json` could not be inspected");
        presence = "file";
      }
      if (presence !== "file") {
        errors.push(
          "default-discovered `hooks/` must contain `hooks/hooks.json`",
        );
      }
    }
  }

  const skillsRoot = posix.join(pluginRoot, "skills");
  let skillsPresence: Presence;
  try {
    skillsPresence = await inspectPath(skillsRoot, deps, true);
  } catch {
    errors.push("required directory `skills/` could not be inspected");
    return;
  }
  if (skillsPresence !== "directory") {
    errors.push("missing required directory `skills/`");
    return;
  }
  let skillDirs: string[];
  try {
    const entries = await listDirectory(skillsRoot, deps);
    skillDirs = [];
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      if (
        (await inspectPath(posix.join(skillsRoot, name), deps, true)) ===
        "directory"
      ) {
        skillDirs.push(name);
      }
    }
    skillDirs.sort(compareByCodePoint);
  } catch {
    // The Python wraps sorted(), iterdir() and is_dir() in one try/except.
    errors.push("skills directory could not be enumerated");
    return;
  }
  if (skillDirs.length === 0) {
    errors.push("`skills/` must contain at least one skill directory");
    return;
  }
  for (const name of skillDirs) {
    const skillMd = posix.join(skillsRoot, name, "SKILL.md");
    let presence: Presence;
    try {
      presence = await inspectPath(skillMd, deps, true);
    } catch {
      errors.push(`skill \`${name}\` \`SKILL.md\` could not be inspected`);
      continue;
    }
    if (presence !== "file") {
      errors.push(`skill \`${name}\` is missing \`SKILL.md\``);
      continue;
    }
    await validateSkillFrontmatter(skillMd, name, errors, deps);
  }
}

const PROVENANCE_KEYS = [
  "source",
  "requested_ref",
  "resolved_ref",
  "commit",
  "upstream_manifest_version",
] as const;

async function validateProvenance(
  options: GeneratedPluginValidationOptions,
  pluginRoot: string,
  errors: string[],
  deps: GeneratedPluginFsDeps,
): Promise<void> {
  const path = posix.join(pluginRoot, ".superpowers-upstream.json");
  let presence: Presence;
  try {
    presence = await inspectPath(path, deps, true);
  } catch {
    errors.push(
      "provenance file `.superpowers-upstream.json` could not be inspected",
    );
    return;
  }
  if (presence !== "file") return;
  const provenance = await loadJsonObject(path, "provenance", errors, deps);
  if (provenance === null) return;
  const keys = Object.keys(provenance).sort(compareByCodePoint);
  const expectedKeys = [...PROVENANCE_KEYS].sort(compareByCodePoint);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    errors.push("provenance keys do not match the manager-owned contract");
  }
  const expected: Record<string, string> = {
    source: options.source,
    requested_ref: options.requestedRef,
    resolved_ref: options.resolvedRef,
    commit: options.commit,
    upstream_manifest_version: options.upstreamManifestVersion,
  };
  // Python iterates the literal's insertion order; PROVENANCE_KEYS matches it.
  for (const key of PROVENANCE_KEYS) {
    if (provenance[key] !== expected[key]) {
      errors.push(`provenance field \`${key}\` does not match expected value`);
    }
  }
  if (!COMMIT_RE.test(options.commit)) {
    errors.push("commit must be 40 lowercase hexadecimal characters");
  }
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
  await validateTree(pluginRoot, hookPolicy, errors, deps);
  await validateProvenance(options, pluginRoot, errors, deps);
  return errors;
}

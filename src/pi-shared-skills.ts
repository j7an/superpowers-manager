import type { Dirent } from "node:fs";
import { readdir, readFile, readlink, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import type { PiPaths } from "./pi-paths.ts";
import type { PiSettings } from "./pi-settings.ts";
import { classifyPathNoFollow } from "./safe-path.ts";
const PI_IGNORE_FILES = [".gitignore", ".ignore", ".fdignore"] as const;

type SharedSkillCollection =
  | { readonly kind: "candidates"; readonly paths: readonly string[] }
  | { readonly kind: "indeterminate" }
  | { readonly kind: "none" };

type SharedSkillActivity = "active" | "disabled" | "indeterminate";
function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

async function ignoreControlState(
  directory: string,
): Promise<"none" | "indeterminate"> {
  for (const filename of PI_IGNORE_FILES) {
    const path = join(directory, filename);
    let kind: Awaited<ReturnType<typeof classifyPathNoFollow>>;
    try {
      kind = await classifyPathNoFollow(path);
    } catch {
      return "indeterminate";
    }
    if (kind === "missing") continue;
    if (kind !== "regular-file") return "indeterminate";
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch {
      return "indeterminate";
    }
    const meaningful = contents.split(/\r?\n/u).some((line) => {
      const trimmed = line.trim();
      return (
        trimmed.length > 0 &&
        !(trimmed.startsWith("#") && !trimmed.startsWith("\\#"))
      );
    });
    if (meaningful) return "indeterminate";
  }
  return "none";
}

async function collectSharedSkillDirectory(
  directory: string,
): Promise<SharedSkillCollection> {
  if ((await ignoreControlState(directory)) === "indeterminate") {
    return { kind: "indeterminate" };
  }

  const declaredSkill = join(directory, "SKILL.md");
  let declaredKind: Awaited<ReturnType<typeof classifyPathNoFollow>>;
  try {
    declaredKind = await classifyPathNoFollow(declaredSkill);
  } catch {
    return { kind: "indeterminate" };
  }
  if (declaredKind === "regular-file") {
    return { kind: "candidates", paths: [declaredSkill] };
  }
  if (declaredKind !== "missing") return { kind: "indeterminate" };

  let entries: Dirent<string>[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return { kind: "indeterminate" };
  }
  const candidates: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    if (entry.name === "SKILL.md") return { kind: "indeterminate" };
    const path = join(directory, entry.name);
    let kind: Awaited<ReturnType<typeof classifyPathNoFollow>>;
    try {
      kind = await classifyPathNoFollow(path);
    } catch {
      return { kind: "indeterminate" };
    }
    if (kind === "symlink" || kind === "missing") {
      return { kind: "indeterminate" };
    }
    if (kind === "directory") {
      const nested = await collectSharedSkillDirectory(path);
      if (nested.kind === "indeterminate") return nested;
      if (nested.kind === "candidates") candidates.push(...nested.paths);
    } else if (kind === "regular-file" && entry.name.endsWith(".md")) {
      candidates.push(path);
    }
  }
  return { kind: "candidates", paths: candidates };
}

async function collectSharedPiSkills(
  paths: PiPaths,
): Promise<SharedSkillCollection> {
  const agentsRoot = join(paths.homeDir, ".agents");
  const skillsRoot = join(agentsRoot, "skills");
  const sharedRoot = join(skillsRoot, "superpowers");
  for (const directory of [agentsRoot, skillsRoot]) {
    let kind: Awaited<ReturnType<typeof classifyPathNoFollow>>;
    try {
      kind = await classifyPathNoFollow(directory);
    } catch {
      return { kind: "indeterminate" };
    }
    if (kind === "missing") return { kind: "none" };
    if (kind !== "directory") return { kind: "indeterminate" };
  }

  let sharedRootKind: Awaited<ReturnType<typeof classifyPathNoFollow>>;
  try {
    sharedRootKind = await classifyPathNoFollow(sharedRoot);
  } catch {
    return { kind: "indeterminate" };
  }
  if (sharedRootKind === "missing") return { kind: "none" };

  if ((await ignoreControlState(skillsRoot)) === "indeterminate") {
    return { kind: "indeterminate" };
  }
  const discoveryRootSkill = join(skillsRoot, "SKILL.md");
  let discoveryRootSkillKind: Awaited<ReturnType<typeof classifyPathNoFollow>>;
  try {
    discoveryRootSkillKind = await classifyPathNoFollow(discoveryRootSkill);
  } catch {
    return { kind: "indeterminate" };
  }
  if (discoveryRootSkillKind === "regular-file") return { kind: "none" };
  if (discoveryRootSkillKind !== "missing") {
    return { kind: "indeterminate" };
  }
  if (sharedRootKind !== "directory") return { kind: "indeterminate" };
  return collectSharedSkillDirectory(sharedRoot);
}

function exactSkillIdentities(path: string, agentsRoot: string): string[] {
  const identities = [
    toPosixPath(relative(agentsRoot, path)),
    toPosixPath(path),
  ];
  if (basename(path) === "SKILL.md") {
    identities.push(
      toPosixPath(relative(agentsRoot, dirname(path))),
      toPosixPath(dirname(path)),
    );
  }
  return identities;
}

function literalExcludeIdentities(path: string, agentsRoot: string): string[] {
  const identities = [
    toPosixPath(relative(agentsRoot, path)),
    basename(path),
    toPosixPath(path),
  ];
  if (basename(path) === "SKILL.md") {
    identities.push(
      toPosixPath(relative(agentsRoot, dirname(path))),
      basename(dirname(path)),
      toPosixPath(dirname(path)),
    );
  }
  return identities;
}

function normalizeExactSkillPattern(pattern: string): string {
  const normalized =
    pattern.startsWith("./") || pattern.startsWith(".\\")
      ? pattern.slice(2)
      : pattern;
  return toPosixPath(normalized);
}

function hasUnknownMinimatchSyntax(pattern: string): boolean {
  return (
    pattern.startsWith("#") ||
    pattern.includes("!") ||
    /[*?[\]{}()|+@\\]/u.test(pattern) ||
    toPosixPath(pattern).includes("//")
  );
}

function sharedSkillActivity(
  path: string,
  agentsRoot: string,
  controls: readonly string[],
): SharedSkillActivity {
  const exactIdentities = exactSkillIdentities(path, agentsRoot);
  const forceExcludes = controls
    .filter((control) => control.startsWith("-"))
    .map((control) => normalizeExactSkillPattern(control.slice(1)));
  if (forceExcludes.some((pattern) => exactIdentities.includes(pattern))) {
    return "disabled";
  }

  const forceIncludes = controls
    .filter((control) => control.startsWith("+"))
    .map((control) => normalizeExactSkillPattern(control.slice(1)));
  if (forceIncludes.some((pattern) => exactIdentities.includes(pattern))) {
    return "active";
  }

  const excludePatterns = controls
    .filter((control) => control.startsWith("!"))
    .map((control) => control.slice(1));
  if (excludePatterns.some(hasUnknownMinimatchSyntax)) return "indeterminate";
  const excludeIdentities = literalExcludeIdentities(path, agentsRoot);
  return excludePatterns
    .map(toPosixPath)
    .some((pattern) => excludeIdentities.includes(pattern))
    ? "disabled"
    : "active";
}

function isTopLevelSkillPattern(value: string): boolean {
  return (
    value.startsWith("!") ||
    value.startsWith("+") ||
    value.startsWith("-") ||
    value.includes("*") ||
    value.includes("?")
  );
}

function normalizeWindowsShellPath(path: string): string {
  if (
    process.platform !== "win32" ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\")
  ) {
    return path;
  }
  const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/iu.exec(path);
  if (match === null) return path;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1]!.toUpperCase()}:\\${suffix ?? ""}`;
}

function resolveTopLevelSkillPath(source: string, paths: PiPaths): string {
  let normalized = normalizeWindowsShellPath(source.trim());
  if (
    normalized === "~" ||
    normalized.startsWith("~/") ||
    (process.platform === "win32" && normalized.startsWith("~\\"))
  ) {
    normalized =
      normalized === "~"
        ? paths.homeDir
        : join(paths.homeDir, normalized.slice(2));
  } else if (normalized.startsWith("file://")) {
    normalized = fileURLToPath(normalized);
  }
  return isAbsolute(normalized)
    ? resolve(normalized)
    : resolve(paths.agentDir, normalized);
}

function containedBy(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return (
    suffix === "" ||
    (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`))
  );
}

async function hasSafeSharedSkillAncestors(
  path: string,
  sharedRoot: string,
): Promise<boolean> {
  const suffix = relative(sharedRoot, dirname(path));
  const directories = [sharedRoot];
  let cursor = sharedRoot;
  for (const segment of suffix.split(sep)) {
    if (segment.length === 0) continue;
    cursor = join(cursor, segment);
    directories.push(cursor);
  }
  for (const directory of directories) {
    try {
      if ((await classifyPathNoFollow(directory)) !== "directory") return false;
    } catch {
      return false;
    }
  }
  return true;
}

function explicitSharedSkillActivity(
  path: string,
  paths: PiPaths,
  controls: readonly string[],
): SharedSkillActivity {
  const exactIdentities = exactSkillIdentities(path, paths.agentDir);
  const forceExcludes = controls
    .filter((control) => control.startsWith("-"))
    .map((control) => normalizeExactSkillPattern(control.slice(1)));
  if (forceExcludes.some((pattern) => exactIdentities.includes(pattern))) {
    return "disabled";
  }

  const forceIncludes = controls
    .filter((control) => control.startsWith("+"))
    .map((control) => normalizeExactSkillPattern(control.slice(1)));
  if (forceIncludes.some((pattern) => exactIdentities.includes(pattern))) {
    return "active";
  }

  const excludePatterns = controls
    .filter((control) => control.startsWith("!"))
    .map((control) => control.slice(1));
  const excludeIdentities = literalExcludeIdentities(path, paths.agentDir);
  if (
    excludePatterns
      .filter((pattern) => !hasUnknownMinimatchSyntax(pattern))
      .map(toPosixPath)
      .some((pattern) => excludeIdentities.includes(pattern))
  ) {
    return "disabled";
  }
  const positivePatterns = controls.filter(
    (control) =>
      !control.startsWith("!") &&
      !control.startsWith("+") &&
      !control.startsWith("-") &&
      (control.includes("*") || control.includes("?")),
  );
  return excludePatterns.some(hasUnknownMinimatchSyntax) ||
    positivePatterns.length > 0
    ? "indeterminate"
    : "active";
}

async function explicitSharedSkillActivities(
  settings: PiSettings,
  paths: PiPaths,
): Promise<{
  readonly activities: ReadonlyMap<string, SharedSkillActivity>;
  readonly indeterminate: boolean;
}> {
  const activities = new Map<string, SharedSkillActivity>();
  const sharedRoot = join(paths.homeDir, ".agents", "skills", "superpowers");
  let canonicalSharedRoot = sharedRoot;
  try {
    canonicalSharedRoot = await realpath(sharedRoot);
  } catch {
    // A missing or unresolvable root cannot contain a resolved explicit file.
  }
  let indeterminate = false;
  for (const source of settings.skills ?? []) {
    if (isTopLevelSkillPattern(source)) continue;
    let path: string;
    try {
      path = resolveTopLevelSkillPath(source, paths);
    } catch {
      if (source.includes(".agents") && source.includes("superpowers")) {
        indeterminate = true;
      }
      continue;
    }
    let lexicalKind: Awaited<ReturnType<typeof classifyPathNoFollow>>;
    try {
      lexicalKind = await classifyPathNoFollow(path);
    } catch {
      if (containedBy(sharedRoot, path) || containedBy(path, sharedRoot)) {
        indeterminate = true;
      }
      continue;
    }
    if (lexicalKind === "missing") continue;
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(path);
    } catch {
      let related =
        containedBy(sharedRoot, path) || containedBy(path, sharedRoot);
      if (!related && lexicalKind === "symlink") {
        try {
          const target = resolve(dirname(path), await readlink(path));
          related =
            containedBy(sharedRoot, target) || containedBy(target, sharedRoot);
        } catch {
          // Without a relationship to the known route, preserve unrelated state.
        }
      }
      if (related) indeterminate = true;
      continue;
    }
    const related =
      containedBy(sharedRoot, path) ||
      containedBy(path, sharedRoot) ||
      containedBy(canonicalSharedRoot, canonicalPath) ||
      containedBy(canonicalPath, canonicalSharedRoot);
    if (!related) continue;
    let canonicalKind: Awaited<ReturnType<typeof classifyPathNoFollow>>;
    try {
      canonicalKind = await classifyPathNoFollow(canonicalPath);
    } catch {
      indeterminate = true;
      continue;
    }
    if (
      canonicalKind !== "regular-file" ||
      !path.endsWith(".md") ||
      !(await hasSafeSharedSkillAncestors(canonicalPath, canonicalSharedRoot))
    ) {
      indeterminate = true;
      continue;
    }
    if (!activities.has(canonicalPath)) {
      activities.set(
        canonicalPath,
        explicitSharedSkillActivity(path, paths, settings.skills ?? []),
      );
    }
  }
  return { activities, indeterminate };
}

export async function sharedPiSkillsActivity(
  settings: PiSettings,
  paths: PiPaths,
): Promise<"active" | "inactive" | "indeterminate"> {
  const explicit = await explicitSharedSkillActivities(settings, paths);
  const collection = await collectSharedPiSkills(paths);
  if (collection.kind === "indeterminate") return "indeterminate";
  const agentsRoot = join(paths.homeDir, ".agents");
  let active = false;
  let indeterminate = explicit.indeterminate;
  for (const activity of explicit.activities.values()) {
    if (activity === "active") active = true;
    if (activity === "indeterminate") indeterminate = true;
  }
  if (collection.kind === "candidates") {
    for (const path of collection.paths) {
      let canonicalPath: string;
      try {
        canonicalPath = await realpath(path);
      } catch {
        indeterminate = true;
        continue;
      }
      if (explicit.activities.has(canonicalPath)) continue;
      const activity = sharedSkillActivity(
        path,
        agentsRoot,
        settings.skills ?? [],
      );
      if (activity === "active") active = true;
      if (activity === "indeterminate") indeterminate = true;
    }
  }
  if (indeterminate) return "indeterminate";
  return active ? "active" : "inactive";
}

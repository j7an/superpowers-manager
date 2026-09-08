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

import {
  failureResult,
  successResult,
  type AdapterContext,
  type AdapterResult,
} from "./adapter-result.ts";
import { readArtifactObject } from "./artifact-tree.ts";
import type { EffectiveSelection } from "./effective-selection.ts";
import type {
  Decision,
  InstalledState,
  OwnershipInspection,
  UpdateControlInspection,
} from "./harness.ts";
import { samePiSource } from "./pi-compatibility.ts";
import {
  digestPiTree,
  readPiPackageAssessment,
  readPiReceipt,
  type PiReceipt,
} from "./pi-package.ts";
import { piPaths, type PiPaths } from "./pi-paths.ts";
import {
  readPiSettings,
  resolveCanonicalPiLocalSource,
  resolvePiLocalSource,
  type PiPackageEntry,
  type PiSettings,
} from "./pi-settings.ts";
import { classifyPathNoFollow } from "./safe-path.ts";

export interface PiRemovalInput {
  readonly installedRoot: string;
  readonly registrationIdentity: string | null;
  readonly receiptDigest: string | null;
}

type SnapshotObservation =
  | { readonly kind: "absent" }
  | { readonly kind: "unverified" }
  | {
      readonly kind: "owned";
      readonly receipt: PiReceipt;
      readonly digest: string;
    };

interface SettingsObservation {
  readonly settings: PiSettings;
  readonly registration: PiPackageEntry | null;
}

// Verified remote spellings only: Pi 0.85.1 accepts http:// as Git. Unprefixed
// github: and git+ forms stay local; git:-wrapped aliases and explicit transports
// normalize only an exact GitHub authority and repository path (native source
// citations are in pi-settings.ts).
const KNOWN_UPSTREAM_PI_SOURCE_BASES = [
  "git:github.com/obra/superpowers",
  "git:github.com/obra/superpowers.git",
  "git:git@github.com:obra/superpowers",
  "git:git@github.com:obra/superpowers.git",
  "git:git@github.com/obra/superpowers",
  "git:git@github.com/obra/superpowers.git",
  "git:github:obra/superpowers",
  "git:github:obra/superpowers.git",
  "git:obra/superpowers",
  "git:obra/superpowers.git",
  "http://github.com/obra/superpowers",
  "http://github.com/obra/superpowers.git",
  "https://github.com/obra/superpowers",
  "https://github.com/obra/superpowers.git",
  "ssh://github.com/obra/superpowers",
  "ssh://github.com/obra/superpowers.git",
  "ssh://git@github.com/obra/superpowers",
  "ssh://git@github.com/obra/superpowers.git",
  "git://github.com/obra/superpowers",
  "git://github.com/obra/superpowers.git",
] as const;

const SHARED_PI_SKILLS_CONFLICT =
  "native Pi skills route ~/.agents/skills/superpowers";
const SHARED_PI_SKILLS_INDETERMINATE = `${SHARED_PI_SKILLS_CONFLICT} has indeterminate activity`;
const PI_IGNORE_FILES = [".gitignore", ".ignore", ".fdignore"] as const;

type SharedSkillCollection =
  | { readonly kind: "candidates"; readonly paths: readonly string[] }
  | { readonly kind: "indeterminate" }
  | { readonly kind: "none" };

type SharedSkillActivity = "active" | "disabled" | "indeterminate";

function blocked(...stderr: string[]): Decision {
  return { kind: "blocked", output: { stdout: [], stderr } };
}

function pathsFor(ctx: AdapterContext): PiPaths {
  return piPaths(ctx.env ?? {}, process.cwd());
}

function isNonemptyControlFree(value: string): boolean {
  if (value.length === 0) return false;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x20 || code === 0x7f) return false;
  }
  return true;
}

function normalizeVerifiedGithubSource(candidate: string): string {
  const match =
    /^(https?|ssh|git):\/\/([^/?#]+)(\/obra\/superpowers(?:\.git)?\/?(?:[@#].*)?)$/u.exec(
      candidate,
    );
  if (match === null) return candidate;
  const [, transport, authority, path] = match;
  const at = authority.lastIndexOf("@");
  const userinfo = at === -1 ? null : authority.slice(0, at);
  if (
    (userinfo !== null &&
      (authority.indexOf("@") !== at || !isNonemptyControlFree(userinfo))) ||
    authority.slice(at + 1) === ""
  )
    return candidate;
  const host = authority.slice(at + 1);
  const normalizedHost = host.startsWith("www.") ? host.slice(4) : host;
  if (normalizedHost !== "github.com") return candidate;
  return `${transport}://github.com${path}`;
}

function isKnownUpstreamPiSource(raw: string): boolean {
  const source = raw.trim();
  const outerBody = source.startsWith("git:") ? source.slice(4).trim() : null;
  const candidates = [
    source,
    ...(outerBody === null
      ? []
      : [
          outerBody.startsWith("git+https://") ||
          outerBody.startsWith("git+ssh://")
            ? outerBody.slice(4)
            : outerBody,
        ]),
  ];
  return candidates.some((candidate) => {
    const normalized = normalizeVerifiedGithubSource(candidate);
    return KNOWN_UPSTREAM_PI_SOURCE_BASES.some((base) => {
      if (normalized === base) return true;
      if (!normalized.startsWith(base)) return false;
      let suffix = normalized.slice(base.length);
      if (suffix.startsWith("/")) suffix = suffix.slice(1);
      if (suffix === "") return true;
      if (suffix.at(0) !== "@" && suffix.at(0) !== "#") return false;
      return isNonemptyControlFree(suffix.slice(1));
    });
  });
}

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

async function sharedPiSkillsActivity(
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

async function observeSettings(paths: PiPaths): Promise<SettingsObservation> {
  const settings = await readPiSettings(paths.settingsFile, paths.homeDir);
  const installedRoot = await resolveCanonicalPiLocalSource(
    paths.installedRoot,
    paths.agentDir,
    paths.homeDir,
  );
  let registration: PiPackageEntry | null = null;
  for (const entry of settings.packages) {
    if (
      (await resolveCanonicalPiLocalSource(
        entry.source,
        paths.agentDir,
        paths.homeDir,
      )) === installedRoot
    ) {
      registration = entry;
    }
  }
  return { settings, registration };
}

async function observeSnapshot(paths: PiPaths): Promise<SnapshotObservation> {
  const kind = await classifyPathNoFollow(paths.installedRoot);
  if (kind === "missing") return { kind: "absent" };
  if (kind !== "directory") return { kind: "unverified" };
  try {
    const receipt = await readPiReceipt(paths.installedRoot);
    const digest = await digestPiTree(paths.installedRoot);
    return receipt.digest === digest
      ? { kind: "owned", receipt, digest }
      : { kind: "unverified" };
  } catch {
    return { kind: "unverified" };
  }
}

async function isNamedLocalSuperpowers(
  entry: PiPackageEntry,
  paths: PiPaths,
  canonicalInstalledRoot: string,
): Promise<boolean> {
  const root = resolvePiLocalSource(
    entry.source,
    paths.agentDir,
    paths.homeDir,
  );
  if (
    root === null ||
    (await resolveCanonicalPiLocalSource(
      entry.source,
      paths.agentDir,
      paths.homeDir,
    )) === canonicalInstalledRoot
  )
    return false;
  const rootKind = await classifyPathNoFollow(root);
  if (rootKind !== "directory" && rootKind !== "symlink") return false;
  const metadata = join(root, "package.json");
  const metadataKind = await classifyPathNoFollow(metadata);
  if (metadataKind === "missing") return false;
  if (metadataKind !== "regular-file") {
    throw new Error(
      "registered local Pi package metadata is not a regular file",
    );
  }
  const pkg = await readArtifactObject(root, metadata);
  return pkg.name === "superpowers";
}

async function unmanagedConflicts(
  settings: PiSettings,
  paths: PiPaths,
): Promise<readonly string[]> {
  const conflicts = new Set<string>();
  const canonicalInstalledRoot = await resolveCanonicalPiLocalSource(
    paths.installedRoot,
    paths.agentDir,
    paths.homeDir,
  );
  if (canonicalInstalledRoot === null)
    throw new Error("Pi installed root is not local");
  for (const entry of settings.packages) {
    if (entry.resourceState === "disabled") continue;
    if (isKnownUpstreamPiSource(entry.source)) {
      conflicts.add("registered Pi package for obra/superpowers");
    } else if (
      await isNamedLocalSuperpowers(entry, paths, canonicalInstalledRoot)
    ) {
      conflicts.add("registered local Pi package named superpowers");
    }
  }
  if (
    (await classifyPathNoFollow(
      join(paths.agentDir, "extensions", "superpowers.ts"),
    )) !== "missing"
  ) {
    conflicts.add("native Pi extension superpowers.ts");
  }
  if (
    (await classifyPathNoFollow(
      join(paths.agentDir, "skills", "using-superpowers", "SKILL.md"),
    )) !== "missing"
  ) {
    conflicts.add("native Pi skill using-superpowers");
  }
  const sharedSkills = await sharedPiSkillsActivity(settings, paths);
  if (sharedSkills === "active") {
    conflicts.add(SHARED_PI_SKILLS_CONFLICT);
  } else if (sharedSkills === "indeterminate") {
    conflicts.add(SHARED_PI_SKILLS_INDETERMINATE);
  }
  return [...conflicts];
}

function inspectionFailure<T>(
  operation: string,
  subject: string,
): AdapterResult<T> {
  return failureResult(
    operation,
    "invalid-state",
    `cannot inspect ${subject}`,
    [],
    [],
  );
}

export async function inspectPiOwnership(
  ctx: AdapterContext,
): Promise<AdapterResult<OwnershipInspection<PiRemovalInput>>> {
  const operation = "inspect-pi-ownership";
  const paths = pathsFor(ctx);
  try {
    const [{ settings, registration }, snapshot] = await Promise.all([
      observeSettings(paths),
      observeSnapshot(paths),
    ]);
    if (snapshot.kind === "unverified") {
      return inspectionFailure(
        operation,
        `Pi ownership at ${paths.installedRoot}`,
      );
    }
    const conflicts = await unmanagedConflicts(settings, paths);
    let installEligibility: Decision = { kind: "allowed" };
    if (registration?.resourceState === "disabled") {
      installEligibility = blocked(
        "error: the Manager Pi registration disables required resources",
        "Enable both Manager-provided Pi resources manually, then retry.",
      );
    } else if (registration?.resourceState === "indeterminate") {
      installEligibility = blocked(
        "error: the Manager Pi registration uses unsupported resource filters",
        "Remove the filters or enable both Manager-provided Pi resources manually, then retry.",
      );
    } else if (conflicts.length > 0) {
      installEligibility = blocked(
        "Conflicting unmanaged Superpowers Pi resources require manual resolution:",
        ...conflicts.map((conflict) => `- ${conflict}`),
        "Remove or disable each resource manually, then retry.",
      );
    }

    let removalVerification: Decision = { kind: "allowed" };
    if (registration !== null) {
      removalVerification = blocked(
        "error: the Manager Pi package registration is still present after removal",
      );
    } else if (snapshot.kind === "owned") {
      removalVerification = blocked(
        "error: the Manager-owned Pi snapshot is still present after removal",
      );
    }

    const presentationValue =
      snapshot.kind === "owned"
        ? registration === null
          ? `managed snapshot ${snapshot.digest}`
          : `managed ${snapshot.digest}`
        : registration === null
          ? "absent"
          : "registered without an installed snapshot";
    return successResult(
      operation,
      {
        installEligibility,
        removalInput: {
          installedRoot: paths.installedRoot,
          registrationIdentity: registration?.source ?? null,
          receiptDigest:
            snapshot.kind === "owned" ? snapshot.receipt.digest : null,
        },
        removalVerification,
        postRemovalOutput: { stdout: [], stderr: [] },
        presentationValue,
        presentationConflicts: conflicts,
      },
      [],
    );
  } catch {
    return inspectionFailure(
      operation,
      `Pi ownership at ${paths.installedRoot}`,
    );
  }
}

export async function inspectPiInstalled(
  selection: EffectiveSelection,
  ctx: AdapterContext,
): Promise<AdapterResult<InstalledState>> {
  const operation = "inspect-pi-installed";
  const paths = pathsFor(ctx);
  let settings: SettingsObservation;
  let snapshot: SnapshotObservation;
  try {
    [settings, snapshot] = await Promise.all([
      observeSettings(paths),
      observeSnapshot(paths),
    ]);
  } catch {
    return inspectionFailure(
      operation,
      `Pi installed state at ${paths.installedRoot}`,
    );
  }

  if (snapshot.kind === "absent") {
    return successResult(
      operation,
      settings.registration === null
        ? { kind: "absent", observedIdentity: "" }
        : {
            kind: "mismatch",
            observedIdentity: "registered without an installed snapshot",
          },
      [],
    );
  }
  if (snapshot.kind === "unverified") {
    return successResult(
      operation,
      { kind: "mismatch", observedIdentity: "unverified installed snapshot" },
      [],
    );
  }
  const mismatch = successResult<InstalledState>(
    operation,
    { kind: "mismatch", observedIdentity: snapshot.digest },
    [],
  );
  if (
    settings.registration === null ||
    settings.registration.resourceState !== "enabled"
  ) {
    return mismatch;
  }

  try {
    const intended = await readPiPackageAssessment(paths.preparedRoot);
    if (
      (intended.compatibility.kind !== "supported" &&
        intended.compatibility.kind !== "experimental") ||
      intended.receipt.commit !== selection.desiredCommit ||
      !samePiSource(intended.receipt.source, selection.effectiveSource) ||
      snapshot.receipt.commit !== intended.receipt.commit ||
      !samePiSource(snapshot.receipt.source, intended.receipt.source) ||
      snapshot.digest !== intended.receipt.digest
    ) {
      return mismatch;
    }
  } catch {
    return mismatch;
  }
  return successResult(
    operation,
    { kind: "current", observedIdentity: snapshot.digest },
    [],
  );
}

export async function inspectPiControl(
  ctx: AdapterContext,
): Promise<AdapterResult<UpdateControlInspection>> {
  const operation = "inspect-pi-control";
  const paths = pathsFor(ctx);
  try {
    const { settings, registration } = await observeSettings(paths);
    const conflicts = await unmanagedConflicts(settings, paths);
    const probeEligibility: Decision = { kind: "allowed" };
    const mutationEligibility: Decision =
      registration?.resourceState === "disabled"
        ? blocked(
            "error: the Manager Pi registration disables required resources",
          )
        : registration?.resourceState === "indeterminate"
          ? blocked(
              "error: the Manager Pi registration uses unsupported resource filters",
            )
          : conflicts.length > 0
            ? blocked(
                "error: unmanaged Superpowers Pi resources prevent managed update control",
              )
            : { kind: "allowed" };
    return successResult(
      operation,
      {
        probeEligibility,
        mutationEligibility,
        presentationValue:
          registration === null
            ? conflicts.length > 0
              ? "unmanaged conflicts"
              : "unregistered"
            : registration.resourceState === "enabled"
              ? "managed local registration"
              : "manual resource configuration",
      },
      [],
    );
  } catch {
    return inspectionFailure(
      operation,
      `Pi update control at ${paths.settingsFile}`,
    );
  }
}

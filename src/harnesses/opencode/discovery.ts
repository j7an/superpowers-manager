import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findNodeAtLocation, type Node as JsonNode } from "jsonc-parser";
import { readArtifactObject } from "../../artifact-tree.ts";
import { runGit } from "../../git.ts";
import { parseStrictJson, type JsonValue } from "../../strict-json.ts";
import {
  canonicalizeProspectivePath,
  classifyPathNoFollow,
} from "../../safe-path.ts";
import { runValidator, type ValidatorPolicy } from "../../validator.ts";
import { withWorkspace } from "../../workspace.ts";
import {
  parseOpenCodeConfig,
  readOpenCodeConfig,
  type ConfigEntry,
  type ConfigFileObservation,
} from "./config.ts";
import type { OpenCodePaths } from "./paths.ts";

// Account inspection pays a full-copy cost so it never opens the native DB or
// its WAL with SQLite. Keep DB+WAL to one finite 16 MiB capture, without retry.
const MAX_ACCOUNT_FILE_BYTES = 16 * 1024 * 1024;
const ACCOUNT_QUERY_POLICY: ValidatorPolicy = {
  timeoutMs: 2_000,
  graceMs: 200,
  drainMs: 50,
  maxBytesPerStream: 1_024,
};
const ACCOUNT_QUERY =
  "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1],{readOnly:true});const row=db.prepare(\"SELECT 1 AS found FROM account_state s JOIN account a ON a.id=s.active_account_id WHERE s.id=1 AND s.active_account_id<>'' AND s.active_org_id<>'' LIMIT 1\").get();db.close();process.stdout.write(row?.found===1?'active':'absent')";
export const OPEN_CODE_UNOWNED_MANAGER_INPUT =
  "OpenCode Manager registration outside native global writer";
export const OPEN_CODE_PURE_MODE_INPUT =
  "OPENCODE_PURE disables OpenCode plugin activation";

export interface OpenCodeDiscovery {
  readonly documents: readonly ConfigFileObservation[];
  readonly conflicts: readonly string[];
  readonly blockedInputs: readonly string[];
  readonly registrationUncertain: boolean;
  readonly managedEntries: readonly {
    readonly observation: ConfigFileObservation;
    readonly entry: ConfigEntry;
    readonly canonicalRoot: string;
  }[];
}

interface DiscoveryState {
  readonly documents: ConfigFileObservation[];
  readonly conflicts: Set<string>;
  readonly blockedInputs: Set<string>;
  registrationUncertain: boolean;
  readonly managedEntries: Array<OpenCodeDiscovery["managedEntries"][number]>;
  readonly installedRoot: string;
  readonly paths: OpenCodePaths;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

interface CapturedFile {
  readonly bytes: Buffer;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
}

function truthy(value: string | undefined): boolean {
  return value?.toLowerCase() === "true" || value === "1";
}

function decode(node: JsonNode | undefined): unknown {
  if (node === undefined) return undefined;
  if (node.type === "array") return (node.children ?? []).map(decode);
  if (node.type === "object") {
    const result: Record<string, unknown> = {};
    for (const property of node.children ?? []) {
      const [key, value] = property.children ?? [];
      if (key?.type !== "string" || typeof key.value !== "string") continue;
      Object.defineProperty(result, key.value, {
        value: decode(value),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  }
  return node.value ?? null;
}

function at(root: JsonNode, path: readonly (string | number)[]): unknown {
  return decode(findNodeAtLocation(root, [...path]));
}

function containsSubstitution(value: string): boolean {
  return /\{(?:env|file):[^}]*\}/u.test(value);
}

function expandEnvironment(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\{env:([^}]+)\}/gu, (_token, name: string) => {
    const replacement = env[name];
    return replacement && replacement.length > 0 ? replacement : "";
  });
}

function addBlocked(
  state: DiscoveryState,
  label: string,
  registrationUncertain = true,
): void {
  state.blockedInputs.add(label);
  if (registrationUncertain) state.registrationUncertain = true;
}

function filesystemAncestors(cwd: string): readonly string[] {
  const result: string[] = [];
  let cursor = resolve(cwd);
  for (;;) {
    result.unshift(cursor);
    if (cursor === parse(cursor).root) break;
    const parent = dirname(cursor);
    cursor = parent;
  }
  return result;
}

async function projectAncestors(cwd: string): Promise<readonly string[]> {
  const ancestors = filesystemAncestors(cwd);
  let markerRoot: string | undefined;
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const candidate = ancestors[index]!;
    try {
      if ((await classifyPathNoFollow(join(candidate, ".git"))) !== "missing") {
        markerRoot = candidate;
        break;
      }
    } catch {
      return ancestors;
    }
  }
  if (markerRoot === undefined) return ancestors;
  try {
    const [topLevel, gitDirectory, commonDirectory] = await Promise.all([
      runGit(["rev-parse", "--show-toplevel"], { cwd: markerRoot }),
      runGit(["rev-parse", "--git-dir"], { cwd: markerRoot }),
      runGit(["rev-parse", "--git-common-dir"], { cwd: markerRoot }),
    ]);
    if (gitDirectory.status !== 0 || commonDirectory.status !== 0)
      return ancestors;
    const boundary =
      topLevel.status === 0 && topLevel.stdout.trim().length > 0
        ? resolve(markerRoot, topLevel.stdout.trim())
        : markerRoot;
    const canonicalBoundary = await canonicalizeProspectivePath(boundary);
    for (let index = 0; index < ancestors.length; index += 1) {
      if (
        (await canonicalizeProspectivePath(ancestors[index]!)) ===
        canonicalBoundary
      )
        return ancestors.slice(index);
    }
    return ancestors;
  } catch {
    return ancestors;
  }
}

function isNativeWriterOrigin(
  observation: ConfigFileObservation,
  state: DiscoveryState,
): boolean {
  const source = resolve(observation.document.path);
  return (
    source === resolve(state.paths.configRoot, "opencode.json") ||
    source === resolve(state.paths.configRoot, "opencode.jsonc")
  );
}

function localPluginPath(
  spec: string,
  origin: string,
  state: DiscoveryState,
): string | null {
  try {
    if (spec.startsWith("file://")) return fileURLToPath(spec);
  } catch {
    addBlocked(state, `${origin} plugin path`);
    return null;
  }
  if (spec.startsWith("~/")) return join(state.paths.homeDir, spec.slice(2));
  if (isAbsolute(spec)) return spec;
  if (spec.startsWith("./") || spec.startsWith("../"))
    return resolve(dirname(origin), spec);
  return null;
}

function isKnownUpstream(spec: string): boolean {
  const trimmed = spec.trim();
  if (trimmed === "superpowers") return true;
  if (
    /^superpowers@(?:git\+)?(?:https?|ssh|git):\/\/(?:git@)?github\.com\/obra\/superpowers(?:\.git)?(?:[#@].+)?$/u.test(
      trimmed,
    )
  )
    return true;
  if (
    /^(?:git\+)?(?:https?|ssh|git):\/\/(?:git@)?github\.com\/obra\/superpowers(?:\.git)?(?:[#@].+)?$/u.test(
      trimmed,
    )
  )
    return true;
  return /^git@github\.com:obra\/superpowers(?:\.git)?(?:[#@].+)?$/u.test(
    trimmed,
  );
}

function isKnownPluginFile(path: string): boolean {
  const parent = basename(dirname(path));
  return (
    (parent === "plugin" || parent === "plugins") &&
    (basename(path) === "superpowers.js" || basename(path) === "superpowers.ts")
  );
}

async function inspectPluginEntry(
  observation: ConfigFileObservation,
  entry: ConfigEntry,
  state: DiscoveryState,
  allowManaged = true,
  active = true,
): Promise<void> {
  if (entry.spec.trim().length === 0) {
    addBlocked(state, `${observation.document.path} plugin[${entry.index}]`);
    return;
  }
  if (containsSubstitution(entry.spec)) {
    addBlocked(state, `${observation.document.path} plugin[${entry.index}]`);
    return;
  }
  const local = localPluginPath(entry.spec, observation.document.path, state);
  if (local !== null) {
    const canonical = await canonicalizeProspectivePath(local);
    if (canonical === state.installedRoot) {
      if (allowManaged)
        state.managedEntries.push({
          observation,
          entry,
          canonicalRoot: canonical,
        });
      else
        addBlocked(
          state,
          `${OPEN_CODE_UNOWNED_MANAGER_INPUT}: ${observation.document.path}`,
        );
      return;
    }
  }
  if (!active) return;
  if (isKnownUpstream(entry.spec)) {
    state.conflicts.add("registered OpenCode package for obra/superpowers");
    return;
  }
  if (local === null) return;
  const kind = await classifyPathNoFollow(local);
  if (kind === "missing") {
    if (/^superpowers(?:\.(?:js|ts))?$/u.test(basename(local)))
      addBlocked(state, `${observation.document.path} plugin[${entry.index}]`);
    return;
  }
  if (isKnownPluginFile(local)) {
    state.conflicts.add(`registered native OpenCode plugin ${local}`);
    return;
  }
  if (kind !== "directory" && kind !== "symlink") {
    addBlocked(state, `${observation.document.path} plugin[${entry.index}]`);
    return;
  }
  try {
    if (
      (await readArtifactObject(local, join(local, "package.json"))).name ===
      "superpowers"
    )
      state.conflicts.add(
        "registered local OpenCode package named superpowers",
      );
  } catch {
    if (basename(local) === "superpowers")
      addBlocked(state, `${observation.document.path} plugin[${entry.index}]`);
  }
}

async function inspectSkillFile(
  path: string,
  label: string,
  state: DiscoveryState,
): Promise<void> {
  if ((await classifyPathNoFollow(path)) !== "missing")
    state.conflicts.add(`${label} ${basename(dirname(path))} at ${path}`);
}

async function inspectSkillRoot(
  root: string,
  label: string,
  state: DiscoveryState,
): Promise<void> {
  for (const leaf of ["superpowers/SKILL.md", "using-superpowers/SKILL.md"])
    await inspectSkillFile(join(root, leaf), label, state);
}

async function inspectConfigFields(
  root: JsonNode,
  source: string,
  state: DiscoveryState,
): Promise<void> {
  const paths = at(root, ["skills", "paths"]);
  if (paths !== undefined) {
    if (
      !Array.isArray(paths) ||
      paths.some((item) => typeof item !== "string")
    ) {
      addBlocked(state, `${source} skills.paths`, false);
    } else {
      for (const item of paths) {
        if (containsSubstitution(item as string)) {
          addBlocked(state, `${source} skills.paths`, false);
          continue;
        }
        const raw = item as string;
        const rootPath = raw.startsWith("~/")
          ? join(state.paths.homeDir, raw.slice(2))
          : isAbsolute(raw)
            ? raw
            : resolve(state.cwd, raw);
        await inspectSkillRoot(rootPath, "configured OpenCode skill", state);
      }
    }
  }
  const urls = at(root, ["skills", "urls"]);
  if (urls !== undefined) {
    if (!Array.isArray(urls) || urls.length > 0)
      addBlocked(state, "OpenCode remote skill configuration", false);
  }
}

async function inspectDocument(
  observation: ConfigFileObservation,
  state: DiscoveryState,
): Promise<void> {
  state.documents.push(observation);
  const source = observation.document.path;
  if (/\{file:[^}]*\}/u.test(observation.document.text))
    addBlocked(state, `${source} file substitution`);
  let effective = observation.document;
  if (/\{env:[^}]*\}/u.test(observation.document.text)) {
    try {
      effective = parseOpenCodeConfig(
        expandEnvironment(observation.document.text, state.env),
        source,
      );
    } catch {
      addBlocked(state, `${source} environment substitution`);
      return;
    }
  }
  await inspectConfigFields(effective.root, source, state);
  const active = !truthy(state.env.OPENCODE_PURE);
  for (const entry of effective.entries) {
    const original = observation.document.entries[entry.index];
    const stable = original !== undefined && original.spec === entry.spec;
    await inspectPluginEntry(
      observation,
      stable ? original : entry,
      state,
      stable && isNativeWriterOrigin(observation, state),
      active,
    );
  }
}

async function inspectConfigPath(
  path: string,
  state: DiscoveryState,
): Promise<void> {
  const observation = await readOpenCodeConfig(path);
  if (observation !== null) await inspectDocument(observation, state);
}

async function inspectNativeDirectory(
  dir: string,
  state: DiscoveryState,
): Promise<void> {
  if (!truthy(state.env.OPENCODE_PURE)) {
    for (const folder of ["plugin", "plugins"])
      for (const file of ["superpowers.js", "superpowers.ts"])
        await inspectSkillFile(
          join(dir, folder, file),
          "native OpenCode plugin",
          state,
        );
  }
  for (const folder of ["skill", "skills"])
    await inspectSkillRoot(join(dir, folder), "native OpenCode skill", state);
}

async function inspectAuth(
  state: DiscoveryState,
  dataRoot: string,
): Promise<void> {
  const hasWellKnown = (value: JsonValue): boolean =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).some(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        item.type === "wellknown",
    );
  const parseAuth = (input: string | Uint8Array): JsonValue =>
    parseStrictJson(input, {
      duplicateKeys: "reject",
      nonStandardConstants: "reject",
      maxDepth: 64,
      maxBytes: 1024 * 1024,
    });
  const inline = state.env.OPENCODE_AUTH_CONTENT;
  if (inline !== undefined) {
    try {
      if (hasWellKnown(parseAuth(inline)))
        addBlocked(state, "OPENCODE_AUTH_CONTENT");
    } catch {
      addBlocked(state, "OPENCODE_AUTH_CONTENT");
    }
  }
  const path = join(dataRoot, "auth.json");
  try {
    const auth = await captureFile(path);
    if (auth !== null && hasWellKnown(parseAuth(auth.bytes)))
      addBlocked(state, "OpenCode auth well-known configuration");
  } catch {
    addBlocked(state, `OpenCode auth configuration ${path}`);
  }
}

async function captureFile(path: string): Promise<CapturedFile | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_ACCOUNT_FILE_BYTES)
      throw new Error("unsupported account database file");
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (read.bytesRead === 0) throw new Error("short account database read");
      offset += read.bytesRead;
    }
    return { bytes, dev: stat.dev, ino: stat.ino, mode: stat.mode };
  } catch (cause) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      (cause as NodeJS.ErrnoException).code === "ENOENT"
    )
      return null;
    throw cause;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function sameCapture(
  left: CapturedFile | null,
  right: CapturedFile | null,
): boolean {
  return left === null || right === null
    ? left === right
    : left.dev === right.dev &&
        left.ino === right.ino &&
        left.mode === right.mode &&
        left.bytes.equals(right.bytes);
}

function accountDatabasePath(
  env: NodeJS.ProcessEnv,
  dataRoot: string,
): string | null {
  const configured = env.OPENCODE_DB;
  if (configured === ":memory:") return null;
  if (configured && configured.length > 0)
    return isAbsolute(configured) ? configured : join(dataRoot, configured);
  return join(dataRoot, "opencode.db");
}

async function inspectAccount(
  state: DiscoveryState,
  dataRoot: string,
): Promise<void> {
  const database = accountDatabasePath(state.env, dataRoot);
  if (database === null) return;
  const wal = `${database}-wal`;
  let initialDb: CapturedFile | null;
  let initialWal: CapturedFile | null;
  try {
    [initialDb, initialWal] = await Promise.all([
      captureFile(database),
      captureFile(wal),
    ]);
    if (initialDb === null) {
      if (initialWal !== null) throw new Error("orphan account WAL");
      return;
    }
    if (
      initialDb.bytes.length + (initialWal?.bytes.length ?? 0) >
      MAX_ACCOUNT_FILE_BYTES
    )
      throw new Error("account database capture limit");
    const result = await withWorkspace(
      tmpdir(),
      "spw-opencode-account-",
      async (workspace) => {
        const copy = join(workspace, "opencode.db");
        await (
          await open(
            copy,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
            0o600,
          )
        ).close();
        const dbOut = await open(copy, constants.O_WRONLY);
        try {
          await dbOut.writeFile(initialDb!.bytes);
        } finally {
          await dbOut.close();
        }
        if (initialWal !== null) {
          const walOut = await open(
            `${copy}-wal`,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
            0o600,
          );
          try {
            await walOut.writeFile(initialWal.bytes);
          } finally {
            await walOut.close();
          }
        }
        const beforeQuery = await Promise.all([
          captureFile(database),
          captureFile(wal),
        ]);
        if (
          !sameCapture(initialDb, beforeQuery[0]) ||
          !sameCapture(initialWal, beforeQuery[1])
        )
          throw new Error("account database moved");
        const run = await runValidator(
          [
            process.execPath,
            "--disable-warning=ExperimentalWarning",
            "-e",
            ACCOUNT_QUERY,
            copy,
          ],
          ACCOUNT_QUERY_POLICY,
          {},
          workspace,
          workspace,
        );
        if (
          run.kind !== "exited" ||
          run.code !== 0 ||
          run.stdout.droppedBytes !== 0 ||
          run.stderr.droppedBytes !== 0 ||
          run.stderr.text !== "" ||
          (run.stdout.text !== "active" && run.stdout.text !== "absent")
        )
          throw new Error("account database query failed");
        return run.stdout.text;
      },
    );
    const afterQuery = await Promise.all([
      captureFile(database),
      captureFile(wal),
    ]);
    if (
      !sameCapture(initialDb, afterQuery[0]) ||
      !sameCapture(initialWal, afterQuery[1])
    )
      throw new Error("account database moved");
    if (result === "active")
      addBlocked(state, "OpenCode active account remote configuration");
  } catch {
    addBlocked(state, `OpenCode account database ${database}`);
  }
}

function dataRoot(paths: OpenCodePaths, env: NodeJS.ProcessEnv): string {
  const base =
    env.XDG_DATA_HOME && env.XDG_DATA_HOME.length > 0
      ? env.XDG_DATA_HOME
      : join(paths.homeDir, ".local", "share");
  if (!isAbsolute(base)) throw new Error("XDG_DATA_HOME must be absolute");
  return join(base, "opencode");
}

async function inspectManagedPreferences(state: DiscoveryState): Promise<void> {
  if (process.platform !== "darwin") return;
  let user = "user";
  try {
    user = userInfo().username || user;
  } catch {
    // Native OpenCode uses the same fallback when username lookup fails.
  }
  for (const path of [
    join("/Library/Managed Preferences", user, "ai.opencode.managed.plist"),
    "/Library/Managed Preferences/ai.opencode.managed.plist",
  ]) {
    if ((await classifyPathNoFollow(path)) !== "missing") {
      addBlocked(state, "OpenCode managed preferences");
      return;
    }
  }
}

export async function inspectOpenCodeDiscovery(
  paths: OpenCodePaths,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<OpenCodeDiscovery> {
  const state: DiscoveryState = {
    documents: [],
    conflicts: new Set(),
    blockedInputs: new Set(),
    registrationUncertain: false,
    managedEntries: [],
    installedRoot: await canonicalizeProspectivePath(paths.installedRoot),
    paths,
    env,
    cwd: resolve(cwd),
  };
  if (truthy(env.OPENCODE_PURE))
    addBlocked(state, OPEN_CODE_PURE_MODE_INPUT, false);
  for (const name of ["config.json", "opencode.json", "opencode.jsonc"])
    await inspectConfigPath(join(paths.configRoot, name), state);

  if (env.OPENCODE_CONFIG) {
    const path = isAbsolute(env.OPENCODE_CONFIG)
      ? env.OPENCODE_CONFIG
      : resolve(cwd, env.OPENCODE_CONFIG);
    await inspectConfigPath(path, state);
  }

  const ancestors = await projectAncestors(cwd);
  if (!truthy(env.OPENCODE_DISABLE_PROJECT_CONFIG)) {
    for (const dir of ancestors)
      for (const name of ["opencode.jsonc", "opencode.json"])
        await inspectConfigPath(join(dir, name), state);
  }

  const configDirs = new Set<string>([
    paths.configRoot,
    ...(!truthy(env.OPENCODE_DISABLE_PROJECT_CONFIG)
      ? ancestors.map((dir) => join(dir, ".opencode"))
      : []),
    join(paths.homeDir, ".opencode"),
    ...(env.OPENCODE_CONFIG_DIR ? [resolve(cwd, env.OPENCODE_CONFIG_DIR)] : []),
  ]);
  for (const dir of configDirs) {
    if (
      dir.endsWith(".opencode") ||
      dir === resolve(cwd, env.OPENCODE_CONFIG_DIR ?? "")
    )
      for (const name of ["opencode.json", "opencode.jsonc"])
        await inspectConfigPath(join(dir, name), state);
    await inspectNativeDirectory(dir, state);
  }

  if (env.OPENCODE_CONFIG_CONTENT !== undefined) {
    try {
      if (/\{file:[^}]*\}/u.test(env.OPENCODE_CONFIG_CONTENT))
        addBlocked(state, "OPENCODE_CONFIG_CONTENT file substitution");
      const inline = parseOpenCodeConfig(
        expandEnvironment(env.OPENCODE_CONFIG_CONTENT, env),
        "OPENCODE_CONFIG_CONTENT",
      );
      await inspectConfigFields(inline.root, "OPENCODE_CONFIG_CONTENT", state);
      if (!truthy(env.OPENCODE_PURE)) {
        for (const entry of inline.entries) {
          if (
            entry.spec.trim().length === 0 ||
            containsSubstitution(entry.spec)
          )
            addBlocked(state, `OPENCODE_CONFIG_CONTENT plugin[${entry.index}]`);
          else if (isKnownUpstream(entry.spec))
            state.conflicts.add(
              "registered OpenCode package for obra/superpowers",
            );
          else if (
            localPluginPath(entry.spec, join(cwd, "opencode.json"), state) !==
            null
          ) {
            const local = localPluginPath(
              entry.spec,
              join(cwd, "opencode.json"),
              state,
            )!;
            const canonical = await canonicalizeProspectivePath(local);
            addBlocked(
              state,
              canonical === state.installedRoot
                ? `${OPEN_CODE_UNOWNED_MANAGER_INPUT}: OPENCODE_CONFIG_CONTENT`
                : `OPENCODE_CONFIG_CONTENT plugin[${entry.index}]`,
            );
          }
        }
      }
    } catch {
      addBlocked(state, "OPENCODE_CONFIG_CONTENT");
    }
  }

  if (!truthy(env.OPENCODE_DISABLE_EXTERNAL_SKILLS)) {
    const skillAncestors = [...ancestors, paths.homeDir];
    for (const dir of skillAncestors) {
      await inspectSkillRoot(
        join(dir, ".agents", "skills"),
        "shared OpenCode skill",
        state,
      );
      if (!truthy(env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS))
        await inspectSkillRoot(
          join(dir, ".claude", "skills"),
          "shared OpenCode skill",
          state,
        );
    }
  }

  const managedDir =
    env.OPENCODE_TEST_MANAGED_CONFIG_DIR ??
    (process.platform === "darwin"
      ? "/Library/Application Support/opencode"
      : process.platform === "win32"
        ? join(env.ProgramData || "C:\\ProgramData", "opencode")
        : "/etc/opencode");
  for (const name of ["opencode.json", "opencode.jsonc"])
    await inspectConfigPath(join(managedDir, name), state);
  await inspectNativeDirectory(managedDir, state);
  await inspectManagedPreferences(state);

  const nativeData = dataRoot(paths, env);
  await inspectAuth(state, nativeData);
  await inspectAccount(state, nativeData);
  return {
    documents: state.documents,
    conflicts: [...state.conflicts],
    blockedInputs: [...state.blockedInputs].sort(),
    registrationUncertain: state.registrationUncertain,
    managedEntries: state.managedEntries,
  };
}

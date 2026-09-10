import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { parse, TomlDate, type TomlTable, type TomlValue } from "smol-toml";

import { SafetyError } from "../../safety-error.ts";
import { codexHome } from "./paths.ts";

const CONFIG_LIMIT = 1024 * 1024;
const CONFIG_DEPTH_LIMIT = 64;
const MANAGER_MARKETPLACE = "superpowers-manager";
const LEGACY_MARKETPLACE = "superpowers-wrapper";
const MANAGER_PLUGIN = `superpowers@${MANAGER_MARKETPLACE}`;
const LEGACY_PLUGIN = `superpowers@${LEGACY_MARKETPLACE}`;
const VERSION_SEGMENT = /^[A-Za-z0-9._+-]+$/u;
const MARKETPLACE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export interface CodexStoredState {
  readonly managerMarketplaceRoot: string;
  readonly legacyMarketplaceRoot: string | null;
  readonly managerPluginPresent: boolean;
  readonly managerPluginEnabled: boolean;
  readonly legacyPluginPresent: boolean;
  readonly legacyPluginEnabled: boolean;
  readonly installedListingJson: string;
}

function storedError(message: string, cause?: unknown): SafetyError {
  return new SafetyError("codex-stored-state", message, { cause });
}

function isErrno(cause: unknown, code: string): boolean {
  return (
    cause !== null &&
    typeof cause === "object" &&
    "code" in cause &&
    cause.code === code
  );
}

function table(value: TomlValue | undefined, name: string): TomlTable {
  if (value === undefined) return {};
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value instanceof TomlDate ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw storedError(`Codex configuration ${name} must be a table`);
  }
  return value as TomlTable;
}

async function readConfig(path: string): Promise<TomlTable> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const initial = await lstat(path);
    if (!initial.isFile() || initial.isSymbolicLink()) {
      throw storedError(`Codex configuration must be a regular file: ${path}`);
    }
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await handle.stat();
    if (!before.isFile() || before.size > CONFIG_LIMIT) {
      throw storedError(
        `Codex configuration must be a bounded regular file: ${path}`,
      );
    }
    const buffer = Buffer.alloc(CONFIG_LIMIT + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    if (
      bytes.length > CONFIG_LIMIT ||
      bytes.length !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.dev !== pathAfter.dev ||
      before.ino !== pathAfter.ino ||
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink()
    ) {
      throw storedError(
        `Codex configuration changed while being read: ${path}`,
      );
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes,
      );
    } catch (cause) {
      throw storedError(
        `Codex configuration is not valid UTF-8: ${path}`,
        cause,
      );
    }
    try {
      return parse(text, {
        maxDepth: CONFIG_DEPTH_LIMIT,
        integersAsBigInt: true,
      });
    } catch (cause) {
      throw storedError(`Codex configuration TOML is invalid: ${path}`, cause);
    }
  } catch (cause) {
    if (cause instanceof SafetyError && cause.module === "codex-stored-state") {
      throw cause;
    }
    throw storedError(`cannot safely read Codex configuration: ${path}`, cause);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function marketplaceRoot(marketplaces: TomlTable, name: string): string | null {
  const value = marketplaces[name];
  if (value === undefined) return null;
  const entry = table(value, `marketplaces.${name}`);
  if (
    entry.source_type !== "local" ||
    typeof entry.source !== "string" ||
    !isAbsolute(entry.source)
  ) {
    throw storedError(
      `Codex marketplace ${name} must name an absolute local source`,
    );
  }
  return entry.source;
}

async function requireMissingManagerSource(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) return;
    throw storedError(
      `cannot inspect Codex marketplace source: ${path}`,
      cause,
    );
  }
  throw storedError(`Codex marketplace source is not missing: ${path}`);
}

function validVersionSegment(value: string): boolean {
  return value !== "." && value !== ".." && VERSION_SEGMENT.test(value);
}

async function cachedVersionPresent(
  searchRoot: string,
  marketplace: string,
): Promise<boolean | null> {
  if (!MARKETPLACE_SEGMENT.test(marketplace)) return null;
  let base = searchRoot;
  for (const segment of ["plugins", "cache", marketplace, "superpowers"]) {
    let details;
    try {
      details = await lstat(base);
    } catch (cause) {
      if (isErrno(cause, "ENOENT")) return false;
      throw storedError(`cannot inspect Codex plugin cache: ${base}`, cause);
    }
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw storedError(`Codex plugin cache must be a directory: ${base}`);
    }
    base = join(base, segment);
  }
  let before;
  try {
    before = await lstat(base);
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) return false;
    throw storedError(`cannot inspect Codex plugin cache: ${base}`, cause);
  }
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw storedError(`Codex plugin cache must be a directory: ${base}`);
  }
  let names: string[];
  try {
    names = await readdir(base);
  } catch (cause) {
    throw storedError(`cannot inspect Codex plugin cache: ${base}`, cause);
  }
  let present = false;
  for (const name of names) {
    if (!validVersionSegment(name)) continue;
    const candidate = join(base, name);
    try {
      const details = await lstat(candidate);
      if (details.isSymbolicLink()) {
        throw storedError(
          `Codex plugin cache entry must not be a symlink: ${candidate}`,
        );
      }
      if (details.isDirectory() && !details.isSymbolicLink()) present = true;
    } catch (cause) {
      if (!isErrno(cause, "ENOENT")) {
        throw storedError(
          `cannot inspect Codex plugin cache entry: ${candidate}`,
          cause,
        );
      }
    }
  }
  let after;
  try {
    after = await lstat(base);
  } catch (cause) {
    throw storedError(`cannot verify Codex plugin cache: ${base}`, cause);
  }
  if (
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw storedError(
      `Codex plugin cache changed while being inspected: ${base}`,
    );
  }
  return present;
}

export async function readCodexStoredState(
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<CodexStoredState> {
  const root = codexHome(env, cwd);
  try {
    const details = await lstat(root);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw storedError(`Codex home must be a directory: ${root}`);
    }
  } catch (cause) {
    if (cause instanceof SafetyError && cause.module === "codex-stored-state") {
      throw cause;
    }
    throw storedError(`cannot inspect Codex home: ${root}`, cause);
  }
  const config = await readConfig(join(root, "config.toml"));
  const marketplaces = table(config.marketplaces, "marketplaces");
  const managerMarketplaceRoot = marketplaceRoot(
    marketplaces,
    MANAGER_MARKETPLACE,
  );
  if (managerMarketplaceRoot === null) {
    throw storedError("Codex manager marketplace is not configured");
  }
  await requireMissingManagerSource(managerMarketplaceRoot);
  const legacyMarketplaceRoot = marketplaceRoot(
    marketplaces,
    LEGACY_MARKETPLACE,
  );
  const plugins = table(config.plugins, "plugins");
  const searchRoot = env.SUPERPOWERS_INSTALLED_SEARCH_ROOT || root;
  const installed: Array<{
    pluginId: string;
    installed: boolean | null;
    enabled: boolean;
  }> = [];
  for (const [pluginId, rawEntry] of Object.entries(plugins)) {
    const entry = table(rawEntry, `plugins.${pluginId}`);
    if (typeof entry.enabled !== "boolean") {
      throw storedError(`Codex plugin ${pluginId} has invalid enabled state`);
    }
    if (!pluginId.startsWith("superpowers@")) continue;
    const marketplace = pluginId.slice("superpowers@".length);
    installed.push({
      pluginId,
      installed: await cachedVersionPresent(searchRoot, marketplace),
      enabled: entry.enabled === true,
    });
  }
  const byId = (id: string) =>
    installed.find((plugin) => plugin.pluginId === id);
  const manager = byId(MANAGER_PLUGIN);
  const legacy = byId(LEGACY_PLUGIN);
  return {
    managerMarketplaceRoot,
    legacyMarketplaceRoot,
    managerPluginPresent: manager?.installed === true,
    managerPluginEnabled: manager?.enabled === true,
    legacyPluginPresent: legacy?.installed === true,
    legacyPluginEnabled: legacy?.enabled === true,
    installedListingJson: JSON.stringify({ installed }),
  };
}

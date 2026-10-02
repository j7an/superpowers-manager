import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseDocument } from "yaml";
import { readArtifactFile } from "../../artifact-tree.ts";
import { compareByCodePoint } from "../../python-text.ts";
import { assertNoFollowType, classifyPathNoFollow } from "../../safe-path.ts";
import { SafetyError } from "../../safety-error.ts";
import type { HermesPaths } from "./paths.ts";

export type HermesStatus = "enabled" | "disabled" | "not enabled";
const DECODER = new TextDecoder("utf-8", { fatal: true });

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseYaml(text: string, uniqueKeys = true): unknown {
  const document = parseDocument(text, { uniqueKeys, merge: true });
  if (
    document.errors.length > 0 ||
    document.warnings.some((warning) => warning.code === "TAG_RESOLVE_FAILED")
  )
    throw new Error("YAML document");
  return document.toJS() as unknown;
}

async function configuration(
  root: string,
): Promise<Record<string, unknown> | null> {
  await assertNoFollowType(root, ["directory", "missing"]);
  const path = join(root, "config.yaml");
  if ((await classifyPathNoFollow(path)) === "missing") return null;
  const value = parseYaml(DECODER.decode(await readArtifactFile(root, path)));
  if (!mapping(value)) throw new Error("configuration mapping");
  return value;
}

async function managedDirectory(
  env: NodeJS.ProcessEnv,
  systemManagedDir: string,
): Promise<string | null> {
  const configured = env.HERMES_MANAGED_DIR;
  for (const path of configured
    ? [configured, systemManagedDir]
    : [systemManagedDir]) {
    const kind = await classifyPathNoFollow(path);
    if (kind === "directory") return path;
    if (kind === "symlink") throw new Error("managed directory symlink");
  }
  return null;
}

function activationList(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  if (
    value.some(
      (item: unknown) =>
        (item !== null && typeof item === "object") ||
        (typeof item === "string" && item.includes("${")),
    )
  )
    throw new SafetyError(
      "hermes-observe",
      "cannot determine Hermes plugin activation",
    );
  return value as unknown[];
}

export async function readHermesStatus(
  paths: HermesPaths,
  env: NodeJS.ProcessEnv,
  systemManagedDir = "/etc/hermes",
): Promise<HermesStatus> {
  let user: Record<string, unknown> | null;
  try {
    user = await configuration(paths.hermesHome);
  } catch (cause) {
    throw new SafetyError(
      "hermes-observe",
      "cannot inspect Hermes configuration",
      { cause },
    );
  }
  try {
    const directory = await managedDirectory(env, systemManagedDir);
    const managed = directory === null ? null : await configuration(directory);
    const plugins = managed?.plugins;
    if (plugins !== undefined && plugins !== null && !mapping(plugins))
      throw new Error("managed plugins shape");
    if (
      mapping(plugins) &&
      (Object.hasOwn(plugins, "enabled") || Object.hasOwn(plugins, "disabled"))
    )
      throw new Error("managed activation");
  } catch (cause) {
    throw new SafetyError(
      "hermes-observe",
      "cannot determine Hermes plugin activation",
      { cause },
    );
  }
  const plugins = mapping(user?.plugins) ? user.plugins : {};
  const enabled = activationList(plugins.enabled);
  const disabled = activationList(plugins.disabled);
  return disabled.includes("superpowers")
    ? "disabled"
    : enabled.includes("superpowers")
      ? "enabled"
      : "not enabled";
}

const FOREIGN_MANIFEST_DIRECTORIES = new Set([
  ".claude-plugin",
  ".codex-plugin",
  ".cursor-plugin",
  ".devin-plugin",
  ".kimi-plugin",
]);

export async function findSuperpowersManifests(
  paths: HermesPaths,
): Promise<string[]> {
  try {
    if ((await classifyPathNoFollow(paths.pluginsRoot)) === "missing")
      return [];
    const found: string[] = [];
    async function scan(root: string, depth: number): Promise<void> {
      await assertNoFollowType(root, ["directory"]);
      for (const name of (await readdir(root)).sort(compareByCodePoint)) {
        if (
          (name.startsWith("__") && name.endsWith("__")) ||
          FOREIGN_MANIFEST_DIRECTORIES.has(name)
        )
          continue;
        const child = join(root, name);
        const kind = await classifyPathNoFollow(child);
        if (kind === "symlink") throw new Error("plugin directory symlink");
        if (kind !== "directory") continue;
        let manifest: string | null = null;
        for (const file of ["plugin.yaml", "plugin.yml", "plugin.json"]) {
          if ((await classifyPathNoFollow(join(child, file))) !== "missing") {
            manifest = file;
            break;
          }
        }
        if (manifest === null) {
          if (depth === 0) await scan(child, 1);
          continue;
        }
        const bytes = await readArtifactFile(
          paths.pluginsRoot,
          join(child, manifest),
          64 * 1024,
        );
        let value: unknown;
        try {
          const text = DECODER.decode(bytes);
          value =
            manifest === "plugin.json"
              ? (JSON.parse(text) as unknown)
              : (parseYaml(text, false) ?? {});
        } catch {
          continue;
        }
        if (!mapping(value)) continue;
        const pluginName = Object.hasOwn(value, "name")
          ? value.name
          : manifest === "plugin.json"
            ? undefined
            : basename(child);
        if (pluginName === "superpowers") found.push(child);
      }
    }
    await scan(paths.pluginsRoot, 0);
    return found.sort(compareByCodePoint);
  } catch (cause) {
    throw new SafetyError("hermes-observe", "cannot inspect Hermes plugins", {
      cause,
    });
  }
}

export function projectPluginsEnabled(env: NodeJS.ProcessEnv): boolean {
  return ["1", "true", "yes", "on"].includes(
    (env.HERMES_ENABLE_PROJECT_PLUGINS ?? "").trim().toLowerCase(),
  );
}

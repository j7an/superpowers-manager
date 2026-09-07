import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

import type { AdapterContext } from "./adapter-result.ts";
import {
  codexInstalledPluginsFromJson,
  type CodexInstalledPlugin,
} from "./codex-json.ts";

export const CODEX_MANAGER_PLUGIN_ID = "superpowers@superpowers-manager";
export const CODEX_LEGACY_PLUGIN_ID = "superpowers@superpowers-wrapper";
const SUPERPOWERS_PLUGIN_PREFIX = "superpowers@";
const DISPLAYABLE_PLUGIN_ID = /^superpowers@[A-Za-z0-9][A-Za-z0-9._-]*/;
const NATIVE_ROUTE = ".agents/skills/superpowers";

function isUnmanagedPluginId(pluginId: string): boolean {
  if (
    pluginId === CODEX_MANAGER_PLUGIN_ID ||
    pluginId === CODEX_LEGACY_PLUGIN_ID
  ) {
    return false;
  }
  return (
    pluginId.startsWith(SUPERPOWERS_PLUGIN_PREFIX) &&
    pluginId.length > SUPERPOWERS_PLUGIN_PREFIX.length
  );
}

function displayablePluginId(pluginId: string): string {
  return pluginId.length <= 256 &&
    DISPLAYABLE_PLUGIN_ID.exec(pluginId)?.[0] === pluginId
    ? pluginId
    : "";
}

function unmanagedPluginConflict(plugin: CodexInstalledPlugin): string {
  if (!isUnmanagedPluginId(plugin.pluginId)) return "";
  const displayId = displayablePluginId(plugin.pluginId);
  const subject =
    displayId.length > 0
      ? `Codex plugin ${displayId}`
      : "Codex plugin with a non-displayable Superpowers identity";
  if (plugin.installed === true && plugin.enabled === true) {
    return `active ${subject}`;
  }
  if (
    (plugin.installed === true && plugin.enabled === false) ||
    (plugin.installed === false && plugin.enabled === false)
  ) {
    return "";
  }
  return `${subject} has indeterminate activity`;
}

async function nativeRouteConflict(ctx: AdapterContext): Promise<string> {
  const home = ctx.env?.HOME;
  if (home === undefined || home.length === 0) return "";
  const route = join(home, ".agents", "skills", "superpowers");
  const asset = join(route, "using-superpowers", "SKILL.md");
  try {
    const resolvedAsset = await realpath(asset);
    if (!(await stat(resolvedAsset)).isFile()) return "";
    const contents = await readFile(resolvedAsset, "utf8");
    const lines = contents.split(/\r?\n/u);
    if (lines[0] !== "---") return "";
    const end = lines.indexOf("---", 1);
    if (
      end < 0 ||
      !lines
        .slice(1, end)
        .some((line) => /^name:[ \t]+using-superpowers[ \t]*$/u.test(line))
    ) {
      return "";
    }
  } catch {
    return "";
  }
  return `native Codex skills route ~/${NATIVE_ROUTE} has indeterminate activity`;
}

export async function inspectCodexConflicts(
  ctx: AdapterContext,
  installedListing: string,
): Promise<readonly string[]> {
  const conflicts = new Set<string>();
  for (const plugin of codexInstalledPluginsFromJson(installedListing)) {
    const conflict = unmanagedPluginConflict(plugin);
    if (conflict.length > 0) conflicts.add(conflict);
  }
  const nativeConflict = await nativeRouteConflict(ctx);
  if (nativeConflict.length > 0) conflicts.add(nativeConflict);
  return [...conflicts];
}

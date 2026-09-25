import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { assertNoFollowType } from "../../safe-path.ts";

export interface ClaudeCodePaths {
  readonly configRoot: string;
  readonly managerRoot: string;
  readonly preparedRoot: string;
  readonly marketplaceRoot: string;
  readonly marketplaceManifest: string;
  readonly pluginsRoot: string;
  readonly pluginRoot: string;
}

export function claudeCodePaths(
  env: NodeJS.ProcessEnv,
  cwd: string,
): ClaudeCodePaths {
  const configured = env.CLAUDE_CONFIG_DIR;
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
  const configRoot =
    configured !== undefined && configured.length > 0
      ? resolve(cwd, configured)
      : join(resolve(cwd, home), ".claude");
  const managerRoot = join(configRoot, "superpowers-manager");
  const marketplaceRoot = join(managerRoot, "marketplace");
  const pluginsRoot = join(marketplaceRoot, "plugins");
  return {
    configRoot,
    managerRoot,
    preparedRoot: join(managerRoot, "prepared"),
    marketplaceRoot,
    marketplaceManifest: join(
      marketplaceRoot,
      ".claude-plugin",
      "marketplace.json",
    ),
    pluginsRoot,
    pluginRoot: join(pluginsRoot, "superpowers"),
  };
}

// Each owned directory is a real directory or absent; a symlink anywhere in
// the chain could redirect publication outside the config root.
export async function assertClaudeCodeStorageSafe(
  paths: ClaudeCodePaths,
): Promise<void> {
  for (const path of [
    paths.configRoot,
    paths.managerRoot,
    paths.preparedRoot,
    paths.marketplaceRoot,
    join(paths.marketplaceRoot, ".claude-plugin"),
    paths.pluginsRoot,
  ])
    await assertNoFollowType(path, ["directory", "missing"]);
}

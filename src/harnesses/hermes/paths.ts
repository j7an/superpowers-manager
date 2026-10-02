import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { assertNoFollowType } from "../../safe-path.ts";

export interface HermesPaths {
  readonly hermesHome: string;
  readonly managerRoot: string;
  readonly preparedRoot: string;
  readonly pluginsRoot: string;
  readonly pluginRoot: string;
}

export function hermesPaths(env: NodeJS.ProcessEnv, cwd: string): HermesPaths {
  const configured = env.HERMES_HOME;
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
  const hermesHome =
    configured !== undefined && configured.length > 0
      ? resolve(cwd, configured)
      : join(resolve(cwd, home), ".hermes");
  const managerRoot = join(hermesHome, "superpowers-manager");
  const pluginsRoot = join(hermesHome, "plugins");
  return {
    hermesHome,
    managerRoot,
    preparedRoot: join(managerRoot, "prepared"),
    pluginsRoot,
    pluginRoot: join(pluginsRoot, "superpowers"),
  };
}

export async function assertHermesStorageSafe(
  paths: HermesPaths,
): Promise<void> {
  for (const path of [
    paths.hermesHome,
    paths.managerRoot,
    paths.preparedRoot,
    paths.pluginsRoot,
    paths.pluginRoot,
  ])
    await assertNoFollowType(path, ["directory", "missing"]);
}

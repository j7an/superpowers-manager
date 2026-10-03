import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { assertNoFollowType } from "../../safe-path.ts";

export interface OpenCodePaths {
  readonly homeDir: string;
  readonly configRoot: string;
  readonly managerRoot: string;
  readonly preparedRoot: string;
  readonly installedRoot: string;
  readonly recoveryRoot: string;
}

export async function assertOpenCodePreparationSeparate(
  paths: OpenCodePaths,
): Promise<void> {
  for (const root of [
    paths.configRoot,
    paths.managerRoot,
    paths.preparedRoot,
    paths.installedRoot,
    paths.recoveryRoot,
  ])
    await assertNoFollowType(root, ["directory", "missing"]);
}

export function openCodePaths(
  env: NodeJS.ProcessEnv,
  cwd: string,
): OpenCodePaths {
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
  const homeDir = resolve(cwd, home);
  const configured = env.XDG_CONFIG_HOME;
  if (
    configured !== undefined &&
    configured.length > 0 &&
    !isAbsolute(configured)
  )
    throw new Error("XDG_CONFIG_HOME must be absolute");
  const configRoot = join(
    configured && configured.length > 0 ? configured : join(homeDir, ".config"),
    "opencode",
  );
  const managerRoot = join(configRoot, "superpowers-manager");
  return {
    homeDir,
    configRoot,
    managerRoot,
    preparedRoot: join(managerRoot, "prepared"),
    installedRoot: join(managerRoot, "installed"),
    recoveryRoot: join(managerRoot, "recovery"),
  };
}

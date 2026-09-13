import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  assertNoFollowType,
  canonicalizeProspectivePath,
} from "../../safe-path.ts";

export interface OpenCodePaths {
  readonly homeDir: string;
  readonly configRoot: string;
  readonly managerRoot: string;
  readonly preparedRoot: string;
  readonly installedRoot: string;
  readonly recoveryRoot: string;
}

function overlaps(left: string, right: string): boolean {
  const contains = (root: string, leaf: string): boolean => {
    const suffix = relative(root, leaf);
    return (
      suffix === "" ||
      (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`))
    );
  };
  return contains(left, right) || contains(right, left);
}

export async function assertOpenCodePreparationSeparate(
  paths: OpenCodePaths,
): Promise<void> {
  await assertNoFollowType(paths.configRoot, ["directory", "missing"]);
  await assertNoFollowType(paths.managerRoot, ["directory", "missing"]);
  const roots = [paths.preparedRoot, paths.installedRoot, paths.recoveryRoot];
  const canonical = await Promise.all(
    roots.map(async (root) => {
      await assertNoFollowType(root, ["directory", "missing"]);
      return await canonicalizeProspectivePath(root);
    }),
  );
  if (
    overlaps(canonical[0]!, canonical[1]!) ||
    overlaps(canonical[0]!, canonical[2]!) ||
    overlaps(canonical[1]!, canonical[2]!)
  )
    throw new Error("storage roots overlap");
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

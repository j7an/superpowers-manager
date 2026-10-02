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

function trimHome(value: string): string {
  const whitespace = (index: number): boolean => {
    const code = value.charCodeAt(index);
    return (
      (code >= 0x1c && code <= 0x1f) ||
      /\p{White_Space}/u.test(value.charAt(index))
    );
  };
  let start = 0;
  let end = value.length;
  while (start < end && whitespace(start)) start++;
  while (end > start && whitespace(end - 1)) end--;
  return value.slice(start, end);
}

function expandHome(
  value: string,
  env: NodeJS.ProcessEnv,
  home: string,
): string {
  const expanded = trimHome(value).replace(
    /\$([A-Za-z0-9_]+|\{[^}]*\})/gu,
    (token, name: string) => {
      const variable = name.startsWith("{") ? name.slice(1, -1) : name;
      return Object.hasOwn(env, variable) ? (env[variable] ?? token) : token;
    },
  );
  if (expanded === "~") return home;
  if (expanded.startsWith("~/")) return join(home, expanded.slice(2));
  if (expanded.startsWith("~"))
    throw new Error(
      "cannot resolve HERMES_HOME: named user homes are unsupported",
    );
  return expanded;
}

export function hermesPaths(env: NodeJS.ProcessEnv, cwd: string): HermesPaths {
  const configured = trimHome(env.HERMES_HOME ?? "");
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
  const hermesHome =
    configured.length > 0
      ? resolve(cwd, expandHome(configured, env, home))
      : join(resolve(cwd, home), ".hermes");
  if (expandHome(hermesHome, env, home) !== hermesHome)
    throw new Error("cannot resolve HERMES_HOME: home expansion is not stable");
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

export async function assertHermesStorageAncestorsSafe(
  paths: HermesPaths,
): Promise<void> {
  for (const path of [
    paths.hermesHome,
    paths.managerRoot,
    paths.preparedRoot,
    paths.pluginsRoot,
  ])
    await assertNoFollowType(path, ["directory", "missing"]);
}

export async function assertHermesStorageSafe(
  paths: HermesPaths,
): Promise<void> {
  await assertHermesStorageAncestorsSafe(paths);
  await assertNoFollowType(paths.pluginRoot, ["directory", "missing"]);
}

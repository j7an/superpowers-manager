import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface PiPaths {
  readonly homeDir: string;
  readonly agentDir: string;
  readonly settingsFile: string;
  readonly managerRoot: string;
  readonly preparedRoot: string;
  readonly installedRoot: string;
  readonly recoveryRoot: string;
}

function homeDirectory(env: NodeJS.ProcessEnv): string {
  return env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
}

function expandTilde(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

export function piPaths(env: NodeJS.ProcessEnv, cwd: string): PiPaths {
  const homeDir = resolve(cwd, homeDirectory(env));
  const configured = env.PI_CODING_AGENT_DIR;
  const selected =
    configured && configured.length > 0
      ? expandTilde(configured, homeDir)
      : join(homeDir, ".pi", "agent");
  const agentDir = resolve(cwd, selected);
  const managerRoot = join(agentDir, "superpowers-manager");

  return {
    homeDir,
    agentDir,
    settingsFile: join(agentDir, "settings.json"),
    managerRoot,
    preparedRoot: join(managerRoot, "prepared"),
    installedRoot: join(managerRoot, "installed"),
    recoveryRoot: join(managerRoot, "recovery"),
  };
}

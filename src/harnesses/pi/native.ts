import { tmpdir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

import {
  failureResult,
  type AdapterContext,
  type AdapterResult,
} from "../../adapter-result.ts";
import {
  nativeCommandResult,
  type NativeCommandOutput,
} from "../../harness-command-result.ts";
import type { PiPaths } from "./paths.ts";
import {
  BOUNDED_EXECUTABLE,
  runValidator as runBoundedCommand,
} from "../../validator.ts";
import { withWorkspace } from "../../workspace.ts";

function selectedExecutable(
  env: NodeJS.ProcessEnv,
  invocationCwd: string,
): string {
  const configured = env.SUPERPOWERS_PI || "pi";
  return configured.includes(sep) && !isAbsolute(configured)
    ? resolve(invocationCwd, configured)
    : configured;
}

export async function runPi(
  args: readonly string[],
  paths: PiPaths,
  ctx: AdapterContext,
  execute: typeof runBoundedCommand = runBoundedCommand,
): Promise<AdapterResult<NativeCommandOutput>> {
  const operation = "pi-command";
  const env = ctx.env ?? {};
  const invocationCwd = process.cwd();
  const executable = selectedExecutable(env, invocationCwd);
  let entered = false;
  try {
    return await withWorkspace(
      env.TMPDIR ?? tmpdir(),
      "superpowers-manager.pi.",
      async (workspace) => {
        entered = true;
        const result = await execute(
          [executable, ...args],
          BOUNDED_EXECUTABLE,
          {
            ...env,
            HOME: paths.homeDir,
            PI_CODING_AGENT_DIR: paths.agentDir,
            PI_OFFLINE: "1",
            PI_SKIP_VERSION_CHECK: "1",
          },
          workspace,
          workspace,
        );
        return nativeCommandResult("Pi", result);
      },
    );
  } catch {
    return failureResult(
      operation,
      "workspace-failed",
      entered
        ? "cannot complete Pi command in its isolated workspace"
        : "cannot create an isolated Pi command workspace",
      [],
      [],
    );
  }
}

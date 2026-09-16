import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { mkdir } from "node:fs/promises";

import {
  failureResult,
  type AdapterContext,
  type AdapterResult,
} from "../../adapter-result.ts";
import {
  nativeCommandResult,
  type NativeCommandOutput,
} from "../../harness-command-result.ts";
import {
  BOUNDED_EXECUTABLE,
  runValidator as runBoundedCommand,
} from "../../validator.ts";
import { withWorkspace } from "../../workspace.ts";
import type { OpenCodePaths } from "./paths.ts";

const OPEN_CODE_EXECUTABLE = {
  ...BOUNDED_EXECUTABLE,
  inheritEnvironment: false,
} as const;

function selectedExecutable(
  env: NodeJS.ProcessEnv,
  invocationCwd: string,
): string {
  const configured = env.SUPERPOWERS_OPENCODE || "opencode";
  return configured.includes(sep) && !isAbsolute(configured)
    ? resolve(invocationCwd, configured)
    : configured;
}

export async function runOpenCode(
  args: readonly string[],
  paths: OpenCodePaths,
  ctx: AdapterContext,
  execute: typeof runBoundedCommand = runBoundedCommand,
): Promise<AdapterResult<NativeCommandOutput>> {
  const operation = "opencode-command";
  const env = ctx.env ?? {};
  const executable = selectedExecutable(env, process.cwd());
  let entered = false;
  try {
    return await withWorkspace(
      env.TMPDIR ?? tmpdir(),
      "superpowers-manager.opencode.",
      async (workspace) => {
        entered = true;
        const home = resolve(workspace, "home");
        const data = resolve(workspace, "data");
        const cache = resolve(workspace, "cache");
        const state = resolve(workspace, "state");
        const temporary = resolve(workspace, "tmp");
        const managed = resolve(workspace, "managed");
        await Promise.all(
          [home, data, cache, state, temporary, managed].map((path) =>
            mkdir(path),
          ),
        );
        const result = await execute(
          [executable, ...args],
          OPEN_CODE_EXECUTABLE,
          {
            PATH: env.PATH,
            HOME: home,
            XDG_CONFIG_HOME: dirname(paths.configRoot),
            XDG_DATA_HOME: data,
            XDG_CACHE_HOME: cache,
            XDG_STATE_HOME: state,
            TMPDIR: temporary,
            OPENCODE_DISABLE_AUTOUPDATE: "1",
            OPENCODE_DISABLE_MODELS_FETCH: "1",
            OPENCODE_DISABLE_PROJECT_CONFIG: "1",
            OPENCODE_PURE: "1",
            OPENCODE_TEST_MANAGED_CONFIG_DIR: managed,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
          },
          temporary,
          workspace,
        );
        return nativeCommandResult("OpenCode", result);
      },
    );
  } catch {
    return failureResult(
      operation,
      "workspace-failed",
      entered
        ? "cannot complete OpenCode command in its isolated workspace"
        : "cannot create an isolated OpenCode command workspace",
      [],
      [],
    );
  }
}

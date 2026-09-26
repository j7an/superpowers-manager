import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";

import {
  type AdapterContext,
  type AdapterResult,
} from "../../adapter-result.ts";
import {
  runIsolatedNative,
  type NativeCommandOutput,
} from "../../harness-command-result.ts";
import {
  BOUNDED_EXECUTABLE,
  runValidator as runBoundedCommand,
} from "../../validator.ts";
import type { OpenCodePaths } from "./paths.ts";

const OPEN_CODE_EXECUTABLE = {
  ...BOUNDED_EXECUTABLE,
  inheritEnvironment: false,
} as const;

export async function runOpenCode(
  args: readonly string[],
  paths: OpenCodePaths,
  ctx: AdapterContext,
  execute: typeof runBoundedCommand = runBoundedCommand,
): Promise<AdapterResult<NativeCommandOutput>> {
  return await runIsolatedNative(
    "OpenCode",
    (ctx.env ?? {}).SUPERPOWERS_OPENCODE || "opencode",
    ctx,
    async (executable, workspace, env) => {
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
      return await execute(
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
    },
  );
}

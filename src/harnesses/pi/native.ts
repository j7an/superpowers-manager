import {
  type AdapterContext,
  type AdapterResult,
} from "../../adapter-result.ts";
import {
  runIsolatedNative,
  type NativeCommandOutput,
} from "../../harness-command-result.ts";
import type { PiPaths } from "./paths.ts";
import {
  BOUNDED_EXECUTABLE,
  runValidator as runBoundedCommand,
} from "../../validator.ts";

export async function runPi(
  args: readonly string[],
  paths: PiPaths,
  ctx: AdapterContext,
  execute: typeof runBoundedCommand = runBoundedCommand,
): Promise<AdapterResult<NativeCommandOutput>> {
  return await runIsolatedNative(
    "Pi",
    (ctx.env ?? {}).SUPERPOWERS_PI || "pi",
    ctx,
    async (executable, workspace, env) =>
      await execute(
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
      ),
  );
}

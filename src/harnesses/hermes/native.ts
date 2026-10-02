import type { AdapterContext, AdapterResult } from "../../adapter-result.ts";
import {
  runIsolatedNative,
  type NativeCommandOutput,
} from "../../harness-command-result.ts";
import { BOUNDED_EXECUTABLE, runValidator } from "../../validator.ts";
import { hermesPaths } from "./paths.ts";

export type RunHermes = (
  args: readonly string[],
  ctx: AdapterContext,
) => Promise<AdapterResult<NativeCommandOutput>>;

export async function runHermes(
  args: readonly string[],
  ctx: AdapterContext,
  execute: typeof runValidator = runValidator,
): Promise<AdapterResult<NativeCommandOutput>> {
  return await runIsolatedNative(
    "Hermes",
    (ctx.env ?? {}).SUPERPOWERS_HERMES || "hermes",
    ctx,
    async (executable, workspace, env, invocationCwd) =>
      await execute(
        [executable, ...args],
        BOUNDED_EXECUTABLE,
        { ...env, HERMES_HOME: hermesPaths(env, invocationCwd).hermesHome },
        workspace,
        invocationCwd,
      ),
  );
}

import { basename, dirname } from "node:path";
import {
  failureResult,
  type AdapterContext,
  type AdapterResult,
} from "../../adapter-result.ts";
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
  const invalidHome = () =>
    failureResult(
      "hermes-command",
      "invalid-home",
      "cannot resolve HERMES_HOME for Hermes command",
      [],
      [],
    );
  let home: string;
  try {
    home = hermesPaths(ctx.env ?? {}, process.cwd()).hermesHome;
  } catch {
    return invalidHome();
  }
  let homeChanged = false;
  const result = await runIsolatedNative(
    "Hermes",
    (ctx.env ?? {}).SUPERPOWERS_HERMES || "hermes",
    ctx,
    async (executable, workspace, env, invocationCwd) => {
      const childEnv = {
        ...process.env,
        ...env,
        HERMES_HOME: home,
        TMPDIR: workspace,
      };
      try {
        if (hermesPaths(childEnv, invocationCwd).hermesHome !== home)
          throw new Error("cannot resolve HERMES_HOME: child home changed");
      } catch {
        homeChanged = true;
        throw new Error("cannot resolve HERMES_HOME for Hermes command");
      }
      return await execute(
        [
          executable,
          ...(basename(dirname(home)) === "profiles"
            ? []
            : ["--profile", "default"]),
          ...args,
        ],
        BOUNDED_EXECUTABLE,
        childEnv,
        workspace,
        invocationCwd,
      );
    },
  );
  return homeChanged ? invalidHome() : result;
}

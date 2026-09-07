import { computeEffectiveSelection } from "../effective-selection.ts";
import { upstreamCacheRoot } from "../upstream-workspace.ts";
import type { CommandContext } from "./context.ts";
import { SafetyError } from "../safety-error.ts";
import { isAbsolute } from "node:path";

export type MutationCommand = "prepare" | "install" | "update" | "uninstall";

export async function withMutation<R>(
  command: MutationCommand,
  ctx: CommandContext<R>,
  action: (scoped: CommandContext<R>) => Promise<number>,
): Promise<number> {
  // Selection validation precedes every adapter call and lock creation. A
  // nested mutation receives the already resolved value and cannot observe a
  // saved-selection change midway through one invocation.
  const selection =
    command === "uninstall"
      ? ctx.selection
      : (ctx.selection ?? (await computeEffectiveSelection(ctx.root, ctx.env)));
  const scoped =
    selection === undefined ? ctx : ({ ...ctx, selection } as const);
  const adapterContext = { root: ctx.root, env: ctx.env };
  let location;
  try {
    location = ctx.adapter.preparationLocation(adapterContext);
  } catch (cause) {
    throw new SafetyError("mutation", "cannot determine preparation location", {
      cause,
    });
  }
  if (!isAbsolute(location.destinationRoot))
    throw new SafetyError(
      "mutation",
      "adapter returned a non-absolute preparation destination",
    );
  if (
    !location.stagingLeaf ||
    location.stagingLeaf === "." ||
    location.stagingLeaf === ".." ||
    location.stagingLeaf.includes("/") ||
    location.stagingLeaf.includes("\\")
  )
    throw new SafetyError(
      "mutation",
      "adapter returned an invalid preparation staging leaf",
    );
  let mutationRoots;
  try {
    mutationRoots = await ctx.adapter.mutationRoots(adapterContext);
    if (
      !Array.isArray(mutationRoots) ||
      mutationRoots.some(
        (root) => typeof root !== "string" || !isAbsolute(root),
      )
    )
      throw new Error("invalid roots");
  } catch (cause) {
    throw new SafetyError(
      "mutation",
      "cannot determine harness mutation resources",
      { cause },
    );
  }
  const resources = [location.destinationRoot, ...mutationRoots];
  if (command === "prepare") {
    resources.push(upstreamCacheRoot(ctx.root, ctx.env, process.cwd()));
  }

  // The coordinator sorts each acquisition and refuses conflicts immediately.
  // A nested prepare may add a cache lock that sorts before an outer target;
  // it cannot deadlock because no acquisition waits, while already-held roots
  // are reentrant for this invocation.
  return await ctx.coordination.withResources(resources, async () =>
    action(scoped),
  );
}

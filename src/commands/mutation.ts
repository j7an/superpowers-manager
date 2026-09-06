import { computeEffectiveSelection } from "../effective-selection.ts";
import { upstreamCacheRoot } from "../upstream-workspace.ts";
import type { CommandContext } from "./context.ts";

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
  const location = ctx.adapter.preparationLocation(adapterContext);
  const mutationRoots = await ctx.adapter.mutationRoots(adapterContext);
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

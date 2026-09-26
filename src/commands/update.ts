// Update delegates adapter calls to probe, prepare, and install. Those
// mutating commands own their workspaces, so update opens none itself.
import type { CommandContext } from "./context.ts";
import { writeOutput } from "./adapter-call.ts";
import { runInstall } from "./install.ts";
import { probeFacts } from "./probe.ts";
import { runPrepare } from "./prepare.ts";
import { runWithMutation } from "./mutation.ts";

export async function runUpdate<R>(
  argv: readonly string[],
  ctx: CommandContext<R>,
): Promise<number> {
  // argv is ignored: scripts/update never reads "$@".
  return await runWithMutation("update", ctx, async (scoped) =>
    performUpdate(scoped),
  );
}

async function performUpdate<R>(ctx: CommandContext<R>): Promise<number> {
  const facts = await probeFacts(ctx);
  if (facts === null) return 1;

  if (facts.ownership.installEligibility.kind === "blocked") {
    writeOutput(facts.ownership.installEligibility.output, ctx);
    return 1;
  }
  if (facts.control.probeEligibility.kind === "blocked") {
    writeOutput(facts.control.probeEligibility.output, ctx);
    return 1;
  }

  switch (facts.status) {
    case "current": {
      if (facts.control.mutationEligibility.kind === "blocked") {
        writeOutput(facts.control.mutationEligibility.output, ctx);
        return 1;
      }
      const rendered = ctx.adapter.presentation.renderProbe(facts);
      ctx.stdout.write(rendered.porcelain);
      ctx.stdout.write(`${ctx.adapter.presentation.currentNotice}\n`);
      return 0;
    }
    case "needs prepare": {
      const prepareStatus = await runPrepare([], ctx);
      if (prepareStatus !== 0) return prepareStatus;
      return await runInstall([], ctx);
    }
    case "needs install":
      return await runInstall([], ctx);
  }
}

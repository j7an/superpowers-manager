// Update delegates adapter calls to probe, prepare, and install. Those
// mutating commands own their workspaces, so update opens none itself.
import { oneLine } from "../cli-arguments.ts";
import type { CommandContext } from "./context.ts";
import { runInstall, writeOutput } from "./install.ts";
import { gatherProbe, replayOutcome } from "./probe.ts";
import { runPrepare } from "./prepare.ts";
import { runWithMutation } from "./mutation.ts";

export async function runUpdate<R>(
  argv: readonly string[],
  ctx: CommandContext<R>,
): Promise<number> {
  return await runWithMutation("update", ctx, async (scoped) =>
    performUpdate(argv, scoped),
  );
}

async function performUpdate<R>(
  argv: readonly string[],
  ctx: CommandContext<R>,
): Promise<number> {
  // scripts/update never reads "$@", so extra arguments are silently
  // ignored -- the same asymmetry runPrepare and runInstall document.
  void argv;

  let probe: Awaited<ReturnType<typeof gatherProbe<R>>>;
  try {
    probe = await gatherProbe(ctx);
  } catch (cause) {
    // Gathering does not write, so this catch cannot misclassify an output
    // failure. oneLine() bounds any inherited diagnostic to one line.
    ctx.stderr.write(`error: ${oneLine(cause)}\n`);
    return 1;
  }
  // Replay first, on both paths, before any decision -- clause 1.
  for (const outcome of probe.outcomes) replayOutcome(outcome, ctx);
  if (probe.status === 1) {
    if (probe.message !== null) {
      ctx.stderr.write(`error: ${probe.message}\n`);
    }
    return 1;
  }
  const facts = probe.facts;

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

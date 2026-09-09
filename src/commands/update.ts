// Ports scripts/update. The shell sourced common.sh and lifecycle.sh; the
// predicates now live in src/harnesses/codex/lifecycle.ts. Unlike install and uninstall,
// update issues no ctx.adapter call of its own: every adapter interaction
// this module needs already happens inside gatherProbe, runPrepare or
// runInstall, each of which owns its own §4.2a-conformant invoke() gate. That
// is also why update opens no temporary workspace of its own -- there is no
// mutation here for one to protect.
import { oneLine } from "../cli-arguments.ts";
import type { Output } from "../harness.ts";
import type { CommandContext } from "./context.ts";
import { gatherProbe, replayOutcome } from "./probe.ts";
import { runInstall } from "./install.ts";
import { runPrepare } from "./prepare.ts";
import { runWithMutation } from "./mutation.ts";

function writeOutput(
  output: Output,
  ctx: Pick<CommandContext<never>, "stdout" | "stderr">,
): void {
  for (const line of output.stdout) ctx.stdout.write(`${line}\n`);
  for (const line of output.stderr) ctx.stderr.write(`${line}\n`);
}

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
    // gatherProbe performs no writes of its own (src/commands/probe.ts), so
    // this catch cannot also be reached by an EPIPE from update's own
    // output -- update writes nothing before this call resolves, unlike
    // install's NOTE line.
    //
    // This is a THIRD consumer of gatherProbe's throw channel --
    // `src/commands/probe.ts:469-527::THREE exceptions, all inherited and none a regression:`'s
    // runProbe catch is the first and src/commands/install.ts's runInstall catch
    // is the second. Because all three wrap the identical function, runProbe's
    // long comment there enumerates exactly what can reach this stream too; not
    // repeated here.
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

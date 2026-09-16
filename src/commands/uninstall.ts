import { tmpdir } from "node:os";
import type { AdapterOutcome, AdapterResult } from "../adapter-result.ts";
import { oneLine } from "../cli-arguments.ts";
import type { Output } from "../harness.ts";
import { withWorkspace, workspaceRemovalFailure } from "../workspace.ts";
import type { CommandContext } from "./context.ts";
import {
  GatherFailure,
  callAdapter,
  type AdapterCall,
} from "./adapter-call.ts";
import { runWithMutation } from "./mutation.ts";
import { replayOutcome } from "./probe.ts";

async function invoke<T>(
  call: () => Promise<AdapterResult<T>>,
  failure: { readonly unexpected: string; readonly invalidStatus: string },
  outcomes: AdapterOutcome<unknown>[],
): Promise<AdapterCall<T>> {
  const result = await callAdapter(call, failure);
  if (result.result !== null) outcomes.push(result.result.outcome);
  return result;
}

type UninstallOutcome =
  | {
      readonly status: 1;
      readonly outcomes: readonly AdapterOutcome<unknown>[];
      readonly message: string | null;
      readonly output: Output | null;
    }
  | {
      readonly status: 0;
      readonly outcomes: readonly AdapterOutcome<unknown>[];
      readonly output: Output;
    };

// Carries a post-success workspace-removal failure without discarding the
// outcome the callback already computed. Cleanup failures remain fail closed.
interface GatherRun {
  readonly outcome: UninstallOutcome;
  readonly cleanupWarning: string | null;
}

// Collect outcomes without writing so output failures cannot be classified as
// inspection failures. Replay collected outcomes after gathering completes.
async function gatherUninstall<R>(ctx: CommandContext<R>): Promise<GatherRun> {
  const parent = ctx.env.TMPDIR ?? tmpdir();
  // Kept outside the workspace callback so a workspace failure preserves every
  // outcome collected before it.
  const outcomes: AdapterOutcome<unknown>[] = [];
  let cleanupWarning: string | null = null;
  try {
    const outcome = await withWorkspace(
      parent,
      "superpowers-manager.uninstall.",
      async (workspace): Promise<UninstallOutcome> => {
        const env = { ...ctx.env, TMPDIR: workspace };
        const failed = (message: string | null): UninstallOutcome => ({
          status: 1,
          outcomes,
          message,
          output: null,
        });
        const adapterContext = { root: ctx.root, env };

        // Stage 1: inspect ownership, before removal.
        const beforeFailure = ctx.adapter.presentation.callFailure(
          "remove-ownership",
          adapterContext,
        );
        const before = await invoke(
          () => ctx.adapter.inspectOwnership(adapterContext),
          beforeFailure,
          outcomes,
        );
        if (!before.ok) return failed(before.message);

        // Stage 2: remove, passing the private input through untouched.
        const removalInput = before.result.outcome.result.removalInput;
        const removeFailure = ctx.adapter.presentation.callFailure(
          "remove",
          adapterContext,
          removalInput,
        );
        const removed = await invoke(
          () => ctx.adapter.remove(removalInput, adapterContext),
          removeFailure,
          outcomes,
        );
        if (!removed.ok) return failed(removed.message);

        // Stage 3: inspect ownership again. Everything below reads this
        // post-removal state, not the inspection before removal.
        const afterFailure = ctx.adapter.presentation.callFailure(
          "post-remove",
          adapterContext,
        );
        const after = await invoke(
          () => ctx.adapter.inspectOwnership(adapterContext),
          afterFailure,
          outcomes,
        );
        if (!after.ok) return failed(after.message);
        const ownership = after.result.outcome.result;
        if (ownership.removalVerification.kind === "blocked") {
          return {
            status: 1,
            outcomes,
            message: null,
            output: ownership.removalVerification.output,
          };
        }
        return {
          status: 0,
          outcomes,
          output: ctx.adapter.presentation.renderRemovalCompletion(
            ownership,
            removalInput,
          ),
        };
      },
      {
        // Suppresses withWorkspace's throw on a POST-SUCCESS cleanup failure,
        // so the UninstallOutcome the callback already computed still comes
        // back as `outcome` instead of being discarded. Runs synchronously,
        // as the option requires (src/workspace.ts).
        onCleanupFailure: (path) => {
          cleanupWarning = workspaceRemovalFailure(path);
        },
      },
    );
    return { outcome, cleanupWarning };
  } catch (cause) {
    // Reachable only for mkdtemp failure, with nothing collected yet: this
    // callback never throws -- every ctx.adapter throw is already caught
    // inside invoke(), and presenceFlag/
    // reportLegacyState are pure (src/harnesses/codex/lifecycle.ts's header comment) -- so a
    // post-success cleanup failure is handled by onCleanupFailure above and
    // cannot reach here. Wrapping with `outcomes` anyway keeps the class
    // total over its declared contract rather than assuming the callback's
    // purity at the throw site.
    throw new GatherFailure("uninstall gather failed", cause, outcomes);
  }
}

export async function runUninstall<R>(
  argv: readonly string[],
  ctx: CommandContext<R>,
): Promise<number> {
  return await runWithMutation("uninstall", ctx, async (scoped) =>
    performUninstall(argv, scoped),
  );
}

async function performUninstall<R>(
  argv: readonly string[],
  ctx: CommandContext<R>,
): Promise<number> {
  // scripts/uninstall never reads "$@", so extra arguments are silently
  // ignored -- the same asymmetry runPrepare documents at its own
  // `void argv;`.
  void argv;
  let run: GatherRun;
  try {
    run = await gatherUninstall(ctx);
  } catch (cause) {
    // Replay collected outcomes before reporting a gather failure. The
    // cleanup reporter retains post-success cleanup failures as data.
    const outcomes =
      cause instanceof GatherFailure ? cause.outcomes : ([] as const);
    for (const outcome of outcomes) replayOutcome(outcome, ctx);
    const inner = cause instanceof GatherFailure ? cause.inner : cause;
    ctx.stderr.write(`error: ${oneLine(inner)}\n`);
    return 1;
  }
  const { outcome, cleanupWarning } = run;
  // Replay before reporting a command-level result on either path.
  for (const each of outcome.outcomes) replayOutcome(each, ctx);
  let status: number;
  if (outcome.status === 1) {
    // null means replayOutcome already emitted the adapter's own error:
    // and hint: lines for the failing outcome.
    if (outcome.message !== null) {
      ctx.stderr.write(`error: ${outcome.message}\n`);
    }
    if (outcome.output !== null) {
      for (const line of outcome.output.stdout) ctx.stdout.write(`${line}\n`);
      for (const line of outcome.output.stderr) ctx.stderr.write(`${line}\n`);
    }
    status = 1;
  } else {
    for (const line of outcome.output.stdout) ctx.stdout.write(`${line}\n`);
    for (const line of outcome.output.stderr) ctx.stderr.write(`${line}\n`);
    status = 0;
  }
  if (cleanupWarning !== null) {
    // Mirrors src/commands/install.ts's closing arm. A leaked workspace is
    // reported even when the domain outcome above was a success: the
    // uninstall and its verification already completed against the adapter
    // before cleanup ran, so it is not being reported as unverified -- but
    // something did still go wrong, and AGENTS.md's fail-closed rule extends
    // to it. The operator keeps "uninstall complete", which is the one line
    // telling them whether the removal they asked for happened.
    ctx.stderr.write(`error: ${cleanupWarning}\n`);
    return 1;
  }
  return status;
}

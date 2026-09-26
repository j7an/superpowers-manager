import { isDeepStrictEqual } from "node:util";
import type { AdapterOutcome, AdapterResult } from "../adapter-result.ts";
import {
  assertFailureWritable,
  writeAdapterFailure,
} from "../adapter-result.ts";
import { oneLine } from "../cli-arguments.ts";
import { computeEffectiveSelection } from "../effective-selection.ts";
import type {
  FailureSite,
  ProbeSnapshot,
  UpdateControlInspection,
} from "../harness.ts";
import type { CommandContext } from "./context.ts";
import { callAdapter, type AdapterCall } from "./adapter-call.ts";

export const PROBE_USAGE =
  "error: usage: superpowers-manager probe [--porcelain]\n";

// Replay adapter messages in order on their declared streams. Adapter failures
// are emitted only after terminal-safety validation. This writes to ctx, so it
// must run after gathering, outside a gather function's failure handling.
export function replayOutcome(
  outcome: AdapterOutcome<unknown>,
  ctx: Pick<CommandContext<never>, "stdout" | "stderr">,
): void {
  // Hoisted ABOVE the message loop, and that ordering is the point: a failure
  // whose code, message, or a hint carries a terminal control character must
  // leave both streams untouched, not the context lines followed by nothing.
  // Returns immediately on a succeeding outcome.
  assertFailureWritable(outcome);
  for (const message of outcome.messages) {
    const stream = message.channel === "stdout" ? ctx.stdout : ctx.stderr;
    stream.write(`${message.text}\n`);
  }
  // The message loop stays unguarded on purpose: D8b scopes the check to code,
  // message, and hints, and AdapterMessageLog escapes message text before it is
  // stored, so scanning it here would re-check a population that cannot fail.
  writeAdapterFailure(ctx, outcome);
}

function coherentControl(value: UpdateControlInspection): boolean {
  return (
    value.recoveryState !== "required" ||
    (value.probeEligibility.kind === "blocked" &&
      value.mutationEligibility.kind === "blocked")
  );
}

type ProbeOutcome<R> =
  | {
      readonly status: 1;
      readonly outcomes: readonly AdapterOutcome<unknown>[];
      readonly message: string | null;
    }
  | {
      readonly status: 0;
      readonly outcomes: readonly AdapterOutcome<unknown>[];
      readonly facts: ProbeSnapshot<R>;
    };

// Collect outcomes without writing so output failures cannot be classified as
// inspection failures. Replay collected outcomes after gathering completes.
export async function gatherProbe<R>(
  ctx: CommandContext<R>,
): Promise<ProbeOutcome<R>> {
  const selection =
    ctx.selection ?? (await computeEffectiveSelection(ctx.root, ctx.env));
  const outcomes: AdapterOutcome<unknown>[] = [];
  const adapterContext = { root: ctx.root, env: ctx.env };
  let resources: readonly string[] | null;
  try {
    resources = [
      ctx.adapter.preparationLocation(adapterContext).destinationRoot,
      ...(await ctx.adapter.mutationRoots(adapterContext)),
    ];
  } catch {
    resources = null;
  }
  const before =
    resources === null
      ? []
      : await ctx.coordination.observeResources(resources);
  const collect = async <T>(
    call: () => Promise<AdapterResult<T>>,
    unexpected: string,
    invalidStatus: string,
    acceptValue?: (value: T) => boolean,
    replaySuccess = true,
  ): Promise<AdapterCall<T>> => {
    let result = await callAdapter(call, { unexpected, invalidStatus });
    if (result.ok && acceptValue !== undefined) {
      try {
        if (!acceptValue(result.result.outcome.result))
          result = { ok: false, result: result.result, message: invalidStatus };
      } catch {
        result = { ok: false, result: result.result, message: invalidStatus };
      }
    }
    if (result.result !== null && (replaySuccess || !result.result.outcome.ok))
      outcomes.push(result.result.outcome);
    return result;
  };

  const prepared = await collect(
    () => ctx.adapter.inspectPrepared(selection, adapterContext),
    "cannot inspect prepared harness state",
    "adapter reported a failure status for prepared harness inspection",
  );
  if (!prepared.ok) {
    return { status: 1, outcomes, message: prepared.message };
  }
  const failure = (site: FailureSite) =>
    ctx.adapter.presentation.callFailure(site, adapterContext);
  const installedFailure = failure("probe-installed");
  const installed = await collect(
    () => ctx.adapter.inspectInstalled(selection, adapterContext),
    installedFailure.unexpected,
    installedFailure.invalidStatus,
  );
  if (!installed.ok) {
    return { status: 1, outcomes, message: installed.message };
  }
  if (resources === null)
    return {
      status: 1,
      outcomes,
      message: "cannot determine harness observation resources",
    };
  const ownershipFailure = failure("probe-ownership");
  const ownership = await collect(
    () => ctx.adapter.inspectOwnership(adapterContext),
    ownershipFailure.unexpected,
    ownershipFailure.invalidStatus,
  );
  if (!ownership.ok) {
    return { status: 1, outcomes, message: ownership.message };
  }
  const controlFailure = failure("probe-control");
  const control = await collect(
    () => ctx.adapter.inspectUpdateControl(adapterContext),
    controlFailure.unexpected,
    controlFailure.invalidStatus,
    coherentControl,
  );
  if (!control.ok) {
    return { status: 1, outcomes, message: control.message };
  }

  const preparedAfter = await collect(
    () => ctx.adapter.inspectPrepared(selection, adapterContext),
    "cannot inspect prepared harness state",
    "adapter reported a failure status for prepared harness inspection",
    undefined,
    false,
  );
  if (!preparedAfter.ok)
    return { status: 1, outcomes, message: preparedAfter.message };
  const installedAfter = await collect(
    () => ctx.adapter.inspectInstalled(selection, adapterContext),
    installedFailure.unexpected,
    installedFailure.invalidStatus,
    undefined,
    false,
  );
  if (!installedAfter.ok)
    return { status: 1, outcomes, message: installedAfter.message };
  const controlAfter = await collect(
    () => ctx.adapter.inspectUpdateControl(adapterContext),
    controlFailure.unexpected,
    controlFailure.invalidStatus,
    coherentControl,
    false,
  );
  if (!controlAfter.ok)
    return { status: 1, outcomes, message: controlAfter.message };
  const after = await ctx.coordination.observeResources(resources);
  if (
    !isDeepStrictEqual(
      [
        before,
        prepared.result.outcome.result,
        installed.result.outcome.result,
        control.result.outcome.result,
      ],
      [
        after,
        preparedAfter.result.outcome.result,
        installedAfter.result.outcome.result,
        controlAfter.result.outcome.result,
      ],
    )
  ) {
    return {
      status: 1,
      outcomes,
      message:
        "harness state changed during observation; retry for a coherent probe",
    };
  }
  const unavailable = after.find(
    (observation) =>
      observation.state === "busy" || observation.state === "uninspectable",
  );
  if (unavailable)
    return {
      status: 1,
      outcomes,
      message: `harness resource is ${unavailable.state}: ${unavailable.resource}`,
    };

  const preparedState = prepared.result.outcome.result;
  const installedState = installed.result.outcome.result;
  return {
    status: 0,
    outcomes,
    facts: {
      selection,
      prepared: preparedState,
      installed: installedState,
      ownership: ownership.result.outcome.result,
      control: control.result.outcome.result,
      compatibility: preparedState.compatibility,
      resourceState:
        control.result.outcome.result.recoveryState === "required"
          ? "recovery-required"
          : after.some((observation) => observation.state === "owned")
            ? "owned"
            : "idle",
      status:
        preparedState.kind !== "current"
          ? "needs prepare"
          : installedState.kind !== "current"
            ? "needs install"
            : "current",
    },
  };
}

// Runs the probe and reports a failed gather the way every probing command
// does: `error:` for a throw, replay of every collected outcome, then the
// command-level message. null means the caller must return 1.
export async function probeFacts<R>(
  ctx: CommandContext<R>,
): Promise<ProbeSnapshot<R> | null> {
  let outcome: ProbeOutcome<R>;
  try {
    outcome = await gatherProbe(ctx);
  } catch (cause) {
    // Reader wrappers supply their own diagnostics. The saved-selection read
    // path retains its sanctioned interpolation at
    // `src/selection-store.ts:116-121::if (cause instanceof SafetyError && cause.module === "selection") {`.
    // oneLine() bounds any inherited git or filesystem diagnostic to one line.
    ctx.stderr.write(`error: ${oneLine(cause)}\n`);
    return null;
  }
  // Replay before reporting a command-level result on either path.
  for (const each of outcome.outcomes) replayOutcome(each, ctx);
  if (outcome.status === 1) {
    // null means replayOutcome already emitted the adapter's own `error:`
    // and `hint:` lines for the failing outcome.
    if (outcome.message !== null) {
      ctx.stderr.write(`error: ${outcome.message}\n`);
    }
    return null;
  }
  return outcome.facts;
}

export async function runProbe<R>(
  argv: readonly string[],
  ctx: CommandContext<R>,
): Promise<number> {
  // The CLI parser rejects these inputs first. Keep this guard for direct
  // in-process callers, which do not necessarily pass through that parser.
  const porcelain = argv.length === 1 && argv[0] === "--porcelain";
  if (!porcelain && argv.length !== 0) {
    ctx.stderr.write(PROBE_USAGE);
    return 2;
  }
  const facts = await probeFacts(ctx);
  if (facts === null) return 1;
  const rendered = ctx.adapter.presentation.renderProbe(facts);
  ctx.stdout.write(porcelain ? rendered.porcelain : rendered.human);
  return facts.resourceState === "recovery-required" ? 1 : 0;
}

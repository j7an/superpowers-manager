// Ports scripts/install. The shell sourced common.sh, provenance.sh,
// status.sh, lifecycle.sh and adapter.sh; the predicates now live in
// src/lifecycle.ts, the generated-metadata read lives in src/provenance.ts,
// and the adapter arrives through ctx.adapter.
import { tmpdir } from "node:os";
import type { AdapterOutcome, AdapterResult } from "../adapter-result.ts";
import { oneLine } from "../cli-arguments.ts";
import type { EffectiveSelection } from "../effective-selection.ts";
import type {
  Output,
  PreparedArtifact,
  InstalledState,
  InstallReceipt,
  InstallTransaction,
} from "../harness.ts";
import { withWorkspace, workspaceRemovalFailure } from "../workspace.ts";
import type { CommandContext } from "./context.ts";
import { gatherProbe, replayOutcome } from "./probe.ts";
import { runPrepare } from "./prepare.ts";
import { withMutation } from "./mutation.ts";
import { activationBlock } from "../harness-compatibility.ts";

function writeOutput(
  output: Output,
  ctx: Pick<CommandContext<never>, "stdout" | "stderr">,
): void {
  for (const line of output.stdout) ctx.stdout.write(`${line}\n`);
  for (const line of output.stderr) ctx.stderr.write(`${line}\n`);
}

type StageResult<T> =
  | {
      readonly ok: true;
      readonly result: {
        readonly status: 0;
        readonly outcome: Extract<AdapterOutcome<T>, { readonly ok: true }>;
      };
    }
  | {
      readonly ok: false;
      readonly message: string | null;
      readonly result: AdapterResult<T> | null;
    };

async function invoke<T>(
  call: () => Promise<AdapterResult<T>>,
  failure: { readonly unexpected: string; readonly invalidStatus: string },
  outcomes: AdapterOutcome<unknown>[],
  valid: (value: T) => boolean = () => true,
): Promise<StageResult<T>> {
  let result: AdapterResult<T>;
  try {
    result = await call();
    if (
      !result ||
      !Number.isInteger(result.status) ||
      !result.outcome ||
      typeof result.outcome.ok !== "boolean" ||
      typeof result.outcome.operation !== "string" ||
      !Array.isArray(result.outcome.messages) ||
      !result.outcome.messages.every(
        (message) =>
          message &&
          (message.channel === "stdout" || message.channel === "stderr") &&
          typeof message.text === "string",
      ) ||
      (result.outcome.ok
        ? result.outcome.error !== null || !valid(result.outcome.result)
        : !result.outcome.error ||
          typeof result.outcome.error.code !== "string" ||
          typeof result.outcome.error.message !== "string" ||
          !Array.isArray(result.outcome.error.hints) ||
          !result.outcome.error.hints.every((hint) => typeof hint === "string"))
    ) {
      return { ok: false, message: failure.invalidStatus, result: null };
    }
  } catch {
    return { ok: false, message: failure.unexpected, result: null };
  }
  outcomes.push(result.outcome);
  const outcome = result.outcome;
  if (result.status !== 0 || !outcome.ok) {
    return {
      ok: false,
      message: outcome.ok ? failure.invalidStatus : null,
      result,
    };
  }
  return {
    ok: true,
    result: { status: result.status, outcome },
  };
}

function validInstalled(value: InstalledState): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    (value.kind === "current" ||
      value.kind === "mismatch" ||
      value.kind === "absent") &&
    typeof value.observedIdentity === "string" &&
    (value.kind !== "absent" || value.observedIdentity === "")
  );
}

function validOutput(value: Output): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    Array.isArray(value.stdout) &&
    value.stdout.every((line) => typeof line === "string") &&
    Array.isArray(value.stderr) &&
    value.stderr.every((line) => typeof line === "string")
  );
}

function validReceipt(value: InstallReceipt): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    validOutput(value.missingVerificationOutput) &&
    validOutput(value.mismatchVerificationOutput)
  );
}

// withWorkspace can throw AFTER its callback has already returned a fully
// computed StageOutcome: a post-success cleanup failure discards that return
// value entirely and rejects instead, UNLESS an `onCleanupFailure` reporter is
// supplied -- which gatherInstallStages below does, precisely so this class
// stays reserved for mkdtemp failure (nothing collected yet) and the
// callback's own throw (never reachable here; see gatherInstallStages).
// Carries the outcomes collected so far so runInstall's catch can still
// replay them instead of discarding them with a bare re-throw. Same shape as
// src/commands/uninstall.ts's GatherFailure, duplicated for the same reason
// invoke() is: no shared dependency between the two modules.
class GatherFailure extends Error {
  readonly inner: unknown;
  readonly outcomes: readonly AdapterOutcome<unknown>[];

  constructor(inner: unknown, outcomes: readonly AdapterOutcome<unknown>[]) {
    super("install gather failed");
    this.inner = inner;
    this.outcomes = outcomes;
  }
}

type StageOutcome =
  | {
      readonly kind: "blocked";
      readonly outcomes: readonly AdapterOutcome<unknown>[];
      readonly output: Output;
    }
  | {
      readonly kind: "failed";
      readonly outcomes: readonly AdapterOutcome<unknown>[];
      // null means replayOutcome already emitted the adapter's own error:
      // and hint: lines for the failing outcome.
      readonly message: string | null;
    }
  | {
      readonly kind: "verified";
      readonly outcomes: readonly AdapterOutcome<unknown>[];
      readonly status: 0 | 1;
      readonly stdout: readonly string[];
      readonly stderr: readonly string[];
    };

interface StageRun {
  readonly outcome: StageOutcome;
  // Carries a post-success workspace-removal failure WITHOUT discarding the
  // outcome the callback already computed. See the header comment on
  // withWorkspace's onCleanupFailure option (src/workspace.ts).
  //
  // The precondition is that this callback never throws: invoke() catches
  // every ctx.adapter failure and every predicate here is pure, so the only
  // way withWorkspace's cleanup failure can collide with a real outcome is
  // the post-SUCCESS case this option exists to catch -- there is no
  // "callback also failed" case to lose the message to.
  //
  // An earlier draft offered that precondition as the reason install's shape
  // "lets this go further than src/commands/uninstall.ts's GatherFailure
  // does". It does not discriminate: uninstall's callback asserts and holds
  // the same property, so uninstall now carries the identical GatherRun
  // retrofit rather than dropping its closing lines. The two modules agree.
  readonly cleanupWarning: string | null;
}

// `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/install:44-58::TMPDIR=`, wrapped in the temporary workspace scripts/install
// created via spw_make_workspace + spw_install_workspace_trap. Performs no
// writes of its own -- same EPIPE-avoidance shape as gatherProbe and
// src/commands/uninstall.ts's gatherUninstall.
async function gatherInstallStages<R>(
  ctx: CommandContext<R>,
  selection: EffectiveSelection,
  artifact: PreparedArtifact,
): Promise<StageRun> {
  // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/install:38::tmp_parent=` -- ${TMPDIR:-/tmp}. Matches
  // src/commands/uninstall.ts's gatherUninstall.
  const parent = ctx.env.TMPDIR ?? tmpdir();
  const outcomes: AdapterOutcome<unknown>[] = [];
  let cleanupWarning: string | null = null;
  try {
    const outcome = await withWorkspace(
      parent,
      "superpowers-manager.install.",
      async (workspace): Promise<StageOutcome> => {
        const env = { ...ctx.env, TMPDIR: workspace };
        const failed = (message: string | null): StageOutcome => ({
          kind: "failed",
          outcomes,
          message,
        });
        const adapterContext = { root: ctx.root, env };

        // Stage 1: inspect ownership, re-checked even though gatherProbe just
        // reported it. Mutation authority requires CURRENT, VALIDATED
        // evidence -- a probe's answer is neither by the time this runs.
        const ownershipFailure = ctx.adapter.presentation.callFailure(
          "install-ownership",
          adapterContext,
        );
        const ownership = await invoke(
          () => ctx.adapter.inspectOwnership(adapterContext),
          ownershipFailure,
          outcomes,
        );
        if (!ownership.ok) return failed(ownership.message);
        const ownershipDecision =
          ownership.result.outcome.result.installEligibility;
        if (ownershipDecision.kind === "blocked") {
          return {
            kind: "blocked",
            outcomes,
            output: ownershipDecision.output,
          };
        }

        // Stage 2: inspect update-control, re-checked for the same reason.
        const controlFailure = ctx.adapter.presentation.callFailure(
          "install-control",
          adapterContext,
        );
        const control = await invoke(
          () => ctx.adapter.inspectUpdateControl(adapterContext),
          controlFailure,
          outcomes,
        );
        if (!control.ok) return failed(control.message);
        const mutationDecision =
          control.result.outcome.result.mutationEligibility;
        if (mutationDecision.kind === "blocked") {
          return {
            kind: "blocked",
            outcomes,
            output: mutationDecision.output,
          };
        }

        // Stage 3: the mutation itself. Nothing above may have issued this --
        // that is the whole point of stages 1 and 2 running first.
        const activationFailure = activationBlock(
          artifact.compatibility,
          ctx.options.allowExperimental,
        );
        if (activationFailure !== null) return failed(activationFailure);
        const installFailure = ctx.adapter.presentation.callFailure(
          "install",
          adapterContext,
        );
        const install = await invoke(
          () => ctx.adapter.install(artifact, adapterContext),
          installFailure,
          outcomes,
          validReceipt,
        );
        if (!install.ok) return failed(install.message);
        let transaction: InstallTransaction | undefined;
        try {
          const candidate = install.result.outcome.result.transaction;
          if (candidate !== undefined) {
            if (candidate === null || typeof candidate !== "object")
              throw new Error("invalid transaction");
            const finalize = candidate.finalize.bind(candidate);
            const rollback = candidate.rollback.bind(candidate);
            if (
              typeof finalize !== "function" ||
              typeof rollback !== "function"
            )
              throw new Error("invalid transaction");
            transaction = { finalize, rollback };
          }
        } catch {
          return failed(
            "invalid installation transaction receipt; preserve recovery material for manual resolution",
          );
        }

        // Stage 4: inspect fingerprint, to verify the mutation actually took.
        //
        // Deliberately NOT short-circuited on `!inspected.ok`, unlike stages
        // 1-3. `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/install:57::spw_verify_installed_fingerprint` handed the inspect result to
        // spw_verify_installed_fingerprint whatever it contained, and that
        // function's first guard, from
        // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/lifecycle.sh:91-94::spw_inspect_fingerprint`,
        // is what turns a failed inspection into "error: installed manager
        // fingerprint inspection failed after install."
        // renderInstallVerification's failed-inspection arm
        // (`src/codex-presentation.ts:328::if (inspection.status !== 0 || !inspection.outcome.ok) {`)
        // exists for this result-bearing path; the lifecycle compatibility
        // export delegates through the same arm. Returning
        // failed() instead reported the adapter's own generic diagnostic and
        // dropped the post-install verification claim -- a mutation had
        // already been issued at stage 3,
        // so "the install could not be verified" is the contract, not "an
        // adapter call failed". A ctx.adapter THROW has no result to render.
        // A pending transaction still rolls back before reporting that failure.
        const inspectionFailure = ctx.adapter.presentation.callFailure(
          "post-install",
          adapterContext,
        );
        const inspected = await invoke(
          () => ctx.adapter.inspectInstalled(selection, adapterContext),
          inspectionFailure,
          outcomes,
          validInstalled,
        );
        const inspection = inspected.result;
        const verified =
          inspection !== null &&
          inspection.status === 0 &&
          inspection.outcome.ok &&
          inspection.outcome.result.kind === "current";
        if (transaction !== undefined) {
          const operation = verified ? "finalize" : "rollback";
          const settlement = await invoke(
            () => (verified ? transaction.finalize() : transaction.rollback()),
            {
              unexpected: `installation ${operation} did not complete; preserve recovery material for manual resolution`,
              invalidStatus: `installation ${operation} returned an invalid result; preserve recovery material for manual resolution`,
            },
            outcomes,
            (value) => value === null,
          );
          if (!verified) {
            const restored = await invoke(
              () => ctx.adapter.inspectInstalled(selection, adapterContext),
              inspectionFailure,
              outcomes,
              validInstalled,
            );
            const restoration = restored.ok
              ? `installed state after rollback: ${restored.result.outcome.result.kind}; identity=${restored.result.outcome.result.observedIdentity}`
              : "installed state after rollback could not be inspected";
            const message = !settlement.ok
              ? settlement.message
              : !inspected.ok
                ? inspected.message
                : "installation could not be verified";
            return {
              kind: "verified",
              outcomes,
              status: 1,
              stdout: [],
              stderr: [
                ...(message === null ? [] : [`error: ${message}`]),
                restoration,
              ],
            };
          }
          if (!settlement.ok) {
            const actual = await invoke(
              () => ctx.adapter.inspectInstalled(selection, adapterContext),
              inspectionFailure,
              outcomes,
              validInstalled,
            );
            return {
              kind: "verified",
              outcomes,
              status: 1,
              stdout: [],
              stderr: [
                "error: installation was verified, but transaction cleanup did not complete; preserve recovery material for manual resolution",
                actual.ok
                  ? `installed state after failed finalization: ${actual.result.outcome.result.kind}; identity=${actual.result.outcome.result.observedIdentity}`
                  : "installed state after failed finalization could not be inspected",
                ...(settlement.message === null
                  ? []
                  : [`error: ${settlement.message}`]),
              ],
            };
          }
        }
        if (inspection === null)
          return failed(inspected.ok ? null : inspected.message);
        const output = ctx.adapter.presentation.renderInstallVerification(
          selection.desiredCommit,
          install.result,
          inspection,
        );
        return {
          kind: "verified",
          outcomes,
          status: verified ? 0 : 1,
          stdout: output.stdout,
          stderr: output.stderr,
        };
      },
      {
        // Suppresses withWorkspace's throw on a POST-SUCCESS cleanup failure,
        // so the StageOutcome the callback already computed still comes back
        // as `outcome` below instead of being discarded. `report` runs
        // synchronously, as the option requires (src/workspace.ts).
        onCleanupFailure: (path) => {
          cleanupWarning = workspaceRemovalFailure(path);
        },
      },
    );
    return { outcome, cleanupWarning };
  } catch (cause) {
    // Reachable only for mkdtemp failure (nothing collected yet) -- the
    // callback above never throws, so a post-success cleanup failure is
    // already handled by onCleanupFailure and cannot reach here.
    throw new GatherFailure(cause, outcomes);
  }
}

export async function runInstall<R>(
  argv: readonly string[],
  ctx: CommandContext<R>,
): Promise<number> {
  if (ctx.adapter.presentation.installNotice !== "")
    ctx.stdout.write(`${ctx.adapter.presentation.installNotice}\n`);
  let actionThrew = false;
  try {
    return await withMutation("install", ctx, async (scoped) => {
      try {
        return await performInstall(argv, scoped);
      } catch (cause) {
        actionThrew = true;
        throw cause;
      }
    });
  } catch (cause) {
    if (actionThrew) throw cause;
    ctx.stderr.write(`error: ${oneLine(cause)}\n`);
    return 1;
  }
}

async function performInstall<R>(
  argv: readonly string[],
  ctx: CommandContext<R>,
): Promise<number> {
  // scripts/install never reads "$@", so extra arguments are silently
  // ignored -- the same asymmetry runPrepare and runUninstall document.
  void argv;

  let probe: Awaited<ReturnType<typeof gatherProbe<R>>>;
  try {
    probe = await gatherProbe(ctx);
  } catch (cause) {
    // gatherProbe performs no writes of its own (src/commands/probe.ts), so
    // this catch cannot also be reached by an EPIPE from install's own
    // output: the NOTE line above already left the try, and everything below
    // runs only after this try/catch has resolved.
    //
    // This is a SECOND consumer of gatherProbe's throw channel --
    // `src/commands/probe.ts:337-395::THREE exceptions, all inherited and none a regression:`'s
    // runProbe catch is the first. Because both consumers wrap the identical
    // function, its long comment there enumerates exactly what can reach THIS
    // stream too, including the three foreign-text exceptions at :251-296:
    //   1. :251-262 -- resolveRef splices git's own combined stdout+stderr
    //      into its text. Reached on probe's DEFAULT path, which that comment
    //      defines as every invocation NOT resolving a saved pin: a 40-hex
    //      ref returns a "raw-commit" resolution at
    //      `src/upstream.ts:162-164::return { kind: "raw-commit"`
    //      before any git call, so it reaches no splice at all.
    //   2. :263-280 -- src/selection-store.ts's read path interpolates the
    //      caught error's own message, so Node errno prose can appear.
    //      AGENTS.md grandfathers that module's wording.
    //   3. :281-296 -- a SPAWN-level git failure, a different channel from
    //      exception 1's exit-status one: on the non-ENOENT arm of
    //      `src/git.ts:47-52::if (typeof failure.code === "string") {`, runGit
    //      rejects with "cannot run git: " followed by the Node spawn error's
    //      own message.
    // Not repeated in full here; read it there.
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
  if (
    facts.resourceState === "recovery-required" &&
    facts.control.probeEligibility.kind === "blocked"
  ) {
    writeOutput(facts.control.probeEligibility.output, ctx);
    return 1;
  }

  switch (facts.status) {
    case "needs prepare": {
      const prepareStatus = await runPrepare([], ctx);
      if (prepareStatus !== 0) return prepareStatus;
      break;
    }
    case "needs install":
      break;
    case "current":
      break;
  }

  let prepared: AdapterResult<PreparedArtifact>;
  try {
    prepared = await ctx.adapter.readPrepared({ root: ctx.root, env: ctx.env });
  } catch {
    ctx.stderr.write("error: cannot read prepared harness state\n");
    return 1;
  }
  replayOutcome(prepared.outcome, ctx);
  if (!prepared.outcome.ok) return 1;
  if (prepared.status !== 0) {
    ctx.stderr.write(
      "error: adapter reported a failure status for prepared harness inspection\n",
    );
    return 1;
  }

  let stage: StageRun;
  try {
    stage = await gatherInstallStages(
      ctx,
      facts.selection,
      prepared.outcome.result,
    );
  } catch (cause) {
    const outcomes =
      cause instanceof GatherFailure ? cause.outcomes : ([] as const);
    for (const outcome of outcomes) replayOutcome(outcome, ctx);
    const inner = cause instanceof GatherFailure ? cause.inner : cause;
    ctx.stderr.write(`error: ${oneLine(inner)}\n`);
    return 1;
  }
  const { outcome, cleanupWarning } = stage;
  for (const each of outcome.outcomes) replayOutcome(each, ctx);

  let status: number;
  if (outcome.kind === "blocked") {
    writeOutput(outcome.output, ctx);
    status = 1;
  } else if (outcome.kind === "failed") {
    if (outcome.message !== null) {
      ctx.stderr.write(`error: ${outcome.message}\n`);
    }
    status = 1;
  } else {
    // :99-100 printed both lines BEFORE deciding, on every path that got this
    // far; the verified outcome already carries both renderer arrays, so they
    // are written in order regardless of its status.
    for (const line of outcome.stdout) ctx.stdout.write(`${line}\n`);
    for (const line of outcome.stderr) ctx.stderr.write(`${line}\n`);
    status = outcome.status;
  }
  if (cleanupWarning !== null) {
    // A leaked workspace is reported even when the domain outcome above was
    // itself a success: the fingerprint verification that produced that
    // success already completed against the adapter before cleanup ran, so
    // it is not being reported as unverified -- but something did still go
    // wrong, and AGENTS.md's fail-closed rule extends to it.
    ctx.stderr.write(`error: ${cleanupWarning}\n`);
    return 1;
  }
  return status;
}

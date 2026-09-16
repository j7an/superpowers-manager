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

// Ports scripts/core/validate-adapter-response.py's replay (:235-238) and its
// error/hint block (:269-272). The shell ran that validator on EVERY adapter
// response, so adapter messages reached the operator on their declared streams
// in array order, and a controlled failure printed `error:` plus one `hint:`
// per hint. DIAG-ADAPTER-01 retains that contract
// (docs/adapter-result-contract.md); dropping it here would be a
// silent diagnostics regression, not a simplification.
//
// Interpolating error.message and each hint is the sanctioned form (AGENTS.md):
// src/harnesses/codex/adapter.ts has 52 `fail()` sites and none interpolates a caught error's
// message, so the callee owns every failure reachable on this path. Those two
// writes now live in writeAdapterFailure (src/adapter-result.ts), which
// validates all three strings before the first of them reaches the stream.
//
// This writes to ctx, so it MUST NOT be called from inside gatherProbe's try
// -- see the ProbeOutcome note below.
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

// Runs every step that can throw or fail closed, returning the outcome as
// data. It performs no writes of its own, so nothing inside runProbe's try can
// raise EPIPE — the same shape as src/commands/unpin.ts's attemptUnpin.
//
// The outcomes are CARRIED OUT rather than replayed in place, for that same
// reason: replayOutcome writes to ctx, and a write inside this try could
// raise EPIPE and be caught and relabelled as a selection failure. runProbe
// replays them, in collection order, after the try/catch has resolved. The
// operator-visible result is identical -- probe emits nothing else until the
// very end -- and the EPIPE hazard never exists.
// Exported for src/commands/install.ts and src/commands/update.ts, which need
// probe's FACTS rather than its rendering. The historical
// `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/lifecycle.sh:39-41::spw_probe_field`
// implementation awk-parsed the porcelain back into fields; that round trip is
// gone.
export async function gatherProbe<R>(
  ctx: CommandContext<R>,
): Promise<ProbeOutcome<R>> {
  // Order mirrors `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/probe:24-40::spw_compute_effective_selection` exactly.
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
    JSON.stringify(before) !== JSON.stringify(after) ||
    JSON.stringify(prepared.result.outcome.result) !==
      JSON.stringify(preparedAfter.result.outcome.result) ||
    JSON.stringify(installed.result.outcome.result) !==
      JSON.stringify(installedAfter.result.outcome.result) ||
    JSON.stringify(control.result.outcome.result) !==
      JSON.stringify(controlAfter.result.outcome.result)
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

export async function runProbe<R>(
  argv: readonly string[],
  ctx: CommandContext<R>,
): Promise<number> {
  // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/probe:42::porcelain` tested only `[ "${1:-}" = "--porcelain" ]`, so a typo'd
  // flag silently produced human output. Rejecting it is a deliberate
  // narrowing from the historical shell behavior.
  //
  // This guard is NOT the production path. src/cli.ts's parseArgs rejects the
  // same inputs first, before preflight, with the usage block the CLI's other
  // usage errors carry — exactly the arrangement track-latest and unpin have,
  // where the in-module check is an unreachable-from-CLI duplicate. It stays
  // because runProbe is also called directly by tests and by any future
  // in-process caller that has not been through parseArgs.
  const porcelain = argv.length === 1 && argv[0] === "--porcelain";
  if (!porcelain && argv.length !== 0) {
    ctx.stderr.write(PROBE_USAGE);
    return 2;
  }
  let outcome: ProbeOutcome<R>;
  try {
    outcome = await gatherProbe(ctx);
  } catch (cause) {
    // Hand-written messages, per AGENTS.md's reader-diagnostics rule. Reachable
    // here: the selectionErrors validateSource raises
    // (`src/selection.ts:137::malformed`, :140, requireSingleLineString at :77),
    // reached from
    // computeEffectiveSelection's validateSource call
    // (src/effective-selection.ts); the ones validateRecord raises
    // (`src/selection.ts:198::integer`, :219, requireObject at :47, requireExactKeys at
    // :64, validatePinnedRecord at :170-183), reached from
    // `src/selection-store.ts:99::return validateRecord` on the read path; the
    // selectionErrors requireAbsolute and selectionConfigDir
    // (src/effective-selection.ts) raise
    // for a non-absolute or missing config directory; readConfigRef's `cannot
    // read packaged upstream ref <path>` (src/upstream.ts); and resolveRef's own
    // two no-match diagnostics, `no stable semver tag found for latest-release`
    // and `cannot resolve upstream ref: <ref>` (src/upstream.ts). normalizeSaved
    // (`src/selection.ts:222-241::normalizeSaved`) throws nothing at all.
    //
    // THREE exceptions, all inherited and none a regression:
    //   1. resolveRef splices git's combined stdout+stderr into its own text
    //      (its three `cannot query upstream ...` throws, src/upstream.ts),
    //      reached via computeEffectiveSelection's resolveRef call
    //      (src/effective-selection.ts). The packaged ref is `latest-release`,
    //      which resolveRef answers with an ls-remote, so an ordinary unpinned
    //      run reaches this rather than only an exotic corner -- though not
    //      every unpinned run does: resolveRef's COMMIT_INPUT_RE branch returns
    //      before any runGit call, so a 40-hex requested ref splices nothing.
    //      Pinned by
    //      `tests/unit/upstream.test.ts:439::void test("resolveRef reports a query failure for latest`,
    //      `tests/unit/upstream.test.ts:450::void test("resolveRef reports a query failure for a tag lookup`, and
    //      `tests/unit/upstream.test.ts:462::void test("resolveRef reports a query failure for the generic ref lookup`.
    //   2. The
    //      `src/selection-store.ts:116-120::cause.module === "selection") {`
    //      site (same shape at :49, :86, :98) is the module AGENTS.md's
    //      `src/selection-store.ts` bullet grandfathers:
    //      it interpolates the caught error's own message, so Node errno
    //      prose can reach this stream. Reached on the READ path only, via
    //      loadSavedSelection (src/effective-selection.ts) ->
    //      readSelectionState
    //      (`src/selection-store.ts:145::export async function readSelectionState`).
    //      This module's two write-only interpolating sites -- ensureStateDirectory
    //      (:172) and writeSelectionState's own catch (:202) -- are both
    //      unreachable from probe, which never writes.
    //   3. Every runGit call site inside resolveRef (src/upstream.ts) can
    //      reject instead of resolving. On the non-ENOENT arm of
    //      `src/git.ts:47-52::if (typeof`, runGit builds the message
    //      "cannot run git: " followed by the Node spawn error's own message
    //      (:51) and rejects with a SafetyError carrying it (:52), so that
    //      Node spawn-level text reaches ctx.stderr through this catch. The
    //      ENOENT arm (:50) is hand-written and carries nothing. A non-zero
    //      *exit status* is handled by exception 1 above; this is the
    //      *spawn-level* case, where runGit throws rather than returning a
    //      status.
    //
    // oneLine() at this catch collapses each of exceptions 1 and 3 -- the two
    // carrying git-derived text -- to a single line. It collapses CR/LF only,
    // so it bounds how much of that text lands, not what it may contain.
    //
    // fetchExactCommit is deliberately NOT in this list, unlike prepare's
    // fetchExactCommit exception, which runPrepare's catch block documents.
    // Its only remaining caller is gatherPrepare's call in
    // src/commands/prepare.ts (git grep -n fetchExactCommit -- src/ is the
    // check that keeps "only" true), so probe never reaches it and
    // its splice sites cannot appear on this stream. Do not add it back by
    // symmetry with prepare.
    //
    // generatedCommitOrEmpty is not in this list either: it cannot throw at
    // all. It (src/provenance.ts) delegates to readGeneratedCommitLenient,
    // which catches every failure and returns "".
    //
    // A non-AdapterFailure re-thrown by runCodexOperation's closing `throw cause`
    // (src/harnesses/codex/adapter.ts) does NOT reach here: inspect() catches it and converts
    // it to a hand-written message per AGENTS.md's reader-diagnostics rule -- a
    // rethrown cause is exactly the failure src/harnesses/codex/adapter.ts declined to own, so
    // its text must never reach this stream. See §3.3a.
    //
    // gatherProbe performs no writes of its own, so this catch cannot also be
    // reached by an EPIPE from probe's own output — every write below runs
    // only after this try/catch has resolved.
    ctx.stderr.write(`error: ${oneLine(cause)}\n`);
    return 1;
  }
  // Replay first, on both paths: the shell validator replayed every response's
  // messages whether or not that response was a failure at
  // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/validate-adapter-response.py:268::replay(messages)`.
  for (const each of outcome.outcomes) replayOutcome(each, ctx);
  if (outcome.status === 1) {
    // null means replayOutcome already emitted the adapter's own `error:`
    // and `hint:` lines for the failing outcome.
    if (outcome.message !== null) {
      ctx.stderr.write(`error: ${outcome.message}\n`);
    }
    return 1;
  }
  const rendered = ctx.adapter.presentation.renderProbe(outcome.facts);
  ctx.stdout.write(porcelain ? rendered.porcelain : rendered.human);
  return outcome.facts.resourceState === "recovery-required" ? 1 : 0;
}

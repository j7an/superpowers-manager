// FROZEN CITATIONS: `scripts/…:NN` references below resolve against the tree at
// ad56569a4c161e7b122967442e2b026eeb6395f6, the last commit in which those paths existed. They are unmaintained
// and will not be re-derived. Resolve one with:
//   git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/probe

import type { AdapterOutcome, AdapterResult } from "../adapter-result.js";
import {
  assertFailureWritable,
  writeAdapterFailure,
} from "../adapter-result.js";
import { oneLine } from "../cli-arguments.js";
import { computeEffectiveSelection } from "../effective-selection.js";
import { generatedCommitOrEmpty } from "../provenance.js";
import { displaySource } from "../selection.js";
import { statusForCommits } from "../status.js";
import type { CommandContext } from "./context.js";

export const PROBE_USAGE =
  "error: usage: superpowers-manager probe [--porcelain]\n";

export interface ProbeFacts {
  readonly requestedRef: string;
  readonly resolvedRef: string;
  readonly desiredCommit: string;
  readonly generatedCommit: string;
  readonly installedCommit: string;
  readonly identityState: string;
  readonly status: string;
  readonly selectionOrigin: string;
  readonly selectionMode: string;
  readonly upstreamSourceOrigin: string;
  readonly effectiveSource: string;
  readonly savedMode: string;
  readonly savedSource: string;
  readonly savedRequestedRef: string;
  readonly savedResolvedRef: string;
  readonly savedCommit: string;
  readonly updateControl: string;
}

interface Field {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly absent?: string;
}

// One ordered table drives both formats, so the porcelain key order
// (scripts/probe:43-59) and the human label order (scripts/probe:61-77) cannot
// drift apart. Two parallel lists could each stay self-consistent while
// disagreeing with one another.
function fields(f: ProbeFacts): readonly Field[] {
  return [
    { key: "requested_ref", label: "requested ref", value: f.requestedRef },
    { key: "resolved_ref", label: "resolved ref", value: f.resolvedRef },
    { key: "desired_commit", label: "desired commit", value: f.desiredCommit },
    {
      key: "generated_commit",
      label: "generated plugin commit",
      value: f.generatedCommit,
      absent: "not present",
    },
    {
      key: "installed_commit",
      label: "installed manager commit or fingerprint",
      value: f.installedCommit,
      absent: "not detected",
    },
    {
      key: "identity_state",
      label: "Codex identity state",
      value: f.identityState,
    },
    { key: "status", label: "status", value: f.status },
    {
      key: "selection_origin",
      label: "selection origin",
      value: f.selectionOrigin,
    },
    { key: "selection_mode", label: "selection mode", value: f.selectionMode },
    {
      key: "upstream_source_origin",
      label: "upstream source origin",
      value: f.upstreamSourceOrigin,
    },
    {
      key: "effective_source",
      label: "effective source",
      value: f.effectiveSource,
    },
    { key: "saved_mode", label: "saved mode", value: f.savedMode },
    { key: "saved_source", label: "saved source", value: f.savedSource },
    {
      key: "saved_requested_ref",
      label: "saved requested ref",
      value: f.savedRequestedRef,
    },
    {
      key: "saved_resolved_ref",
      label: "saved resolved ref",
      value: f.savedResolvedRef,
    },
    { key: "saved_commit", label: "saved commit", value: f.savedCommit },
    { key: "update_control", label: "update control", value: f.updateControl },
  ];
}

// Derived from the same fields() table, so the key list a test asserts and
// the key list formatPorcelain emits cannot be different lists. The facts
// argument is irrelevant here — fields() is total over ProbeFacts and the
// keys do not depend on the values.
const NO_FACTS: ProbeFacts = {
  requestedRef: "",
  resolvedRef: "",
  desiredCommit: "",
  generatedCommit: "",
  installedCommit: "",
  identityState: "",
  status: "",
  selectionOrigin: "",
  selectionMode: "",
  upstreamSourceOrigin: "",
  effectiveSource: "",
  savedMode: "",
  savedSource: "",
  savedRequestedRef: "",
  savedResolvedRef: "",
  savedCommit: "",
  updateControl: "",
};

export const PROBE_PORCELAIN_KEYS: readonly string[] = fields(NO_FACTS).map(
  (field) => field.key,
);

export function formatPorcelain(f: ProbeFacts): string {
  return fields(f)
    .map((field) => `${field.key}=${field.value}\n`)
    .join("");
}

export function formatHuman(f: ProbeFacts): string {
  let text = fields(f)
    .map((field) => {
      const shown =
        field.value.length === 0 && field.absent !== undefined
          ? field.absent
          : field.value;
      return `${field.label}: ${shown}\n`;
    })
    .join("");
  // scripts/probe:78-81.
  if (f.selectionOrigin !== f.upstreamSourceOrigin) {
    text +=
      "warning: effective ref and source have mixed origins " +
      `(ref: ${f.selectionOrigin}, source: ${f.upstreamSourceOrigin})\n`;
  }
  return text;
}

// Ports scripts/core/validate-adapter-response.py's replay (:235-238) and its
// error/hint block (:269-272). The shell ran that validator on EVERY adapter
// response, so adapter messages reached the operator on their declared streams
// in array order, and a controlled failure printed `error:` plus one `hint:`
// per hint. DIAG-ADAPTER-01 retains that contract
// (docs/baseline/protocol-disposition.md:53); dropping it here would be a
// silent diagnostics regression, not a simplification.
//
// Interpolating error.message and each hint is the sanctioned form (AGENTS.md):
// src/adapter.ts has 52 `fail()` sites and none interpolates a caught error's
// message, so the callee owns every failure reachable on this path. Those two
// writes now live in writeAdapterFailure (src/adapter-result.ts), which
// validates all three strings before the first of them reaches the stream.
//
// This writes to ctx, so it MUST NOT be called from inside gatherProbe's try
// -- see the ProbeOutcome note below.
export function replayOutcome(
  outcome: AdapterOutcome,
  ctx: CommandContext,
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

type Inspection =
  | {
      readonly ok: true;
      readonly value: string;
      readonly outcome: AdapterOutcome;
    }
  | {
      readonly ok: false;
      // null when the outcome's own error already carries the diagnostic --
      // replayOutcome emits it, and adding a second line would duplicate it.
      readonly message: string | null;
      readonly outcome: AdapterOutcome | null;
    };

// `runAdapter` reports a CONTROLLED failure by RETURN VALUE, not by throwing
// (src/adapter-result.ts:32-35). The shell got fail-closed behaviour for
// free: spw_invoke_adapter returned 1 and scripts/probe ran under `set -eu`.
// Omitting the status check here would read a failed inspection as absent
// evidence and report it as success.
//
// It does still THROW for a non-AdapterFailure cause (src/adapter.ts:1009).
// That is caught here rather than in runProbe's outer catch, because the two
// need different diagnostics -- see spec §3.3a.
//
// Reached through ctx.adapter, not a direct module-level dependency on the
// adapter module: src/commands/prepare.ts and this module are the two the
// injected double must observe, because install reaches the adapter through
// gatherProbe and runPrepare. Spec §4.5.
async function inspect(
  view: string,
  key: string,
  ctx: CommandContext,
): Promise<Inspection> {
  let result: AdapterResult;
  try {
    result = await ctx.adapter(["inspect", "--view", view], {
      root: ctx.root,
      env: ctx.env,
    });
  } catch {
    // Deliberately does NOT interpolate the cause. A rethrown non-
    // AdapterFailure is by construction the one failure src/adapter.ts chose
    // not to own: free-form text of unknown provenance, which AGENTS.md bars
    // from this stream. `view` is a bounded token -- one of three literals
    // this function is ever called with -- so naming the input is safe.
    return {
      ok: false,
      outcome: null,
      message: `cannot inspect Codex adapter state for view ${view}`,
    };
  }
  const outcome = result.outcome;
  if (result.status !== 0 || !outcome.ok) {
    // The `outcome.ok && status !== 0` combination cannot arise from
    // successResult/failureResult, so it gets its own hand-written message
    // rather than falling through to a replay that would print nothing.
    return {
      ok: false,
      outcome,
      message: outcome.ok
        ? `adapter reported a failure status for inspect --view ${view}`
        : null,
    };
  }
  const value = (outcome.result as Record<string, unknown> | null)?.[key];
  // The Python reader printed the empty string for a JSON null
  // (scripts/core/provenance.sh's spw_json_get), and `fingerprint` is null
  // whenever no plugin version is active (src/adapter.ts:818).
  if (value === null || value === undefined) {
    return { ok: true, value: "", outcome };
  }
  if (typeof value !== "string") {
    return {
      ok: false,
      outcome,
      message: `adapter returned a non-string ${key} for inspect --view ${view}`,
    };
  }
  return { ok: true, value, outcome };
}

type ProbeOutcome =
  | {
      readonly status: 1;
      readonly outcomes: readonly AdapterOutcome[];
      readonly message: string | null;
    }
  | {
      readonly status: 0;
      readonly outcomes: readonly AdapterOutcome[];
      readonly facts: ProbeFacts;
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
// probe's FACTS rather than its rendering. scripts/core/lifecycle.sh:39-41
// awk-parsed the porcelain back into fields; that round trip is gone.
export async function gatherProbe(ctx: CommandContext): Promise<ProbeOutcome> {
  // Order mirrors scripts/probe:24-40 exactly.
  const selection = await computeEffectiveSelection(ctx.root, ctx.env);
  const generatedCommit = await generatedCommitOrEmpty(ctx.root);

  const outcomes: AdapterOutcome[] = [];
  const collect = async (view: string, key: string): Promise<Inspection> => {
    const result = await inspect(view, key, ctx);
    if (result.outcome !== null) outcomes.push(result.outcome);
    return result;
  };

  const fingerprint = await collect("fingerprint", "fingerprint");
  if (!fingerprint.ok) {
    return { status: 1, outcomes, message: fingerprint.message };
  }
  const ownership = await collect("ownership", "identity_state");
  if (!ownership.ok) {
    return { status: 1, outcomes, message: ownership.message };
  }
  const updateControl = await collect("update-control", "update_control");
  if (!updateControl.ok) {
    return { status: 1, outcomes, message: updateControl.message };
  }

  const saved = selection.saved;
  return {
    status: 0,
    outcomes,
    facts: {
      requestedRef: selection.requestedRef,
      resolvedRef: selection.resolvedRef,
      desiredCommit: selection.desiredCommit,
      generatedCommit,
      installedCommit: fingerprint.value,
      identityState: ownership.value,
      status: statusForCommits(
        selection.desiredCommit,
        generatedCommit,
        fingerprint.value,
      ),
      selectionOrigin: selection.selectionOrigin,
      selectionMode: selection.selectionMode,
      upstreamSourceOrigin: selection.upstreamSourceOrigin,
      effectiveSource: displaySource(selection.effectiveSource),
      savedMode: saved.saved_mode,
      // scripts/probe:26-30: an absent saved source stays empty rather than
      // being run through displaySource, which would render <redacted-source>.
      savedSource:
        saved.saved_source.length > 0 ? displaySource(saved.saved_source) : "",
      savedRequestedRef: saved.saved_requested_ref,
      savedResolvedRef: saved.saved_resolved_ref,
      savedCommit: saved.saved_commit,
      updateControl: updateControl.value,
    },
  };
}

export async function runProbe(
  argv: readonly string[],
  ctx: CommandContext,
): Promise<number> {
  // scripts/probe:42 tested only `[ "${1:-}" = "--porcelain" ]`, so a typo'd
  // flag silently produced human output. Rejecting it is a deliberate
  // narrowing, recorded as a port-only entry in
  // tests/migration-inventory/probe.md.
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
  let outcome: ProbeOutcome;
  try {
    outcome = await gatherProbe(ctx);
  } catch (cause) {
    // Most throws reachable here carry a HAND-WRITTEN message:
    //   - the selectionErrors validateSource raises (src/selection.ts:137,
    //     :140, and requireSingleLineString at :77), reached from
    //     src/effective-selection.ts:92, and the ones validateRecord raises
    //     (src/selection.ts:198, :219, plus requireObject at :47,
    //     requireExactKeys at :64, and validatePinnedRecord at :170-183),
    //     reached from src/selection-store.ts:103 on the read path.
    //     normalizeSaved (src/selection.ts:222-241) is NOT in this list: it
    //     contains no throw statement and raises nothing at all.
    //   - the selectionErrors src/effective-selection.ts:15 and :35 raise for
    //     a non-absolute or missing config directory.
    //   - readConfigRef's `cannot read packaged upstream ref <path>`
    //     (src/upstream.ts:52), which names the path and drops the cause.
    //   - resolveRef's own no-match diagnostics (src/upstream.ts:155, :199).
    //
    // THREE exceptions, all inherited and none a regression:
    //   1. resolveRef splices git's combined stdout+stderr into its own text
    //      (src/upstream.ts:150, :175, :191), reached via
    //      computeEffectiveSelection (src/effective-selection.ts:133). This is
    //      probe's DEFAULT path -- every invocation that is not resolving a
    //      saved pin -- not an exotic corner. Pinned by
    //      tests/unit/upstream.test.js:460, :471, and :483.
    //   2. src/selection-store.ts:124 (same shape at :49, :86, :98)
    //      interpolates the caught error's own message, so Node errno prose
    //      (e.g. "EACCES: permission denied, open '<path>'") can reach this
    //      stream. Reached on the READ path only, via loadSavedSelection
    //      (src/effective-selection.ts:50) -> readSelectionState
    //      (src/selection-store.ts:149). This module's four write-only
    //      interpolating sites are all unreachable from probe, which never
    //      writes: :172 (ensureStateDirectory, called from :206), :197
    //      (finalStateDiagnostic, called from :229), and :225 and :231 in
    //      writeSelectionState's own catch. AGENTS.md explicitly grandfathers
    //      this module's wording, so the read-path sites are sanctioned
    //      behaviour -- nothing here needs fixing.
    //   3. Every runGit call site inside resolveRef (src/upstream.ts:141,
    //      :165, :188) can reject instead of resolving. On the non-ENOENT arm
    //      of src/git.ts:47-52, runGit builds the message
    //      "cannot run git: " followed by the Node spawn error's own message
    //      (:51) and rejects with a SafetyError carrying it (:52), so that
    //      Node spawn-level text reaches ctx.stderr through this catch. The
    //      ENOENT arm (:50) is hand-written and carries nothing. A non-zero
    //      *exit status* is handled by exception 1 above; this is the
    //      *spawn-level* case, where runGit throws rather than returning a
    //      status.
    //
    // oneLine() collapses each of exceptions 1 and 3 to a single line,
    // containing the harm to one line of git text rather than the arbitrarily
    // many scripts/probe's `set -eu` plumbing allowed.
    //
    // fetchExactCommit is deliberately NOT in this list, unlike
    // src/commands/prepare.ts:529's exception 2. Its only callers are
    // src/upstream-cli.ts:83 and src/commands/prepare.ts:301, so probe never
    // reaches it and its splice sites cannot appear on this stream. Do not
    // add it back by symmetry with prepare.
    //
    // generatedCommitOrEmpty is not in this list either, and -- contrary to
    // what this comment used to claim -- it is not a source of hand-written
    // SafetyErrors: it cannot throw at all. src/provenance.ts:105 delegates to
    // readGeneratedCommitLenient (src/provenance.ts:78-94), which catches
    // every failure and returns "".
    //
    // A non-AdapterFailure re-thrown by runAdapter (src/adapter.ts:1009) does
    // NOT reach here: inspect() catches it and converts it to a hand-written
    // message, because a rethrown cause is exactly the failure src/adapter.ts
    // declined to own and its text must never reach this stream. See §3.3a.
    //
    // gatherProbe performs no writes of its own, so this catch cannot also be
    // reached by an EPIPE from probe's own output — every write below runs
    // only after this try/catch has resolved.
    ctx.stderr.write(`error: ${oneLine(cause)}\n`);
    return 1;
  }
  // Replay first, on both paths: the shell validator replayed every response's
  // messages whether or not that response was a failure
  // (scripts/core/validate-adapter-response.py:268).
  for (const each of outcome.outcomes) replayOutcome(each, ctx);
  if (outcome.status === 1) {
    // null means replayOutcome already emitted the adapter's own `error:`
    // and `hint:` lines for the failing outcome.
    if (outcome.message !== null) {
      ctx.stderr.write(`error: ${outcome.message}\n`);
    }
    return 1;
  }
  ctx.stdout.write(
    porcelain ? formatPorcelain(outcome.facts) : formatHuman(outcome.facts),
  );
  return 0;
}

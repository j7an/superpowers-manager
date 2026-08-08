import { runAdapter } from "../adapter.js";
import type { AdapterEnvelope, AdapterResult } from "../adapter-protocol.js";
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
// message, so the callee owns every failure reachable on this path.
//
// This writes to ctx, so it MUST NOT be called from inside gatherProbe's try
// -- see the ProbeOutcome note below.
export function replayEnvelope(
  envelope: AdapterEnvelope,
  ctx: CommandContext,
): void {
  for (const message of envelope.messages) {
    const stream = message.channel === "stdout" ? ctx.stdout : ctx.stderr;
    stream.write(`${message.text}\n`);
  }
  if (!envelope.ok) {
    ctx.stderr.write(`error: ${envelope.error.message}\n`);
    for (const hint of envelope.error.hints) {
      ctx.stderr.write(`hint: ${hint}\n`);
    }
  }
}

type Inspection =
  | {
      readonly ok: true;
      readonly value: string;
      readonly envelope: AdapterEnvelope;
    }
  | {
      readonly ok: false;
      // null when the envelope's own error already carries the diagnostic --
      // replayEnvelope emits it, and adding a second line would duplicate it.
      readonly message: string | null;
      readonly envelope: AdapterEnvelope | null;
    };

// `runAdapter` reports a CONTROLLED failure by RETURN VALUE, not by throwing
// (src/adapter-protocol.ts:34-37). The shell got fail-closed behaviour for
// free: spw_invoke_adapter returned 1 and scripts/probe ran under `set -eu`.
// Omitting the status check here would read a failed inspection as absent
// evidence and report it as success.
//
// It does still THROW for a non-AdapterFailure cause (src/adapter.ts:986).
// That is caught here rather than in runProbe's outer catch, because the two
// need different diagnostics -- see spec §3.3a.
async function inspect(
  view: string,
  key: string,
  ctx: CommandContext,
): Promise<Inspection> {
  let result: AdapterResult;
  try {
    result = await runAdapter(["inspect", "--view", view], {
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
      envelope: null,
      message: `cannot inspect Codex adapter state for view ${view}`,
    };
  }
  const envelope = result.envelope;
  if (result.status !== 0 || !envelope.ok) {
    // The `envelope.ok && status !== 0` combination cannot arise from
    // successResult/failureResult, so it gets its own hand-written message
    // rather than falling through to a replay that would print nothing.
    return {
      ok: false,
      envelope,
      message: envelope.ok
        ? `adapter reported a failure status for inspect --view ${view}`
        : null,
    };
  }
  const value = (envelope.result as Record<string, unknown> | null)?.[key];
  // The Python reader printed the empty string for a JSON null
  // (scripts/core/provenance.sh's spw_json_get), and `fingerprint` is null
  // whenever no plugin version is active (src/adapter.ts:802).
  if (value === null || value === undefined) {
    return { ok: true, value: "", envelope };
  }
  if (typeof value !== "string") {
    return {
      ok: false,
      envelope,
      message: `adapter returned a non-string ${key} for inspect --view ${view}`,
    };
  }
  return { ok: true, value, envelope };
}

type ProbeOutcome =
  | {
      readonly status: 1;
      readonly envelopes: readonly AdapterEnvelope[];
      readonly message: string | null;
    }
  | {
      readonly status: 0;
      readonly envelopes: readonly AdapterEnvelope[];
      readonly facts: ProbeFacts;
    };

// Runs every step that can throw or fail closed, returning the outcome as
// data. It performs no writes of its own, so nothing inside runProbe's try can
// raise EPIPE — the same shape as src/commands/unpin.ts's attemptUnpin.
//
// The envelopes are CARRIED OUT rather than replayed in place, for that same
// reason: replayEnvelope writes to ctx, and a write inside this try could
// raise EPIPE and be caught and relabelled as a selection failure. runProbe
// replays them, in collection order, after the try/catch has resolved. The
// operator-visible result is identical -- probe emits nothing else until the
// very end -- and the EPIPE hazard never exists.
async function gatherProbe(ctx: CommandContext): Promise<ProbeOutcome> {
  // Order mirrors scripts/probe:24-40 exactly.
  const selection = await computeEffectiveSelection(ctx.root, ctx.env);
  const generatedCommit = await generatedCommitOrEmpty(ctx.root);

  const envelopes: AdapterEnvelope[] = [];
  const collect = async (view: string, key: string): Promise<Inspection> => {
    const result = await inspect(view, key, ctx);
    if (result.envelope !== null) envelopes.push(result.envelope);
    return result;
  };

  const fingerprint = await collect("fingerprint", "fingerprint");
  if (!fingerprint.ok) {
    return { status: 1, envelopes, message: fingerprint.message };
  }
  const ownership = await collect("ownership", "identity_state");
  if (!ownership.ok) {
    return { status: 1, envelopes, message: ownership.message };
  }
  const updateControl = await collect("update-control", "update_control");
  if (!updateControl.ok) {
    return { status: 1, envelopes, message: updateControl.message };
  }

  const saved = selection.saved;
  return {
    status: 0,
    envelopes,
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
  // narrowing, matching the strict arity slice 1 gave unpin and track-latest,
  // and is recorded as a port-only entry in tests/migration-inventory/probe.md.
  const porcelain = argv.length === 1 && argv[0] === "--porcelain";
  if (!porcelain && argv.length !== 0) {
    ctx.stderr.write(PROBE_USAGE);
    return 2;
  }
  let outcome: ProbeOutcome;
  try {
    outcome = await gatherProbe(ctx);
  } catch (cause) {
    // Every throw that reaches HERE is a hand-written SafetyError from
    // computeEffectiveSelection or generatedCommitOrEmpty -- re-emitting a
    // subordinate module's own diagnostic is the sanctioned form of
    // interpolation (AGENTS.md).
    //
    // A non-AdapterFailure re-thrown by runAdapter (src/adapter.ts:986) does
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
  for (const envelope of outcome.envelopes) replayEnvelope(envelope, ctx);
  if (outcome.status === 1) {
    // null means replayEnvelope already emitted the adapter's own `error:`
    // and `hint:` lines for the failing envelope.
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

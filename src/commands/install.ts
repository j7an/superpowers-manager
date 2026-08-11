// Ports scripts/install. The shell sourced common.sh, provenance.sh,
// status.sh, lifecycle.sh and adapter.sh; the predicates now live in
// src/lifecycle.ts, the generated-metadata read lives in src/provenance.ts,
// and the adapter arrives through ctx.adapter.
import { tmpdir } from "node:os";
import type { AdapterEnvelope, AdapterResult } from "../adapter-protocol.js";
import { oneLine } from "../cli-arguments.js";
import {
  requireManagedUpdateControl,
  requireNoLegacyState,
  verifyInstalledFingerprint,
} from "../lifecycle.js";
import {
  generatedMetadataPath,
  readStrictProvenanceField,
} from "../provenance.js";
import { withWorkspace, workspaceRemovalFailure } from "../workspace.js";
import type { CommandContext } from "./context.js";
import {
  formatPorcelain,
  gatherProbe,
  replayEnvelope,
  type ProbeFacts,
} from "./probe.js";
import { runPrepare } from "./prepare.js";

// scripts/install:13, verbatim, and always first: the shell echoed it before
// even invoking probe.
const NOTE =
  "Note: remove or disable conflicting Superpowers providers yourself before" +
  " relying on manager skills.\n";

// scripts/core/adapter.sh:58-73 via the same convention src/commands/probe.ts's
// inspect() and src/commands/uninstall.ts's identity_state read both use: a
// JSON null or missing key is the Python reader's own "" convention
// (scripts/core/provenance.sh), but a present, non-null, NON-STRING value is a
// distinct, fail-closed "malformed" case with its own text -- never silently
// stringified. AGENTS.md's fail-closed rule wins over shell parity here.
type FieldRead =
  | { readonly kind: "ok"; readonly value: string }
  | { readonly kind: "malformed"; readonly message: string };

function readStringField(
  result: AdapterResult,
  key: string,
  label: string,
): FieldRead {
  // Callers only reach this after invoke() has already proven
  // `result.status === 0 && result.envelope.ok`; the guard below is for
  // TypeScript's narrowing of `envelope.result`, not a live branch.
  const envelope = result.envelope;
  const parsed = envelope.ok
    ? (envelope.result as Record<string, unknown> | null)
    : null;
  const raw = parsed?.[key];
  if (raw === null || raw === undefined) return { kind: "ok", value: "" };
  if (typeof raw === "string") return { kind: "ok", value: raw };
  return {
    kind: "malformed",
    message: `adapter returned a non-string ${key} for ${label}`,
  };
}

// Every ctx.adapter call site obeys spec §4.2a's five clauses, in order --
// identical to src/commands/uninstall.ts's invoke(), duplicated rather than
// shared: the two modules' call sites differ in argv shape and neither is a
// dependency of the other. See uninstall.ts's header comment for the full
// five-clause rationale.
type StageResult =
  | { readonly ok: true; readonly result: AdapterResult }
  | { readonly ok: false; readonly message: string | null };

async function invoke(
  ctx: CommandContext,
  env: NodeJS.ProcessEnv,
  argv: readonly string[],
  envelopes: AdapterEnvelope[],
): Promise<StageResult> {
  let result: AdapterResult;
  try {
    result = await ctx.adapter(argv, { root: ctx.root, env });
  } catch {
    return {
      ok: false,
      message: `cannot invoke Codex adapter for ${argv.join(" ")}`,
    };
  }
  // Clause 1: replay every envelope, on both the success and the failure
  // path, before any decision -- collected here and replayed by runInstall
  // once gatherInstallStages's try/catch has resolved, for the same EPIPE
  // reason gatherProbe carries its envelopes out rather than writing in place
  // (src/commands/probe.ts).
  envelopes.push(result.envelope);
  const envelope = result.envelope;
  if (result.status !== 0 || !envelope.ok) {
    return {
      ok: false,
      message: envelope.ok
        ? `adapter reported a failure status for ${argv.join(" ")}`
        : null,
    };
  }
  return { ok: true, result };
}

// withWorkspace can throw AFTER its callback has already returned a fully
// computed StageOutcome: a post-success cleanup failure discards that return
// value entirely and rejects instead, UNLESS an `onCleanupFailure` reporter is
// supplied -- which gatherInstallStages below does, precisely so this class
// stays reserved for mkdtemp failure (nothing collected yet) and the
// callback's own throw (never reachable here; see gatherInstallStages).
// Carries the envelopes collected so far so runInstall's catch can still
// replay them instead of discarding them with a bare re-throw. Same shape as
// src/commands/uninstall.ts's GatherFailure, duplicated for the same reason
// invoke() is: no shared dependency between the two modules.
class GatherFailure extends Error {
  constructor(
    readonly inner: unknown,
    readonly envelopes: readonly AdapterEnvelope[],
  ) {
    super("install gather failed");
  }
}

type StageOutcome =
  | {
      readonly kind: "blocked";
      readonly envelopes: readonly AdapterEnvelope[];
      readonly lines: readonly string[];
    }
  | {
      readonly kind: "failed";
      readonly envelopes: readonly AdapterEnvelope[];
      // null means replayEnvelope already emitted the adapter's own error:
      // and hint: lines for the failing envelope.
      readonly message: string | null;
    }
  | {
      readonly kind: "verified";
      readonly envelopes: readonly AdapterEnvelope[];
      readonly status: 0 | 1;
      readonly stdout: readonly string[];
      readonly stderr: readonly string[];
    };

interface StageRun {
  readonly outcome: StageOutcome;
  // Carries a post-success workspace-removal failure WITHOUT discarding the
  // outcome the callback already computed. See the header comment on
  // withWorkspace's onCleanupFailure option (src/workspace.ts) and the report
  // for why install's shape lets this go further than
  // src/commands/uninstall.ts's GatherFailure does: this callback never
  // throws (invoke() catches every ctx.adapter failure and every predicate
  // here is pure), so the only way withWorkspace's cleanup failure can
  // collide with a real outcome is the post-SUCCESS case this option exists
  // to catch -- there is no "callback also failed" case to lose the message
  // to.
  readonly cleanupWarning: string | null;
}

// scripts/install:44-58, wrapped in the temporary workspace scripts/install
// created via spw_make_workspace + spw_install_workspace_trap. Performs no
// writes of its own -- same EPIPE-avoidance shape as gatherProbe and
// src/commands/uninstall.ts's gatherUninstall.
async function gatherInstallStages(
  ctx: CommandContext,
  desiredCommit: string,
): Promise<StageRun> {
  // scripts/install:38 -- ${TMPDIR:-/tmp}. Matches
  // src/commands/uninstall.ts's gatherUninstall.
  const parent = ctx.env.TMPDIR ?? tmpdir();
  const envelopes: AdapterEnvelope[] = [];
  let cleanupWarning: string | null = null;
  try {
    const outcome = await withWorkspace(
      parent,
      "superpowers-manager.install.",
      async (workspace): Promise<StageOutcome> => {
        const env = { ...ctx.env, TMPDIR: workspace };
        const failed = (message: string | null): StageOutcome => ({
          kind: "failed",
          envelopes,
          message,
        });

        // Stage 1: inspect ownership, re-checked even though gatherProbe just
        // reported it. Mutation authority requires CURRENT, VALIDATED
        // evidence -- a probe's answer is neither by the time this runs.
        const ownership = await invoke(
          ctx,
          env,
          ["inspect", "--view", "ownership"],
          envelopes,
        );
        if (!ownership.ok) return failed(ownership.message);
        const identity = readStringField(
          ownership.result,
          "identity_state",
          "inspect --view ownership",
        );
        if (identity.kind === "malformed") return failed(identity.message);
        const legacy = requireNoLegacyState(identity.value);
        if (legacy.kind === "blocked") {
          return { kind: "blocked", envelopes, lines: legacy.lines };
        }
        if (legacy.kind === "unknown") return failed(legacy.message);

        // Stage 2: inspect update-control, re-checked for the same reason.
        const updateControl = await invoke(
          ctx,
          env,
          ["inspect", "--view", "update-control"],
          envelopes,
        );
        if (!updateControl.ok) return failed(updateControl.message);
        const control = readStringField(
          updateControl.result,
          "update_control",
          "inspect --view update-control",
        );
        if (control.kind === "malformed") return failed(control.message);
        const managed = requireManagedUpdateControl(control.value);
        if (!managed.ok) return failed(managed.message);

        // Stage 3: the mutation itself. Nothing above may have issued this --
        // that is the whole point of stages 1 and 2 running first.
        const install = await invoke(
          ctx,
          env,
          ["install", "--package-root", ctx.root],
          envelopes,
        );
        if (!install.ok) return failed(install.message);

        // Stage 4: inspect fingerprint, to verify the mutation actually took.
        const inspected = await invoke(
          ctx,
          env,
          ["inspect", "--view", "fingerprint"],
          envelopes,
        );
        if (!inspected.ok) return failed(inspected.message);

        const verdict = verifyInstalledFingerprint(
          desiredCommit,
          install.result,
          inspected.result,
        );
        return {
          kind: "verified",
          envelopes,
          status: verdict.ok ? 0 : 1,
          stdout: verdict.stdout,
          stderr: verdict.stderr,
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
    throw new GatherFailure(cause, envelopes);
  }
}

// scripts/install:29-32 kept its shell `case ... *)` wildcard even though the
// three inputs the shell's own probe could ever emit were bounded by the same
// three-way status.sh logic this port's statusForCommits (src/status.ts) now
// owns exactly. statusForCommits can only ever return "needs prepare",
// "needs install" or "current" -- so this branch is NOT reachable through
// runInstall's own call to gatherProbe today. It stays anyway, because
// ProbeFacts.status is typed `string`, not that three-literal union, and a
// future caller that builds facts by hand (as this module's own unit test
// does, directly) must still see it fail closed rather than silently
// proceed.
//
// Exported specifically so a direct test can reach it. That is ONE STEP
// FURTHER than src/commands/probe.ts:355-360's own precedent: that comment
// licenses RETAINING an unreachable branch inside an already-public
// function (runProbe was public before that comment existed), not EXPORTING
// a new one. This module does the latter, deliberately, because runInstall
// itself has no way to construct the unreachable input. Not part of the
// interface Task 5 or Task 8 consume.
//
// A test against this export proves the two writes below are correct for a
// given `facts`. It does NOT prove that runInstall's own `else if` branch
// actually reaches and calls this function, or that runInstall returns 1
// afterward -- those are properties of the call site, not of this function,
// and need their own coverage there.
export function renderUnknownProbeStatus(
  facts: ProbeFacts,
  ctx: CommandContext,
): void {
  // scripts/install:30-31 -- the porcelain reaches the terminal ONLY here.
  // Every other path swallows it, matching scripts/install:18's
  // probe_output=$(...) capture.
  ctx.stdout.write(formatPorcelain(facts));
  ctx.stderr.write(`error: unknown probe status: ${facts.status}\n`);
}

export async function runInstall(
  argv: readonly string[],
  ctx: CommandContext,
): Promise<number> {
  // scripts/install never reads "$@", so extra arguments are silently
  // ignored -- the same asymmetry runPrepare and runUninstall document.
  void argv;
  ctx.stdout.write(NOTE);

  let probe: Awaited<ReturnType<typeof gatherProbe>>;
  try {
    probe = await gatherProbe(ctx);
  } catch (cause) {
    // gatherProbe performs no writes of its own (src/commands/probe.ts), so
    // this catch cannot also be reached by an EPIPE from install's own
    // output: the NOTE line above already left the try, and everything below
    // runs only after this try/catch has resolved.
    //
    // This is a SECOND consumer of gatherProbe's throw channel --
    // src/commands/probe.ts:369-439's runProbe catch is the first, and its
    // long comment there (particularly the three documented foreign-text
    // exceptions at :385-413: git's own combined stdout+stderr on both the
    // non-pinned and pinned resolution paths, and src/selection-store.ts's
    // grandfathered errno-interpolating read-path wording) is exactly the
    // set of things that can reach THIS stream too, since both consumers
    // wrap the identical function. Not repeated here; read it there.
    ctx.stderr.write(`error: ${oneLine(cause)}\n`);
    return 1;
  }
  // Replay first, on both paths, before any decision -- clause 1.
  for (const envelope of probe.envelopes) replayEnvelope(envelope, ctx);
  if (probe.status === 1) {
    if (probe.message !== null) {
      ctx.stderr.write(`error: ${probe.message}\n`);
    }
    return 1;
  }
  const facts = probe.facts;

  // scripts/install:19-20. Guards the PROBE-derived value only -- the
  // re-inspection at :198 reads through readStringField, which already has
  // its own "malformed" arm for a non-string value, and an empty string
  // there is legitimately absent (the JSON-null convention), not an error.
  // This check exists because a probe that reports no identity state at all
  // is a different failure than one that reports an unrecognised one:
  // requireNoLegacyState("") would otherwise reach its "unknown" arm and
  // print "unknown adapter identity state: " (empty-suffixed), which names a
  // symptom rather than the actual cause. Do NOT add a second copy of this
  // check at :198 -- it guards a different value with a different failure
  // mode.
  if (facts.identityState.length === 0) {
    ctx.stderr.write("error: probe did not report adapter identity state\n");
    return 1;
  }

  // scripts/install:21, run BEFORE the workspace is ever created and before
  // any further adapter call -- a legacy identity is fatal on sight, not
  // something worth spending a mutation attempt on.
  const legacy = requireNoLegacyState(facts.identityState);
  if (legacy.kind === "blocked") {
    // scripts/core/lifecycle.sh:50-53 returns 1 without spw_die: three bare
    // lines to stderr, no `error: ` prefix.
    for (const line of legacy.lines) ctx.stderr.write(`${line}\n`);
    return 1;
  }
  if (legacy.kind === "unknown") {
    ctx.stderr.write(`error: ${legacy.message}\n`);
    return 1;
  }

  // scripts/install:22-33.
  if (facts.status === "needs prepare") {
    // Called as a FUNCTION: a failure propagates as a status, never through
    // `set -eu`. runPrepare has already replayed its own envelopes and
    // written its own diagnostics by the time it returns, so nothing further
    // is written here on that path.
    const prepareStatus = await runPrepare([], ctx);
    if (prepareStatus !== 0) return prepareStatus;
  } else if (facts.status !== "needs install" && facts.status !== "current") {
    renderUnknownProbeStatus(facts, ctx);
    return 1;
  }

  // scripts/install:35-36. The STRICT reader, never the lenient
  // generatedCommitOrEmpty gatherProbe already used for facts.generatedCommit:
  // a throw, an absent key, or a non-string value are all treated as absent
  // here, matching spw_metadata_commit_or_empty's `|| true` plus the
  // following `[ -n ]` check.
  let desiredCommit = "";
  try {
    const value = await readStrictProvenanceField(
      generatedMetadataPath(ctx.root),
      "commit",
    );
    if (typeof value === "string") desiredCommit = value;
  } catch {
    // Absent, same as an undefined or non-string read.
  }
  if (desiredCommit.length === 0) {
    ctx.stderr.write(
      "error: generated metadata missing desired commit after prepare\n",
    );
    return 1;
  }

  let stage: StageRun;
  try {
    stage = await gatherInstallStages(ctx, desiredCommit);
  } catch (cause) {
    const envelopes =
      cause instanceof GatherFailure ? cause.envelopes : ([] as const);
    for (const envelope of envelopes) replayEnvelope(envelope, ctx);
    const inner = cause instanceof GatherFailure ? cause.inner : cause;
    ctx.stderr.write(`error: ${oneLine(inner)}\n`);
    return 1;
  }
  const { outcome, cleanupWarning } = stage;
  for (const envelope of outcome.envelopes) replayEnvelope(envelope, ctx);

  let status: number;
  if (outcome.kind === "blocked") {
    for (const line of outcome.lines) ctx.stderr.write(`${line}\n`);
    status = 1;
  } else if (outcome.kind === "failed") {
    if (outcome.message !== null) {
      ctx.stderr.write(`error: ${outcome.message}\n`);
    }
    status = 1;
  } else {
    // :99-100 printed both lines BEFORE deciding, on every path that got this
    // far; verifyInstalledFingerprint already encodes that, so both arrays
    // are written in order regardless of verdict.ok.
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

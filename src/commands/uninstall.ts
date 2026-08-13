// Ports scripts/uninstall. The shell sourced common.sh, provenance.sh,
// lifecycle.sh and adapter.sh; the predicates now live in src/lifecycle.ts
// and the adapter arrives through ctx.adapter.
// FROZEN CITATIONS: `scripts/…:NN` references below resolve against the tree at
// ad56569a4c161e7b122967442e2b026eeb6395f6, the last commit in which those paths existed. They are unmaintained
// and will not be re-derived. Resolve one with:
//   git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/uninstall
import { tmpdir } from "node:os";
import type { AdapterEnvelope, AdapterResult } from "../adapter-protocol.js";
import { oneLine } from "../cli-arguments.js";
import type { Check } from "../lifecycle.js";
import { reportLegacyState, verifyUninstalledResources } from "../lifecycle.js";
import { withWorkspace, workspaceRemovalFailure } from "../workspace.js";
import type { CommandContext } from "./context.js";
import { replayEnvelope } from "./probe.js";

// scripts/core/adapter.sh:58-73. A non-Boolean is a HARD failure, never a
// falsy absent -- the shell spw_die'd rather than defaulting.
//
// THREE outcomes, not two. Collapsing "the call failed" into "the result is
// malformed" would emit the Boolean diagnostic for a controlled adapter
// failure, where the shell exits silently on the replay alone
// (scripts/uninstall:23 is a bare command under set -eu). That is the same
// collapse Task 2 undoes in src/lifecycle.ts's resultObject. Spec §4.2a
// clauses 2 and 4.
type Presence =
  // Clause 2/3: the call itself did not produce a usable envelope. The
  // caller already knows -- via the `invoke()` gate below -- which of clause
  // 2 or 3 applies and what (if any) message to write; this arm exists so
  // presenceFlag stays a total function over an arbitrary AdapterResult
  // rather than assuming its caller always gates first.
  | { readonly kind: "call-failed" }
  // Clause 4: the call succeeded and the content is unusable. This -- and
  // only this -- gets scripts/core/adapter.sh:70's Boolean text.
  | { readonly kind: "malformed"; readonly key: "plugin" | "marketplace" }
  | { readonly kind: "ok"; readonly value: boolean };

function presenceFlag(
  result: AdapterResult,
  key: "plugin" | "marketplace",
): Presence {
  const envelope = result.envelope;
  if (result.status !== 0 || !envelope.ok) {
    return { kind: "call-failed" };
  }
  const value = envelope.result;
  // Mirrors src/lifecycle.ts's verifyUninstalledResources: a missing or
  // non-object `resources` falls THROUGH to the Boolean check rather than
  // getting its own message, for parity with
  // scripts/core/adapter.sh:70's single "expected Boolean..." text on {}.
  const resources =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>).resources
      : undefined;
  const bag: Record<string, unknown> =
    typeof resources === "object" &&
    resources !== null &&
    !Array.isArray(resources)
      ? (resources as Record<string, unknown>)
      : {};
  const flag = bag[key];
  if (typeof flag !== "boolean") {
    return { kind: "malformed", key };
  }
  return { kind: "ok", value: flag };
}

// Every ctx.adapter call site obeys spec §4.2a's five clauses, in order:
// replay every envelope (the caller pushes it below before deciding
// anything); !envelope.ok stops with no additional diagnostic (`message:
// null` -- replayEnvelope already wrote the adapter's own error:/hint:
// lines); envelope.ok && status !== 0 gets a hand-written message naming the
// operation; a stop issues no further calls; and an unrelated throw (a
// non-AdapterFailure cause -- src/adapter.ts:1009) gets a hand-written
// message naming the operation too, never the caught error's own text
// (AGENTS.md). `argv` here is always this module's own literal, bounded
// construction -- never adapter-controlled text -- so naming it is safe.
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
  // path, before any decision -- collected here and replayed by the caller
  // once gatherUninstall's try/catch has resolved, for the same EPIPE reason
  // gatherProbe carries its envelopes out rather than writing in place
  // (src/commands/probe.ts:279-284).
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

type UninstallOutcome =
  | {
      readonly status: 1;
      readonly envelopes: readonly AdapterEnvelope[];
      readonly message: string | null;
    }
  | {
      readonly status: 0;
      readonly envelopes: readonly AdapterEnvelope[];
      readonly lines: readonly string[];
    };

// withWorkspace throws for mkdtemp failure before the callback ever runs
// ("cannot create workspace", src/workspace.ts:120). A bare re-throw would
// silently drop every envelope collected before that point -- a narrow
// DIAG-ADAPTER-01 regression the shell never had, since it replayed each
// adapter response as it went rather than batching replay to the end. This
// carries the envelopes collected so far alongside the original cause, so
// runUninstall's catch can still replay them before reporting the cause.
//
// The post-success cleanup failure no longer reaches here: onCleanupFailure
// below suppresses withWorkspace's throw for that case and records the
// warning as data, so the computed UninstallOutcome survives it. The
// envelope-carrying is still load-bearing for mkdtemp, and the shape stays
// identical to src/commands/install.ts's GatherFailure.
class GatherFailure extends Error {
  constructor(
    readonly inner: unknown,
    readonly envelopes: readonly AdapterEnvelope[],
  ) {
    super("uninstall gather failed");
  }
}

// Mirrors src/commands/install.ts's StageRun, and for the same reason:
// carries a post-success workspace-removal failure WITHOUT discarding the
// outcome the callback already computed.
//
// scripts/uninstall:34-35 echoed both closing lines before the exit trap ran,
// and spw_cleanup_workspace_trap (scripts/core/common.sh:25-30) is
// `rm -rf "$path" || :` -- the shell swallowed the removal failure outright
// and kept its exit status. So the shell reported the removal it was asked to
// perform on this path, and a port that drops "uninstall complete" is the one
// that diverges. The port still exits 1 and names the leaked workspace, which
// the shell did not; that half is the deliberate fail-closed divergence
// install already carries.
interface GatherRun {
  readonly outcome: UninstallOutcome;
  readonly cleanupWarning: string | null;
}

// Every step that can throw or fail closed, returning the outcome as data and
// performing NO writes. Same shape as gatherProbe (src/commands/probe.ts:285)
// and for the same reason: a write inside this try could raise EPIPE, be
// caught here, and be relabelled as a domain failure.
async function gatherUninstall(ctx: CommandContext): Promise<GatherRun> {
  // scripts/uninstall:20-21 exported TMPDIR="$uninstall_workspace" so every
  // child confined its temporary files to the tree the workspace trap
  // removed. The AdapterContext passed to ctx.adapter below does the same.
  const parent = ctx.env.TMPDIR ?? tmpdir();
  // Declared OUTSIDE the withWorkspace callback (rather than inside, as an
  // earlier draft had it) so the catch below -- which wraps the ENTIRE
  // withWorkspace call, not just the callback -- can still see whatever was
  // collected before a workspace throw. Both `mkdtemp` failure (nothing
  // collected yet) and a post-success cleanup failure (everything the
  // callback collected) reach this same array.
  const envelopes: AdapterEnvelope[] = [];
  let cleanupWarning: string | null = null;
  try {
    const outcome = await withWorkspace(
      parent,
      "superpowers-manager.uninstall.",
      async (workspace): Promise<UninstallOutcome> => {
        const env = { ...ctx.env, TMPDIR: workspace };
        const failed = (message: string | null): UninstallOutcome => ({
          status: 1,
          envelopes,
          message,
        });

        // Stage 1: inspect ownership, before removal.
        const first = await invoke(
          ctx,
          env,
          ["inspect", "--view", "ownership"],
          envelopes,
        );
        if (!first.ok) return failed(first.message);

        const pluginFlag = presenceFlag(first.result, "plugin");
        if (pluginFlag.kind === "malformed") {
          return failed(
            `expected a Boolean adapter result at resources.${pluginFlag.key}`,
          );
        }
        if (pluginFlag.kind === "call-failed") {
          // Unreachable via this call path: `first.ok` above already proved
          // status === 0 && envelope.ok, the only inputs presenceFlag reads
          // to decide this arm. Handled anyway so presenceFlag stays total
          // and this switch stays exhaustive rather than assuming its caller
          // always gates first.
          return failed(null);
        }
        const marketplaceFlag = presenceFlag(first.result, "marketplace");
        if (marketplaceFlag.kind === "malformed") {
          return failed(
            `expected a Boolean adapter result at resources.${marketplaceFlag.key}`,
          );
        }
        if (marketplaceFlag.kind === "call-failed") {
          return failed(null);
        }

        // Stage 2: uninstall, with the two presence Booleans read above.
        const uninstallStage = await invoke(
          ctx,
          env,
          [
            "uninstall",
            "--plugin-present",
            String(pluginFlag.value),
            "--marketplace-present",
            String(marketplaceFlag.value),
          ],
          envelopes,
        );
        if (!uninstallStage.ok) return failed(uninstallStage.message);

        // Stage 3: inspect ownership AGAIN. This overwrites the first
        // inspection (scripts/uninstall:29), so everything below reads the
        // POST-uninstall state, not the pre-uninstall one read above.
        const second = await invoke(
          ctx,
          env,
          ["inspect", "--view", "ownership"],
          envelopes,
        );
        if (!second.ok) return failed(second.message);

        const verify: Check = verifyUninstalledResources(second.result);
        if (!verify.ok) return failed(verify.message);

        // identity_state comes from this SAME second inspection, matching
        // scripts/uninstall:31's spw_adapter_result_get read of the
        // overwritten inspect_result. `second.ok` already proved this call
        // succeeded, so envelope.ok is true here; the explicit check below is
        // for TypeScript's narrowing (a local variable, not a re-derivation
        // of that fact) rather than a live branch.
        const secondEnvelope = second.result.envelope;
        if (!secondEnvelope.ok) return failed(null);
        // Mirrors src/commands/probe.ts:250-257's inspect() and
        // src/lifecycle.ts:171-190's fingerprint read: a JSON null or a
        // missing key defaults to "" (the Python reader's own convention for
        // a JSON null, scripts/core/provenance.sh's spw_json_get), but a
        // present, non-null, NON-STRING value is a distinct, fail-closed
        // "malformed" case with its own text -- never silently stringified.
        // (A previous draft of this comment claimed parity with the shell's
        // stringify-and-compare behaviour at scripts/core/provenance.sh:62;
        // that was wrong on inspection, and it cited these same two call
        // sites as support even though both of them fail closed on a
        // non-string value rather than stringifying it. AGENTS.md's
        // fail-closed rule wins over shell parity here.)
        const parsed = secondEnvelope.result as Record<string, unknown> | null;
        const identityRaw = parsed?.identity_state;
        let identityState: string;
        if (identityRaw === null || identityRaw === undefined) {
          identityState = "";
        } else if (typeof identityRaw === "string") {
          identityState = identityRaw;
        } else {
          return failed(
            "adapter returned a non-string identity_state for inspect --view ownership",
          );
        }
        const verdict = reportLegacyState(identityState);
        if (verdict.kind === "unknown") return failed(verdict.message);

        const lines: string[] = [];
        // verdict.kind is "ok" or "report" here (reportLegacyState never
        // returns "blocked" -- that arm belongs to requireNoLegacyState --
        // but LegacyVerdict is one shared union, so this narrows rather than
        // assumes).
        if (verdict.kind !== "ok") {
          lines.push(...verdict.lines);
        }
        // scripts/uninstall:34-35. The first line ports verbatim; the second
        // changes scripts/prepare to npx superpowers-manager prepare (spec
        // §3.6) -- a deliberate, observable divergence, recorded as a
        // port-only entry in tests/migration-inventory/uninstall-commands.md.
        lines.push("uninstall complete");
        lines.push(
          "note: local generated artifacts under plugins/superpowers/ and " +
            ".cache/upstream/ were left in place; remove them manually or " +
            "regenerate with npx superpowers-manager prepare.",
        );
        return { status: 0, envelopes, lines };
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
    // inside invoke(), and presenceFlag/verifyUninstalledResources/
    // reportLegacyState are pure (src/lifecycle.ts's header comment) -- so a
    // post-success cleanup failure is handled by onCleanupFailure above and
    // cannot reach here. Wrapping with `envelopes` anyway keeps the class
    // total over its declared contract rather than assuming the callback's
    // purity at the throw site.
    throw new GatherFailure(cause, envelopes);
  }
}

export async function runUninstall(
  argv: readonly string[],
  ctx: CommandContext,
): Promise<number> {
  // scripts/uninstall never reads "$@", so extra arguments are silently
  // ignored -- the same asymmetry runPrepare documents
  // (src/commands/prepare.ts:507).
  void argv;
  let run: GatherRun;
  try {
    run = await gatherUninstall(ctx);
  } catch (cause) {
    // gatherUninstall throws exactly one shape: GatherFailure, wrapping
    // withWorkspace's "cannot create workspace" SafetyError
    // (src/workspace.ts:120), alongside whatever envelopes were collected
    // before that throw -- none, for that cause. Replaying first, before
    // reporting the cause, keeps the arm honest for any envelope-bearing
    // throw the class is declared to carry (DIAG-ADAPTER-01). The
    // post-success cleanup failure no longer arrives here: gatherUninstall's
    // onCleanupFailure records it as `cleanupWarning` and the computed
    // outcome survives, which is what scripts/uninstall:34-35 did. The
    // `instanceof` guard is defensive rather than load-bearing --
    // gatherUninstall's own catch is the only thing that can throw here, and
    // it always wraps -- but this catch does not assume that invariant
    // blindly.
    //
    // ctx.adapter's non-AdapterFailure rethrow (src/adapter.ts:1009) does NOT
    // reach here: invoke() catches it inside gatherUninstall and converts it
    // to a hand-written message carried as UninstallOutcome data, exactly as
    // src/commands/probe.ts's inspect() does for the same cause.
    //
    // gatherUninstall performs no writes of its own, so this catch cannot
    // also be reached by an EPIPE from uninstall's own output -- every write
    // below runs only after this try/catch has resolved.
    const envelopes =
      cause instanceof GatherFailure ? cause.envelopes : ([] as const);
    for (const envelope of envelopes) replayEnvelope(envelope, ctx);
    const inner = cause instanceof GatherFailure ? cause.inner : cause;
    ctx.stderr.write(`error: ${oneLine(inner)}\n`);
    return 1;
  }
  const { outcome, cleanupWarning } = run;
  // Replay first, on both paths: the shell validator replayed every
  // response's messages whether or not that response was a failure
  // (scripts/core/validate-adapter-response.py:268).
  for (const envelope of outcome.envelopes) replayEnvelope(envelope, ctx);
  let status: number;
  if (outcome.status === 1) {
    // null means replayEnvelope already emitted the adapter's own error:
    // and hint: lines for the failing envelope.
    if (outcome.message !== null) {
      ctx.stderr.write(`error: ${outcome.message}\n`);
    }
    status = 1;
  } else {
    for (const line of outcome.lines) {
      ctx.stdout.write(`${line}\n`);
    }
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

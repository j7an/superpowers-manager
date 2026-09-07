// Ports scripts/uninstall. The shell sourced common.sh, provenance.sh,
// lifecycle.sh and adapter.sh; the predicates now live in src/lifecycle.ts
// and the adapter arrives through ctx.adapter.
import { tmpdir } from "node:os";
import type { AdapterOutcome, AdapterResult } from "../adapter-result.ts";
import { oneLine } from "../cli-arguments.ts";
import type { Output } from "../harness.ts";
import { withWorkspace, workspaceRemovalFailure } from "../workspace.ts";
import type { CommandContext } from "./context.ts";
import { runWithMutation } from "./mutation.ts";
import { replayOutcome } from "./probe.ts";

type StageResult<T> =
  | {
      readonly ok: true;
      readonly result: {
        readonly status: 0;
        readonly outcome: Extract<AdapterOutcome<T>, { readonly ok: true }>;
      };
    }
  | { readonly ok: false; readonly message: string | null };

async function invoke<T>(
  call: () => Promise<AdapterResult<T>>,
  failure: { readonly unexpected: string; readonly invalidStatus: string },
  outcomes: AdapterOutcome<unknown>[],
): Promise<StageResult<T>> {
  let result: AdapterResult<T>;
  try {
    result = await call();
  } catch {
    return { ok: false, message: failure.unexpected };
  }
  outcomes.push(result.outcome);
  const outcome = result.outcome;
  if (result.status !== 0 || !outcome.ok) {
    return {
      ok: false,
      message: outcome.ok ? failure.invalidStatus : null,
    };
  }
  return {
    ok: true,
    result: { status: result.status, outcome },
  };
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

// withWorkspace throws for mkdtemp failure before the callback ever runs
// ("cannot create workspace",
// `src/workspace.ts:120::throw new SafetyError("workspace", "cannot create workspace"`).
// A bare re-throw would silently drop every outcome collected before that
// point -- a narrow
// DIAG-ADAPTER-01 regression the shell never had, since it replayed each
// adapter response as it went rather than batching replay to the end. This
// carries the outcomes collected so far alongside the original cause, so
// runUninstall's catch can still replay them before reporting the cause.
//
// The post-success cleanup failure no longer reaches here: onCleanupFailure
// below suppresses withWorkspace's throw for that case and records the
// warning as data, so the computed UninstallOutcome survives it. The
// outcome-carrying is still load-bearing for mkdtemp, and the shape stays
// identical to src/commands/install.ts's GatherFailure.
class GatherFailure extends Error {
  readonly inner: unknown;
  readonly outcomes: readonly AdapterOutcome<unknown>[];

  constructor(inner: unknown, outcomes: readonly AdapterOutcome<unknown>[]) {
    super("uninstall gather failed");
    this.inner = inner;
    this.outcomes = outcomes;
  }
}

// Mirrors src/commands/install.ts's StageRun, and for the same reason:
// carries a post-success workspace-removal failure WITHOUT discarding the
// outcome the callback already computed.
//
// `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/uninstall:34-35::complete` echoed both closing lines before the exit trap ran,
// and
// `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/common.sh:25-30::spw_cleanup_workspace_trap(`
// is `rm -rf "$path" || :` -- the shell swallowed the removal failure outright
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
// performing NO writes. Same shape as gatherProbe
// (`src/commands/probe.ts::readonly facts: ProbeSnapshot<R>;`) and for the same
// reason: a write inside this try could raise EPIPE, be caught here, and be
// relabelled as a domain failure.
async function gatherUninstall<R>(ctx: CommandContext<R>): Promise<GatherRun> {
  // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/uninstall:20-21::TMPDIR=` exported TMPDIR="$uninstall_workspace" so every
  // child confined its temporary files to the tree the workspace trap
  // removed. The AdapterContext passed to ctx.adapter below does the same.
  const parent = ctx.env.TMPDIR ?? tmpdir();
  // Declared OUTSIDE the withWorkspace callback (rather than inside, as an
  // earlier draft had it) so the catch below -- which wraps the ENTIRE
  // withWorkspace call, not just the callback -- can still see whatever was
  // collected before a workspace throw. Both `mkdtemp` failure (nothing
  // collected yet) and a post-success cleanup failure (everything the
  // callback collected) reach this same array.
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

        // Stage 3: inspect ownership AGAIN. This overwrites the first
        // inspection (`git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/uninstall:29-30::spw_verify_uninstalled_resources`), so everything below reads the
        // POST-uninstall state, not the pre-uninstall one read above.
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
    // inside invoke(), and presenceFlag/verifyUninstalledResources/
    // reportLegacyState are pure (src/lifecycle.ts's header comment) -- so a
    // post-success cleanup failure is handled by onCleanupFailure above and
    // cannot reach here. Wrapping with `outcomes` anyway keeps the class
    // total over its declared contract rather than assuming the callback's
    // purity at the throw site.
    throw new GatherFailure(cause, outcomes);
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
    // gatherUninstall throws exactly one shape: GatherFailure, wrapping
    // withWorkspace's "cannot create workspace" SafetyError
    // (`src/workspace.ts:120::throw new SafetyError("workspace", "cannot create workspace"`),
    // alongside whatever outcomes were collected before that throw -- none,
    // for that cause. Replaying first, before
    // reporting the cause, keeps the arm honest for any outcome-bearing
    // throw the class is declared to carry (DIAG-ADAPTER-01). The
    // post-success cleanup failure no longer arrives here: gatherUninstall's
    // onCleanupFailure records it as `cleanupWarning` and the computed
    // outcome survives, which is what `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/uninstall:34-35::complete` did. The
    // `instanceof` guard is defensive rather than load-bearing --
    // gatherUninstall's own catch is the only thing that can throw here, and
    // it always wraps -- but this catch does not assume that invariant
    // blindly.
    //
    // A cause outside ctx.adapter's AdapterFailure guard
    // (`src/adapter.ts:973-999::async function runCodexOperation(`) does NOT
    // reach here: invoke() catches it inside gatherUninstall and converts it
    // to a hand-written message carried as UninstallOutcome data, exactly as
    // src/commands/probe.ts's inspect() does for the same cause.
    //
    // gatherUninstall performs no writes of its own, so this catch cannot
    // also be reached by an EPIPE from uninstall's own output -- every write
    // below runs only after this try/catch has resolved.
    const outcomes =
      cause instanceof GatherFailure ? cause.outcomes : ([] as const);
    for (const outcome of outcomes) replayOutcome(outcome, ctx);
    const inner = cause instanceof GatherFailure ? cause.inner : cause;
    ctx.stderr.write(`error: ${oneLine(inner)}\n`);
    return 1;
  }
  const { outcome, cleanupWarning } = run;
  // Replay first, on both paths: the shell validator replayed every
  // response's messages whether or not that response was a failure
  // (`git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/validate-adapter-response.py:268::replay(messages)`).
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

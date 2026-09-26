import { mkdir } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

import type { AdapterOutcome } from "../adapter-result.ts";
import { atomicReplaceDir } from "../atomic.ts";
import { oneLine } from "../cli-arguments.ts";
import { computeEffectiveSelection } from "../effective-selection.ts";
import { runGit } from "../git.ts";
import type { PreparationLocation } from "../harness.ts";
import { isDirectory } from "../safe-path.ts";
import { SafetyError } from "../safety-error.ts";
import {
  fetchExactCommit,
  gitSafeSource,
  upstreamCacheRoot,
} from "../upstream.ts";
import {
  BOUNDED_EXECUTABLE,
  launchFailureMessage,
  resolveValidator,
  runValidator,
  displayPath,
  type Captured,
  type ValidatorResolution,
} from "../validator.ts";
import {
  withWorkspaceReporting,
  type ReportedWorkspace,
} from "../workspace.ts";
import type { CommandContext } from "./context.ts";
import { invoke } from "./adapter-call.ts";
import { replayOutcome } from "./probe.ts";
import { runWithMutation } from "./mutation.ts";

// Every message this module writes is hand-written here. The cause is attached
// for debuggability and never reaches a stream: oneLine (src/cli-arguments.ts)
// reads .message only. Same arrangement as hookError
// (`src/harnesses/codex/hooks.ts:45::function hookError`).
function prepareError(message: string, cause?: unknown): SafetyError {
  return new SafetyError("prepare", message, { cause });
}

// mkdir throws raw ErrnoExceptions. Every command-owned call goes through here
// so the message on the stream is this module's, not Node's.
async function owned<T>(message: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (cause) {
    throw prepareError(message, cause);
  }
}

// Each stream's marker goes to that stream's own destination, so a reader of either
// sees its own truncation and neither is silently short.
function withTruncationMarker(captured: Captured, stream: string): string {
  if (captured.droppedBytes === 0) return captured.text;
  return `${captured.text}\n[superpowers-manager: validator ${stream} truncated, ${captured.droppedBytes} bytes dropped]\n`;
}

// D8's disclosure. The variable is ambient process env and nothing filters it, so a
// consumer's CI can set it; naming what actually ran is what makes a supply-chain
// surprise visible. Paths go through displayPath, so a control character in either
// one cannot reach the terminal raw.
function disclosureLine(resolution: ValidatorResolution): string {
  const configured = displayPath(resolution.configured);
  if (resolution.resolved === null) {
    // The manager does not know the final target and does not pretend to. But a
    // dangling symlink is a KNOWN fact even when resolution fails, and saying "the
    // OS selects it" about a path-like value would be wrong.
    if (resolution.isSymlink) {
      return `[superpowers-manager: running external validator ${configured} (a symlink whose target could not be resolved)]\n`;
    }
    if (configured.includes(sep)) {
      return `[superpowers-manager: running external validator ${configured} (unresolved)]\n`;
    }
    return `[superpowers-manager: running external validator ${configured} (a bare name; PATH selects the file, and the manager does not guess which)]\n`;
  }
  const via = resolution.isSymlink ? " via symlink" : "";
  return `[superpowers-manager: running external validator ${configured}${via} -> ${displayPath(resolution.resolved)}]\n`;
}

interface ValidatorOutput {
  readonly stdout: string;
  readonly stderr: string;
}

const NO_VALIDATOR_OUTPUT: ValidatorOutput = { stdout: "", stderr: "" };

type PrepareOutcome =
  | {
      readonly kind: "ok";
      readonly outcomes: readonly AdapterOutcome<unknown>[];
      readonly validator: ValidatorOutput;
      readonly resolvedRef: string;
      readonly commit: string;
    }
  | {
      readonly kind: "failed";
      readonly outcomes: readonly AdapterOutcome<unknown>[];
      readonly validator: ValidatorOutput;
      // null when the replayed outcome already carries the diagnostic.
      readonly message: string | null;
    };

async function gatherPrepare<R>(
  ctx: CommandContext<R>,
  location: PreparationLocation,
): Promise<ReportedWorkspace<PrepareOutcome>> {
  // Collect outcomes without writing so output failures cannot be classified as
  // inspection failures. Replay collected outcomes after gathering completes.
  const env = ctx.env;
  const cache = upstreamCacheRoot(ctx.root, env);
  const cacheParent = dirname(cache);
  const adapterContext = { root: ctx.root, env };
  const pluginRoot = location.destinationRoot;
  const executableValidator = env.SUPERPOWERS_VALIDATOR_EXECUTABLE || "";
  const tmpParent = dirname(pluginRoot);
  const outcomes: AdapterOutcome<unknown>[] = [];
  const failed = (message: string | null): PrepareOutcome => ({
    kind: "failed",
    outcomes,
    validator: NO_VALIDATOR_OUTPUT,
    message,
  });
  const selection =
    ctx.selection ?? (await computeEffectiveSelection(ctx.root, env));
  // callFailure only formats strings; computing it once up front is safe.
  const failure = ctx.adapter.presentation.callFailure(
    "prepare",
    adapterContext,
  );
  const prefetch = await invoke(
    () => ctx.adapter.validatePreparationBeforeFetch(adapterContext),
    failure,
    outcomes,
  );
  if (!prefetch.ok) {
    return { value: failed(prefetch.message), cleanupWarning: null };
  }
  await owned(`cannot create directory: ${tmpParent}`, () =>
    mkdir(tmpParent, { recursive: true }),
  );

  return await withWorkspaceReporting(
    tmpParent,
    ".superpowers.prepare.",
    async (workspace): Promise<PrepareOutcome> => {
      const candidate = join(workspace, location.stagingLeaf);
      await owned(`cannot create directory: ${cacheParent}`, () =>
        mkdir(cacheParent, { recursive: true }),
      );

      if (selection.selectionMode === "pinned") {
        await fetchExactCommit(
          selection.effectiveSource,
          selection.desiredCommit,
          cache,
          workspace,
        );
      } else {
        const source = gitSafeSource(selection.effectiveSource);
        // `[ -d ]` — `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/prepare:50::if [ -d`. A regular file named `.git` is what a git
        // worktree or `clone --separate-git-dir` leaves behind; `-e` would take the
        // fetch branch and let git follow its `gitdir:` pointer, where the shell took
        // the clone branch. `src/upstream.ts:323::if (!(await isDirectory` makes the
        // same distinction.
        if (await isDirectory(join(cache, ".git"))) {
          const fetched = await runGit([
            "-C",
            cache,
            "fetch",
            "--tags",
            "--prune",
            "--",
            source,
          ]);
          // runGit returns its status rather than throwing, so no git output is
          // in scope. `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/prepare:52::spw_die "cannot fetch` names the source and nothing else, and
          // computeEffectiveSelection ran validateSource first, so a
          // credential-bearing source never reaches here.
          if (fetched.status !== 0) {
            return failed(
              `cannot fetch upstream repo: ${selection.effectiveSource}`,
            );
          }
        } else {
          const cloned = await runGit(["clone", "--", source, cache]);
          if (cloned.status !== 0) {
            return failed(
              `cannot clone upstream repo: ${selection.effectiveSource}`,
            );
          }
        }
      }

      const checkedOut = await runGit([
        "-C",
        cache,
        "checkout",
        "--detach",
        selection.desiredCommit,
      ]);
      if (checkedOut.status !== 0) {
        return failed(
          `cannot check out upstream commit: ${selection.desiredCommit}`,
        );
      }

      const prepared = await invoke(
        () =>
          ctx.adapter.prepareCandidate(
            {
              upstreamRoot: cache,
              workspaceRoot: workspace,
              candidateRoot: candidate,
              selection,
            },
            adapterContext,
          ),
        failure,
        outcomes,
      );
      if (!prepared.ok) return failed(prepared.message);
      const candidateResult = prepared.result.outcome.result;
      if (candidateResult.root !== candidate) {
        return failed("adapter returned an unexpected preparation root");
      }
      if (candidateResult.commit !== selection.desiredCommit) {
        return failed("adapter returned an unexpected preparation commit");
      }
      if (candidateResult.compatibility.kind === "unsupported") {
        return failed(candidateResult.compatibility.reason);
      }
      let validator = NO_VALIDATOR_OUTPUT;
      if (executableValidator.length > 0) {
        const resolution = await resolveValidator(executableValidator);
        const ran = await runValidator(
          [executableValidator, candidate],
          BOUNDED_EXECUTABLE,
          env,
          workspace,
        );
        // The disclosure lands BEFORE any early return, so a launch failure still
        // reports what the manager tried to run and what it resolved to — exactly
        // the path where an operator most needs it. It is assigned twice rather
        // than once because `launchFailed` carries no captured streams: there was
        // no process to capture from.
        validator = { stdout: disclosureLine(resolution), stderr: "" };
        if (ran.kind === "launchFailed") {
          return {
            kind: "failed",
            outcomes,
            validator,
            message: launchFailureMessage(ran.errno, resolution),
          };
        }
        validator = {
          stdout:
            disclosureLine(resolution) +
            withTruncationMarker(ran.stdout, "stdout"),
          stderr: withTruncationMarker(ran.stderr, "stderr"),
        };
        if (ran.kind === "timedOut") {
          return {
            kind: "failed",
            outcomes,
            validator,
            message: `external plugin validation timed out after ${Math.round(ran.afterMs / 1000)}s`,
          };
        }
        if (ran.code !== 0) {
          return {
            kind: "failed",
            outcomes,
            validator,
            message: "external plugin validation failed",
          };
        }
      }

      // The swap must run inside the workspace callback: withWorkspace removes
      // the workspace on return, and the candidate lives in it.
      //
      // atomicReplaceDir delegates to beginDirectoryPublication, whose outer
      // catch (`src/atomic.ts:315::if (cause`) wraps every non-SafetyError
      // into a SafetyError, so the callee owns every failure on this path and
      // re-emitting its own diagnostic is the sanctioned form of interpolation.
      // The hand-written prefix carries the live root, which the callee's message
      // does not.
      try {
        await atomicReplaceDir(candidate, pluginRoot);
      } catch (cause) {
        return {
          kind: "failed",
          outcomes,
          validator,
          message: `cannot install generated tree into ${pluginRoot}: ${oneLine(cause)}`,
        };
      }

      return {
        kind: "ok",
        outcomes,
        validator,
        resolvedRef: selection.resolvedRef,
        commit: selection.desiredCommit,
      };
    },
  );
}

export async function runPrepare<R>(
  argv: readonly string[],
  ctx: CommandContext<R>,
): Promise<number> {
  // argv is ignored: scripts/prepare never read "$@". Probe, by contrast,
  // rejects extra arguments in the CLI parser.
  return await runWithMutation("prepare", ctx, async (scoped, location) =>
    performPrepare(scoped, location),
  );
}

async function performPrepare<R>(
  ctx: CommandContext<R>,
  location: PreparationLocation,
): Promise<number> {
  let run: ReportedWorkspace<PrepareOutcome>;
  try {
    run = await gatherPrepare(ctx, location);
  } catch (cause) {
    // Reader wrappers supply their own diagnostics. The saved-selection read
    // path retains its sanctioned interpolation at
    // `src/selection-store.ts:116-121::if (cause instanceof SafetyError && cause.module === "selection") {`.
    // oneLine() bounds any inherited git or filesystem diagnostic to one line.
    ctx.stderr.write(`error: ${oneLine(cause)}\n`);
    return 1;
  }
  const { value: outcome, cleanupWarning } = run;
  for (const each of outcome.outcomes) replayOutcome(each, ctx);
  if (outcome.validator.stdout.length > 0) {
    ctx.stdout.write(outcome.validator.stdout);
  }
  if (outcome.validator.stderr.length > 0) {
    ctx.stderr.write(outcome.validator.stderr);
  }
  let status: number;
  if (outcome.kind === "failed") {
    if (outcome.message !== null) {
      ctx.stderr.write(`error: ${outcome.message}\n`);
    }
    status = 1;
  } else {
    ctx.stdout.write(`prepared ${outcome.resolvedRef} at ${outcome.commit}\n`);
    status = 0;
  }
  if (cleanupWarning !== null) {
    // A leaked workspace is reported even when the outcome above was itself a
    // success: the generated-tree replacement that produced it already
    // completed before cleanup ran, so it is not being reported as unverified
    // -- but something did still go wrong, and AGENTS.md's fail-closed rule
    // extends to it. Mirrors
    // `src/commands/install.ts:372::if (cleanupWarning`.
    ctx.stderr.write(`error: ${cleanupWarning}\n`);
    return 1;
  }
  return status;
}

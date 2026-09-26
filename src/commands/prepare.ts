import { mkdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";

import type { AdapterOutcome } from "../adapter-result.ts";
import { atomicReplaceDir } from "../atomic.ts";
import { oneLine } from "../cli-arguments.ts";
import { computeEffectiveSelection } from "../effective-selection.ts";
import { runGit } from "../git.ts";
import type { PreparationLocation } from "../harness.ts";
import { SafetyError } from "../safety-error.ts";
import { fetchExactCommit, gitSafeSource } from "../upstream.ts";
import { upstreamCacheRoot } from "../upstream-workspace.ts";
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
import { replayOutcome } from "./probe.ts";
import { runWithMutation } from "./mutation.ts";

// Every message this module writes is hand-written here. The cause is attached
// for debuggability and never reaches a stream: oneLine (src/cli-arguments.ts)
// reads .message only. Same arrangement as hookError
// (`src/harnesses/codex/hooks.ts:44::function hookError`).
function prepareError(message: string, cause?: unknown): SafetyError {
  return new SafetyError("prepare", message, { cause });
}

// `[ -d ]` — `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/prepare:50::if [ -d`. A regular file named `.git` is what a git
// worktree or `clone --separate-git-dir` leaves behind; `-e` would take the
// fetch branch and let git follow its `gitdir:` pointer, where the shell took
// the clone branch. `src/upstream.ts:332::if (!(await isDirectory` makes the
// same distinction.
async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
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

function validStagingLeaf(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

async function gatherPrepare<R>(
  ctx: CommandContext<R>,
): Promise<ReportedWorkspace<PrepareOutcome>> {
  // Collect outcomes without writing so output failures cannot be classified as
  // inspection failures. Replay collected outcomes after gathering completes.
  const env = ctx.env;
  const cwd = process.cwd();
  const cache = upstreamCacheRoot(ctx.root, env, cwd);
  const cacheParent = dirname(cache);
  const adapterContext = { root: ctx.root, env };
  let location: PreparationLocation;
  try {
    location = ctx.adapter.preparationLocation(adapterContext);
  } catch (cause) {
    throw prepareError("cannot determine preparation location", cause);
  }
  if (!isAbsolute(location.destinationRoot)) {
    throw prepareError(
      "adapter returned a non-absolute preparation destination",
    );
  }
  if (!validStagingLeaf(location.stagingLeaf)) {
    throw prepareError("adapter returned an invalid preparation staging leaf");
  }
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
  let prefetch;
  try {
    prefetch = await ctx.adapter.validatePreparationBeforeFetch(adapterContext);
  } catch {
    return {
      value: failed(
        ctx.adapter.presentation.callFailure("prepare", adapterContext)
          .unexpected,
      ),
      cleanupWarning: null,
    };
  }
  outcomes.push(prefetch.outcome);
  if (!prefetch.outcome.ok)
    return { value: failed(null), cleanupWarning: null };
  if (prefetch.status !== 0) {
    return {
      value: failed(
        ctx.adapter.presentation.callFailure("prepare", adapterContext)
          .invalidStatus,
      ),
      cleanupWarning: null,
    };
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
        if (await directoryExists(join(cache, ".git"))) {
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

      let prepared;
      try {
        prepared = await ctx.adapter.prepareCandidate(
          {
            upstreamRoot: cache,
            workspaceRoot: workspace,
            candidateRoot: candidate,
            selection,
          },
          adapterContext,
        );
      } catch {
        return failed(
          ctx.adapter.presentation.callFailure("prepare", adapterContext)
            .unexpected,
        );
      }
      outcomes.push(prepared.outcome);
      if (prepared.status !== 0 || !prepared.outcome.ok) {
        return failed(
          prepared.outcome.ok
            ? ctx.adapter.presentation.callFailure("prepare", adapterContext)
                .invalidStatus
            : null,
        );
      }
      if (prepared.outcome.result.root !== candidate) {
        return failed("adapter returned an unexpected preparation root");
      }
      if (prepared.outcome.result.commit !== selection.desiredCommit) {
        return failed("adapter returned an unexpected preparation commit");
      }
      if (prepared.outcome.result.compatibility.kind === "unsupported") {
        return failed(prepared.outcome.result.compatibility.reason);
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
      // catch (`src/atomic.ts:319::if (cause`) wraps every non-SafetyError
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
  return await runWithMutation("prepare", ctx, async (scoped) =>
    performPrepare(argv, scoped),
  );
}

async function performPrepare<R>(
  argv: readonly string[],
  ctx: CommandContext<R>,
): Promise<number> {
  // scripts/prepare never reads "$@", so extra arguments are ignored. This is a
  // deliberate asymmetry with probe, whose shell original rejected unknown
  // arguments and whose arity therefore moved into parseArgs in slice 2.
  void argv;
  let run: ReportedWorkspace<PrepareOutcome>;
  try {
    run = await gatherPrepare(ctx);
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
    // `src/commands/install.ts:425::if (cleanupWarning`.
    ctx.stderr.write(`error: ${cleanupWarning}\n`);
    return 1;
  }
  return status;
}

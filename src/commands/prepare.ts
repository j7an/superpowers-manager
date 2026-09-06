import { mkdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import type { AdapterOutcome } from "../adapter-result.ts";
import { atomicReplaceDir } from "../atomic.ts";
import { oneLine } from "../cli-arguments.ts";
import { computeEffectiveSelection } from "../effective-selection.ts";
import { runGit } from "../git.ts";
import type { PreparationLocation } from "../harness.ts";
import { SafetyError } from "../safety-error.ts";
import { fetchExactCommit, gitSafeSource } from "../upstream.ts";
import {
  BOUNDED_EXECUTABLE,
  UNBOUNDED_LEGACY,
  launchFailureMessage,
  resolveValidator,
  runValidator,
  displayPath,
  type Captured,
  type ValidatorResolution,
} from "../validator.ts";
import { withWorkspace, workspaceRemovalFailure } from "../workspace.ts";
import type { CommandContext } from "./context.ts";
import { replayOutcome } from "./probe.ts";

// Every message this module writes is hand-written here. The cause is attached
// for debuggability and never reaches a stream: oneLine (src/cli-arguments.ts)
// reads .message only. Same arrangement as hookError
// (`src/hooks.ts:44::function hookError`).
function prepareError(message: string, cause?: unknown): SafetyError {
  return new SafetyError("prepare", message, { cause });
}

// `[ -f ]` — regular file. `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/prepare:108::[ -f "$additional_validator` uses -f, and
// tests/baseline/cli-parity.test.js's "CLI-ENV-MANIFEST-TEMPLATE-01 fallback
// template bytes and non-file rejection" also covers the separately extracted
// fallback check.
async function regularFileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
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

// Carries a post-success workspace-removal failure WITHOUT discarding the
// PrepareOutcome the callback already computed. See the header comment on
// withWorkspace's onCleanupFailure option
// (`src/workspace.ts:99-107::interface`).
//
// Deliberately NOT a copy of src/commands/install.ts's StageRun comment.
// StageRun documents a precondition that its callback never throws, so it has
// no "callback also failed" case to lose the cleanup message to. That
// precondition does NOT hold here: the additional-validator branch below
// itself throws prepareError when the shared runner (src/validator.ts)
// settles a launchFailed result from a legacy-validator spawn failure, and
// withWorkspace THROWS the callback error on that path
// (`src/workspace.ts:136-137::} catch (cleanupError`, :141) without ever
// consulting the reporter below.
// The outcomes the callback below collected into its `outcomes` array are
// lost there. That is a separate, unassigned defect -- the callback-throw
// path discards them -- and it is out of scope here: this type fixes only
// the post-success cleanup case, and its existence should not be read as
// covering the other.
interface PrepareRun {
  readonly outcome: PrepareOutcome;
  readonly cleanupWarning: string | null;
}

function validStagingLeaf(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

async function gatherPrepare<R>(ctx: CommandContext<R>): Promise<PrepareRun> {
  const env = ctx.env;
  // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/prepare:16::invocation_root=` — captured before the two case statements below.
  // getcwd(3) returns the physical path, so this matches `pwd -P` without a
  // realpath call.
  const cwd = process.cwd();
  const configuredCache =
    env.SUPERPOWERS_CACHE_DIR || join(ctx.root, ".cache", "upstream");
  const cacheParent = isAbsolute(configuredCache)
    ? configuredCache
    : resolve(cwd, configuredCache);
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
  const additionalValidator = env.SUPERPOWERS_VALIDATOR || "";
  const executableValidator = env.SUPERPOWERS_VALIDATOR_EXECUTABLE || "";
  const cache = join(cacheParent, "superpowers");
  const tmpParent = dirname(pluginRoot);
  await owned(`cannot create directory: ${tmpParent}`, () =>
    mkdir(tmpParent, { recursive: true }),
  );

  let cleanupWarning: string | null = null;
  const outcome = await withWorkspace(
    tmpParent,
    ".superpowers.prepare.",
    async (workspace): Promise<PrepareOutcome> => {
      const outcomes: AdapterOutcome<unknown>[] = [];
      const failed = (message: string | null): PrepareOutcome => ({
        kind: "failed",
        outcomes,
        validator: NO_VALIDATOR_OUTPUT,
        message,
      });
      const candidate = join(workspace, location.stagingLeaf);
      const selection = await computeEffectiveSelection(ctx.root, env);
      let prefetch;
      try {
        prefetch =
          await ctx.adapter.validatePreparationBeforeFetch(adapterContext);
      } catch {
        return failed(
          ctx.adapter.presentation.callFailure("prepare", adapterContext)
            .unexpected,
        );
      }
      outcomes.push(prefetch.outcome);
      if (!prefetch.outcome.ok) return failed(null);
      if (prefetch.status !== 0) {
        return failed(
          ctx.adapter.presentation.callFailure("prepare", adapterContext)
            .invalidStatus,
        );
      }
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
      if (additionalValidator.length > 0) {
        // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/prepare:108::[ -f "$additional_validator` — `[ -f ]`.
        if (!(await regularFileExists(additionalValidator))) {
          return {
            kind: "failed",
            outcomes,
            validator,
            message: `additional plugin validator not found: ${additionalValidator}`,
          };
        }
        const ran = await runValidator(
          ["python3", additionalValidator, candidate],
          UNBOUNDED_LEGACY,
          env,
          workspace,
        );
        if (ran.kind === "launchFailed") {
          // PARITY, and it must stay a THROW. The legacy path rejects the workspace
          // callback on a spawn failure; withWorkspace returns the callback error
          // and the `outcomes` collected above are LOST. That loss is a recorded,
          // deliberately unassigned defect. Returning a failed outcome here would
          // replay those outcomes instead -- observably different control flow for
          // CLI-ENV-VALIDATOR-01, which this PR is not authorized to change.
          throw prepareError(
            `cannot execute additional plugin validator: ${additionalValidator}`,
            ran.cause,
          );
        }
        validator = { stdout: ran.stdout.text, stderr: ran.stderr.text };
        if (ran.kind !== "exited" || ran.code !== 0) {
          return {
            kind: "failed",
            outcomes,
            validator,
            message: "additional plugin validation failed",
          };
        }
      } else if (executableValidator.length > 0) {
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
      // atomicReplaceDir's outer catch (`src/atomic.ts:208-215::if (cause`) wraps every
      // non-SafetyError into a SafetyError, so the callee owns every failure on
      // this path and re-emitting its own diagnostic is the sanctioned form of
      // interpolation. The hand-written prefix carries the live root, which the
      // callee's message does not.
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
    {
      // Suppresses withWorkspace's throw on a POST-SUCCESS cleanup failure, so
      // the PrepareOutcome the callback already computed still reaches
      // runPrepare instead of being discarded. The reporter runs synchronously,
      // as the option requires (`src/workspace.ts:103-106::Must`).
      onCleanupFailure: (path) => {
        cleanupWarning = workspaceRemovalFailure(path);
      },
    },
  );
  return { outcome, cleanupWarning };
}

export async function runPrepare<R>(
  argv: readonly string[],
  ctx: CommandContext<R>,
): Promise<number> {
  // scripts/prepare never reads "$@", so extra arguments are ignored. This is a
  // deliberate asymmetry with probe, whose shell original rejected unknown
  // arguments and whose arity therefore moved into parseArgs in slice 2.
  void argv;
  let run: PrepareRun;
  try {
    run = await gatherPrepare(ctx);
  } catch (cause) {
    // Hand-written messages, per AGENTS.md's reader-diagnostics rule.
    // Reachable here: prepareError(), from this module's owned() wrappers,
    // its two manifest-version checks, asResolutionKind, and the
    // additional-validator branch's own throw on a legacy-validator launch
    // failure (its cause is the shared runner's (src/validator.ts) captured
    // spawn error, which oneLine never reads -- it takes .message only);
    // readManifest's three hookError messages
    // (`src/hooks.ts:113-138::readManifest`), pinned by
    // `tests/unit/hooks.test.ts:95::void test("readManifest diagnostics` as carrying no reader vocabulary or
    // errno; and SafetyErrors from gitSafeSource, writeProvenance, and
    // withWorkspace.
    //
    // FOUR exceptions, all inherited and none a regression:
    //   1. resolveRef splices git's combined stdout+stderr into its own text
    //      on the NON-PINNED path (src/upstream.ts), reached via
    //      computeEffectiveSelection (src/effective-selection.ts).
    //      This is the DEFAULT invocation -- plain `prepare`, `track-latest`,
    //      and any non-40-hex SUPERPOWERS_REF -- not an exotic corner. Pinned
    //      by
    //      `tests/unit/upstream.test.ts:453-462::void test("resolveRef reports a query failure for latest`,
    //      :471-481, and :483-501.
    //   2. fetchExactCommit splices the same combined stdout+stderr into its
    //      own text on the PINNED path (both of its own splice sites in
    //      src/upstream.ts, and proveCommit's, which it calls). This is the
    //      rarer of the two raw-git-output paths, not the only one.
    //   3. `src/selection-store.ts:120-124::cause.module === "selection") {`
    //      (same shape at :49, :86, :98) is the
    //      module AGENTS.md's `src/selection-store.ts` bullet grandfathers:
    //      it interpolates the caught error's own message, so Node errno
    //      prose can reach this stream -- sanctioned, nothing here needs
    //      fixing.
    //   4. Every runGit call site in this module (fetch, clone, checkout) can
    //      reject instead of resolving: `src/git.ts:47-52::reject(new SafetyError` wraps every string
    //      errno other than ENOENT in
    //      `new SafetyError("git", \`cannot run git: ${failure.message}\`)`,
    //      and that Node spawn-level message reaches ctx.stderr through this
    //      catch. So the claim that the non-pinned clone/fetch/checkout
    //      branch names only the source is true for a non-zero *exit status*
    //      (handled explicitly below, in gatherPrepare) but false for a
    //      *spawn-level* failure -- runGit throws rather than returning a
    //      status in that case, and this outer catch is what stands between
    //      it and the stream.
    //
    // oneLine() at this catch collapses each of exceptions 1, 2, and 4 -- the
    // three carrying git-derived text -- to a single line. It collapses CR/LF
    // only, so it bounds how much of that text lands, not what it may
    // contain.
    //
    // runAdapter's closing `throw cause` (src/adapter.ts) does NOT arrive
    // here -- the call site catches it and converts it to a hand-written
    // message per AGENTS.md's reader-diagnostics rule.
    //
    // gatherPrepare performs no writes of its own, so this catch cannot also be
    // reached by an EPIPE from prepare's own output: every write below runs
    // only after this try/catch has resolved.
    ctx.stderr.write(`error: ${oneLine(cause)}\n`);
    return 1;
  }
  const { outcome, cleanupWarning } = run;
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
    // `src/commands/install.ts:395-403::if (cleanupWarning`.
    ctx.stderr.write(`error: ${cleanupWarning}\n`);
    return 1;
  }
  return status;
}

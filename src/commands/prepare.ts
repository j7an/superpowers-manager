import { spawn } from "node:child_process";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { AdapterEnvelope, AdapterResult } from "../adapter-protocol.js";
import { atomicReplaceDir } from "../atomic.js";
import { oneLine } from "../cli-arguments.js";
import { computeEffectiveSelection } from "../effective-selection.js";
import { runGit } from "../git.js";
import { readManifest } from "../hooks.js";
import { writeProvenance } from "../provenance.js";
import { SafetyError } from "../safety-error.js";
import type { ResolutionKind } from "../upstream-version.js";
import { manifestVersionForRef } from "../upstream-version.js";
import { fetchExactCommit, gitSafeSource } from "../upstream.js";
import { withWorkspace } from "../workspace.js";
import type { CommandContext } from "./context.js";

// scripts/prepare:64-67, via spw_require_upstream_path. Order is the shell's;
// the first miss wins.
const REQUIRED_UPSTREAM = [
  { path: "skills", label: "skills/" },
  { path: "LICENSE", label: "LICENSE" },
  { path: "README.md", label: "README.md" },
  { path: "CODE_OF_CONDUCT.md", label: "CODE_OF_CONDUCT.md" },
] as const;

// scripts/prepare:73-77. Same names on both sides.
const COPY_PATHS = [
  "skills",
  "assets",
  "LICENSE",
  "README.md",
  "CODE_OF_CONDUCT.md",
] as const;

const RESOLUTION_KINDS: readonly ResolutionKind[] = [
  "latest-release",
  "tag",
  "ref",
  "raw-commit",
];

// Every message this module writes is hand-written here. The cause is attached
// for debuggability and never reaches a stream: oneLine (src/cli-arguments.ts)
// reads .message only. Same arrangement as hookError (src/hooks.ts:40).
function prepareError(message: string, cause?: unknown): SafetyError {
  return new SafetyError("prepare", message, { cause });
}

// `[ -e ]` — follows symlinks, so a dangling link is absent to the shell too.
// Two call sites, each mirroring a distinct `-e` in the shell: the
// REQUIRED_UPSTREAM loop (spw_require_upstream_path, common.sh:53-59 — e.g.
// skills/ is a directory, not a regular file) and copyPathIfPresent's guard
// (spw_copy_path_if_present's `[ -e "$src" ]`, common.sh:44-51). The `.git`
// check below is NOT a third site: it needs `-d` (F1), not `-e`, and uses
// directoryExists instead.
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// `[ -f ]` — regular file. scripts/prepare:42, :80, and :108 all use -f, and
// tests/baseline/cli-parity.test.js:1190 asserts a DIRECTORY passed as
// SUPERPOWERS_MANIFEST_TEMPLATE is rejected before any adapter build. A
// stat-only predicate would accept it.
async function regularFileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

// `[ -d ]` — scripts/prepare:50. A regular file named `.git` is what a git
// worktree or `clone --separate-git-dir` leaves behind; `-e` would take the
// fetch branch and let git follow its `gitdir:` pointer, where the shell took
// the clone branch. src/upstream.ts:330 makes the same distinction.
async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

// mkdir, cp, and rm throw raw ErrnoExceptions. Every prepare-owned call goes
// through here so the message on the stream is this module's, not Node's.
async function owned<T>(message: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (cause) {
    throw prepareError(message, cause);
  }
}

// scripts/core/common.sh:44-51. `cp -R` copies symlinks AS symlinks;
// fs.cp's default rewrites relative link targets against the destination,
// which would change what the adapter's containment checks see.
async function copyPathIfPresent(
  source: string,
  destination: string,
): Promise<void> {
  if (!(await pathExists(source))) return;
  await owned(`cannot clear candidate path: ${destination}`, () =>
    rm(destination, { recursive: true, force: true }),
  );
  await owned(`cannot copy upstream path into candidate: ${source}`, () =>
    cp(source, destination, { recursive: true, verbatimSymlinks: true }),
  );
}

// scripts/prepare:17-24. Only cache_parent and plugin_root are resolved against
// the invocation cwd; manifest_template (:14) is not.
function resolveFromCwd(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolve(cwd, value);
}

// readManifest (src/hooks.ts:109) owns the read and the parse completely: byte
// read so invalid UTF-8 is rejected rather than replaced, cause dropped, three
// hand-written messages naming the path, object check included. Its
// diagnostics are pinned by tests/unit/hooks.test.js:95. This wrapper adds only
// the `version` type check.
export async function readUpstreamManifestVersion(
  path: string,
): Promise<string> {
  const manifest = await readManifest(path);
  const value = manifest.version;
  // scripts/core/provenance.sh:56-62 — absent key and JSON null both yield "".
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    // The shell stringified any other type through Python's print()
    // (provenance.sh:62), so `"version": 6` became "6" and flowed into both the
    // provenance record and --upstream-manifest-version. Fail closed instead.
    // Spec divergence 7.
    throw prepareError(`upstream manifest version is not a string: ${path}`);
  }
  return value;
}

function asResolutionKind(value: string): ResolutionKind {
  for (const kind of RESOLUTION_KINDS) {
    if (kind === value) return kind;
  }
  throw prepareError(`unknown upstream resolution kind: ${value}`);
}

interface ValidatorOutput {
  readonly stdout: string;
  readonly stderr: string;
}

const NO_VALIDATOR_OUTPUT: ValidatorOutput = { stdout: "", stderr: "" };

type PrepareOutcome =
  | {
      readonly kind: "ok";
      readonly envelopes: readonly AdapterEnvelope[];
      readonly validator: ValidatorOutput;
      readonly resolvedRef: string;
      readonly commit: string;
    }
  | {
      readonly kind: "failed";
      readonly envelopes: readonly AdapterEnvelope[];
      readonly validator: ValidatorOutput;
      // null when the replayed envelope already carries the diagnostic.
      readonly message: string | null;
    };

// Identical to src/commands/probe.ts's replayEnvelope, and identical for the
// same reason: scripts/core/validate-adapter-response.py:235-272 replayed every
// response's messages whether or not that response failed.
//
// Interpolating error.message and each hint is the sanctioned form: none of
// src/adapter.ts's fail() sites interpolates a caught error's message, so the
// callee owns every failure reachable on this path.
//
// This WRITES, so it must never be called from inside gatherPrepare.
function replayEnvelope(envelope: AdapterEnvelope, ctx: CommandContext): void {
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

// scripts/prepare:107-113, ported verbatim per the parent spec's D1: no
// timeout, no output cap, no executable policy. Those ten sub-decisions belong
// to SUPERPOWERS_VALIDATOR_EXECUTABLE in PR 11.6.
//
// Output is captured rather than inherited so it reaches ctx.stdout/stderr
// instead of the real process streams. That buffers it until the command ends;
// the shell streamed it live. Spec divergence 8.
//
// scripts/prepare:35-36 exported TMPDIR="$prepare_workspace" so every child
// confined its temporary files to the tree the workspace trap removed. This
// child still does. The in-process adapter build does NOT: src/adapter.ts:335
// calls withWorkspace(tmpdir(), ...) and os.tmpdir() reads process.env, never
// ctx.env, so its build workspace lands in the ambient temp dir. Setting
// process.env.TMPDIR around the call would be a process-global mutation inside
// a library function and is unsafe under the concurrent suite; the adapter
// removes its own workspace, so the residue is bounded. Spec divergence 9.
function runValidator(
  validator: string,
  candidate: string,
  env: NodeJS.ProcessEnv,
  workspace: string,
): Promise<{ readonly code: number | null } & ValidatorOutput> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("python3", [validator, candidate], {
      env: { ...process.env, ...env, TMPDIR: workspace },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (cause) => {
      rejectPromise(
        prepareError(
          `cannot execute additional plugin validator: ${validator}`,
          cause,
        ),
      );
    });
    child.on("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

async function gatherPrepare(ctx: CommandContext): Promise<PrepareOutcome> {
  const env = ctx.env;
  // scripts/prepare:16 — captured before the two case statements below.
  // getcwd(3) returns the physical path, so this matches `pwd -P` without a
  // realpath call.
  const cwd = process.cwd();
  const cacheParent = resolveFromCwd(
    env.SUPERPOWERS_CACHE_DIR || join(ctx.root, ".cache", "upstream"),
    cwd,
  );
  const pluginRoot = resolveFromCwd(
    env.SUPERPOWERS_PLUGIN_ROOT || join(ctx.root, "plugins", "superpowers"),
    cwd,
  );
  const manifestTemplate =
    env.SUPERPOWERS_MANIFEST_TEMPLATE ||
    join(
      ctx.root,
      "plugins",
      "superpowers",
      ".codex-plugin",
      "plugin.template.json",
    );
  const additionalValidator = env.SUPERPOWERS_VALIDATOR || "";
  const cache = join(cacheParent, "superpowers");
  const tmpParent = dirname(pluginRoot);
  await owned(`cannot create directory: ${tmpParent}`, () =>
    mkdir(tmpParent, { recursive: true }),
  );

  return await withWorkspace(
    tmpParent,
    ".superpowers.prepare.",
    async (workspace): Promise<PrepareOutcome> => {
      const failed = (message: string): PrepareOutcome => ({
        kind: "failed",
        envelopes: [],
        validator: NO_VALIDATOR_OUTPUT,
        message,
      });
      const candidate = join(workspace, "superpowers");
      const selection = await computeEffectiveSelection(ctx.root, env);
      // scripts/prepare:42 — `[ -f ]`.
      if (!(await regularFileExists(manifestTemplate))) {
        return failed(
          `missing fallback manifest template: ${manifestTemplate}`,
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
          // in scope. scripts/prepare:52 names the source and nothing else, and
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

      for (const required of REQUIRED_UPSTREAM) {
        // spw_require_upstream_path is `[ -e ]`, not `[ -f ]`: skills/ is a
        // directory.
        if (!(await pathExists(join(cache, required.path)))) {
          return failed(`required upstream path missing: ${required.label}`);
        }
      }

      await owned(`cannot clear candidate root: ${candidate}`, () =>
        rm(candidate, { recursive: true, force: true }),
      );
      await owned(`cannot create candidate root: ${candidate}`, () =>
        mkdir(join(candidate, ".codex-plugin"), { recursive: true }),
      );
      for (const name of COPY_PATHS) {
        await copyPathIfPresent(join(cache, name), join(candidate, name));
      }

      const upstreamManifest = join(cache, ".codex-plugin", "plugin.json");
      let upstreamManifestVersion = "";
      // scripts/prepare:80 — `[ -f ]`.
      if (await regularFileExists(upstreamManifest)) {
        upstreamManifestVersion =
          await readUpstreamManifestVersion(upstreamManifest);
      }

      await writeProvenance(join(candidate, ".superpowers-upstream.json"), {
        source: selection.effectiveSource,
        requested_ref: selection.requestedRef,
        resolved_ref: selection.resolvedRef,
        commit: selection.desiredCommit,
        upstream_manifest_version: upstreamManifestVersion,
      });

      const managerVersion = manifestVersionForRef({
        requestedRef: selection.requestedRef,
        resolutionKind: asResolutionKind(selection.resolutionKind),
        resolvedRef: selection.resolvedRef,
        commit: selection.desiredCommit,
      });

      let built: AdapterResult;
      try {
        built = await ctx.adapter(
          [
            "build",
            "--upstream-root",
            cache,
            "--candidate-root",
            candidate,
            "--requested-ref",
            selection.requestedRef,
            "--resolved-ref",
            selection.resolvedRef,
            "--commit",
            selection.desiredCommit,
            "--manager-version",
            managerVersion,
            "--upstream-manifest-version",
            upstreamManifestVersion,
            "--fallback-manifest",
            manifestTemplate,
          ],
          { root: ctx.root, env },
        );
      } catch {
        // ctx.adapter reports CONTROLLED failures by return value
        // (src/adapter-protocol.ts:34-37) but still THROWS for a
        // non-AdapterFailure cause (src/adapter.ts:1009). That cause is by
        // construction the one failure src/adapter.ts declined to own, so its
        // text must never reach ctx.stderr. Caught here rather than in
        // runPrepare's outer catch, the same treatment
        // src/commands/probe.ts:206-228 gives it.
        return failed("cannot build the generated plugin candidate");
      }
      const envelopes = [built.envelope];
      if (built.status !== 0 || !built.envelope.ok) {
        return {
          kind: "failed",
          envelopes,
          validator: NO_VALIDATOR_OUTPUT,
          // replayEnvelope emits the adapter's own error and hints; a second
          // line here would duplicate them. The `ok && status !== 0`
          // combination cannot arise from successResult/failureResult, so it
          // gets its own hand-written message rather than a silent replay.
          message: built.envelope.ok
            ? "adapter reported failure without an error envelope"
            : null,
        };
      }

      let validator = NO_VALIDATOR_OUTPUT;
      if (additionalValidator.length > 0) {
        // scripts/prepare:108 — `[ -f ]`.
        if (!(await regularFileExists(additionalValidator))) {
          return {
            kind: "failed",
            envelopes,
            validator,
            message: `additional plugin validator not found: ${additionalValidator}`,
          };
        }
        const ran = await runValidator(
          additionalValidator,
          candidate,
          env,
          workspace,
        );
        validator = { stdout: ran.stdout, stderr: ran.stderr };
        if (ran.code !== 0) {
          return {
            kind: "failed",
            envelopes,
            validator,
            message: "additional plugin validation failed",
          };
        }
      }

      // The swap must run inside the workspace callback: withWorkspace removes
      // the workspace on return, and the candidate lives in it.
      //
      // atomicReplaceDir's outer catch (src/atomic.ts:208-215) wraps every
      // non-SafetyError into a SafetyError, so the callee owns every failure on
      // this path and re-emitting its own diagnostic is the sanctioned form of
      // interpolation. The hand-written prefix carries the live root, which the
      // callee's message does not.
      try {
        await atomicReplaceDir(candidate, pluginRoot);
      } catch (cause) {
        return {
          kind: "failed",
          envelopes,
          validator,
          message: `cannot install generated tree into ${pluginRoot}: ${oneLine(cause)}`,
        };
      }

      return {
        kind: "ok",
        envelopes,
        validator,
        resolvedRef: selection.resolvedRef,
        commit: selection.desiredCommit,
      };
    },
  );
}

export async function runPrepare(
  argv: readonly string[],
  ctx: CommandContext,
): Promise<number> {
  // scripts/prepare never reads "$@", so extra arguments are ignored. This is a
  // deliberate asymmetry with probe, whose shell original rejected unknown
  // arguments and whose arity therefore moved into parseArgs in slice 2.
  void argv;
  let outcome: PrepareOutcome;
  try {
    outcome = await gatherPrepare(ctx);
  } catch (cause) {
    // Every throw reachable here carries a HAND-WRITTEN message:
    //   - prepareError(), from this module's owned() wrappers, its two
    //     manifest-version checks, asResolutionKind, and runValidator's spawn
    //     failure. owned() attaches the raw ErrnoException as `cause`, which
    //     oneLine never reads -- it takes .message only.
    //   - readManifest's three hookError messages (src/hooks.ts:109-134),
    //     pinned by tests/unit/hooks.test.js:95 as carrying no reader
    //     vocabulary or errno.
    //   - SafetyErrors from gitSafeSource, writeProvenance, and withWorkspace.
    //
    // FOUR exceptions, all inherited and none a regression:
    //   1. resolveRef splices git's combined stdout+stderr into its own text
    //      on the NON-PINNED path (src/upstream.ts:150, :175, :191), reached
    //      via computeEffectiveSelection (src/effective-selection.ts:133).
    //      This is the DEFAULT invocation -- plain `prepare`, `track-latest`,
    //      and any non-40-hex SUPERPOWERS_REF -- not an exotic corner. Pinned
    //      by tests/unit/upstream.test.js:460-469, :471-481, and :483-501.
    //   2. fetchExactCommit splices the same combined stdout+stderr into its
    //      own text on the PINNED path (src/upstream.ts:334, :349, and
    //      proveCommit via :262). This is the rarer of the two raw-git-output
    //      paths, not the only one.
    //   3. src/selection-store.ts:124 (same shape at :49, :86, :98)
    //      interpolates the caught error's own message, so Node errno prose
    //      (e.g. "EACCES: permission denied, open '<path>'") can reach this
    //      stream. AGENTS.md explicitly grandfathers this module's wording,
    //      so this is sanctioned behaviour -- nothing here needs fixing.
    //   4. Every runGit call site in this module (fetch, clone, checkout) can
    //      reject instead of resolving: src/git.ts:47-51 wraps every string
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
    // scripts/prepare piped comparable text through spw_upstream_cli's
    // `spw_die "${_upstream_out#error: }"`, and oneLine() here collapses each
    // of exceptions 1, 2, and 4 to one line, containing the harm to one line
    // of git text rather than the arbitrarily many the shell original
    // allowed.
    //
    // runAdapter's rethrow (src/adapter.ts:1009) does NOT arrive here -- the
    // call site catches it and converts it to a hand-written message.
    //
    // gatherPrepare performs no writes of its own, so this catch cannot also be
    // reached by an EPIPE from prepare's own output: every write below runs
    // only after this try/catch has resolved.
    ctx.stderr.write(`error: ${oneLine(cause)}\n`);
    return 1;
  }
  for (const envelope of outcome.envelopes) replayEnvelope(envelope, ctx);
  if (outcome.validator.stdout.length > 0) {
    ctx.stdout.write(outcome.validator.stdout);
  }
  if (outcome.validator.stderr.length > 0) {
    ctx.stderr.write(outcome.validator.stderr);
  }
  if (outcome.kind === "failed") {
    if (outcome.message !== null) {
      ctx.stderr.write(`error: ${outcome.message}\n`);
    }
    return 1;
  }
  ctx.stdout.write(`prepared ${outcome.resolvedRef} at ${outcome.commit}\n`);
  return 0;
}

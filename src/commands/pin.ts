// FROZEN CITATIONS: `scripts/…:NN` references below resolve against the tree at
// 349fe2ed405b371ec2de1347bb3fc50c6bc15dc4, the last commit in which scripts/pin existed; it differs because
// scripts/pin was deleted before the common citation anchor. They are unmaintained and will not be re-derived. Resolve one with:
//   git show 349fe2ed405b371ec2de1347bb3fc50c6bc15dc4:scripts/pin

import { tmpdir } from "node:os";
import { oneLine } from "../cli-arguments.js";
import { isTagRef, normalizeCommitInput } from "../domain/refs.js";
import {
  loadSavedSelection,
  selectionStatePath,
  UPSTREAM_URL_DEFAULT,
} from "../effective-selection.js";
import { normalizePinnedArguments, validateSource } from "../selection.js";
import { writeSelectionState } from "../selection-store.js";
import { resolveExactTag, verifyRawCommit } from "../upstream.js";
import type { CommandContext } from "./context.js";

// The one success shape pin can produce, carried out of the try in runPin
// below so the confirmation write happens only once resolution and the state
// write have both already succeeded — see runPin for why nothing may write
// inside that try.
interface PinResult {
  readonly resolvedRef: string;
  readonly commit: string;
}

// Runs every step that can throw, and performs no writes of its own: that is
// the point of this shape (mirrors src/commands/unpin.ts's attemptUnpin) —
// runPin's try (below) can therefore never itself raise EPIPE, since nothing
// left inside it writes to a stream.
async function attemptPin(
  requested: string,
  ctx: CommandContext,
): Promise<PinResult> {
  // Read first. This is a deliberate redundant boundary check, not the
  // enforcing guard: writeSelectionState below already refuses to overwrite
  // a corrupt existing record on its own (src/selection-store.ts's
  // writeSelectionState calls readSelectionState on the same path before
  // writing, under "Invalid existing state must block overwrite" —
  // readSelectionState's own readOpenedRecord/parseRecordBytes is what
  // validates an existing record, via validateRecord at
  // `src/selection-store.ts:103::return validateRecord`). Calling loadSavedSelection here preserves
  // `git show 349fe2ed405b371ec2de1347bb3fc50c6bc15dc4:scripts/pin:26-27::read`'s read-then-resolve-then-write shape, so this command
  // stays fail-closed on its own terms rather than solely by depending on the
  // store's internals.
  await loadSavedSelection(ctx.env);
  const source = ctx.env.SUPERPOWERS_UPSTREAM_URL || UPSTREAM_URL_DEFAULT;
  validateSource(source);

  let resolvedRef: string;
  let commit: string;
  if (isTagRef(requested)) {
    resolvedRef = requested;
    commit = await resolveExactTag(source, requested);
  } else {
    // `git show 349fe2ed405b371ec2de1347bb3fc50c6bc15dc4:scripts/pin:39::upper` lowercases a raw-commit request before use; both
    // requested_ref and resolved_ref end up equal to the normalized commit.
    resolvedRef = normalizeCommitInput(requested)!;
    commit = await verifyRawCommit(source, resolvedRef, tmpdir());
  }

  await writeSelectionState(
    selectionStatePath(ctx.env),
    normalizePinnedArguments({
      source,
      requestedRef: resolvedRef,
      resolvedRef,
      commit,
    }),
  );
  return { resolvedRef, commit };
}

export async function runPin(
  argv: readonly string[],
  ctx: CommandContext,
): Promise<number> {
  // Arity and ref syntax are already decided in src/cli.ts's parseArgs (the
  // TAG_RE / COMMIT_INPUT_RE check ahead of dispatch) and must not be
  // duplicated here — one source, checked before any tool lookup.
  const requested = argv[0]!;
  let result: PinResult;
  try {
    result = await attemptPin(requested, ctx);
  } catch (cause) {
    // Every throw reachable here is a hand-written SafetyError from
    // loadSavedSelection, validateSource, resolveExactTag, verifyRawCommit,
    // or writeSelectionState — re-emitting a subordinate module's own
    // diagnostic is the sanctioned form of interpolation (see AGENTS.md's
    // diagnostics convention). That does not make every such message clean:
    // resolveExactTag's and verifyRawCommit's SafetyErrors splice git's own
    // combined stdout+stderr into their text (src/upstream.ts's `combined()`,
    // used at :219 for `ls-remote` and :262 for `init`), so raw git output can
    // reach ctx.stderr through this catch. Not a regression — scripts/pin
    // piped git's output into its own error text the same way — but `pin` is
    // the first in-process command able to surface it. oneLine() collapses
    // that spliced output to one line, containing the harm to one line of
    // git text rather than the arbitrarily many the shell original allowed.
    // attemptPin performs no writes of its own (see above), so this catch
    // cannot also be reached by an EPIPE from a write this function made
    // itself — the write below runs only after this try/catch has already
    // resolved.
    ctx.stderr.write(`error: ${oneLine(cause)}\n`);
    return 1;
  }
  ctx.stdout.write(
    `pinned upstream selection to ${result.resolvedRef} at ${result.commit}\n`,
  );
  return 0;
}

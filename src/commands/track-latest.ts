import { oneLine } from "../cli-arguments.ts";
import {
  selectionStatePath,
  loadSavedSelection,
  UPSTREAM_URL_DEFAULT,
} from "../effective-selection.ts";
import { validateSource } from "../selection.ts";
import { writeSelectionState } from "../selection-store.ts";
import type { CommandContext } from "./context.ts";

export async function runTrackLatest(
  argv: readonly string[],
  ctx: CommandContext,
): Promise<number> {
  if (argv.length !== 0) {
    ctx.stderr.write("error: usage: superpowers-manager track-latest\n");
    return 2;
  }
  try {
    // Read first. This is a deliberate redundant boundary check, not the
    // enforcing guard: writeSelectionState below already refuses to overwrite
    // a corrupt existing record on its own (src/selection-store.ts's
    // writeSelectionState calls readSelectionState on the same path before
    // writing, under "Invalid existing state must block overwrite" —
    // readSelectionState's own readOpenedRecord/parseRecordBytes is what
    // validates an existing record, via validateRecord at
    // `src/selection-store.ts:103::return validateRecord`). Calling loadSavedSelection here preserves
    // `git show 349fe2ed405b371ec2de1347bb3fc50c6bc15dc4:scripts/track-latest:20-21::read`'s read-then-write shape, so this command
    // stays fail-closed on its own terms rather than solely by depending on
    // the store's internals.
    await loadSavedSelection(ctx.env);
    const source = ctx.env.SUPERPOWERS_UPSTREAM_URL || UPSTREAM_URL_DEFAULT;
    validateSource(source);
    await writeSelectionState(selectionStatePath(ctx.env), {
      schema_version: 1,
      mode: "track-latest",
      source,
    });
  } catch (cause) {
    // Every throw reachable here is a hand-written SafetyError from
    // loadSavedSelection, validateSource, selectionStatePath, or
    // writeSelectionState — re-emitting a subordinate module's own
    // diagnostic is the sanctioned form of interpolation (see AGENTS.md's
    // diagnostics convention). The try ends here, before the stdout write
    // below: an EPIPE from that write must never be caught and relabelled
    // as one of those modules' own diagnostics.
    ctx.stderr.write(`error: ${oneLine(cause)}\n`);
    return 1;
  }
  ctx.stdout.write("saved upstream selection: latest stable release\n");
  return 0;
}

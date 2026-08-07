import { lstat, unlink } from "node:fs/promises";
import { selectionStatePath } from "../effective-selection.js";
import { selectionError } from "../selection.js";
import { readConfigRef } from "../upstream.js";
import type { CommandContext } from "./context.js";

const NOT_REGULAR =
  "selection state path is not a regular file; remove it manually after inspecting";

// Runs every step that can throw or fail closed, and returns either the exit
// code for a decided-in-try outcome (a diagnostic already written to stderr)
// or the data the success path needs to compose its stdout message.
async function attemptUnpin(
  ctx: CommandContext,
): Promise<number | { removed: boolean; fallback: string }> {
  const statePath = selectionStatePath(ctx.env);
  // The packaged fallback ignores an active SUPERPOWERS_REF: scripts/unpin:12
  // cleared it deliberately so the reported value is the packaged one.
  const fallback = await readConfigRef(ctx.root, {
    ...ctx.env,
    SUPERPOWERS_REF: "",
  });

  // Only a validated ENOENT means "absent". Treating every errno as absence
  // turns EACCES or ENOTDIR into `no saved upstream selection` and exit 0 —
  // reporting unverifiable state as success, which the fail-closed rule forbids.
  // The shell could not draw this distinction ([ -e ] cannot), so this is a
  // deliberate narrowing beyond parity, recorded as a port-only inventory entry.
  const inspect = async (path: string) => {
    try {
      return await lstat(path);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw selectionError(`cannot inspect selection state: ${path}`);
    }
  };

  let removed = false;
  const info = await inspect(statePath);
  if (info !== null) {
    if (!info.isFile()) {
      ctx.stderr.write(`error: ${NOT_REGULAR}: ${statePath}\n`);
      return 1;
    }
    try {
      await unlink(statePath);
    } catch {
      ctx.stderr.write(`error: cannot remove selection state: ${statePath}\n`);
      return 1;
    }
    removed = true;
  }

  // Same classification on the verification read: an EACCES here must not be
  // read as "successfully absent".
  if ((await inspect(statePath)) !== null) {
    ctx.stderr.write(
      `error: selection state remains after removal attempt: ${statePath}\n`,
    );
    return 1;
  }

  return { removed, fallback };
}

export async function runUnpin(
  argv: readonly string[],
  ctx: CommandContext,
): Promise<number> {
  if (argv.length !== 0) {
    ctx.stderr.write("error: usage: superpowers-manager unpin\n");
    return 2;
  }
  let outcome: number | { removed: boolean; fallback: string };
  try {
    outcome = await attemptUnpin(ctx);
  } catch (cause) {
    // Every throw reachable here is a hand-written SafetyError from
    // selectionStatePath, readConfigRef, or inspect() inside attemptUnpin —
    // re-emitting a subordinate module's own diagnostic is the sanctioned
    // form of interpolation (see AGENTS.md's diagnostics convention). The try
    // ends here, before the stdout writes below: an EPIPE from one of those
    // writes must never be caught and relabelled as one of those modules'
    // own diagnostics.
    ctx.stderr.write(
      `error: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
    return 1;
  }
  if (typeof outcome === "number") return outcome;
  const { removed, fallback } = outcome;
  ctx.stdout.write(
    removed
      ? `removed saved upstream selection; packaged fallback is ${fallback}\n`
      : `no saved upstream selection; packaged fallback is ${fallback}\n`,
  );
  if (ctx.env.SUPERPOWERS_REF) {
    ctx.stdout.write(
      "note: active SUPERPOWERS_REF override remains effective\n",
    );
  }
  if (ctx.env.SUPERPOWERS_UPSTREAM_URL) {
    ctx.stdout.write(
      "note: active SUPERPOWERS_UPSTREAM_URL override remains effective\n",
    );
  }
  return 0;
}

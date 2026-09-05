import { lstat, unlink } from "node:fs/promises";
import { oneLine } from "../cli-arguments.ts";
import { selectionStatePath } from "../effective-selection.ts";
import { selectionError } from "../selection.ts";
import { readConfigRef } from "../upstream.ts";
import type { CommandContext } from "./context.ts";

const NOT_REGULAR =
  "selection state path is not a regular file; remove it manually after inspecting";

// Every decided-in-attempt outcome, success or failure, carries its message
// or data as plain returned values rather than writing to a stream directly.
// That is the point of this shape: attemptUnpin performs no I/O writes of its
// own, so nothing inside runUnpin's try (below) can raise EPIPE — there is
// nothing left in there that writes.
type UnpinOutcome =
  | { readonly status: 1; readonly message: string }
  | {
      readonly status: 0;
      readonly removed: boolean;
      readonly fallback: string;
    };

// Runs every step that can throw or fail closed, returning the outcome as
// data instead of writing it — see UnpinOutcome above for why.
async function attemptUnpin(ctx: CommandContext): Promise<UnpinOutcome> {
  const statePath = selectionStatePath(ctx.env);
  // The packaged fallback ignores an active SUPERPOWERS_REF: `git show 349fe2ed405b371ec2de1347bb3fc50c6bc15dc4:scripts/unpin:12::spw_config_ref`
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
      return { status: 1, message: `${NOT_REGULAR}: ${statePath}` };
    }
    try {
      await unlink(statePath);
    } catch {
      return {
        status: 1,
        message: `cannot remove selection state: ${statePath}`,
      };
    }
    removed = true;
  }

  // Same classification on the verification read: an EACCES here must not be
  // read as "successfully absent".
  if ((await inspect(statePath)) !== null) {
    return {
      status: 1,
      message: `selection state remains after removal attempt: ${statePath}`,
    };
  }

  return { status: 0, removed, fallback };
}

export async function runUnpin(
  argv: readonly string[],
  ctx: CommandContext,
): Promise<number> {
  if (argv.length !== 0) {
    ctx.stderr.write("error: usage: superpowers-manager unpin\n");
    return 2;
  }
  let outcome: UnpinOutcome;
  try {
    outcome = await attemptUnpin(ctx);
  } catch (cause) {
    // Every throw reachable here is a hand-written SafetyError from
    // selectionStatePath, readConfigRef, or inspect() inside attemptUnpin —
    // re-emitting a subordinate module's own diagnostic is the sanctioned
    // form of interpolation (see AGENTS.md's diagnostics convention).
    // attemptUnpin performs no writes of its own (see UnpinOutcome above),
    // so this catch cannot also be reached by an EPIPE from a write this
    // function made itself — the write below runs only after this try/catch
    // has already resolved.
    ctx.stderr.write(`error: ${oneLine(cause)}\n`);
    return 1;
  }
  if (outcome.status === 1) {
    ctx.stderr.write(`error: ${outcome.message}\n`);
    return 1;
  }
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

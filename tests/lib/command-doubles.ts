import assert from "node:assert/strict";

/**
 * A ctx.adapter stand-in for command modules that never reach the adapter
 * (pin, track-latest, unpin, and the prepare/probe cases that fail before
 * inspecting or building).
 *
 * The throw is loud only for a caller that does not catch it. Neither prepare
 * nor probe is such a caller: gatherPrepare (after building the adapter
 * build argv) and probe's `inspect` helper both wrap the adapter
 * call in a `catch` that turns any thrown error — this one included — into
 * a hand-written, status-1 diagnostic. So on those two paths, reaching this
 * double by mistake does NOT surface as an uncaught throw; it surfaces only if
 * the test's own assertions are tight enough to notice the resulting
 * diagnostic (e.g. an exact `stderr` match) rather than a loose one (e.g.
 * `status === 1` plus a `doesNotMatch`, which a build-call diagnostic still
 * satisfies).
 * Callers that route this double through prepare or probe MUST assert
 * precisely enough to make that diagnostic visible — the double alone does
 * not guarantee it.
 */
export async function notCalledAdapter(
  _argv: readonly string[],
): Promise<never> {
  throw new Error("ctx.adapter must not be called by this command path");
}

export function capture(): {
  stream: NodeJS.WritableStream;
  text: () => string;
} {
  const chunks: string[] = [];
  return {
    stream: {
      write(text: string) {
        chunks.push(text);
        return true;
      },
    } as unknown as NodeJS.WritableStream,
    text: () => chunks.join(""),
  };
}

export function scriptedAdapter(
  responses: readonly import("../../src/adapter-result.ts").AdapterResult[],
) {
  const calls: string[][] = [];
  let index = 0;
  return {
    calls,

    adapter: (async (argv) => {
      calls.push([...argv]);
      const response = responses[index++];
      // Exhaustion is a FAILURE, not an empty answer. A double that runs out
      // and returns a benign value satisfies every absence assertion while
      // proving nothing -- the vacuity mode this slice exists to avoid.
      assert.ok(
        response !== undefined,
        `scriptedAdapter exhausted at call ${index}: ${argv.join(" ")}`,
      );
      return response;
    }) as import("../../src/commands/context.ts").CommandContext["adapter"],
  };
}

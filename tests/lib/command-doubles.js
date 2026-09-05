// @ts-check
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
 * @param {readonly string[]} _argv
 * @returns {Promise<never>}
 */
export async function notCalledAdapter(_argv) {
  throw new Error("ctx.adapter must not be called by this command path");
}

/** @returns {{ stream: NodeJS.WritableStream, text: () => string }} */
export function capture() {
  /** @type {string[]} */
  const chunks = [];
  return {
    stream: /** @type {NodeJS.WritableStream} */ (
      /** @type {unknown} */ ({
        write(/** @type {string} */ text) {
          chunks.push(text);
          return true;
        },
      })
    ),
    text: () => chunks.join(""),
  };
}

/** @param {readonly import("../../src/adapter-result.js").AdapterResult[]} responses */
export function scriptedAdapter(responses) {
  /** @type {string[][]} */
  const calls = [];
  let index = 0;
  return {
    calls,
    /** @type {import("../../src/commands/context.js").CommandContext["adapter"]} */
    adapter: async (argv) => {
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
    },
  };
}

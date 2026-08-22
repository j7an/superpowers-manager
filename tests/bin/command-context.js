// @ts-check
// The in-process half of D4. A case holding an injected recording adapter
// calls the command function DIRECTLY, so its assertion is a structural claim
// about which adapter operations were issued -- not a text search over a log
// file that stops existing when the seam does.
//
// Classes 3 and 4 get STRONGER here. Today they assert the string
// "update-control" is absent from adapter.log; with a double they assert no
// `inspect --view update-control` call was made.

import assert from "node:assert/strict";
import { join, resolve, sep } from "node:path";
import { SCRATCH, UPSTREAM } from "./lifecycle-fixture.js";

/**
 * The env allowlist runScript builds in tests/bin/lifecycle-fixture.js. It
 * used to be that list minus SPW_ADAPTER, because an in-process subject never
 * read it and leaving it in would have let a case look seam-wired when it was
 * not. The seam is retired, so no context carries it and there is nothing
 * left to subtract.
 * @param {import("./lifecycle-fixture.js").CaseEnv} c
 * @param {Record<string, string>} [extra]
 * @returns {NodeJS.ProcessEnv}
 */
export function caseEnvVars(c, extra = {}) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: c.home,
    XDG_CONFIG_HOME: join(c.home, ".config"),
    TMPDIR: c.tmp,
    SPW_FIXTURE_STATE: c.state,
    SPW_TEST_PKG_ROOT: c.pkg,
    SUPERPOWERS_CODEX: c.codexBin,
    SUPERPOWERS_UPSTREAM_URL: UPSTREAM,
    SUPERPOWERS_INSTALLED_SEARCH_ROOT: join(c.state, "codex-home"),
    ...extra,
  };
}

/**
 * Records every argv and answers from `handler`. Exhaustion is a FAILURE:
 * a double that runs out and returns a benign value satisfies every absence
 * assertion while proving nothing.
 * @param {(argv: readonly string[], call: number) => unknown} handler
 */
export function recordingAdapter(handler) {
  /** @type {string[][]} */
  const calls = [];
  /**
   * @param {readonly string[]} argv
   * @param {import("../../src/adapter-result.js").AdapterContext} _ctx
   * @returns {Promise<import("../../src/adapter-result.js").AdapterResult>}
   */
  const adapter = async (argv, _ctx) => {
    const copy = [...argv];
    calls.push(copy);
    let answer;
    try {
      answer = handler(copy, calls.length);
    } catch (cause) {
      assert.fail(
        `recordingAdapter: handler threw for call ${calls.length} ` +
          `(${copy.join(" ")}): ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    // Exhaustion is a FAILURE, not an empty answer. A double that runs out
    // and returns a benign value satisfies every absence assertion while
    // proving nothing -- the vacuity mode this slice exists to avoid.
    assert.ok(
      answer !== undefined,
      `recordingAdapter exhausted at call ${calls.length}: ${copy.join(" ")}`,
    );
    return /** @type {import("../../src/adapter-result.js").AdapterResult} */ (
      answer
    );
  };
  adapter.calls = calls;
  return adapter;
}

/**
 * @param {import("./lifecycle-fixture.js").CaseEnv} c
 * @param {{ adapter: ReturnType<typeof recordingAdapter>, env?: Record<string, string> }} options
 * @returns {{ ctx: import("../../src/commands/context.js").CommandContext, stdout: () => string, stderr: () => string }}
 */
export function caseContext(c, options) {
  // Resolved, segment-aware containment, copied from runScript
  // (tests/bin/lifecycle-fixture.js:279-288): a lexical startsWith() also
  // accepts a sibling whose name merely extends the scratch path, so it would
  // not actually prevent an in-process command from mutating the real
  // checkout.
  const resolvedPkg = resolve(c.pkg);
  const resolvedScratch = resolve(SCRATCH);
  if (
    resolvedPkg !== resolvedScratch &&
    !resolvedPkg.startsWith(resolvedScratch + sep)
  ) {
    throw new Error(
      `refusing to build a CommandContext against a package root outside the fixture scratch tree: ${c.pkg}`,
    );
  }
  let stdoutBuf = "";
  let stderrBuf = "";
  const stdout = /** @type {NodeJS.WritableStream} */ (
    /** @type {unknown} */ ({
      write(/** @type {string} */ text) {
        stdoutBuf += text;
        return true;
      },
    })
  );
  const stderr = /** @type {NodeJS.WritableStream} */ (
    /** @type {unknown} */ ({
      write(/** @type {string} */ text) {
        stderrBuf += text;
        return true;
      },
    })
  );
  const ctx =
    /** @type {import("../../src/commands/context.js").CommandContext} */ ({
      root: c.pkg,
      env: caseEnvVars(c, options.env),
      stdout,
      stderr,
      adapter: options.adapter,
    });
  return { ctx, stdout: () => stdoutBuf, stderr: () => stderrBuf };
}

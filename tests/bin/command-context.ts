// The in-process half of D4. A case holding an injected recording adapter
// calls the command function DIRECTLY, so its assertion is a structural claim
// about which adapter operations were issued -- not a text search over a log
// file that stops existing when the seam does.
//
// Classes 3 and 4 got STRONGER here. They used to assert the string
// "update-control" was absent from adapter.log; with a double they assert no
// `inspect --view update-control` call was made.

import assert from "node:assert/strict";
import { join, resolve, sep } from "node:path";
import { SCRATCH, UPSTREAM } from "./lifecycle-fixture.ts";

/**
 * The env allowlist runScript builds in tests/bin/lifecycle-fixture.js. It
 * used to be that list minus SPW_ADAPTER, because an in-process subject never
 * read it and leaving it in would have let a case look seam-wired when it was
 * not. The seam is retired, so no context carries it and there is nothing
 * left to subtract.
 */
export function caseEnvVars(
  c: import("./lifecycle-fixture.ts").CaseEnv,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
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
 */
export function recordingAdapter(
  handler: (argv: readonly string[], call: number) => unknown,
) {
  const calls: string[][] = [];

  const adapter = async (
    argv: readonly string[],
    _ctx: import("../../src/adapter-result.ts").AdapterContext,
  ): Promise<import("../../src/adapter-result.ts").AdapterResult> => {
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
    return answer as import("../../src/adapter-result.ts").AdapterResult;
  };
  adapter.calls = calls;
  return adapter;
}

export function caseContext(
  c: import("./lifecycle-fixture.ts").CaseEnv,
  options: {
    adapter: ReturnType<typeof recordingAdapter>;
    env?: Record<string, string>;
  },
): {
  ctx: import("../../src/commands/context.ts").CommandContext;
  stdout: () => string;
  stderr: () => string;
} {
  // Resolved, segment-aware containment, copied from runScript
  // (`tests/bin/lifecycle-fixture.ts:453-461::const resolvedPkg`): a lexical startsWith() also
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
  const stdout = {
    write(text: string) {
      stdoutBuf += text;
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  const stderr = {
    write(text: string) {
      stderrBuf += text;
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  const ctx = {
    root: c.pkg,
    env: caseEnvVars(c, options.env),
    stdout,
    stderr,
    adapter: options.adapter,
  } as import("../../src/commands/context.ts").CommandContext;
  return { ctx, stdout: () => stdoutBuf, stderr: () => stderrBuf };
}

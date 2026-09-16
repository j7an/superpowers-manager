#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";
import {
  capture,
  notCalledAdapter,
  observingCoordinator,
} from "./helpers/command-harness.ts";

import {
  replayOutcome,
  PROBE_USAGE,
  runProbe,
} from "../../src/commands/probe.ts";

void test("an unrecognised argument is a usage error on stderr", async () => {
  for (const argv of [["--porcelaine"], ["--porcelain", "extra"], ["extra"]]) {
    const out = capture();
    const err = capture();
    const status = await runProbe(argv, {
      root: "/unused",
      env: {},
      stdout: out.stream,
      stderr: err.stream,
      options: { harness: "codex", allowExperimental: false },
      coordination: observingCoordinator(),
      adapter: notCalledAdapter,
    });
    assert.equal(status, 2);
    assert.equal(out.text(), "");
    assert.equal(err.text(), PROBE_USAGE);
  }
});

void test("a thrown selection failure is an operational failure", async () => {
  const out = capture();
  const err = capture();
  // HOME absent and no SUPERPOWERS_CONFIG_DIR: selectionConfigDir throws a
  // hand-written SafetyError before anything else runs.
  const status = await runProbe([], {
    root: "/unused",
    env: {},
    stdout: out.stream,
    stderr: err.stream,
    options: { harness: "codex", allowExperimental: false },
    coordination: observingCoordinator(),
    adapter: notCalledAdapter,
  });
  assert.equal(status, 1);
  assert.equal(out.text(), "");
  assert.equal(
    err.text(),
    "error: HOME is required to locate selection state\n",
  );
});

// --- Outcome replay (spec §3.3, added 2026-08-07 after adjudication) ---
//
// These four cases are supplementary command-boundary witnesses for
// DIAG-ADAPTER-01: per-stream order, error/hint presence and order, no writes
// before the terminal-safety guard, and a quiet clean success. The canonical
// target remains tests/unit/harnesses/codex/adapter.test.ts. ADAPTER-REPLAY-01
// remains retired because it owned validation of a serialized response
// document, absent from this in-process path.

function outcomeWith(
  over: Partial<import("../../src/adapter-result.ts").AdapterOutcome>,
) {
  return {
    operation: "inspect",
    ok: true,
    messages: [],
    result: null,
    error: null,
    ...over,
  } as any;
}

void test("replay writes each message to its declared stream in array order", () => {
  const out = capture();
  const err = capture();
  replayOutcome(
    outcomeWith({
      messages: [
        { channel: "stdout", text: "first" },
        { channel: "stderr", text: "second" },
        { channel: "stdout", text: "third" },
      ],
    }),
    {
      stdout: out.stream,
      stderr: err.stream,
    },
  );
  // Per-stream sequence, so a reversal inside one stream is caught. The
  // cross-stream interleave is not observable through separate captures and
  // is not asserted.
  assert.equal(out.text(), "first\nthird\n");
  assert.equal(err.text(), "second\n");
});

void test("replay emits the error line then one hint line per hint", () => {
  const out = capture();
  const err = capture();
  replayOutcome(
    outcomeWith({
      ok: false,
      messages: [{ channel: "stderr", text: "context" }],
      result: null,
      error: {
        code: "inspect-failed",
        message: "cannot list",
        hints: ["a", "b"],
      },
    }),
    {
      stdout: out.stream,
      stderr: err.stream,
    },
  );
  assert.equal(out.text(), "");
  // Whole-string equality: the messages precede the error, and the hints
  // follow it in array order. Three separate `match` calls would pass on any
  // permutation of the same three lines.
  assert.equal(err.text(), "context\nerror: cannot list\nhint: a\nhint: b\n");

  // The hoist: a failure that will be refused writes NOTHING, not even the
  // messages that precede the error line. Without assertFailureWritable above
  // the message loop, both context lines would already be on their streams
  // when the guard fired on the hint.
  //
  // The poisoned outcome carries a record on EACH channel, and that is the
  // point. replayOutcome routes per record (`message.channel === "stdout" ?
  // ctx.stdout : ctx.stderr`), so a stderr-only outcome makes the
  // `badOut.text() === ""` assertion true by construction: stdout was never
  // going to receive anything, and a hoist split so that stdout messages
  // wrote BEFORE the guard and stderr messages after would stay green. With
  // both channels populated, each exact-empty assertion below constrains its
  // own stream.
  const badOut = capture();
  const badErr = capture();
  assert.throws(
    () =>
      replayOutcome(
        outcomeWith({
          ok: false,
          messages: [
            { channel: "stdout", text: "stdout context" },
            { channel: "stderr", text: "stderr context" },
          ],
          result: null,
          error: {
            code: "inspect-failed",
            message: "cannot list",
            hints: ["fine", "bad\u001bhint"],
          },
        }),
        {
          stdout: badOut.stream,
          stderr: badErr.stream,
        },
      ),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /hint/);
      return true;
    },
  );
  assert.equal(badOut.text(), "");
  assert.equal(badErr.text(), "");
});

void test("replay on a clean success outcome writes nothing", () => {
  const out = capture();
  const err = capture();
  replayOutcome(outcomeWith({}), {
    stdout: out.stream,
    stderr: err.stream,
  });
  assert.equal(out.text(), "");
  assert.equal(err.text(), "");
});

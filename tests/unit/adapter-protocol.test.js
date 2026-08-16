// @ts-check
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { capture } from "./helpers/command-harness.js";

/** @type {typeof import("../../src/adapter-protocol.js")} */
const {
  AdapterMessageLog,
  failureResult,
  pythonUnicodeEscapeBytes,
  serializeEnvelope,
  successResult,
  writeAdapterFailure,
} = await import(
  new URL("../../dist/adapter-protocol.js", import.meta.url).href
);

/** @param {Uint8Array} bytes */
function pythonOracle(bytes) {
  return execFileSync(
    "python3",
    [
      "-S",
      "-c",
      [
        "import sys",
        "value = bytes.fromhex(sys.argv[1])",
        'print(value.decode("utf-8", errors="backslashreplace")',
        '      .encode("unicode_escape").decode("ascii"))',
      ].join("\n"),
      Buffer.from(bytes).toString("hex"),
    ],
    { encoding: "utf8" },
  ).replace(/\n$/, "");
}

void test("command byte escaping matches Python over malformed UTF-8", () => {
  const corpus = [
    Uint8Array.from([]),
    Uint8Array.from([0x61, 0x09, 0x62, 0x0d]),
    Uint8Array.from([0x5c, 0x22, 0xc3, 0xa9]),
    Uint8Array.from([0xe4, 0xb8, 0xad]),
    Uint8Array.from([0xf0, 0x9f, 0x98, 0x80]),
    Uint8Array.from([0xff, 0x61]),
    Uint8Array.from([0xfe, 0x61]),
    Uint8Array.from([0xc2]),
    Uint8Array.from([0xe2, 0x82]),
    Uint8Array.from([0xf0, 0x9f, 0x98]),
    Uint8Array.from([0xc0, 0xaf]),
    Uint8Array.from([0xe0, 0x80, 0xaf]),
    Uint8Array.from([0xf0, 0x80, 0x80, 0xaf]),
    Uint8Array.from([0x80]),
    Uint8Array.from([0xe2, 0x28, 0xa1]),
  ];
  for (const bytes of corpus) {
    assert.equal(
      pythonUnicodeEscapeBytes(bytes),
      pythonOracle(bytes),
      Buffer.from(bytes).toString("hex"),
    );
  }
});

void test("message log splits on LF, drops empty chunks, and keeps channels", () => {
  const log = new AdapterMessageLog();
  log.appendBytes("stderr", Buffer.from("first\n\nsecond\n"));
  log.appendBytes("stdout", Uint8Array.from([0xff, 0x0a]));
  log.appendText("stdout", "literal\\tab\tend");
  assert.deepEqual(log.snapshot(), [
    { channel: "stderr", text: "first" },
    { channel: "stderr", text: "second" },
    { channel: "stdout", text: "\\\\xff" },
    { channel: "stdout", text: "literal\\\\tab\\tend" },
  ]);
});

void test("serializer preserves envelope shape and rejects unsafe values", () => {
  const success = successResult("build", {}, []);
  assert.equal(
    serializeEnvelope(success.envelope),
    '{"protocol":1,"operation":"build","ok":true,"messages":[],"result":{},"error":null}\n',
  );
  const failure = failureResult(
    "install",
    "install-failed",
    "failed",
    ["retry"],
    [{ channel: "stderr", text: "detail" }],
  );
  assert.deepEqual(JSON.parse(serializeEnvelope(failure.envelope)), {
    protocol: 1,
    operation: "install",
    ok: false,
    messages: [{ channel: "stderr", text: "detail" }],
    result: null,
    error: {
      code: "install-failed",
      message: "failed",
      hints: ["retry"],
    },
  });

  for (const operation of ["bad\nop", "bad\u0085op", "bad\ud800op"]) {
    assert.throws(
      () => serializeEnvelope(successResult(operation, {}, []).envelope),
      {
        message:
          "protocol strings must not contain terminal control characters",
      },
    );
  }
  assert.doesNotThrow(() =>
    serializeEnvelope(successResult("build😀", {}, []).envelope),
  );
  assert.throws(
    () =>
      serializeEnvelope(
        successResult("build", { value: Number.NaN }, []).envelope,
      ),
    { message: "protocol JSON must not contain non-finite numbers" },
  );
  // Note the message: a tab in a message record is rejected as an invalid
  // record, not as a control character. The bare assert.throws this replaces
  // could not tell the two apart, so it passed whichever fired.
  assert.throws(
    () =>
      serializeEnvelope(
        successResult("build", {}, [
          { channel: "stderr", text: "bad\tmessage" },
        ]).envelope,
      ),
    { message: "invalid message record at line 1" },
  );
});

// The enforcement point the parent spec requires to outlive the transport.
// Today the only validation of error code, message, and hints lives inside
// serializeEnvelope, whose sole caller is src/adapter-cli.ts -- which no
// product path invokes. replayEnvelope writes those strings unfiltered.
// PR 11.5 slice 5 deletes the serializer, so the check moves here first.

// Uses the existing capture() rather than a private recorder.
// tests/unit/helpers/command-harness.js:47-59 already returns a
// `{ stream: any, text: () => string }` writable stand-in, and its `stream` is
// cast to `any` there precisely because a two-member object literal is not
// assignable to NodeJS.WritableStream under checkJs + strict. A private
// recorder would have to repeat that cast and would drift from the harness
// every other command suite uses.

/** @returns {{ out: { stdout: () => string, stderr: () => string }, ctx: any }} */
function recordingCtx() {
  const stdout = capture();
  const stderr = capture();
  return {
    out: { stdout: stdout.text, stderr: stderr.text },
    ctx: { stdout: stdout.stream, stderr: stderr.stream },
  };
}

void test("writeAdapterFailure writes the error and every hint to stderr in order", () => {
  const { out, ctx } = recordingCtx();
  writeAdapterFailure(
    ctx,
    failureResult(
      "install",
      "install-failed",
      "install failed",
      ["first hint", "second hint"],
      [],
    ).envelope,
  );
  assert.equal(out.stdout(), "");
  assert.equal(
    out.stderr(),
    "error: install failed\nhint: first hint\nhint: second hint\n",
  );
});

// failureResult takes FIVE arguments -- (operation, code, message, hints,
// messages) -- per src/adapter-protocol.ts:177-183. The fifth is neither
// optional nor trailing-defaulted, and this file is typechecked: it carries
// `// @ts-check` and annotates the destructured dist/ import with
// `@type {typeof import("../../src/adapter-protocol.js")}`, so a four-argument
// call is a hard `pnpm run typecheck:js` failure. An earlier draft of this plan
// omitted it in all four calls below.
//
// `.envelope` on every call is the other half of the same typecheck.
// failureResult returns AdapterResult (`{ status, envelope }`); the helpers
// take AdapterEnvelope, because that is what replayEnvelope holds at the call
// site Step 5 routes. Passing the result would fail on the same run.

// D8b: the guard THROWS, and the thrown message names the failing member
// only. An assertion on the throw alone would not catch an implementation that
// interpolated the offending string into the message it throws -- which would
// put the very bytes the guard exists to withhold onto the stream cli.ts
// writes the caught error to.
//
// The expected text is asserted EXACTLY, per member. An earlier draft matched
// /code|message|hint/, which every one of these three cases satisfies no
// matter which member actually failed: the word "message" appears in the
// prose of any plausible diagnostic, so a single hand-written string would
// have passed all three rows while identifying nothing. The hint row also
// pins the INDEX, which is the one interpolated value D8b permits -- and the
// index is 1, not 0, because the safe hint precedes the unsafe one.
void test("writeAdapterFailure throws on an unsafe string and never emits the value", () => {
  // Annotated rather than inferred: a bare array literal of mixed-type tuples
  // widens each element to `string | AdapterEnvelope`, and `label` is then not
  // assignable to assert's `message` parameter -- a hard `typecheck:js` error
  // on all five assertions below.
  /**
   * @type {readonly [
   *   string,
   *   string,
   *   import("../../src/adapter-protocol.js").AdapterEnvelope,
   * ][]}
   */
  const cases = [
    [
      "message",
      "adapter failure message contains a terminal control character",
      failureResult("install", "install-failed", "bad\u001bmessage", [], [])
        .envelope,
    ],
    [
      "code",
      "adapter failure code contains a terminal control character",
      failureResult("install", "bad\u007fcode", "install failed", [], [])
        .envelope,
    ],
    [
      "hint",
      "adapter failure hint[1] contains a terminal control character",
      failureResult(
        "install",
        "install-failed",
        "install failed",
        ["safe hint", "bad\u009fhint"],
        [],
      ).envelope,
    ],
  ];
  for (const [label, expected, envelope] of cases) {
    const { out, ctx } = recordingCtx();
    assert.throws(
      () => writeAdapterFailure(ctx, envelope),
      (error) => {
        assert.ok(error instanceof Error, label);
        // Names the failing member, exactly and only...
        assert.equal(error.message, expected, label);
        // ...and NOT the value. Every guarded code point must be absent from
        // the thrown text. This is redundant with the equality above on a
        // correct implementation and deliberately kept: it is the assertion
        // that still holds if the expected strings are ever revised.
        //
        // no-control-regex is suppressed rather than worked around: matching
        // control characters is exactly what this assertion exists to do, and
        // the escapes below are already the Unicode form the rule suggests.
        assert.doesNotMatch(
          error.message,
          // oxlint-disable-next-line no-control-regex
          /[\u0000-\u001f\u007f-\u009f]/,
          label,
        );
        return true;
      },
      label,
    );
    // Fail-closed means nothing partial reached either stream. A hint that
    // fails after two safe ones must not leave those two written.
    assert.equal(out.stdout(), "", label);
    assert.equal(out.stderr(), "", label);
  }
});

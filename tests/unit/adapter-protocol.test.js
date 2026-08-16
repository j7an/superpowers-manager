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

/**
 * Both halves of "the unsafe string never reaches the terminal": the guard
 * threw, and neither stream carries the offending code point. Either half
 * alone is satisfiable by a broken implementation -- a throw after a partial
 * write, or a silent no-op that writes nothing.
 * @param {() => void} run
 * @param {{stdout: () => string, stderr: () => string}} out
 * @param {string} offending
 * @param {string} member  exactly "code", "message", or "hint[<index>]"
 */
function assertRefused(run, out, offending, member) {
  const expected = `adapter failure ${member} contains a terminal control character`;
  // A real matcher, never a bare call and never a string second argument:
  // tests/assert-matcher-gate.js fails this suite otherwise.
  assert.throws(
    run,
    (error) => {
      assert.ok(error instanceof Error, member);
      assert.equal(error.message, expected, member);
      assert.equal(error.message.includes(offending), false, member);
      return true;
    },
    member,
  );
  assert.equal(out.stdout(), "", member);
  assert.equal(out.stderr(), "", member);
}

// ADAPTER-TERMINAL-01 and ADAPTER-SURROGATE-01 were owned by
// tests/test_adapter_protocol.py until PR 11.5 slice 5. Their contracts cover
// every terminal-facing string and they are NOT narrowed. Per spec D0 that
// population has FIVE members kept safe by THREE mechanisms:
//
//   error.code, error.message, each error hint
//                       -> refused by writeAdapterFailure (this file)
//   AdapterMessage.text -> escaped on the way in by AdapterMessageLog,
//                          through both ingresses (appendText, appendBytes)
//   install verification hint
//                       -> dropped at the consumer by verifyInstalledFingerprint
//                          (src/lifecycle.ts), per D0c
//
// The subtests below are one per mechanism, and all three are required: a
// witness naming only writeAdapterFailure would stay green while a future
// change dropped either of the other two.
//
// Escapes are written as \u sequences so this source carries no invisible
// bytes: C0 U+0001, DEL U+007F, C1 U+009F.

void test("ADAPTER-TERMINAL-01 a C0, DEL, or C1 control in any terminal-facing failure string is refused", async (t) => {
  // One subtest per MECHANISM. Step 1b appends two more to this body, and
  // Step 6 mutates each mechanism separately; a subtest is what makes those
  // rounds separately reportable. See the note below this block.
  await t.test("refused at writeAdapterFailure", () => {
    for (const control of ["\u0001", "\u007f", "\u009f"]) {
      for (const field of ["code", "message", "hint"]) {
        const { out, ctx } = recordingCtx();
        const envelope = failureResult(
          "install",
          field === "code" ? `install-failed${control}` : "install-failed",
          field === "message" ? `boom${control}` : "boom",
          field === "hint" ? [`try again${control}`] : ["try again"],
          [],
        ).envelope;
        // The member token, not the field name: the hint case is `hint[0]`
        // because these envelopes carry exactly one hint. Step 2's helper
        // builds the expected message from it.
        const member = field === "hint" ? "hint[0]" : field;
        // The assertion is that the unsafe string never reaches the terminal.
        // Per D8b the policy is a THROW, decided in the spec rather than here.
        // assertRefused pins both halves: the throw happened, and neither
        // stream carries the offending code point.
        assertRefused(
          () => writeAdapterFailure(ctx, envelope),
          out,
          control,
          member,
        );
      }
    }
  });

  await t.test("text ingress via appendText", () => {
    // The fourth member: message text, kept safe by escaping rather than by
    // refusal. A raw control byte entering the log must leave it as the
    // printable escape, so hasTerminalControl can never see one downstream.
    //
    // The expected text is written EXACTLY, not matched by pattern. Each of
    // these three code points is <= 0xff, so pythonUnicodeEscape takes the
    // `\x%02x` branch (src/adapter-protocol.ts:120); a pattern like /\\x/ would
    // also pass on an implementation that escaped only the first character of
    // a longer run.
    for (const [control, escaped] of [
      ["\u0001", "boom\\x01"],
      ["\u007f", "boom\\x7f"],
      ["\u009f", "boom\\x9f"],
    ]) {
      const log = new AdapterMessageLog();
      log.appendText("stderr", `boom${control}`);
      assert.deepStrictEqual(
        log.snapshot(),
        [{ channel: "stderr", text: escaped }],
        control,
      );
    }
  });

  await t.test("byte ingress via appendBytes", () => {
    // The same member through the OTHER ingress -- the one the product uses.
    // appendBytes decodes before it escapes, so it has a second failure mode
    // appendText does not have, and these four rows separate them.
    //
    // Note the two shapes. A byte that DECODES to a code point reaches
    // pythonUnicodeEscape's `\x%02x` branch (:120) and yields ONE backslash. A
    // byte that fails validation is handed to byteEscape (:53-55), whose own
    // backslash is then escaped by pythonUnicodeEscape, yielding TWO. The C1
    // rows are the pair that pins this: the same code point arrives as valid
    // UTF-8 in one row and as a lone continuation byte in the other, and the
    // expected texts differ by exactly one backslash. An assertion that blurred
    // them would pass on a decoder that gave up and byte-escaped everything.
    //
    // Every expected value here was confirmed against the built module rather
    // than derived by hand; re-derive rather than adjust if one disagrees.
    for (const [label, bytes, escaped] of [
      ["C0", [0x62, 0x6f, 0x6f, 0x6d, 0x01], "boom\\x01"],
      ["DEL", [0x62, 0x6f, 0x6f, 0x6d, 0x7f], "boom\\x7f"],
      ["C1 as valid UTF-8", [0x62, 0x6f, 0x6f, 0x6d, 0xc2, 0x9f], "boom\\x9f"],
      ["C1 as a lone byte", [0x62, 0x6f, 0x6f, 0x6d, 0x9f], "boom\\\\x9f"],
    ]) {
      const log = new AdapterMessageLog();
      log.appendBytes(
        "stderr",
        Uint8Array.from(/** @type {number[]} */ (bytes)),
      );
      assert.deepStrictEqual(
        log.snapshot(),
        [{ channel: "stderr", text: escaped }],
        // Cast for the same reason as `bytes` above: this is a bare array
        // literal of mixed-type tuples, so every element widens to
        // `string | number[]` and `label` is not assignable to assert's
        // `message` parameter under `typecheck:js`.
        /** @type {string} */ (label),
      );
    }
  });
});

void test("ADAPTER-SURROGATE-01 a surrogate code point in any terminal-facing failure string is refused without leaking a traceback", async (t) => {
  await t.test("refused at writeAdapterFailure", () => {
    for (const field of ["code", "message", "hint"]) {
      const { out, ctx } = recordingCtx();
      const envelope = failureResult(
        "install",
        field === "code" ? "install-failed\ud800" : "install-failed",
        field === "message" ? "boom\ud800" : "boom",
        field === "hint" ? ["try again\ud800"] : ["try again"],
        [],
      ).envelope;
      const member = field === "hint" ? "hint[0]" : field;
      assertRefused(
        () => writeAdapterFailure(ctx, envelope),
        out,
        "\ud800",
        member,
      );
      // "without leaking a traceback": no stack frame text reaches the operator.
      assert.equal(out.stderr().includes("    at "), false, member);
    }
  });

  await t.test("text ingress via appendText", () => {
    // Same member, the surrogate half. A lone surrogate is unencodable, so an
    // implementation that let one through would fail at the write rather than
    // at the guard -- which is exactly the traceback this contract forbids.
    //
    // U+D800 is > 0xff and <= 0xffff, so it takes the `\u%04x` branch
    // (src/adapter-protocol.ts:121-122): the stored text is the six literal
    // characters backslash-u-d-8-0-0, and carries no surrogate at all.
    const log = new AdapterMessageLog();
    log.appendText("stderr", "boom\ud800");
    assert.deepStrictEqual(log.snapshot(), [
      { channel: "stderr", text: "boom\\ud800" },
    ]);
  });

  await t.test("byte ingress via appendBytes", () => {
    // The byte ingress cannot produce a surrogate AT ALL, and that -- not an
    // escape -- is what this half asserts. decodeBackslashReplace clamps the
    // second byte after 0xed to 0x9f (src/adapter-protocol.ts:78), so ed a0 80,
    // the UTF-8 encoding of U+D800, fails validation and each of its three
    // bytes is byte-escaped on its own. The stored text carries three
    // double-backslash escapes and no surrogate anywhere, which is why a lone
    // surrogate can never reach the encoder on the path the product uses.
    //
    // Confirmed against the built module, not derived by hand.
    const log = new AdapterMessageLog();
    log.appendBytes(
      "stderr",
      Uint8Array.from([0x62, 0x6f, 0x6f, 0x6d, 0xed, 0xa0, 0x80]),
    );
    assert.deepStrictEqual(log.snapshot(), [
      { channel: "stderr", text: "boom\\\\xed\\\\xa0\\\\x80" },
    ]);
  });
});

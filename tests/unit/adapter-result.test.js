// @ts-check
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { capture } from "./helpers/command-harness.js";

/** @type {typeof import("../../src/adapter-result.js")} */
const {
  AdapterMessageLog,
  failureResult,
  pythonUnicodeEscapeBytes,
  requireProtocolString,
  successResult,
  writeAdapterFailure,
} = await import(new URL("../../dist/adapter-result.js", import.meta.url).href);

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

void test("adapter result exposes an outcome with no protocol tag", () => {
  const ok = successResult("build", { built: true }, []);
  assert.deepEqual(ok, {
    status: 0,
    outcome: {
      operation: "build",
      ok: true,
      messages: [],
      result: { built: true },
      error: null,
    },
  });
  const bad = failureResult("build", "E_X", "boom", ["try again"], []);
  assert.deepEqual(bad, {
    status: 1,
    outcome: {
      operation: "build",
      ok: false,
      messages: [],
      result: null,
      error: { code: "E_X", message: "boom", hints: ["try again"] },
    },
  });
  // the two properties the union's deletion is supposed to produce, stated so
  // a reader sees them rather than inferring them from the deepEqual above
  assert.ok(
    !("envelope" in ok),
    "AdapterResult must expose outcome, not envelope",
  );
  assert.ok(
    !("protocol" in ok.outcome),
    "the transport version tag must be gone",
  );
  assert.equal(ok.outcome.operation, "build");
});

void test("requireProtocolString accepts safe text and rejects terminal controls", () => {
  /** @type {(...codes: number[]) => string} */
  const cp = (...codes) => String.fromCodePoint(...codes);
  // accepted: printable ASCII, and non-ASCII that is neither a control nor a
  // surrogate -- the guard must not become a blanket non-ASCII reject
  for (const safe of [
    "",
    "plain",
    "hyphen-free",
    cp(0xe9),
    cp(0x65e5, 0x672c),
  ]) {
    assert.doesNotThrow(
      () => requireProtocolString(safe),
      `rejected safe input ${JSON.stringify(safe)}`,
    );
  }
  // rejected: the three ranges hasTerminalControl scans
  // (src/adapter-result.ts:197-199), each sampled at both ends AND inside.
  // The interior samples are not decoration -- see the note below the fence:
  // with only the two surrogate endpoints, a predicate narrowed to
  // `code === 0xd800 || code === 0xdfff` passes this entire test.
  // Built with fromCodePoint rather than written as literals: a raw C0 byte in
  // a source file is invisible to the next reader, and a `\u` escape typed into
  // a tool that decodes escapes lands as that raw byte anyway.
  const rejected = [
    cp(0x00), // C0 bottom
    "a" + cp(0x1b) + "b", // ESC mid-string -- the case the guard exists for
    cp(0x1f), // C0 top
    cp(0x7f), // DEL, bottom of the second range
    "a" + cp(0x85) + "b", // C1 interior
    cp(0x9f), // C1 top
    cp(0xd800), // lone high surrogate, bottom of the third range
    cp(0xdb7f), // interior high surrogate
    cp(0xdc00), // interior -- first low surrogate
    cp(0xdc9b), // interior low surrogate
    cp(0xdfff), // lone low surrogate, top of the third range
  ];
  for (const bad of rejected) {
    assert.throws(
      () => requireProtocolString(bad),
      {
        name: "Error",
        message:
          "protocol strings must not contain terminal control characters",
      },
      `accepted unsafe input ${JSON.stringify(bad)}`,
    );
  }
  // the safe side of each boundary, so a predicate widened by one code point
  // reddens this test rather than passing quietly
  for (const edge of [cp(0x20), cp(0x7e), cp(0xa0), cp(0x10000)]) {
    assert.doesNotThrow(
      () => requireProtocolString(edge),
      `rejected boundary ${JSON.stringify(edge)}`,
    );
  }
});

// The enforcement point the parent spec requires to outlive the transport.
// writeAdapterFailure is the live validator of error code, message, and
// hints; replayOutcome writes those strings unfiltered otherwise.
// PR 11.5 slice 5 deleted the serializer that used to also enforce this,
// leaving writeAdapterFailure the check's sole enforcement point.

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
    ).outcome,
  );
  assert.equal(out.stdout(), "");
  assert.equal(
    out.stderr(),
    "error: install failed\nhint: first hint\nhint: second hint\n",
  );
});

// failureResult takes FIVE arguments -- (operation, code, message, hints,
// messages) -- per src/adapter-result.ts:174-180. The fifth is neither
// optional nor trailing-defaulted, and this file is typechecked: it carries
// `// @ts-check` and annotates the destructured dist/ import with
// `@type {typeof import("../../src/adapter-result.js")}`, so a four-argument
// call is a hard `pnpm run typecheck:js` failure. An earlier draft of this plan
// omitted it in all four calls below.
//
// `.outcome` on every call is the other half of the same typecheck.
// failureResult returns AdapterResult (`{ status, outcome }`); the helpers
// take AdapterOutcome, because that is what replayOutcome holds at the call
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
  // widens each element to `string | AdapterOutcome`, and `label` is then not
  // assignable to assert's `message` parameter -- a hard `typecheck:js` error
  // on all five assertions below.
  /**
   * @type {readonly [
   *   string,
   *   string,
   *   import("../../src/adapter-result.js").AdapterOutcome,
   * ][]}
   */
  const cases = [
    [
      "message",
      "adapter failure message contains a terminal control character",
      failureResult("install", "install-failed", "bad\u001bmessage", [], [])
        .outcome,
    ],
    [
      "code",
      "adapter failure code contains a terminal control character",
      failureResult("install", "bad\u007fcode", "install failed", [], [])
        .outcome,
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
      ).outcome,
    ],
  ];
  for (const [label, expected, outcome] of cases) {
    const { out, ctx } = recordingCtx();
    assert.throws(
      () => writeAdapterFailure(ctx, outcome),
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
// The first three subtests below are one per mechanism, and all three are
// required: a witness naming only writeAdapterFailure would stay green while a
// future change dropped either of the other two. ADAPTER-TERMINAL-01 carries a
// FOURTH, which is not a mechanism but the operator-visible BOUNDARY -- the
// real CLI, spawned -- because no in-process witness can see whether a
// traceback reaches the terminal.
//
// Escapes are written as \u sequences so this source carries no invisible
// bytes: C0 U+0001 and U+001B, DEL U+007F, C1 U+009B and U+009F.
//
// Each range is exercised at a BOUNDARY and in its INTERIOR, because a
// boundary-only corpus cannot distinguish the range from its endpoints.
// hasTerminalControl is `code < 0x20 || (code >= 0x7f && code <= 0x9f) || ...`
// (src/adapter-result.ts:196-201): U+0001 is the bottom of C0, so narrowing
// to `code < 0x02` keeps it green while admitting U+0002-U+001F including ESC;
// U+007F and U+009F are the two ends of the DEL/C1 clause, so narrowing to
// `code === 0x7f || code === 0x9f` keeps both green while admitting
// U+0080-U+009E including CSI. U+001B and U+009B are the interior values that
// close both holes, and they are the two the retiring Python witness used
// (tests/test_adapter_protocol.py:473-528 at fd94d7d).

void test("ADAPTER-TERMINAL-01 a C0, DEL, or C1 control in any terminal-facing failure string is refused", async (t) => {
  // One subtest per MECHANISM, then one for the CLI boundary. Each is mutated
  // separately during verification; a subtest is what makes those rounds
  // separately reportable. See the note above this block.
  await t.test("refused at writeAdapterFailure", () => {
    for (const control of ["\u0001", "\u001b", "\u007f", "\u009b", "\u009f"]) {
      for (const field of ["code", "message", "hint"]) {
        const { out, ctx } = recordingCtx();
        const outcome = failureResult(
          "install",
          field === "code" ? `install-failed${control}` : "install-failed",
          field === "message" ? `boom${control}` : "boom",
          field === "hint" ? [`try again${control}`] : ["try again"],
          [],
        ).outcome;
        // The member token, not the field name: the hint case is `hint[0]`
        // because these outcomes carry exactly one hint. Step 2's helper
        // builds the expected message from it.
        const member = field === "hint" ? "hint[0]" : field;
        // The assertion is that the unsafe string never reaches the terminal.
        // Per D8b the policy is a THROW, decided in the spec rather than here.
        // assertRefused pins both halves: the throw happened, and neither
        // stream carries the offending code point.
        assertRefused(
          () => writeAdapterFailure(ctx, outcome),
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
    // these five code points is <= 0xff, so pythonUnicodeEscape takes the
    // `\x%02x` branch (src/adapter-result.ts:118); a pattern like /\\x/ would
    // also pass on an implementation that escaped only the first character of
    // a longer run.
    for (const [control, escaped] of [
      ["\u0001", "boom\\x01"],
      ["\u001b", "boom\\x1b"],
      ["\u007f", "boom\\x7f"],
      ["\u009b", "boom\\x9b"],
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
    // appendText does not have, and these seven rows separate them.
    //
    // Note the two shapes. A byte that DECODES to a code point reaches
    // pythonUnicodeEscape's `\x%02x` branch (:118) and yields ONE backslash. A
    // byte that fails validation is handed to byteEscape (:51-53), whose own
    // backslash is then escaped by pythonUnicodeEscape, yielding TWO. The C1
    // rows are the pair that pins this: the same code point arrives as valid
    // UTF-8 in one row and as a lone continuation byte in the other, and the
    // expected texts differ by exactly one backslash. An assertion that blurred
    // them would pass on a decoder that gave up and byte-escaped everything.
    //
    // Every expected value here was confirmed against the built module rather
    // than derived by hand; re-derive rather than adjust if one disagrees.
    for (const [label, bytes, escaped] of [
      ["C0 boundary", [0x62, 0x6f, 0x6f, 0x6d, 0x01], "boom\\x01"],
      ["C0 interior", [0x62, 0x6f, 0x6f, 0x6d, 0x1b], "boom\\x1b"],
      ["DEL", [0x62, 0x6f, 0x6f, 0x6d, 0x7f], "boom\\x7f"],
      [
        "C1 boundary as valid UTF-8",
        [0x62, 0x6f, 0x6f, 0x6d, 0xc2, 0x9f],
        "boom\\x9f",
      ],
      [
        "C1 boundary as a lone byte",
        [0x62, 0x6f, 0x6f, 0x6d, 0x9f],
        "boom\\\\x9f",
      ],
      [
        "C1 interior as valid UTF-8",
        [0x62, 0x6f, 0x6f, 0x6d, 0xc2, 0x9b],
        "boom\\x9b",
      ],
      [
        "C1 interior as a lone byte",
        [0x62, 0x6f, 0x6f, 0x6d, 0x9b],
        "boom\\\\x9b",
      ],
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

  // The operator-visible boundary, driven through the REAL CLI. The three
  // subtests above all stop at a module edge, and every one of them stays
  // green if main's status/exit block is changed to emit `cause.stack` instead
  // of `oneLine(cause)` -- so the "without leaking a traceback" clause both
  // behavior IDs carry needs a subprocess to be non-vacuous at all. The clause
  // is witnessed HERE for both IDs; the note in ADAPTER-SURROGATE-01 records
  // why a surrogate cannot take this route.
  //
  // The route is constructible end to end with no product code bent to reach
  // it. SUPERPOWERS_CODEX may name any existing executable (preflight's
  // codexBin resolution accepts a path outright), a POSIX filename may carry
  // any byte but NUL and slash, and src/adapter.ts:806-809 interpolates that
  // path into an adapter-authored failure message when `codex plugin list
  // --json` exits non-zero. probe replays the resulting outcome AFTER its
  // try/catch has resolved (the loop below runProbe's catch), so the throw from
  // assertFailureWritable escapes runProbe, escapes the handler, and lands in
  // src/cli.ts's catch -- the only place an operator ever sees it.
  await t.test("refused at the CLI without a traceback", () => {
    const esc = String.fromCharCode(0x1b);
    const base = mkdtempSync(join(tmpdir(), "spw-adapter-terminal-"));
    try {
      const home = join(base, "home");
      const temp = join(base, "tmp");
      const codexDir = join(base, `co${esc}dex`);
      for (const dir of [home, temp, codexDir]) {
        mkdirSync(dir, { recursive: true });
      }
      const codexBin = join(codexDir, "codex");
      // Writes a context line as well as failing: listingCommand appends the
      // child's stderr to the outcome's message records
      // (src/adapter.ts:238-246). That record is what the hoist withholds, so
      // its absence below is the end-to-end half of the atomicity contract.
      writeFileSync(
        codexBin,
        "#!/bin/sh\necho codex-context-line >&2\nexit 1\n",
        "utf8",
      );
      chmodSync(codexBin, 0o755);

      const run = spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL("../../bin/superpowers-manager.js", import.meta.url),
          ),
          "probe",
        ],
        {
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          env: {
            HOME: home,
            TMPDIR: temp,
            // git must RESOLVE, because probe's preflight requires it
            // (COMMAND_REQUIREMENTS's probe entry). Nothing here reaches a git
            // PROCESS -- a 40-hex SUPERPOWERS_REF is a raw-commit resolution
            // (src/upstream.ts:160-162) -- so the case stays hermetic, and
            // probe is read-only besides.
            PATH: process.env.PATH ?? "",
            SUPERPOWERS_CONFIG_DIR: join(
              home,
              ".config",
              "superpowers-manager",
            ),
            SUPERPOWERS_CODEX: codexBin,
            SUPERPOWERS_INSTALLED_SEARCH_ROOT: join(home, ".codex"),
            SUPERPOWERS_REF: "a".repeat(40),
            SUPERPOWERS_UPSTREAM_URL: join(base, "upstream"),
          },
        },
      );

      assert.equal(run.status, 1);
      // EXACTLY empty, not merely free of the offending byte. replayOutcome
      // writes stdout message records too, and probe's own report follows the
      // replay, so a guard that fired late would leave a prefix here.
      assert.equal(run.stdout, "");
      // EXACTLY the guard's own hand-written text and nothing else: no
      // context line, no hint, no second line of any kind.
      assert.equal(
        run.stderr,
        "error: adapter failure message contains a terminal control character\n",
      );
      for (const stream of [run.stdout, run.stderr]) {
        assert.equal(stream.includes(esc), false);
        assert.equal(stream.includes("codex-context-line"), false);
        // Node stack frames, and the traceback header the retiring Python
        // witness forbade (tests/test_adapter_protocol.py at fd94d7d).
        assert.equal(stream.includes("    at "), false);
        assert.equal(stream.includes("Traceback"), false);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

void test("ADAPTER-SURROGATE-01 a surrogate code point in any terminal-facing failure string is refused without leaking a traceback", async (t) => {
  await t.test("refused at writeAdapterFailure", () => {
    // BOTH halves of the range, not just the high one. hasTerminalControl
    // covers 0xd800-0xdfff (src/adapter-result.ts:199); a corpus of high
    // surrogates alone stays green under a narrowing to `code <= 0xdbff`,
    // which admits every low surrogate. U+DC9B is the value the retiring
    // Python witness drove through code, message, hints, the message log,
    // and the verification hint alike (tests/test_adapter_protocol.py:544
    // at fd94d7d).
    for (const surrogate of ["\ud800", "\udc9b"]) {
      for (const field of ["code", "message", "hint"]) {
        const { out, ctx } = recordingCtx();
        const outcome = failureResult(
          "install",
          field === "code" ? `install-failed${surrogate}` : "install-failed",
          field === "message" ? `boom${surrogate}` : "boom",
          field === "hint" ? [`try again${surrogate}`] : ["try again"],
          [],
        ).outcome;
        const member = field === "hint" ? "hint[0]" : field;
        // assertRefused already pins BOTH streams to exactly empty, which
        // is why no `includes("    at ")` assertion appears here: after an
        // exact-empty assertion it would be trivially true and would prove
        // nothing. The "without leaking a traceback" clause is witnessed
        // by the CLI subtest in ADAPTER-TERMINAL-01, at the only boundary
        // where a traceback could become visible to an operator.
        assertRefused(
          () => writeAdapterFailure(ctx, outcome),
          out,
          surrogate,
          member,
        );
      }
    }
  });

  await t.test("text ingress via appendText", () => {
    // Same member, the surrogate half. A lone surrogate is unencodable, so an
    // implementation that let one through would fail at the write rather than
    // at the guard -- which is exactly the traceback this contract forbids.
    //
    // Both surrogates are > 0xff and <= 0xffff, so each takes the
    // `\u%04x` branch (src/adapter-result.ts:119-120): the stored text
    // is the six literal characters backslash-u-<four hex digits>, and
    // carries no surrogate at all. Both expected values were confirmed
    // against the built module rather than derived by hand.
    for (const [surrogate, escaped] of [
      ["\ud800", "boom\\ud800"],
      ["\udc9b", "boom\\udc9b"],
    ]) {
      const log = new AdapterMessageLog();
      log.appendText("stderr", `boom${surrogate}`);
      assert.deepStrictEqual(
        log.snapshot(),
        [{ channel: "stderr", text: escaped }],
        escaped,
      );
    }
  });

  await t.test("byte ingress via appendBytes", () => {
    // The byte ingress cannot produce a surrogate AT ALL, and that -- not an
    // escape -- is what this half asserts. decodeBackslashReplace clamps the
    // second byte after 0xed to 0x9f (src/adapter-result.ts:76), so the
    // UTF-8 encoding of ANY surrogate fails validation and each of its three
    // bytes is byte-escaped on its own -- ed a0 80 for the high half, ed b2 9b
    // for the low one. Both rows store three double-backslash escapes and no
    // surrogate anywhere, which is why a lone surrogate can never reach the
    // encoder on the path the product uses. It is also why no surrogate is
    // constructible on the end-to-end CLI route: a lone surrogate cannot
    // survive a POSIX filename (Node decodes an undecodable byte to U+FFFD)
    // or an environment variable, and this ingress escapes it before it can
    // reach a failure string. The CLI witness in ADAPTER-TERMINAL-01 uses a
    // control character for exactly that reason.
    //
    // Confirmed against the built module, not derived by hand.
    for (const [bytes, escaped] of [
      [[0x62, 0x6f, 0x6f, 0x6d, 0xed, 0xa0, 0x80], "boom\\\\xed\\\\xa0\\\\x80"],
      [[0x62, 0x6f, 0x6f, 0x6d, 0xed, 0xb2, 0x9b], "boom\\\\xed\\\\xb2\\\\x9b"],
    ]) {
      const log = new AdapterMessageLog();
      log.appendBytes(
        "stderr",
        Uint8Array.from(/** @type {number[]} */ (bytes)),
      );
      assert.deepStrictEqual(
        log.snapshot(),
        [{ channel: "stderr", text: escaped }],
        /** @type {string} */ (escaped),
      );
    }
  });
});

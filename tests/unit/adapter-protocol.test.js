// @ts-check
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

/** @type {typeof import("../../src/adapter-protocol.js")} */
const {
  AdapterMessageLog,
  failureResult,
  pythonUnicodeEscapeBytes,
  serializeEnvelope,
  successResult,
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
    assert.throws(() =>
      serializeEnvelope(successResult(operation, {}, []).envelope),
    );
  }
  assert.doesNotThrow(() =>
    serializeEnvelope(successResult("build😀", {}, []).envelope),
  );
  assert.throws(() =>
    serializeEnvelope(
      successResult("build", { value: Number.NaN }, []).envelope,
    ),
  );
  assert.throws(() =>
    serializeEnvelope(
      successResult("build", {}, [
        { channel: "stderr", text: "bad\tmessage" },
      ]).envelope,
    ),
  );
});

// @ts-check
import assert from "node:assert/strict";
import test from "node:test";

/** @type {typeof import("../../src/safety-error.js")} */
const { SafetyError } = await import("../../dist/safety-error.js");
/** @type {typeof import("../../src/strict-json.js")} */
const { parseStrictJson } = await import("../../dist/strict-json.js");

/** @type {import("../../src/strict-json.js").StrictJsonProfile} */
const reject = { duplicateKeys: "reject" };
/** @type {import("../../src/strict-json.js").StrictJsonProfile} */
const lastWins = { duplicateKeys: "last-wins" };
/** @param {number} depth */
const nested = (depth) => "[".repeat(depth) + "0" + "]".repeat(depth);

test("duplicate policy compares decoded keys recursively", () => {
  assert.throws(
    () => parseStrictJson('{"outer":{"a":1,"\\u0061":2}}', reject),
    SafetyError,
  );
  assert.deepEqual(
    parseStrictJson('{"outer":{"a":1,"\\u0061":2}}', lastWins),
    { outer: { a: 2 } },
  );
});

test("depth cap accepts 256 containers and rejects 257", () => {
  assert.doesNotThrow(() =>
    parseStrictJson(nested(256), {
      duplicateKeys: "reject",
      maxDepth: 256,
    }),
  );
  assert.throws(
    () =>
      parseStrictJson(nested(257), {
        duplicateKeys: "reject",
        maxDepth: 256,
      }),
    SafetyError,
  );
});

test("uncapped recursion failure is converted to SafetyError", () => {
  assert.throws(() => parseStrictJson(nested(20_000), reject), SafetyError);
});

test("grammar rejects constants, malformed input, and trailing input", () => {
  for (const text of ["NaN", "Infinity", "-Infinity", "{", "[1,]", "true x"]) {
    assert.throws(() => parseStrictJson(text, reject), SafetyError, text);
  }
});

test("byte input uses fatal UTF-8 decoding", () => {
  assert.throws(
    () => parseStrictJson(Uint8Array.from([0xc3, 0x28]), reject),
    SafetyError,
  );
});

test("maxBytes is an inclusive UTF-8 byte boundary", () => {
  assert.equal(
    parseStrictJson('"é"', { duplicateKeys: "reject", maxBytes: 4 }),
    "é",
  );
  assert.throws(
    () =>
      parseStrictJson('"é"', {
        duplicateKeys: "reject",
        maxBytes: 3,
      }),
    SafetyError,
  );
});

test("standard JSON strings, escapes, numbers, and literals parse", () => {
  assert.deepEqual(
    parseStrictJson(
      '{"s":"quote: \\" slash: \\\\ unicode: \\u4e2d","n":-1.5e2,"t":true,"f":false,"z":null}',
      reject,
    ),
    { s: 'quote: " slash: \\ unicode: 中', n: -150, t: true, f: false, z: null },
  );
});

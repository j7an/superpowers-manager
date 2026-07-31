// @ts-check
import assert from "node:assert/strict";
import test from "node:test";

/** @type {typeof import("../../src/python-json-format.js")} */
const { escapeNonAscii, formatPythonNumber } = await import(
  new URL("../../dist/python-json-format.js", import.meta.url).href
);

// Every expected value below was produced by CPython 3.11 `json.dumps`, not by
// reading the implementation. They are the contract, so they are exact literals.
const NUMBERS = [
  ["100", "100"],
  ["-0", "0"],
  ["9007199254740993", "9007199254740993"],
  ["12345678901234567890123", "12345678901234567890123"],
  ["1e2", "100.0"],
  ["1.0", "1.0"],
  ["1.50", "1.5"],
  ["0.1", "0.1"],
  ["1e15", "1000000000000000.0"],
  ["1e16", "1e+16"],
  ["1e20", "1e+20"],
  ["1e21", "1e+21"],
  ["1e22", "1e+22"],
  ["1e-4", "0.0001"],
  ["1e-5", "1e-05"],
  ["1e-7", "1e-07"],
  ["-1e-7", "-1e-07"],
  ["-0.0", "-0.0"],
  ["0.0", "0.0"],
  ["123456789012345678.0", "1.2345678901234568e+17"],
  ["1.7976931348623157e308", "1.7976931348623157e+308"],
  ["5e-324", "5e-324"],
  ["1234567.125", "1234567.125"],
  // The re-rounding class. A toFixed()-based formatter returns ...320.3 here.
  // This case exists because a 22-value corpus that probed only notation
  // thresholds passed while the implementation was wrong.
  ["1888570120608320.2", "1888570120608320.2"],
  ["-1888570120608320.2", "-1888570120608320.2"],
  ["1e-300", "1e-300"],
  ["3.0", "3.0"],
];

void test("formatPythonNumber reproduces CPython json.dumps", () => {
  for (const [input, expected] of NUMBERS) {
    assert.equal(formatPythonNumber(input), expected, `input ${input}`);
  }
});

void test("formatPythonNumber rejects values that overflow to infinity", () => {
  // CPython raises ValueError under allow_nan=False; JSON.stringify would
  // silently emit null, substituting data rather than refusing it.
  assert.throws(() => formatPythonNumber("2e308"), /out of range/);
});

void test("escapeNonAscii matches ensure_ascii, including astral pairs", () => {
  assert.equal(escapeNonAscii(JSON.stringify("é")), '"\\u00e9"');
  assert.equal(escapeNonAscii(JSON.stringify("\u{1F600}")), '"\\ud83d\\ude00"');
  assert.equal(escapeNonAscii(JSON.stringify("\u0007")), '"\\u0007"');
  assert.equal(escapeNonAscii(JSON.stringify("plain")), '"plain"');
  // DEL: CPython escapes it, JSON.stringify does not. U+007E must NOT escape.
  assert.equal(escapeNonAscii(JSON.stringify("\u007f")), '"\\u007f"');
  assert.equal(escapeNonAscii(JSON.stringify("~")), '"~"');
  assert.equal(escapeNonAscii(JSON.stringify("\u0080")), '"\\u0080"');
});

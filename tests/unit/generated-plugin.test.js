// @ts-check
import assert from "node:assert/strict";
import test from "node:test";

/** @type {typeof import("../../src/python-text.js")} */
const { pythonStrip, pythonSplitlines } = await import(
  new URL("../../dist/python-text.js", import.meta.url).href
);

void test("pythonStrip matches CPython str.strip and not JavaScript trim", () => {
  assert.equal(pythonStrip("  value  "), "value");
  assert.equal(pythonStrip("\t\n\v\f\r value \r\f\v\n\t"), "value");
  // Python-only: the C0 separators and NEL.
  assert.equal(pythonStrip("\x1c\x1d\x1e\x1fvalue\x85"), "value");
  // Shared: NBSP, LS, PS, and the Unicode space run.
  assert.equal(pythonStrip("\xa0   　value"), "value");
  // JavaScript-only: trim() removes U+FEFF, Python keeps it.
  assert.equal(pythonStrip("﻿value﻿"), "﻿value﻿");
  // Neither runtime strips these.
  assert.equal(pythonStrip("᠎value​"), "᠎value​");
  assert.equal(pythonStrip("   "), "");
});

void test("pythonSplitlines matches CPython str.splitlines", () => {
  assert.deepStrictEqual(pythonSplitlines(""), []);
  assert.deepStrictEqual(pythonSplitlines("a\n"), ["a"]);
  assert.deepStrictEqual(pythonSplitlines("a\nb"), ["a", "b"]);
  assert.deepStrictEqual(pythonSplitlines("a\r\nb"), ["a", "b"]);
  assert.deepStrictEqual(pythonSplitlines("a\rb"), ["a", "b"]);
  assert.deepStrictEqual(pythonSplitlines("a\n\nb"), ["a", "", "b"]);
  assert.deepStrictEqual(
    pythonSplitlines("a\x0bb\x0cc\x1cd\x1de\x1ef\x85g h i"),
    ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
  );
  // A CRLF must not produce an empty line between the halves.
  assert.deepStrictEqual(pythonSplitlines("---\r\nname: x\r\n---\r\n"), [
    "---",
    "name: x",
    "---",
  ]);
});

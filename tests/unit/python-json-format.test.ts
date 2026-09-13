import assert from "node:assert/strict";
import test from "node:test";

import { escapeNonAscii } from "../../src/python-json-format.ts";

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

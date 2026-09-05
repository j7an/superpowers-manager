import assert from "node:assert/strict";
import test from "node:test";

import { applyManifestOverlay } from "../../src/manifest-overlay.ts";

const VERSION = "9.8.7+manager.0123456";
const PATH = "/w/plugin.json";

const overlay = (source: string) => applyManifestOverlay(source, VERSION, PATH);

void test("sets version and skills, preserving unknown fields and key order", () => {
  const out = overlay(
    '{"name":"superpowers","x_future":{"nested":[1,2,"preserve-me"]},"version":"0.0.0"}',
  );
  assert.equal(
    out,
    '{\n  "name": "superpowers",\n  "x_future": {\n    "nested": [\n      1,\n      2,\n      "preserve-me"\n    ]\n  },\n  "version": "9.8.7+manager.0123456",\n  "skills": "./skills/"\n}\n',
  );
});

void test("an absent version is appended, a present one keeps its slot", () => {
  // Both orderings are CPython dict-assignment semantics, verified 2026-07-31.
  assert.equal(
    overlay('{"b":2}'),
    '{\n  "b": 2,\n  "version": "9.8.7+manager.0123456",\n  "skills": "./skills/"\n}\n',
  );
  assert.equal(
    overlay('{"version":"old","b":2}'),
    '{\n  "version": "9.8.7+manager.0123456",\n  "b": 2,\n  "skills": "./skills/"\n}\n',
  );
});

void test("integer-like keys keep their source order", () => {
  // A plain-object implementation emits 1,2,z,a here.
  assert.match(
    overlay('{"z":0,"2":2,"1":1,"a":3}'),
    /"z": 0,\n  "2": 2,\n  "1": 1,\n  "a": 3,/,
  );
});

void test("an unknown object with a rawNumber field is preserved", () => {
  // The brand-forgery case. A structural predicate emits `"future": 123`.
  assert.match(
    overlay('{"future":{"rawNumber":"123"}}'),
    /"future": \{\n {4}"rawNumber": "123"\n {2}\}/,
  );
});

void test("an integer beyond 2^53 survives byte-exactly", () => {
  assert.match(
    overlay('{"name":"superpowers","unknown_integer":9007199254740993}'),
    /"unknown_integer": 9007199254740993/,
  );
});

void test("duplicate keys resolve last-wins at the first key's position", () => {
  const out = overlay('{"name":"first","z":1,"name":"renamed"}');
  assert.match(out, /"name": "renamed",\n  "z": 1,/);
  assert.doesNotMatch(out, /"first"/);
});

void test("a 5000-digit integer is accepted — an intentional divergence", () => {
  // CPython's 4,300-digit int-conversion limit rejects this. The port copies
  // source text and never converts, so the cost that limit defends against
  // does not arise. Recorded in the spec as a deliberate widening.
  const digits = "9".repeat(5000);
  assert.match(overlay(`{"n":${digits}}`), new RegExp(`"n": ${digits}`));
});

// Diagnostics are asserted as COMPLETE messages. A substring assertion on
// "manifest must be a JSON object" passes whether or not the path is present,
// which is exactly the regression this contract exists to prevent.
void test("a non-object manifest is rejected with the complete message", () => {
  assert.throws(
    () => overlay("[]"),
    (error) => {
      assert.ok(error instanceof Error, "expected an Error");
      assert.equal(error.message, `manifest must be a JSON object: ${PATH}`);
      return true;
    },
  );
});

void test("a non-standard constant is rejected with the complete message", () => {
  assert.throws(
    () => overlay('{"a":NaN}'),
    (error) => {
      assert.ok(error instanceof Error, "expected an Error");
      assert.equal(
        error.message,
        `invalid manifest JSON in ${PATH}: non-standard numeric constant: NaN`,
      );
      return true;
    },
  );
});

void test("nesting beyond 256 is rejected with the complete message", () => {
  const deep = `{"a":${"[".repeat(257)}${"]".repeat(257)}}`;
  assert.throws(
    () => overlay(deep),
    (error) => {
      assert.ok(error instanceof Error, "expected an Error");
      assert.equal(error.message, `JSON nesting exceeds limit in ${PATH}`);
      return true;
    },
  );
});

void test("an out-of-range numeric literal is rejected with the complete message, naming the path", () => {
  // Only the numeric-overflow guard in src/python-json-format.ts (roughly
  // :33) is reachable through applyManifestOverlay: the sibling literal
  // guard for NaN/Infinity/-Infinity (roughly :24) can only fire when a
  // caller parses with `nonStandardConstants: "accept"`, and
  // OVERLAY_PROFILE rejects those tokens at the parser before they ever
  // become a raw number source — see src/strict-json.ts's
  // parseNonStandardConstant. That case is covered directly against
  // formatPythonNumber in tests/unit/python-json-format.test.js instead.
  assert.throws(
    () => overlay('{"a":2e308}'),
    (error) => {
      assert.ok(error instanceof Error, "expected an Error");
      assert.equal(error.message, `JSON number out of range in ${PATH}: 2e308`);
      return true;
    },
  );
});

void test("a malformed manifest reports line and column", () => {
  assert.throws(
    () => overlay('{\n  "a": ,\n}'),
    (error) => {
      assert.ok(error instanceof Error, "expected an Error");
      assert.match(
        error.message,
        new RegExp(`^invalid manifest JSON in ${PATH}: line 2 column \\d+: `),
      );
      return true;
    },
  );
});

void test("no diagnostic leaks interpreter detail", () => {
  for (const bad of ["[]", '{"a":NaN}', '{\n  "a": ,\n}']) {
    assert.throws(
      () => overlay(bad),
      (error) => {
        assert.ok(error instanceof Error, "expected an Error");
        assert.doesNotMatch(error.message, /Traceback|errno|ENOENT|EACCES|\n/);
        return true;
      },
    );
  }
});

void test("nesting at exactly 256 is accepted", () => {
  const deep = `{"a":${"[".repeat(255)}${"]".repeat(255)}}`;
  assert.match(overlay(deep), /"skills": "\.\/skills\/"/);
});

void test("trailing whitespace beyond 1 MiB is accepted", () => {
  assert.match(
    overlay(`{"name":"superpowers"}${" ".repeat(1_048_577)}`),
    /"skills"/,
  );
});

void test("empty containers render the way CPython renders them", () => {
  const out = overlay('{"a":{},"b":[]}');
  assert.match(out, /"a": \{\}/);
  assert.match(out, /"b": \[\]/);
});

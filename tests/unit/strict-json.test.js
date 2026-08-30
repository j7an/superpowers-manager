// @ts-check
import assert from "node:assert/strict";
import test from "node:test";
import { exactError } from "../lib/error-assertions.js";

/** @type {typeof import("../../src/safety-error.js")} */
const { SafetyError } = await import(
  new URL("../../dist/safety-error.js", import.meta.url).href
);
/** @type {typeof import("../../src/strict-json.js")} */
const {
  parseStrictJson,
  parseStrictJsonPreservingNumbers,
  isRawNumber,
  isRawObject,
} = await import(new URL("../../dist/strict-json.js", import.meta.url).href);

/** @type {import("../../src/strict-json.js").StrictJsonProfile} */
const reject = { duplicateKeys: "reject", nonStandardConstants: "reject" };
/** @type {import("../../src/strict-json.js").StrictJsonProfile} */
const lastWins = {
  duplicateKeys: "last-wins",
  nonStandardConstants: "reject",
};
/** @type {import("../../src/strict-json.js").StrictJsonProfile} */
const acceptConstants = {
  duplicateKeys: "last-wins",
  nonStandardConstants: "accept",
};
/** @param {number} depth */
const nested = (depth) => "[".repeat(depth) + "0" + "]".repeat(depth);

void test("duplicate policy compares decoded keys recursively", () => {
  assert.throws(
    () => parseStrictJson('{"outer":{"a":1,"\\u0061":2}}', reject),
    exactError(SafetyError, 'duplicate object key "a" at character 26'),
  );
  assert.deepEqual(parseStrictJson('{"outer":{"a":1,"\\u0061":2}}', lastWins), {
    outer: { a: 2 },
  });
});

void test("depth cap accepts 256 containers and rejects 257", () => {
  assert.doesNotThrow(() =>
    parseStrictJson(nested(256), {
      duplicateKeys: "reject",
      nonStandardConstants: "reject",
      maxDepth: 256,
    }),
  );
  assert.throws(
    () =>
      parseStrictJson(nested(257), {
        duplicateKeys: "reject",
        nonStandardConstants: "reject",
        maxDepth: 256,
      }),
    exactError(SafetyError, "container depth exceeds 256 at character 256"),
  );
});

void test("uncapped recursion failure is converted to SafetyError", () => {
  assert.throws(
    () => parseStrictJson(nested(20_000), reject),
    exactError(SafetyError, "JSON parsing failed"),
  );
});

void test("grammar rejects constants, malformed input, and trailing input", () => {
  const grammarRejected = [
    ["NaN", "non-standard JSON constant NaN at character 0"],
    ["Infinity", "non-standard JSON constant Infinity at character 0"],
    ["-Infinity", "non-standard JSON constant -Infinity at character 0"],
    ["{", "object key must be a string at character 1"],
    ["[1,]", "expected JSON value at character 3"],
    ["true x", "unexpected trailing input at character 5"],
  ];
  for (const [text, message] of grammarRejected) {
    assert.throws(() => parseStrictJson(text, reject), exactError(SafetyError, message), text);
  }
});

void test("non-standard constants are an explicit exact-token policy", () => {
  assert.ok(Number.isNaN(parseStrictJson("NaN", acceptConstants)));
  assert.equal(parseStrictJson("Infinity", acceptConstants), Infinity);
  assert.equal(parseStrictJson("-Infinity", acceptConstants), -Infinity);

  for (const text of ["NaN", "Infinity", "-Infinity"]) {
    assert.throws(
      () => parseStrictJson(text, reject),
      (error) =>
        error instanceof SafetyError &&
        error.message.startsWith(`non-standard JSON constant ${text} at `),
      text,
    );
  }
  const constantSpellingRejected = [
    ["nan", "invalid literal at character 0"],
    ["infinity", "expected JSON value at character 0"],
    ["+Infinity", "expected JSON value at character 0"],
  ];
  for (const [text, message] of constantSpellingRejected) {
    assert.throws(() => parseStrictJson(text, acceptConstants), exactError(SafetyError, message));
  }
});

void test("maxBytes rejects before UTF-8 decoding", () => {
  assert.throws(
    () =>
      parseStrictJson(Uint8Array.from([0xc3, 0x28]), {
        duplicateKeys: "reject",
        nonStandardConstants: "reject",
        maxBytes: 1,
      }),
    (error) =>
      error instanceof SafetyError &&
      error.message === "input exceeds 1 UTF-8 bytes",
  );
});

void test("byte input uses fatal UTF-8 decoding", () => {
  assert.throws(
    () => parseStrictJson(Uint8Array.from([0xc3, 0x28]), reject),
    exactError(SafetyError, "input is not valid UTF-8"),
  );
});

void test("byte input rejects a UTF-8 BOM", () => {
  assert.throws(
    () =>
      parseStrictJson(Uint8Array.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), reject),
    exactError(SafetyError, "expected JSON value at character 0"),
  );
});

void test("maxBytes is an inclusive UTF-8 byte boundary", () => {
  assert.equal(
    parseStrictJson('"é"', {
      duplicateKeys: "reject",
      nonStandardConstants: "reject",
      maxBytes: 4,
    }),
    "é",
  );
  assert.throws(
    () =>
      parseStrictJson('"é"', {
        duplicateKeys: "reject",
        nonStandardConstants: "reject",
        maxBytes: 3,
      }),
    exactError(SafetyError, "input exceeds 3 UTF-8 bytes"),
  );
});

void test("standard JSON strings, escapes, numbers, and literals parse", () => {
  assert.deepEqual(
    parseStrictJson(
      '{"s":"quote: \\" slash: \\\\ unicode: \\u4e2d","n":-1.5e2,"t":true,"f":false,"z":null}',
      reject,
    ),
    {
      s: 'quote: " slash: \\ unicode: 中',
      n: -150,
      t: true,
      f: false,
      z: null,
    },
  );
});

void test("optional integer-token profile rejects decimal and exponent spellings", () => {
  /** @type {import("../../src/strict-json.js").StrictJsonProfile} */
  const integersOnly = {
    duplicateKeys: "reject",
    nonStandardConstants: "reject",
    integerNumbersOnly: true,
  };
  assert.equal(parseStrictJson("1", integersOnly), 1);
  const integerRejected = [
    ["1.0", "non-integer JSON number at character 3"],
    ["1e0", "non-integer JSON number at character 3"],
  ];
  for (const [text, message] of integerRejected) {
    assert.throws(() => parseStrictJson(text, integersOnly), exactError(SafetyError, message), text);
    assert.equal(parseStrictJson(text, reject), 1, text);
  }
});

void test("__proto__ is an own enumerable data property without prototype mutation", () => {
  const parsed = parseStrictJson('{"__proto__":{"polluted":true}}', lastWins);
  assert.ok(
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed),
  );
  const descriptor = Object.getOwnPropertyDescriptor(parsed, "__proto__");
  assert.ok(descriptor);
  assert.equal(descriptor.enumerable, true);
  assert.equal("value" in descriptor, true);
  assert.deepEqual(descriptor.value, { polluted: true });
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
});

/** @param {import("../../src/strict-json.js").RawJsonValue} value */
const entriesOf = (value) => {
  assert.ok(isRawObject(value));
  return value.entries;
};
/** @param {import("../../src/strict-json.js").RawJsonValue} value */
const sourcesOf = (value) =>
  entriesOf(value).map(([key, child]) => {
    assert.ok(isRawNumber(child));
    return [key, child.source];
  });

void test("preserving parser keeps the source text of every number", () => {
  const value = parseStrictJsonPreservingNumbers(
    '{"big":9007199254740993,"f":1.50,"e":1e2,"neg":-0}',
    { duplicateKeys: "last-wins", nonStandardConstants: "reject" },
  );
  assert.deepEqual(sourcesOf(value), [
    ["big", "9007199254740993"],
    ["f", "1.50"],
    ["e", "1e2"],
    ["neg", "-0"],
  ]);
});

void test("key order survives, including integer-like keys", () => {
  // A plain JS object would reorder these to 1,2,z,a.
  const value = parseStrictJsonPreservingNumbers('{"z":0,"2":2,"1":1,"a":3}', {
    duplicateKeys: "last-wins",
    nonStandardConstants: "reject",
  });
  assert.deepEqual(
    entriesOf(value).map(([key]) => key),
    ["z", "2", "1", "a"],
  );
});

void test("last-wins replaces in place, keeping the first key's position", () => {
  const value = parseStrictJsonPreservingNumbers('{"a":1,"b":2,"a":3}', {
    duplicateKeys: "last-wins",
    nonStandardConstants: "reject",
  });
  assert.deepEqual(sourcesOf(value), [
    ["a", "3"],
    ["b", "2"],
  ]);
});

void test("an upstream object cannot forge the number brand", () => {
  // The defect this brand exists to prevent: a structural predicate such as
  // `"source" in value` or `typeof value.source === "string"` would classify
  // an ordinary object that merely happens to carry a `source` property as a
  // RawNumber and re-emit it as a bare number token, corrupting the value.
  // Note this object is hand-built, not parsed: the parser always wraps a
  // parsed `{...}` as a RawObject (its forged keys would land inside
  // `.entries`, never as own properties), so parsed input can never exercise
  // this discriminator — only a directly-constructed lookalike can.
  const forged = { source: "123" };
  assert.equal(isRawNumber(forged), false);

  const genuine = parseStrictJsonPreservingNumbers("123", {
    duplicateKeys: "last-wins",
    nonStandardConstants: "reject",
  });
  assert.ok(isRawNumber(genuine));
});

void test("the value parser is unchanged and still coerces", () => {
  assert.deepEqual(
    parseStrictJson('{"big":9007199254740993}', {
      duplicateKeys: "reject",
      nonStandardConstants: "reject",
    }),
    { big: 9007199254740992 },
  );
});

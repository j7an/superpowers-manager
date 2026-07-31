// @ts-check
import assert from "node:assert/strict";
import test from "node:test";

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
    SafetyError,
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
    SafetyError,
  );
});

void test("uncapped recursion failure is converted to SafetyError", () => {
  assert.throws(() => parseStrictJson(nested(20_000), reject), SafetyError);
});

void test("grammar rejects constants, malformed input, and trailing input", () => {
  for (const text of ["NaN", "Infinity", "-Infinity", "{", "[1,]", "true x"]) {
    assert.throws(() => parseStrictJson(text, reject), SafetyError, text);
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
  for (const text of ["nan", "infinity", "+Infinity"]) {
    assert.throws(() => parseStrictJson(text, acceptConstants), SafetyError);
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
    SafetyError,
  );
});

void test("byte input rejects a UTF-8 BOM", () => {
  assert.throws(
    () =>
      parseStrictJson(Uint8Array.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), reject),
    SafetyError,
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
    SafetyError,
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
  for (const text of ["1.0", "1e0"]) {
    assert.throws(() => parseStrictJson(text, integersOnly), SafetyError, text);
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
  // The defect this brand exists to prevent: a structural predicate would
  // classify the inner object as a number token and re-emit it as `123`.
  const value = parseStrictJsonPreservingNumbers(
    '{"future":{"rawNumber":"123","source":"123"}}',
    { duplicateKeys: "last-wins", nonStandardConstants: "reject" },
  );
  const [[, inner]] = entriesOf(value);
  assert.equal(isRawNumber(inner), false);
  assert.ok(isRawObject(inner));
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

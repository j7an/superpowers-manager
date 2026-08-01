// @ts-check
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Dynamic form for the same reason as the unit test: a static `dist/` import
// fails `typecheck:js`. Corrected 2026-07-31.
/** @type {typeof import("../../src/manifest-overlay.js")} */
const { applyManifestOverlay } = await import(
  new URL("../../dist/manifest-overlay.js", import.meta.url).href
);

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, "../fixtures/baseline/overlay-parity");
const VERSION = "9.8.7+manager.0123456";
const PATH = "/w/plugin.json";

// The expected files hold the exact bytes CPython's apply-manifest-overlay.py
// produced, captured before that file was deleted. They are not a snapshot of
// this implementation's own output, which is what makes them evidence.
void test("BASELINE CASE: MANIFEST-READER-OVERLAY-01 byte parity with the Python oracle", () => {
  const names = readdirSync(join(CORPUS, "input")).sort();
  assert.ok(names.length > 0, "corpus is empty");
  for (const name of names) {
    const source = readFileSync(join(CORPUS, "input", name), "utf8");
    const expected = readFileSync(join(CORPUS, "expected", name), "utf8");
    assert.equal(applyManifestOverlay(source, VERSION, PATH), expected, name);
  }
});

// Committed map from fixture file name to the complete message
// applyManifestOverlay must throw for it. Three entries pin CPython-oracle
// wording the parity test above already establishes as byte-identical
// (non-standard-constant, nesting-limit, non-object). `float-overflow.json`
// pins this port's own wording: no committed CPython oracle output
// constrains that message (see the corpus reject test's stale-label defect,
// fixed here), so this is the port recording its own current behavior, not
// matching an oracle byte for byte.
/** @type {Record<string, string>} */
const EXPECTED_REJECT_MESSAGES = {
  "constant-nan.json": `invalid manifest JSON in ${PATH}: non-standard numeric constant: NaN`,
  "float-overflow.json": `JSON number out of range in ${PATH}: 2e308`,
  "nesting-257.json": `JSON nesting exceeds limit in ${PATH}`,
  "non-object.json": `manifest must be a JSON object: ${PATH}`,
};

void test("BASELINE CASE: MANIFEST-READER-OVERLAY-01 rejections match the oracle", () => {
  const names = readdirSync(join(CORPUS, "reject")).sort();
  assert.ok(names.length > 0, "rejection corpus is empty");
  for (const name of names) {
    const source = readFileSync(join(CORPUS, "reject", name), "utf8");
    const expected = EXPECTED_REJECT_MESSAGES[name];
    // A fixture added to the corpus without a pinned message here must fail,
    // not silently pass — that silent pass is exactly the defect this test
    // previously had via assert.throws(fn, name), where the fixture's own
    // filename was mistaken for a matcher instead of a failure label.
    assert.ok(
      expected !== undefined,
      `no expected message pinned in EXPECTED_REJECT_MESSAGES for ${name}`,
    );
    assert.throws(
      () => applyManifestOverlay(source, VERSION, PATH),
      (error) => {
        assert.ok(error instanceof Error, `expected an Error for ${name}`);
        assert.equal(error.message, expected, name);
        return true;
      },
    );
  }
});

// The 5,000-digit integer is a deliberate divergence, not a parity case: the
// oracle rejects it (CPython's 4,300-digit int-conversion limit) and the port
// accepts it, by design — see the sibling README.md. This asserts only the
// port's side of that contract; there is no oracle output to compare against.
void test("BASELINE CASE: MANIFEST-READER-OVERLAY-01 the 5000-digit integer divergence is accepted by the port", () => {
  const source = readFileSync(
    join(CORPUS, "divergent", "int-5000-digits.json"),
    "utf8",
  );
  const out = applyManifestOverlay(source, VERSION, PATH);
  assert.match(out, new RegExp(`"n": ${"9".repeat(5000)}`));
});

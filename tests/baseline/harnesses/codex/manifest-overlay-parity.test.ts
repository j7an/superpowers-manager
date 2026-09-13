import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { applyManifestOverlay } from "../../../../src/harnesses/codex/manifest-overlay.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, "../../../fixtures/baseline/overlay-parity");
const VERSION = "9.8.7+manager.0123456";
const PATH = "/w/plugin.json";

// The expected files hold the overlay contract's exact bytes. Numeric tokens
// intentionally preserve their validated source spelling; the fixtures record
// that contract independently from this implementation's output.
void test("BASELINE CASE: MANIFEST-READER-OVERLAY-01 matches the overlay contract", () => {
  const names = readdirSync(join(CORPUS, "input")).sort();
  assert.ok(names.length > 0, "corpus is empty");
  for (const name of names) {
    const source = readFileSync(join(CORPUS, "input", name), "utf8");
    const expected = readFileSync(join(CORPUS, "expected", name), "utf8");
    assert.equal(applyManifestOverlay(source, VERSION, PATH), expected, name);
  }
});

// Committed map from fixture file name to the complete message
// applyManifestOverlay must throw for it. These entries pin the current overlay
// contract for non-standard constants, numeric range, nesting, and root shape.

const EXPECTED_REJECT_MESSAGES: Record<string, string> = {
  "constant-nan.json": `invalid manifest JSON in ${PATH}: non-standard numeric constant: NaN`,
  "float-overflow.json": `JSON number out of range in ${PATH}: 2e308`,
  "nesting-257.json": `JSON nesting exceeds limit in ${PATH}`,
  "non-object.json": `manifest must be a JSON object: ${PATH}`,
};

void test("BASELINE CASE: MANIFEST-READER-OVERLAY-01 rejections match the overlay contract", () => {
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

// The 5,000-digit integer is a deliberate widening: source-token preservation
// accepts it without numeric conversion. See the sibling README.md.
void test("BASELINE CASE: MANIFEST-READER-OVERLAY-01 accepts the 5000-digit integer", () => {
  const source = readFileSync(
    join(CORPUS, "divergent", "int-5000-digits.json"),
    "utf8",
  );
  const out = applyManifestOverlay(source, VERSION, PATH);
  assert.match(out, new RegExp(`"n": ${"9".repeat(5000)}`));
});

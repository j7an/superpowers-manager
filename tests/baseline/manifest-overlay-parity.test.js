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

void test("BASELINE CASE: MANIFEST-READER-OVERLAY-01 rejections match the oracle", () => {
  const names = readdirSync(join(CORPUS, "reject")).sort();
  assert.ok(names.length > 0, "rejection corpus is empty");
  for (const name of names) {
    const source = readFileSync(join(CORPUS, "reject", name), "utf8");
    assert.throws(() => applyManifestOverlay(source, VERSION, PATH), name);
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

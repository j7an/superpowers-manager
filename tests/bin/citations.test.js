// @ts-check
// The citation gate. PR 12.2 builds the mechanism and repairs nothing.
// Fixture trees are scratch directories; the two live gates at the bottom read
// the real corpus.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { registerScratch } from "./fixture-scratch.js";
import { commentText, scan, targetExists } from "../lib/citations.js";

/**
 * A scratch tree with the given files, cleaned up with the suite.
 * @param {Record<string, string>} files
 * @returns {string}
 */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "spw-citations-"));
  registerScratch(root);
  for (const [name, body] of Object.entries(files)) {
    const target = join(root, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  return root;
}

void test("commentText accepts the three comment-leading forms", () => {
  assert.equal(commentText("  // a")?.text, "  // a");
  assert.equal(commentText("   * a")?.text, "   * a");
  assert.equal(commentText("  /* a */")?.text, "  /* a */");
});

void test("commentText finds a trailing comment outside string delimiters", () => {
  const found = commentText("run(); // see it");
  assert.equal(found?.text, "// see it");
  assert.equal(found?.offset, 7);
});

void test("commentText ignores a slash pair inside a string literal", () => {
  assert.equal(commentText('const u = "http://example.test";'), undefined);
  assert.equal(commentText("const u = 'a//b';"), undefined);
});

void test("commentText finds a trailing comment after a quote-bearing regex literal", () => {
  const found = commentText("const re = /'/; // see src/x.ts:44");
  assert.equal(found?.text, "// see src/x.ts:44");
  assert.equal(found?.offset, 16);
});

void test("commentText finds a trailing comment after a control-condition regex", () => {
  const found = commentText("if (ok) /'/.test(value); // see src/x.ts:44");
  assert.equal(found?.text, "// see src/x.ts:44");
  assert.equal(found?.offset, 25);
});

void test("commentText finds a trailing comment after postfix increment division", () => {
  const found = commentText("count++ / divisor; // see src/x.ts:44");
  assert.equal(found?.text, "// see src/x.ts:44");
  assert.equal(found?.offset, 19);
});

void test("scan parses all four citation forms", () => {
  const root = fixture({
    "a.js": [
      "// anchor only `src/x.ts::export function go`",
      "// anchor and line `src/x.ts:12::const seen`",
      "// anchor and range `src/x.ts:12-18::const seen`",
      "// resolution `git show " + "0".repeat(40) + ":scripts/core/gone.sh`",
      "// legacy src/x.ts:44",
    ].join("\n"),
  });
  const found = scan([join(root, "a.js")]);
  assert.deepEqual(
    found.map((c) => c.kind),
    ["anchored", "anchored", "anchored", "resolution", "legacy"],
  );
  assert.equal(found[0].anchor, "export function go");
  assert.equal(found[0].line, undefined);
  assert.equal(found[1].line, 12);
  assert.equal(found[2].endLine, 18);
  assert.equal(found[3].sha, "0".repeat(40));
  assert.equal(found[4].raw, "src/x.ts:44");
});

void test("scan does not read a citation out of a string literal", () => {
  const root = fixture({ "a.js": 'const s = "src/x.ts:44";\n' });
  assert.deepEqual(scan([join(root, "a.js")]), []);
});

void test("scan does not count an anchored citation's own line as legacy", () => {
  const root = fixture({ "a.js": "// `src/x.ts:12::const seen`\n" });
  const found = scan([join(root, "a.js")]);
  assert.deepEqual(
    found.map((c) => c.kind),
    ["anchored"],
  );
});

void test("scan retains a malformed anchored citation rather than dropping it", () => {
  const root = fixture({ "a.js": "// `src/x.ts:12::`\n" });
  const found = scan([join(root, "a.js")]);
  assert.deepEqual(
    found.map((c) => [c.kind, c.shape]),
    [["malformed", "anchored"]],
  );
});

void test("scan retains a malformed resolution citation", () => {
  const root = fixture({ "a.js": "// `git show 0123:scripts/gone.sh`\n" });
  const found = scan([join(root, "a.js")]);
  assert.deepEqual(
    found.map((c) => [c.kind, c.shape]),
    [["malformed", "resolution"]],
  );
});

void test("scan retains a citation whose line part is not a number", () => {
  const root = fixture({ "a.js": "// `src/x.ts:abc::const seen`\n" });
  const found = scan([join(root, "a.js")]);
  assert.deepEqual(
    found.map((c) => [c.kind, c.shape]),
    [["malformed", "anchored"]],
    "a non-numeric line part must be retained, not vanish",
  );
});

void test("scan retains a citation whose line part contains whitespace", () => {
  const root = fixture({ "a.js": "// `src/x.ts:abc def::const seen`\n" });
  const found = scan([join(root, "a.js")]);
  assert.deepEqual(
    found.map((c) => c.kind),
    ["malformed"],
    "whitespace in the line part must not make the citation disappear",
  );
});

void test("scan retains a citation whose range part is truncated", () => {
  const root = fixture({ "a.js": "// `src/x.ts:1-::const seen`\n" });
  const found = scan([join(root, "a.js")]);
  assert.deepEqual(
    found.map((c) => c.kind),
    ["malformed"],
    "a truncated range must not decay into legacy debt",
  );
});

void test("scan ignores a backticked git show that names only a commit", () => {
  // Prose, not a citation: no OBJECT:PATH, so nothing is being pointed at.
  // The corpus contains one of these and it must not turn the gate red.
  const root = fixture({ "a.js": "// restored from (`git show 76131cf`)\n" });
  assert.deepEqual(scan([join(root, "a.js")]), []);
});

void test("scan does not treat a backticked legacy citation as malformed", () => {
  const root = fixture({ "a.js": "// `src/x.ts:12`\n" });
  const found = scan([join(root, "a.js")]);
  assert.deepEqual(
    found.map((c) => c.kind),
    ["legacy"],
  );
});

void test("scan records the column of the raw token", () => {
  const root = fixture({ "a.js": "// x `src/x.ts:12::const seen`\n" });
  const [found] = scan([join(root, "a.js")]);
  assert.equal(found.column, 5);
  assert.equal(found.raw, "`src/x.ts:12::const seen`");
});

void test("targetExists rejects a target reached through an escaping symlink", () => {
  const scratch = mkdtempSync(join(tmpdir(), "spw-citations-"));
  registerScratch(scratch);
  const root = join(scratch, "root");
  const outside = join(scratch, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, "target.ts"), "outside\n");
  symlinkSync(outside, join(root, "escape"));
  assert.equal(targetExists("escape/target.ts", root), false);
});

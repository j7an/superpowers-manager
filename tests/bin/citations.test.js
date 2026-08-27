// @ts-check
// The citation gate. PR 12.2 builds the mechanism and repairs nothing.
// Fixture trees are scratch directories; the two live gates at the bottom read
// the real corpus.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { registerScratch } from "./fixture-scratch.js";
import {
  buildLedger,
  classify,
  commentText,
  CORPUS_DIRS,
  displayPath,
  ledgerDrift,
  listSources,
  readLedger,
  scan,
  targetExists,
  validate,
} from "../lib/citations.js";

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

void test("commentText treats ordinary identifier of before slash as division", () => {
  const found = commentText("of / divisor; // see src/x.ts:44");
  assert.equal(found?.text, "// see src/x.ts:44");
  assert.equal(found?.offset, 14);
});

void test("commentText allows a regex expression after for-of", () => {
  const found = commentText("for (x of /'/) run(); // see src/x.ts:44");
  assert.equal(found?.text, "// see src/x.ts:44");
  assert.equal(found?.offset, 22);
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

/**
 * One citing file plus one target, scanned and validated in a scratch root.
 * @param {string} comment
 * @param {string} target
 * @returns {{ ok: boolean, code?: string, line?: number, message?: string }}
 */
function check(comment, target) {
  const root = fixture({ "a.js": comment + "\n", "src/x.ts": target });
  const [found] = scan([join(root, "a.js")]);
  return validate(found, root);
}

const TARGET = [
  "const a = 1;",
  "export function go() {",
  "  return a;",
  "}",
].join("\n");

void test("an anchor-only citation resolves to its unique line", () => {
  const r = check("// `src/x.ts::export function go`", TARGET);
  assert.equal(r.ok, true);
  assert.equal(r.line, 2);
});

void test("a line citation agreeing with its anchor passes", () => {
  const r = check("// `src/x.ts:2::export function go`", TARGET);
  assert.equal(r.ok, true);
});

void test("a line citation disagreeing with its anchor reports where the anchor is", () => {
  const r = check("// `src/x.ts:9::export function go`", TARGET);
  assert.equal(r.ok, false);
  assert.equal(r.code, "LINE_MISMATCH");
  assert.equal(r.line, 2);
  assert.match(r.message ?? "", /anchor is at :2/);
});

void test("a range citation passes when the anchor falls inside it", () => {
  assert.equal(check("// `src/x.ts:1-3::export function go`", TARGET).ok, true);
});

void test("a range citation fails when the anchor falls outside it", () => {
  const r = check("// `src/x.ts:3-4::export function go`", TARGET);
  assert.equal(r.ok, false);
  assert.equal(r.code, "RANGE_MISS");
});

void test("an anchor occurring on more than one line is refused", () => {
  const r = check("// `src/x.ts::return`", "return\nreturn\n");
  assert.equal(r.ok, false);
  assert.equal(r.code, "ANCHOR_MULTIPLE");
  assert.match(r.message ?? "", /lengthen it/);
});

void test("an anchor occurring nowhere is refused", () => {
  const r = check("// `src/x.ts::no such text`", TARGET);
  assert.equal(r.ok, false);
  assert.equal(r.code, "ANCHOR_NOT_FOUND");
});

void test("a citation with no anchor text after the separator is refused", () => {
  const r = check("// `src/x.ts:2::`", TARGET);
  assert.equal(r.ok, false);
  assert.equal(r.code, "ANCHOR_MISSING");
});

void test("a resolution reference with a short object name is refused", () => {
  const r = check("// `git show 0123:scripts/gone.sh`", TARGET);
  assert.equal(r.ok, false);
  assert.equal(r.code, "MALFORMED_RESOLUTION");
});

void test("a path escaping the root is refused without touching the filesystem", () => {
  const root = fixture({ "a.js": "// `../outside.ts::export function go`\n" });
  const [found] = scan([join(root, "a.js")]);
  const verdict = validate(found, root);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "MISSING_TARGET");
  assert.equal(targetExists("../outside.ts", root), false);
});

void test("a resolution reference escaping the root is refused", () => {
  const root = fixture({
    "a.js": "// `git show " + "a".repeat(40) + ":../outside.ts`\n",
  });
  const [found] = scan([join(root, "a.js")]);
  const verdict = validate(found, root);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "MALFORMED_RESOLUTION");
});

void test("a legacy citation escaping the root classifies as dead, never live", () => {
  const root = fixture({ "a.js": "// ../outside.ts:5\n" });
  const [found] = scan([join(root, "a.js")]);
  assert.equal(classify(found, root), "dead");
});

void test("an anchor shorter than the minimum is refused", () => {
  const r = check("// `src/x.ts::a`", TARGET);
  assert.equal(r.ok, false);
  assert.equal(r.code, "ANCHOR_TOO_SHORT");
});

void test("an anchored citation whose target is gone is a failure, never debt", () => {
  const root = fixture({ "a.js": "// `src/gone.ts::export function go`\n" });
  const [found] = scan([join(root, "a.js")]);
  const verdict = validate(found, root);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "MISSING_TARGET");
  assert.equal(classify(found, root), "checked");
});

void test("a legacy citation classifies by whether its target survives", () => {
  const root = fixture({
    "a.js": "// live src/x.ts:2 and dead scripts/gone.sh:5\n",
    "src/x.ts": TARGET,
  });
  const found = scan([join(root, "a.js")]);
  assert.deepEqual(
    found.map((c) => classify(c, root)),
    ["unanchored", "dead"],
  );
});

void test("a resolution citation is checked by shape and never opens Git", () => {
  const root = fixture({
    "a.js": "// `git show " + "a".repeat(40) + ":scripts/gone.sh`\n",
  });
  const [found] = scan([join(root, "a.js")]);
  assert.equal(classify(found, root), "checked");
  assert.equal(validate(found, root).ok, true);
});

void test("a malformed citation is never ledgered", () => {
  const root = fixture({ "a.js": "// `src/x.ts:abc::const seen`\n" });
  const ledger = buildLedger(scan([join(root, "a.js")]), root);
  assert.deepEqual(ledger, { unanchored: {}, deadReferent: {} });
});

void test("buildLedger keys by citing file and token, counting duplicates", () => {
  const root = fixture({
    "a.js": [
      "// src/x.ts:2 twice",
      "// again src/x.ts:2 and scripts/gone.sh:5",
    ].join("\n"),
    "src/x.ts": TARGET,
  });
  const ledger = buildLedger(scan([join(root, "a.js")]), root);
  assert.deepEqual(ledger.unanchored, { "a.js": { "src/x.ts:2": 2 } });
  assert.deepEqual(ledger.deadReferent, { "a.js": { "scripts/gone.sh:5": 1 } });
});

void test("buildLedger never records an anchored citation", () => {
  const root = fixture({
    "a.js": "// `src/x.ts:2::export function go`\n",
    "src/x.ts": TARGET,
  });
  const ledger = buildLedger(scan([join(root, "a.js")]), root);
  assert.deepEqual(ledger, { unanchored: {}, deadReferent: {} });
});

void test("ledgerDrift reports an unledgered citation", () => {
  const observed = {
    unanchored: { "a.js": { "src/x.ts:2": 1 } },
    deadReferent: {},
  };
  const drift = ledgerDrift(observed, { unanchored: {}, deadReferent: {} });
  assert.deepEqual(drift, [
    "unanchored a.js `src/x.ts:2`: ledger declares 0, tree has 1",
  ]);
});

void test("ledgerDrift reports an orphan ledger entry", () => {
  const declared = {
    unanchored: { "gone.js": { "src/x.ts:2": 1 } },
    deadReferent: {},
  };
  const drift = ledgerDrift({ unanchored: {}, deadReferent: {} }, declared);
  assert.deepEqual(drift, [
    "unanchored gone.js `src/x.ts:2`: ledger declares 1, tree has 0",
  ]);
});

void test("ledgerDrift reports a count mismatch in either direction", () => {
  const one = { unanchored: { "a.js": { "src/x.ts:2": 1 } }, deadReferent: {} };
  const two = { unanchored: { "a.js": { "src/x.ts:2": 2 } }, deadReferent: {} };
  assert.equal(ledgerDrift(one, two).length, 1);
  assert.equal(ledgerDrift(two, one).length, 1);
});

void test("ledgerDrift reports a bucket mismatch", () => {
  const observed = {
    unanchored: {},
    deadReferent: { "a.js": { "src/x.ts:2": 1 } },
  };
  const declared = {
    unanchored: { "a.js": { "src/x.ts:2": 1 } },
    deadReferent: {},
  };
  assert.deepEqual(ledgerDrift(observed, declared), [
    "deadReferent a.js `src/x.ts:2`: ledger declares 0, tree has 1",
    "unanchored a.js `src/x.ts:2`: ledger declares 1, tree has 0",
  ]);
});

void test("readLedger fails closed on malformed JSON", () => {
  const root = fixture({ "ledger.json": "{ not json" });
  assert.throws(
    () => readLedger(join(root, "ledger.json")),
    /is not valid JSON$/,
    "a malformed ledger must fail, never read as empty",
  );
});

void test("readLedger refuses a missing bucket", () => {
  const root = fixture({ "ledger.json": '{"unanchored":{}}' });
  assert.throws(
    () => readLedger(join(root, "ledger.json")),
    /exactly the buckets deadReferent and unanchored/,
    "a truncated ledger must fail, never default the missing bucket to empty",
  );
});

void test("readLedger refuses an extra bucket", () => {
  const root = fixture({
    "ledger.json": '{"unanchored":{},"deadReferent":{},"waived":{}}',
  });
  assert.throws(
    () => readLedger(join(root, "ledger.json")),
    /exactly the buckets deadReferent and unanchored/,
    "debt must not be parkable in a bucket the drift comparison never reads",
  );
});

void test("readLedger refuses a non-object bucket", () => {
  const root = fixture({
    "ledger.json": '{"unanchored":[],"deadReferent":{}}',
  });
  assert.throws(
    () => readLedger(join(root, "ledger.json")),
    /bucket unanchored must be an object/,
    "an array bucket must fail rather than iterate as empty",
  );
});

void test("readLedger refuses a count that is not a positive integer", () => {
  const root = fixture({
    "ledger.json": '{"unanchored":{"a.js":{"src/x.ts:2":0}},"deadReferent":{}}',
  });
  assert.throws(
    () => readLedger(join(root, "ledger.json")),
    /must be a positive integer/,
    "a zero count would silently cancel a real citation in the drift comparison",
  );
});

void test("readLedger preserves a __proto__ citing-file key as own debt", () => {
  const root = fixture({
    "ledger.json":
      '{"unanchored":{"__proto__":{"src/x.ts:2":1}},"deadReferent":{}}',
  });
  const ledger = readLedger(join(root, "ledger.json"));
  assert.deepEqual(ledgerDrift({ unanchored: {}, deadReferent: {} }, ledger), [
    "unanchored __proto__ `src/x.ts:2`: ledger declares 1, tree has 0",
  ]);
  assert.equal(Object.getPrototypeOf(ledger.unanchored), Object.prototype);
  assert.equal(Object.hasOwn(ledger.unanchored, "__proto__"), true);
});

void test("readLedger preserves a __proto__ token key as own debt", () => {
  const root = fixture({
    "ledger.json": '{"unanchored":{"a.js":{"__proto__":1}},"deadReferent":{}}',
  });
  const ledger = readLedger(join(root, "ledger.json"));
  const counts = ledger.unanchored["a.js"];
  assert.deepEqual(ledgerDrift({ unanchored: {}, deadReferent: {} }, ledger), [
    "unanchored a.js `__proto__`: ledger declares 1, tree has 0",
  ]);
  assert.equal(Object.getPrototypeOf(counts), Object.prototype);
  assert.equal(Object.hasOwn(counts, "__proto__"), true);
});

// ---- the two live gates -------------------------------------------------
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const LEDGER_PATH = join(ROOT, "tests", "citation-ledger.json");

void test("CITATION-01 every anchored citation in the corpus validates", () => {
  /** @type {string[]} */
  const failures = [];
  for (const c of scan(listSources(CORPUS_DIRS, ROOT))) {
    if (c.kind === "legacy") continue;
    const verdict = validate(c, ROOT);
    if (!verdict.ok) {
      failures.push(
        `${displayPath(c.file, ROOT)}:${c.lineNumber}: ${verdict.message}`,
      );
    }
  }
  assert.deepEqual(
    failures,
    [],
    `anchored citations must validate:\n${failures.join("\n")}`,
  );
});

void test("CITATION-02 the ledger matches the tree exactly", () => {
  const declared = readLedger(LEDGER_PATH);
  const observed = buildLedger(scan(listSources(CORPUS_DIRS, ROOT)), ROOT);
  const drift = ledgerDrift(observed, declared);
  assert.deepEqual(drift, [], `citation ledger drift:\n${drift.join("\n")}`);
});

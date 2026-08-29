// @ts-check
// The citation gate. PR 12.2 builds the mechanism and repairs nothing.
// Fixture trees are scratch directories; the two live gates at the bottom read
// the real corpus.

import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
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
  fixEdits,
  applyFixEdits,
  anchorRespectsBoundaries,
  ledgerDrift,
  listSources,
  readLedger,
  scan,
  suggest,
  suggestAnchor,
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

/**
 * A scratch Git object database holding one file, with no commits. Returns the
 * repository root and a 40-hex tree object name that resolves as <sha>:<name>.
 * No commit is created, so no git identity is consulted.
 * @param {string} name
 * @param {string} body
 * @returns {{ root: string, sha: string }}
 */
function gitFixture(name, body) {
  const root = mkdtempSync(join(tmpdir(), "spw-citations-git-"));
  registerScratch(root);
  /**
   * @param {string[]} args
   * @param {string} [input]
   * @returns {string}
   */
  const git = (args, input) => {
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      input,
    });
    assert.equal(
      result.status,
      0,
      `git ${args.join(" ")} failed: ${result.stderr}`,
    );
    return result.stdout.trim();
  };
  git(["init", "--quiet", "."]);
  const target = join(root, name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
  git(["add", "--", name]);
  const sha = git(["write-tree"]);
  assert.equal(git(["rev-list", "--count", "--all"]), "0");
  assert.match(sha, /^[0-9a-f]{40}$/);
  return { root, sha };
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

void test("commentText finds a trailing comment after a quote-bearing block comment", () => {
  const found = commentText("x /* ' */ // see src/x.ts:44");
  assert.equal(found?.text, "// see src/x.ts:44");
  assert.equal(found?.offset, 10);
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

void test("anchored citations accept a slash-bearing extensionless target", () => {
  const root = fixture({
    "a.js": "// `tests/container/Dockerfile:1::ENV SPW_CONTAINER`\n",
    "tests/container/Dockerfile": "ENV SPW_CONTAINER=1\n",
  });
  const [citation] = scan([join(root, "a.js")]);
  assert.equal(citation.kind, "anchored");
  assert.equal(citation.path, "tests/container/Dockerfile");
  assert.deepEqual(validate(citation, root), { ok: true, line: 1 });
});

void test("legacy scanning recognizes a slash-bearing extensionless path", () => {
  const root = fixture({ "a.js": "// scripts/install:13\n" });
  const [citation] = scan([join(root, "a.js")]);
  assert.deepEqual(
    [citation.kind, citation.path, citation.line],
    ["legacy", "scripts/install", 13],
  );
});

void test("a bare word without a slash is not a citation path", () => {
  const root = fixture({ "a.js": "// install:13\n" });
  assert.deepEqual(scan([join(root, "a.js")]), []);
});

void test("an invalid extensionless anchored near-miss is retained", () => {
  const root = fixture({ "a.js": "// `scripts/in@stall:13::spw_main`\n" });
  const [citation] = scan([join(root, "a.js")]);
  assert.deepEqual([citation.kind, citation.shape], ["malformed", "anchored"]);
  const verdict = validate(citation, root);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "ANCHOR_MISSING");
  assert.deepEqual(buildLedger([citation], root), {
    unanchored: {},
    deadReferent: {},
  });
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

void test("scan retains a colon-separated line part as malformed", () => {
  const root = fixture({ "a.js": "// `src/x.ts:12:18::const seen`\n" });
  const found = scan([join(root, "a.js")]);
  assert.equal(found.length, 1);
  const [citation] = found;
  assert.deepEqual([citation.kind, citation.shape], ["malformed", "anchored"]);
  assert.equal(validate(citation, root).ok, false);
  assert.deepEqual(buildLedger(found, root), {
    unanchored: {},
    deadReferent: {},
  });
});

void test("scan retains a point continuation as checked malformed debt exclusion", () => {
  const root = fixture({ "a.js": "// `:12`\n" });
  const [citation] = scan([join(root, "a.js")]);
  assert.deepEqual(
    [citation.kind, citation.shape, citation.path],
    ["malformed", "anchored", ""],
  );
  assert.equal(classify(citation, root), "checked");
  const verdict = validate(citation, root);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "ANCHOR_MISSING");
  assert.deepEqual(buildLedger([citation], root), {
    unanchored: {},
    deadReferent: {},
  });
});

void test("scan retains a range continuation as malformed", () => {
  const root = fixture({ "a.js": "// `:12-18`\n" });
  const [citation] = scan([join(root, "a.js")]);
  assert.deepEqual([citation.kind, citation.shape], ["malformed", "anchored"]);
  const verdict = validate(citation, root);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "ANCHOR_MISSING");
});

void test("scan ignores a nonnumeric colon token", () => {
  const root = fixture({ "a.js": "// `:name`\n" });
  assert.deepEqual(scan([join(root, "a.js")]), []);
});

void test("scan retains an absolute anchored path as malformed", () => {
  const root = fixture({
    "a.js": "// `/src/x.ts::export function go`\n",
  });
  const found = scan([join(root, "a.js")]);
  assert.equal(found.length, 1);
  const [citation] = found;
  assert.deepEqual([citation.kind, citation.shape], ["malformed", "anchored"]);
  assert.equal(validate(citation, root).ok, false);
  assert.deepEqual(buildLedger(found, root), {
    unanchored: {},
    deadReferent: {},
  });
});

void test("scan retains an invalid-character anchored path as malformed", () => {
  const root = fixture({
    "a.js": "// `src/x@.ts::export function go`\n",
  });
  const found = scan([join(root, "a.js")]);
  assert.equal(found.length, 1);
  const [citation] = found;
  assert.deepEqual([citation.kind, citation.shape], ["malformed", "anchored"]);
  assert.equal(validate(citation, root).ok, false);
  assert.deepEqual(buildLedger(found, root), {
    unanchored: {},
    deadReferent: {},
  });
});

void test("scan retains a whitespace-bearing file-like anchored path as malformed", () => {
  const root = fixture({
    "a.js": "// `src/my file.ts::export function go`\n",
  });
  const found = scan([join(root, "a.js")]);
  assert.equal(found.length, 1);
  const [citation] = found;
  assert.deepEqual([citation.kind, citation.shape], ["malformed", "anchored"]);
  assert.equal(validate(citation, root).ok, false);
  assert.deepEqual(buildLedger(found, root), {
    unanchored: {},
    deadReferent: {},
  });
});

void test("scan retains a colon-bearing absolute anchored path as malformed", () => {
  const root = fixture({
    "a.js": "// `C:/src/x.ts::export function go`\n",
  });
  const found = scan([join(root, "a.js")]);
  assert.equal(found.length, 1);
  const [citation] = found;
  assert.deepEqual([citation.kind, citation.shape], ["malformed", "anchored"]);
  assert.equal(validate(citation, root).ok, false);
  assert.deepEqual(buildLedger(found, root), {
    unanchored: {},
    deadReferent: {},
  });
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

void test("a live self-citation excludes only its own raw anchor echo", () => {
  const root = fixture({
    "a.js": "// `a.js:2::export function go`\nexport function go() {}\n",
  });
  const [citation] = scan([join(root, "a.js")]);
  assert.deepEqual(validate(citation, root), { ok: true, line: 2 });
});

void test("a live self-citation still rejects a second real occurrence", () => {
  const root = fixture({
    "a.js":
      "// `a.js:2::export function go`\n" +
      "export function go() {}\n" +
      "// export function go is named again\n",
  });
  const [citation] = scan([join(root, "a.js")]);
  const verdict = validate(citation, root);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "ANCHOR_MULTIPLE");
});

// Spec §4.2's literal table: seven rejects, three accepts. Each fragment is
// unique in its one-line target, so uniqueness alone would admit it; only the
// boundary rule tells them apart. Fixture bodies are double-quoted, never
// template literals -- a citation-shaped token inside a template literal is
// this scanner's declared blind spot.
const BOUNDARY_CASES = [
  ["tion h", "function hookError(x) {", false],
  ["if (ty", 'if (typeof value === "string") {', false],
  ["ommit:", "  commit: true,", false],
  ["turn v", "  return value;", false],
  ["if (ca", "  if (cause) {", false],
  ["rol: u", "  control: unset,", false],
  ["e AdapterR", "type AdapterResult = {", false],
  ["appendBytes", "  appendBytes(buf);", true],
  ["readManifest", "function readManifest(root) {", true],
  ["if (failed) throw", "    if (failed) throw callbackError;", true],
];

for (const [anchor, targetLine, accepted] of BOUNDARY_CASES) {
  void test(`anchor ${JSON.stringify(anchor)} is ${accepted ? "accepted" : "rejected"}`, () => {
    const root = fixture({
      "t.ts": targetLine + "\n",
      "a.js": "// `t.ts:1::" + anchor + "`\n",
    });
    const [citation] = scan([join(root, "a.js")]);
    const verdict = validate(citation, root);
    if (accepted) {
      assert.deepEqual(verdict, { ok: true, line: 1 });
      return;
    }
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, "ANCHOR_UNBOUNDED");
  });
}

void test("boundaries are checked per occurrence, not per line", () => {
  // "cause" appears inside "because" and standalone on the same line; the
  // standalone occurrence is what makes the anchor legible.
  const root = fixture({
    "t.ts": "  // because the cause matters\n",
    "a.js": "// `t.ts:1::cause`\n",
  });
  const [citation] = scan([join(root, "a.js")]);
  assert.deepEqual(validate(citation, root), { ok: true, line: 1 });
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

void test("a resolution citation is checked, never ledgered", () => {
  const root = fixture({
    "a.js": "// `git show " + "a".repeat(40) + ":scripts/gone.sh`\n",
  });
  const [found] = scan([join(root, "a.js")]);
  assert.equal(found.kind, "resolution");
  assert.equal(classify(found, root), "checked");
  assert.deepEqual(buildLedger([found], root), {
    unanchored: {},
    deadReferent: {},
  });
});

void test("a resolution citation whose path exists at that object validates", () => {
  const { root, sha } = gitFixture("gone.sh", "alpha\nbeta\n");
  writeFileSync(join(root, "a.js"), "// `git show " + sha + ":gone.sh`\n");
  const [citation] = scan([join(root, "a.js")]);
  assert.equal(citation.kind, "resolution");
  assert.deepEqual(validate(citation, root), { ok: true });
});

void test("resolution citations accept a slash-bearing extensionless path", () => {
  const { root, sha } = gitFixture(
    "scripts/install",
    "spw_main() {\n  return 0\n}\n",
  );
  writeFileSync(
    join(root, "a.js"),
    "// `git show " + sha + ":scripts/install:1::spw_main`\n",
  );
  const [citation] = scan([join(root, "a.js")]);
  assert.equal(citation.kind, "resolution");
  assert.equal(citation.path, "scripts/install");
  assert.deepEqual(validate(citation, root), { ok: true, line: 1 });
});

void test("a resolution citation whose path is absent at that object fails", () => {
  const { root, sha } = gitFixture("gone.sh", "alpha\nbeta\n");
  writeFileSync(join(root, "a.js"), "// `git show " + sha + ":other.sh`\n");
  const [citation] = scan([join(root, "a.js")]);
  const verdict = validate(citation, root);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "MISSING_HISTORICAL_TARGET");
});

void test("a resolution citation naming an object not in the repository fails", () => {
  const { root } = gitFixture("gone.sh", "alpha\nbeta\n");
  writeFileSync(
    join(root, "a.js"),
    "// `git show " + "0".repeat(40) + ":gone.sh`\n",
  );
  const [citation] = scan([join(root, "a.js")]);
  const verdict = validate(citation, root);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "MISSING_HISTORICAL_TARGET");
});

void test("the historical leg is unverified where there is no repository", () => {
  const root = fixture({
    "a.js": "// `git show " + "a".repeat(40) + ":scripts/gone.sh`\n",
  });
  const [citation] = scan([join(root, "a.js")]);
  assert.deepEqual(validate(citation, root), {
    ok: true,
    unverified: "historical",
  });
});

void test("the historical leg is verified where a repository exists", () => {
  const { root, sha } = gitFixture("gone.sh", "alpha\nbeta\n");
  writeFileSync(join(root, "a.js"), "// `git show " + sha + ":gone.sh`\n");
  const [citation] = scan([join(root, "a.js")]);
  assert.deepEqual(validate(citation, root), { ok: true });
});

void test("a resolution citation carries a line and an anchor", () => {
  const { root, sha } = gitFixture("gone.sh", "alpha\nbeta gamma\ndelta\n");
  writeFileSync(
    join(root, "a.js"),
    "// `git show " + sha + ":gone.sh:2::beta gamma`\n",
  );
  const [citation] = scan([join(root, "a.js")]);
  assert.equal(citation.kind, "resolution");
  assert.equal(citation.anchor, "beta gamma");
  assert.deepEqual(validate(citation, root), { ok: true, line: 2 });
});

void test("a resolution anchor that is not in the historical blob fails", () => {
  const { root, sha } = gitFixture("gone.sh", "alpha\nbeta gamma\ndelta\n");
  writeFileSync(
    join(root, "a.js"),
    "// `git show " + sha + ":gone.sh::no such text`\n",
  );
  const [citation] = scan([join(root, "a.js")]);
  const verdict = validate(citation, root);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "ANCHOR_NOT_FOUND");
});

void test("a resolution anchor on the wrong line fails", () => {
  const { root, sha } = gitFixture("gone.sh", "alpha\nbeta gamma\ndelta\n");
  writeFileSync(
    join(root, "a.js"),
    "// `git show " + sha + ":gone.sh:3::beta gamma`\n",
  );
  const [citation] = scan([join(root, "a.js")]);
  const verdict = validate(citation, root);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "LINE_MISMATCH");
});

void test("a resolution range that does not contain the anchor fails", () => {
  const { root, sha } = gitFixture("gone.sh", "alpha\nbeta gamma\ndelta\n");
  writeFileSync(
    join(root, "a.js"),
    "// `git show " + sha + ":gone.sh:3-4::beta gamma`\n",
  );
  const [citation] = scan([join(root, "a.js")]);
  const verdict = validate(citation, root);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "RANGE_MISS");
});

void test("a resolution citation with a line but no anchor is malformed", () => {
  const { root, sha } = gitFixture("gone.sh", "alpha\nbeta gamma\ndelta\n");
  writeFileSync(join(root, "a.js"), "// `git show " + sha + ":gone.sh:2`\n");
  const [citation] = scan([join(root, "a.js")]);
  assert.deepEqual(
    [citation.kind, citation.shape],
    ["malformed", "resolution"],
  );
  const verdict = validate(citation, root);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "MALFORMED_RESOLUTION");
});

void test("the bare resolution form still parses and still has no anchor", () => {
  const { root, sha } = gitFixture("gone.sh", "alpha\nbeta gamma\ndelta\n");
  writeFileSync(join(root, "a.js"), "// `git show " + sha + ":gone.sh`\n");
  const [citation] = scan([join(root, "a.js")]);
  assert.equal(citation.kind, "resolution");
  assert.equal(citation.anchor, undefined);
  assert.equal(citation.line, undefined);
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

void test("fixEdits rewrites a single-line citation to its anchor's line", () => {
  const root = fixture({
    "a.js": "// `src/x.ts:9::export function go`\n",
    "src/x.ts": TARGET,
  });
  const edits = fixEdits(scan([join(root, "a.js")]), root);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].from, "`src/x.ts:9::export function go`");
  assert.equal(edits[0].to, "`src/x.ts:2::export function go`");
  assert.equal(edits[0].column, 3);
});

void test("fixEdits refuses a range, because shifting one is applying an offset", () => {
  const root = fixture({
    "a.js": "// `src/x.ts:8-9::export function go`\n",
    "src/x.ts": TARGET,
  });
  assert.deepEqual(fixEdits(scan([join(root, "a.js")]), root), []);
});

void test("fixEdits never adds an anchor to a legacy citation", () => {
  const root = fixture({ "a.js": "// src/x.ts:9\n", "src/x.ts": TARGET });
  assert.deepEqual(fixEdits(scan([join(root, "a.js")]), root), []);
});

void test("fixEdits never touches a dead referent", () => {
  const root = fixture({ "a.js": "// `scripts/gone.sh:9::anything`\n" });
  assert.deepEqual(fixEdits(scan([join(root, "a.js")]), root), []);
});

void test("fixEdits leaves an ambiguous anchor alone rather than guessing", () => {
  const root = fixture({
    "a.js": "// `src/x.ts:9::return`\n",
    "src/x.ts": "return\nreturn\n",
  });
  assert.deepEqual(fixEdits(scan([join(root, "a.js")]), root), []);
});

void test("applyFixEdits rewrites the file's bytes", () => {
  const root = fixture({
    "a.js": "// `src/x.ts:9::export function go`\n",
    "src/x.ts": TARGET,
  });
  const a = join(root, "a.js");
  assert.equal(applyFixEdits(fixEdits(scan([a]), root)), 1);
  assert.equal(
    readFileSync(a, "utf8"),
    "// `src/x.ts:2::export function go`\n",
  );
});

void test("applyFixEdits rewrites two citations on one line correctly", () => {
  // The left rewrite shrinks by one character, so a left-to-right writer using
  // original columns would corrupt the right-hand one.
  const root = fixture({
    "a.js": "// `src/x.ts:11::const a` and `src/y.ts:12::const b`\n",
    "src/x.ts": "const a = 1;\n",
    "src/y.ts": "\nconst b = 2;\n",
  });
  const a = join(root, "a.js");
  assert.equal(applyFixEdits(fixEdits(scan([a]), root)), 1);
  assert.equal(
    readFileSync(a, "utf8"),
    "// `src/x.ts:1::const a` and `src/y.ts:2::const b`\n",
  );
});

void test("applyFixEdits is idempotent: a second run rewrites nothing", () => {
  const root = fixture({
    "a.js": "// `src/x.ts:9::export function go`\n",
    "src/x.ts": TARGET,
  });
  const a = join(root, "a.js");
  applyFixEdits(fixEdits(scan([a]), root));
  const once = readFileSync(a, "utf8");
  assert.equal(applyFixEdits(fixEdits(scan([a]), root)), 0);
  assert.equal(
    readFileSync(a, "utf8"),
    once,
    "a second run must not change a byte",
  );
});

void test("applyFixEdits canonicalizes an accepted leading-zero citation in one pass", () => {
  const root = fixture({
    "a.js": "// `src/x.ts:0001::export function go`\n",
    "src/x.ts": TARGET,
  });
  const a = join(root, "a.js");
  assert.equal(applyFixEdits(fixEdits(scan([a]), root)), 1);
  const once = readFileSync(a, "utf8");
  const secondEdits = fixEdits(scan([a]), root);
  const secondWrites = applyFixEdits(secondEdits);
  const corrected = "// `src/x.ts:2::export function go`\n";
  assert.deepEqual(
    {
      once,
      secondEditCount: secondEdits.length,
      secondWrites,
      twice: readFileSync(a, "utf8"),
    },
    { once: corrected, secondEditCount: 0, secondWrites: 0, twice: corrected },
  );
});

const TOOL = fileURLToPath(new URL("../tools/citations.mjs", import.meta.url));

void test("the --fix CLI dispatch rewrites a scratch root, never the repository", () => {
  const root = fixture({
    "src/x.ts": TARGET,
    "tests/bin/a.js": "// `src/x.ts:9::export function go`\n",
    "tests/baseline/.keep": "",
    "tests/unit/.keep": "",
    "tests/lib/.keep": "",
  });
  const result = spawnSync(process.execPath, [TOOL, "--fix"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, SPW_CITATIONS_ROOT: root },
    timeout: 30000,
  });
  assert.equal(result.signal, null, "the tool was killed at the harness bound");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rewrote 1 citations in 1 files/);
  assert.equal(
    readFileSync(join(root, "tests", "bin", "a.js"), "utf8"),
    "// `src/x.ts:2::export function go`\n",
  );
});

void test("CITATION-03 --fix proposes nothing against this repository", () => {
  assert.deepEqual(
    fixEdits(scan(listSources(CORPUS_DIRS, ROOT)), ROOT),
    [],
    "PR 12.2 sweeps nothing: there must be no citation here for --fix to rewrite",
  );
});

void test("fixEdits is empty on a correct citation, so a second run is a no-op", () => {
  const root = fixture({
    "a.js": "// `src/x.ts:2::export function go`\n",
    "src/x.ts": TARGET,
  });
  assert.deepEqual(fixEdits(scan([join(root, "a.js")]), root), []);
});

const SUGGEST_TARGET = [
  "export function begin() {",
  "  const value = compute();",
  "  return value;",
  "}",
  "",
  "export function finish() {",
  "  const value = compute();",
  "  return value;",
  "}",
  "",
].join("\n");

// `begin` and `finish` are five and six characters. A two-character declared
// name would be filtered by MIN_ANCHOR before it could be proposed, which is
// correct behavior and a confusing fixture.

void test("suggestAnchor prefers the declared name", () => {
  const lines = SUGGEST_TARGET.split("\n");
  assert.deepEqual(suggestAnchor(lines, 1, 1), {
    anchor: "begin",
    line: 1,
    endLine: 1,
  });
});

void test("suggestAnchor prefers a unique identifier over a line prefix", () => {
  const lines = ["const value = 1;", "compute(distinctIdentifier);", ""];
  assert.deepEqual(suggestAnchor(lines, 2, 2), {
    anchor: "distinctIdentifier",
    line: 2,
    endLine: 2,
  });
});

void test("suggestAnchor never proposes an inner fragment", () => {
  const lines = ["const hookError = 1;", "call(hookError);", ""];
  const picked = suggestAnchor(lines, 2, 2);
  assert.notEqual(picked, null);
  const anchor = /** @type {{ anchor: string }} */ (picked).anchor;
  assert.ok(
    anchorRespectsBoundaries(lines[1], anchor),
    `suggested ${JSON.stringify(anchor)} begins or ends inside an identifier`,
  );
});

void test("suggestAnchor widens outward when the span is not unique", () => {
  const lines = SUGGEST_TARGET.split("\n");
  const picked = suggestAnchor(lines, 3, 3);
  assert.notEqual(picked, null);
  const span = /** @type {{ line: number, endLine: number }} */ (picked);
  assert.ok(
    span.line < 3 || span.endLine > 3,
    "line 3 is duplicated at line 8, so the span must widen",
  );
  assert.equal(/** @type {{ anchor: string }} */ (picked).anchor, "begin");
});

void test("suggestAnchor returns null rather than proposing a duplicate", () => {
  const lines = ["dup", "dup", "dup", "dup", "dup", "dup", "dup", "dup", ""];
  assert.equal(suggestAnchor(lines, 4, 4), null);
});

void test("suggest proposes an anchored form for a live target", () => {
  const root = fixture({
    "src/x.ts": SUGGEST_TARGET,
    "tests/bin/a.js": "// see src/x.ts:1 for the entry point\n",
    "tests/baseline/.keep": "",
    "tests/unit/.keep": "",
    "tests/lib/.keep": "",
  });
  const lines = suggest(scan(listSources(CORPUS_DIRS, root)), root);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\tsrc\/x\.ts:1\tsrc\/x\.ts:1::begin$/);
});

void test("suggest reports a dead referent as dead when no object is given", () => {
  const root = fixture({
    "src/.keep": "",
    "tests/bin/a.js": "// ported from scripts/core/gone.sh:4\n",
    "tests/baseline/.keep": "",
    "tests/unit/.keep": "",
    "tests/lib/.keep": "",
  });
  const lines = suggest(scan(listSources(CORPUS_DIRS, root)), root);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\tDEAD\b/);
});

void test("suggest proposes a resolution form against a historical object", () => {
  const { root, sha } = gitFixture("old.sh", SUGGEST_TARGET);
  unlinkSync(join(root, "old.sh"));
  mkdirSync(join(root, "tests", "bin"), { recursive: true });
  writeFileSync(
    join(root, "tests", "bin", "a.js"),
    "// ported from old.sh:1\n",
  );
  const lines = suggest(scan([join(root, "tests", "bin", "a.js")]), root, {
    sha,
    path: "old.sh",
  });
  assert.equal(lines.length, 1);
  assert.equal(
    lines[0].endsWith(`git show ${sha}:old.sh:1::begin`),
    true,
    lines[0],
  );
});

void test("an --at object applies only to citations naming that path", () => {
  const { root, sha } = gitFixture("old.sh", SUGGEST_TARGET);
  mkdirSync(join(root, "tests", "bin"), { recursive: true });
  writeFileSync(
    join(root, "tests", "bin", "a.js"),
    "// ported from other.sh:1\n",
  );
  const lines = suggest(scan([join(root, "tests", "bin", "a.js")]), root, {
    sha,
    path: "old.sh",
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\tDEAD\b/);
});

void test("the --report CLI dispatch prints the unverified count", () => {
  const root = fixture({
    "src/x.ts": TARGET,
    "tests/bin/a.js": "// `src/x.ts:2::export function go`\n",
    "tests/baseline/.keep": "",
    "tests/unit/.keep": "",
    "tests/lib/.keep": "",
  });
  const result = spawnSync(process.execPath, [TOOL, "--report"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, SPW_CITATIONS_ROOT: root },
    timeout: 30000,
  });
  assert.equal(result.signal, null, "the tool was killed at the harness bound");
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /^citations=1 unanchored=0 deadReferent=0 unverified=0 failing=0\n/,
  );
});

void test("the --report CLI dispatch counts an unverified historical citation", () => {
  // No `.git` under a scratch root, so the historical leg cannot run and the
  // object name is never resolved -- the all-zero name is a fixture literal,
  // not a claim that such an object exists.
  const root = fixture({
    "src/.keep": "",
    "tests/bin/a.js":
      "// `git show 0000000000000000000000000000000000000000:old.sh::begin`\n",
    "tests/baseline/.keep": "",
    "tests/unit/.keep": "",
    "tests/lib/.keep": "",
  });
  const result = spawnSync(process.execPath, [TOOL, "--report"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, SPW_CITATIONS_ROOT: root },
    timeout: 30000,
  });
  assert.equal(result.signal, null, "the tool was killed at the harness bound");
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /^citations=1 unanchored=0 deadReferent=0 unverified=1 failing=0\n/,
  );
});

void test("the --suggest CLI dispatch proposes without writing", () => {
  const root = fixture({
    "src/x.ts": TARGET,
    "tests/bin/a.js": "// see src/x.ts:2 for the entry point\n",
    "tests/baseline/.keep": "",
    "tests/unit/.keep": "",
    "tests/lib/.keep": "",
  });
  const before = readFileSync(join(root, "tests", "bin", "a.js"), "utf8");
  const result = spawnSync(process.execPath, [TOOL, "--suggest"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, SPW_CITATIONS_ROOT: root },
    timeout: 30000,
  });
  assert.equal(result.signal, null, "the tool was killed at the harness bound");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /src\/x\.ts:2::/);
  assert.equal(
    readFileSync(join(root, "tests", "bin", "a.js"), "utf8"),
    before,
    "--suggest proposes; it never writes",
  );
});

void test("the --suggest CLI dispatch keeps --at separate from the optional prefix", () => {
  const { root, sha } = gitFixture("old.sh", SUGGEST_TARGET);
  unlinkSync(join(root, "old.sh"));
  mkdirSync(join(root, "tests", "bin"), { recursive: true });
  writeFileSync(
    join(root, "tests", "bin", "a.js"),
    "// ported from old.sh:1\n",
  );
  mkdirSync(join(root, "src"), { recursive: true });
  for (const directory of ["baseline", "unit", "lib"])
    mkdirSync(join(root, "tests", directory), { recursive: true });
  const before = readFileSync(join(root, "tests", "bin", "a.js"), "utf8");
  const at = `${sha}:old.sh`;
  for (const args of [
    ["--at", at],
    ["tests/bin", "--at", at],
    ["--at", at, "tests/bin"],
  ]) {
    const result = spawnSync(process.execPath, [TOOL, "--suggest", ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, SPW_CITATIONS_ROOT: root },
      timeout: 30000,
    });
    assert.equal(
      result.signal,
      null,
      "the tool was killed at the harness bound",
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      new RegExp(`git show ${sha}:old\\.sh:1::begin`),
    );
  }
  assert.equal(
    readFileSync(join(root, "tests", "bin", "a.js"), "utf8"),
    before,
    "historical --suggest proposals never write",
  );
});

// ---- the two live gates -------------------------------------------------
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const LEDGER_PATH = join(ROOT, "tests", "citation-ledger.json");

// The container is a copy of a checkout, not a checkout, so the historical leg
// cannot run there. That scope is DECLARED, not silent: the count below must be
// zero wherever a repository exists, and exactly the resolution population
// where none does. The declaration itself is asserted by
// `tests/bin/tooling-coverage.test.js:52::the container declaration matches the actual environment`,
// so deleting or renaming that test fails this gate.
const DECLARED_CONTAINER = process.env.SPW_CONTAINER === "1";

void test("the corpus reaches every committed JavaScript file under tests/", () => {
  const covered = new Set(
    listSources(CORPUS_DIRS, ROOT).map((f) => displayPath(f, ROOT)),
  );
  for (const f of [
    "tests/assert-matcher-gate.js",
    "tests/build-id.js",
    "tests/run-node-suites.js",
    "tests/write-build-id.js",
    "tests/tools/citations.mjs",
    "tests/tools/float-differential.mjs",
  ]) {
    assert.ok(covered.has(f), `${f} must be in the enforced corpus`);
  }
});

void test("CITATION-01 every anchored citation in the corpus validates", () => {
  const citations = scan(listSources(CORPUS_DIRS, ROOT));
  /** @type {string[]} */
  const failures = [];
  let unverified = 0;
  for (const c of citations) {
    if (c.kind === "legacy") continue;
    const verdict = validate(c, ROOT);
    if (!verdict.ok) {
      failures.push(
        `${displayPath(c.file, ROOT)}:${c.lineNumber}: ${verdict.message}`,
      );
    }
    if (verdict.ok && verdict.unverified !== undefined) unverified += 1;
  }
  assert.deepEqual(
    failures,
    [],
    `anchored citations must validate:\n${failures.join("\n")}`,
  );
  const resolutions = citations.filter((c) => c.kind === "resolution").length;
  assert.equal(
    unverified,
    DECLARED_CONTAINER ? resolutions : 0,
    DECLARED_CONTAINER
      ? `declared scope covers resolution citations only; ${unverified} of ${citations.length} went unverified`
      : "a repository exists here, so every resolution citation must be verified against the object database",
  );
});

void test("CITATION-02 the ledger matches the tree exactly", () => {
  const declared = readLedger(LEDGER_PATH);
  const observed = buildLedger(scan(listSources(CORPUS_DIRS, ROOT)), ROOT);
  const drift = ledgerDrift(observed, declared);
  assert.deepEqual(drift, [], `citation ledger drift:\n${drift.join("\n")}`);
});

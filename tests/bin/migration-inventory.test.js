// @ts-check
// Makes each migration inventory's reconciliation executable. Guards two
// deletion modes the existing per-cluster TABLE.length assertions cannot see:
// a numbered inventory entry removed, and a whole test( call site removed.
// A fixture-table row removed is still the TABLE.length guards' job.
//
// An assert deleted from inside a surviving test body is NOT caught here.
// That is per-entry accounting, deliberately out of scope — it needs a
// markdown-parsing harness, and runtime counting would not catch it either.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const INVENTORY_DIR = join(ROOT, "tests", "migration-inventory");

// Declared, never derived. A glob is a query over mutable state and it empties
// exactly when the deletion it should catch happens — the failure instance this
// series has already hit twice. Adding or removing an inventory, or changing
// which port files one covers, requires editing this map in the same reviewed
// commit as the file itself.
/** @type {Record<string, string[]>} */
const DECLARED = {
  "bin-dispatch.md": ["tests/bin/bin-dispatch.test.js"],
  "bootstrap.md": ["tests/bin/bootstrap.test.js"],
  "container-contract.md": ["tests/bin/container-contract.test.js"],
  "install-commands.md": ["tests/bin/install-commands.test.js"],
  "node-tooling.md": ["tests/bin/node-tooling.test.js"],
  "npm-pack-contents.md": ["tests/bin/npm-pack-contents.test.js"],
  "ref-resolution.md": ["tests/baseline/ref-resolution.test.js"],
  "selection-commands.md": ["tests/baseline/selection-commands.test.js"],
  "selection-state.md": ["tests/baseline/selection-location.test.js"],
  "uninstall-commands.md": ["tests/bin/uninstall-commands.test.js"],
  "workflows.md": [
    "tests/bin/action-pins.test.js",
    "tests/bin/workflows.test.js",
  ],
};

const DECLARATION = /^```json inventory\n([\s\S]*?)\n```$/gm;
const ENTRY = /^(\d+)(?:-(\d+))?\.\s/;
const PROSE_TOTAL = /^- Shell original: \*\*(\d+)\*\* assertions/m;
const TEST_IMPORT = /^import test from "node:test";$/m;

// Cardinal words this project's inventories have actually used for a stated
// count (bin-dispatch.md's "two", selection-state.md's "six",
// ref-resolution.md's "seven" and, before its fix-round correction, "nine").
// Bounded at twenty: every inventory's merge/retirement count observed so
// far is well under ten, and a count needing a word beyond this list is a
// sign the file should say the digit instead, not a gap to close here.
/** @type {Record<string, number>} */
const WORD_NUMBERS = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};
const NUMBER_TOKEN = `(\\d+|${Object.keys(WORD_NUMBERS).join("|")})`;

// Anchored to the two exact declared-count phrasings that have each drifted
// from their own file's marker count once already (Tasks 7, 8, and 9's
// review rounds) — not a general-purpose prose parser. Each phrasing pairs a
// stated number with a specific noun phrase directly behind it
// ("N recorded merges", "N retired items"); nothing that merely mentions
// "retired" or "merged" elsewhere (e.g. "bin-dispatch.md's retired items",
// which names no count) can match, because there is no number token
// immediately before the phrase.
const RECORDED_MERGES_RE = new RegExp(
  `\\b${NUMBER_TOKEN}\\s+recorded merges\\b`,
  "gi",
);
const RETIRED_ITEMS_RE = new RegExp(
  `\\*{0,2}${NUMBER_TOKEN}\\s+retired items\\*{0,2}`,
  "gi",
);

// Declared, never derived — same philosophy as DECLARED above, and for the
// same reason: a predicate ("skip any file with zero markers") would also
// match a file that *lost* its markers, silently passing exactly the
// deletion this checker exists to catch. workflows.md is named here, alone,
// because it records its merges by prose item-range enumeration
// ("items 1-2", "items 17-24", "items 25-28") and never adopted the
// `**Merged**` bold-marker convention the other three phrase-bearing files
// use — its "three recorded merges" is not machine-checkable in this form,
// not a defect. Remove this entry if workflows.md ever adopts the marker.
const STATED_COUNT_MARKER_CHECK_EXEMPT = new Set(["workflows.md"]);

// Anchored to the literal shorthand punctuation an inventory uses to restate
// its own divergence arithmetic in one place (e.g. "+5/-7/net-2") — not to
// any specific file's wording, so it needs no phrase-specific exemption list
// and rewording the surrounding sentence cannot defeat it. It is still an
// anchor on punctuation, not a general parser: a spelled-out "+5 / -7 /
// net -2" produces no match at all, so this catches drift in the shorthand
// itself, not every way the same arithmetic could be phrased. Unlike RECORDED_MERGES_RE/
// RETIRED_ITEMS_RE, which each check a stated count against the file's own
// bold-marker count (an external ground truth), this checks the shorthand's
// three numbers against each other: it cannot know whether either +N or -M
// is itself correct, only whether the stated net is the *arithmetic
// consequence* of the other two, wherever this exact shape appears. That is
// enough to catch a total that contradicts its own inputs — the failure
// mode a fourth consecutive inventory shipped (see selection-commands.md's
// fix history: "+8/-9/net-2" stood next to a correct "Net: ... = -2"
// derivation two paragraphs earlier, and no existing check compared them).
const NET_ARITHMETIC_RE = /\+(\d+)\/-(\d+)\/net(-?\d+)/g;

/**
 * Asserts every occurrence of the "+N/-M/netK" shorthand in `source` is
 * self-consistent (N - M === K), independent of whether N or M themselves
 * are correct.
 * @param {string} source
 * @param {string} name
 */
function assertNetArithmeticSelfConsistent(source, name) {
  for (const match of source.matchAll(NET_ARITHMETIC_RE)) {
    const additions = Number(match[1]);
    const subtractions = Number(match[2]);
    const claimedNet = Number(match[3]);
    assert.equal(
      additions - subtractions,
      claimedNet,
      `${name}: states "${match[0]}" but ${additions} - ${subtractions} = ${additions - subtractions}, not ${claimedNet}`,
    );
  }
}

/**
 * @param {string} token digits or one of WORD_NUMBERS's keys, any case
 * @returns {number}
 */
function parseStatedCount(token) {
  if (/^\d+$/.test(token)) return Number(token);
  const found = WORD_NUMBERS[token.toLowerCase()];
  assert.ok(found !== undefined, `unrecognized count word: ${token}`);
  return found;
}

/**
 * Asserts every occurrence of `countRe` in `source` (a stated "N <phrase>")
 * agrees with the file's own count of `markerRe` (its bold per-item marker
 * for the same concept, e.g. `**Merged**`). Both regexes must be global.
 * Skipped entirely for a name in `exempt` — see
 * STATED_COUNT_MARKER_CHECK_EXEMPT.
 * @param {string} source
 * @param {RegExp} countRe
 * @param {RegExp} markerRe
 * @param {string} phraseLabel
 * @param {string} name
 * @param {ReadonlySet<string>} exempt
 */
function assertStatedCountMatchesMarkers(
  source,
  countRe,
  markerRe,
  phraseLabel,
  name,
  exempt,
) {
  if (exempt.has(name)) return;
  const stated = [...source.matchAll(countRe)];
  if (stated.length === 0) return;
  const actual = [...source.matchAll(markerRe)].length;
  for (const match of stated) {
    const claimed = parseStatedCount(match[1]);
    assert.equal(
      claimed,
      actual,
      `${name}: states "${match[0].trim()}" (${phraseLabel}) but the file has ${actual} bold marker(s) for it`,
    );
  }
}

/**
 * Lines between a marker pair. Regions are stated, never inferred from
 * headings: workflows.md carries a legitimate prose enumeration at column 0
 * (`:484`, `:495`, `:506`) that heading inference reads as entries 1-3. That
 * enumeration sits *inside* the mapped span, so position alone cannot exclude
 * it — see `mappedLinesOf` and the `inventory:ignore` kind.
 * @param {string[]} lines
 * @param {string} kind
 * @param {string} name
 * @returns {{ start: number, end: number, lines: string[] } | null}
 */
function region(lines, kind, name) {
  const open = lines.filter(
    (l) => l.trim() === `<!-- inventory:${kind}:start -->`,
  );
  const close = lines.filter(
    (l) => l.trim() === `<!-- inventory:${kind}:end -->`,
  );
  assert.ok(
    open.length === close.length && open.length <= 1,
    `${name}: unbalanced or repeated inventory:${kind} markers (${open.length} start, ${close.length} end)`,
  );
  if (open.length === 0) return null;
  const start = lines.findIndex(
    (l) => l.trim() === `<!-- inventory:${kind}:start -->`,
  );
  const end = lines.findIndex(
    (l) => l.trim() === `<!-- inventory:${kind}:end -->`,
  );
  assert.ok(
    end > start,
    `${name}: inventory:${kind} end marker precedes its start`,
  );
  return { start, end, lines: lines.slice(start + 1, end) };
}

/**
 * The two regions must be disjoint. Checking each marker kind independently
 * lets an interleaved `port-only:start` sit inside the mapped region, which
 * would count its entries twice.
 * @param {{ start: number, end: number } | null} a
 * @param {{ start: number, end: number } | null} b
 * @param {string} name
 */
function assertDisjoint(a, b, name) {
  if (a === null || b === null) return;
  assert.ok(
    a.end < b.start || b.end < a.start,
    `${name}: the mapped and port-only regions overlap or nest — mapped [${a.start}, ${a.end}], port-only [${b.start}, ${b.end}]`,
  );
}

/**
 * The mapped region's lines with a nested `inventory:ignore` span removed.
 *
 * Needed because workflows.md's mutation-proof narrative sits between entries
 * `83.` and `84.`, and its "1. 2. 3." list is at column 0. A single mapped pair
 * cannot exclude it by position, and relocating the prose would divorce the
 * proof from the entries it documents.
 *
 * The exclusion cannot silently swallow a real entry, because
 * `assertExactlyOneThrough` compares the mapped numbers to `[1..shellOriginal]`
 * — and `shellOriginal` comes from the JSON declaration block, which no ignore
 * span can reach.
 *
 * Do NOT weaken that to a no-gaps check. A no-gaps test catches only interior
 * holes. Measured 2026-08-03 on workflows.md: swallowing entry `84.` yields
 * `gaps=[84]` (caught either way), but swallowing the tail `95.`-`100.` yields
 * `mapped=94, max=94, gaps=[]` — silently GREEN under contiguity alone, RED
 * against `[1..100]`. The ignore span and the `shellOriginal` equality are a
 * matched pair.
 * @param {{ start: number, end: number, lines: string[] }} outer
 * @param {{ start: number, end: number, lines: string[] } | null} inner
 * @param {string} name
 * @returns {string[]}
 */
function mappedLinesOf(outer, inner, name) {
  if (inner === null) return outer.lines;
  assert.ok(
    inner.start > outer.start && inner.end < outer.end,
    `${name}: the inventory:ignore span must nest strictly inside the mapped region — ignore [${inner.start}, ${inner.end}], mapped [${outer.start}, ${outer.end}]`,
  );
  return outer.lines.filter((_, offset) => {
    const absolute = outer.start + 1 + offset;
    return absolute < inner.start || absolute > inner.end;
  });
}

/**
 * Entry numbers in a region, ranges expanded inclusively. Range headings are
 * load-bearing: container-contract.md uses `51-65.`, `73-90.`, `97-101.`, and
 * `116-141.` for bundled items.
 * @param {string[]} lines
 * @param {string} label
 * @returns {number[]}
 */
function entryNumbers(lines, label) {
  const found = [];
  for (const line of lines) {
    const match = ENTRY.exec(line);
    if (match === null) continue;
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    assert.ok(end >= start, `${label}: descending range heading: ${line}`);
    for (let n = start; n <= end; n += 1) found.push(n);
  }
  return found;
}

/**
 * @param {number[]} numbers
 * @param {number} expected
 * @param {string} label
 */
function assertExactlyOneThrough(numbers, expected, label) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const duplicates = sorted.filter((n, i) => i > 0 && n === sorted[i - 1]);
  assert.deepEqual(duplicates, [], `${label}: duplicate entry numbers`);
  assert.deepEqual(
    sorted,
    Array.from({ length: expected }, (_, i) => i + 1),
    `${label}: entry numbers must be exactly 1..${expected}`,
  );
}

/**
 * Remove line comments, block comments, and string/template literal contents,
 * replacing each literal with an empty pair so surrounding syntax survives.
 *
 * Not a full JavaScript lexer: it does not track regex-literal context. That is
 * acceptable because a mis-strip yields a wrong count and therefore RED — it
 * cannot manufacture a false green, except by exact compensation (e.g. a
 * regex literal containing `test(` inflating the count by exactly the amount
 * a real deletion decreased it). Verified 2026-08-02 across every file in
 * tests/bin/: only assert-matcher-gate.test.js changes (10 unstripped, 8
 * stripped, two `test(` occurrences living inside string fixtures), and no
 * inventoried file's count moves.
 * @param {string} source
 * @returns {string}
 */
function stripInert(source) {
  let out = "";
  let index = 0;
  const length = source.length;
  while (index < length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      while (index < length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (
        index < length &&
        !(source[index] === "*" && source[index + 1] === "/")
      ) {
        index += 1;
      }
      index += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      index += 1;
      while (index < length && source[index] !== quote) {
        if (source[index] === "\\") index += 1;
        index += 1;
      }
      index += 1;
      out += '""';
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * Static test( call sites: `test(` not preceded by an identifier character or a
 * dot, counted AFTER comments and string/template contents are stripped.
 * Counts `void test(` at any indentation, including inside a loop; excludes
 * `t.test(`, `subtest(`, and any `test(` in a comment or string.
 *
 * A STATIC count, not the runtime case count — three call sites in
 * action-pins.test.js iterate fixture tables, so its 8 sites produce 22 runtime
 * cases.
 * @param {string} source
 * @returns {number}
 */
function testCallSites(source) {
  return (stripInert(source).match(/(?<![A-Za-z0-9_$.])test\(/g) ?? []).length;
}

const inventories = readdirSync(INVENTORY_DIR)
  .filter((name) => name.endsWith(".md"))
  .sort();

// The glob still runs — it is what sees an undeclared file appear. What it
// cannot see on its own is a file disappearing, because iterating one fewer
// item is not an error. Comparing it against the declared list catches both
// directions.
assert.deepEqual(
  inventories,
  Object.keys(DECLARED).sort(),
  "the migration-inventory directory disagrees with the declared inventory list",
);

for (const name of inventories) {
  void test(`migration inventory reconciles: ${name}`, () => {
    const source = readFileSync(join(INVENTORY_DIR, name), "utf8");
    const lines = source.split("\n");

    const declarationMatches = [...source.matchAll(DECLARATION)];
    assert.equal(
      declarationMatches.length,
      1,
      `${name}: expected exactly one \`json inventory\` declaration block, found ${declarationMatches.length}`,
    );
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(declarationMatches[0][1]);
    } catch {
      return assert.fail(`${name}: the json inventory block is not valid JSON`);
    }

    assert.ok(
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed),
      `${name}: the json inventory block must be an object`,
    );
    /** @type {{ shellOriginal: unknown, portOnly: unknown, ports: unknown }} */
    const declared = /** @type {any} */ (parsed);
    assert.ok(
      Number.isInteger(declared.shellOriginal) &&
        /** @type {number} */ (declared.shellOriginal) > 0,
      `${name}: shellOriginal must be a positive integer`,
    );
    assert.ok(
      Number.isInteger(declared.portOnly) &&
        /** @type {number} */ (declared.portOnly) >= 0,
      `${name}: portOnly must be a non-negative integer`,
    );
    // Explicit, not `?? {}`: a scalar or array `ports` must be named as the
    // fault it is, rather than degrading into an empty-entries diagnostic that
    // points somewhere else.
    assert.ok(
      typeof declared.ports === "object" &&
        declared.ports !== null &&
        !Array.isArray(declared.ports),
      `${name}: ports must be an object`,
    );
    const portEntries = Object.entries(
      /** @type {Record<string, unknown>} */ (declared.ports),
    );
    assert.ok(
      portEntries.length > 0,
      `${name}: ports must name at least one port file`,
    );
    // Binds the SET of port files, not just their contents. Without this, deleting
    // a `ports` entry removes that port file's call-site guard and stays green.
    assert.deepEqual(
      portEntries.map(([portPath]) => portPath).sort(),
      [...DECLARED[name]].sort(),
      `${name}: the declaration's port files disagree with the declared port map`,
    );
    const shellOriginal = /** @type {number} */ (declared.shellOriginal);
    const portOnlyCount = /** @type {number} */ (declared.portOnly);

    const mapped = region(lines, "mapped", name);
    assert.ok(mapped !== null, `${name}: missing inventory:mapped markers`);
    const portOnly = region(lines, "port-only", name);
    assertDisjoint(mapped, portOnly, name);
    const ignored = region(lines, "ignore", name);

    assertExactlyOneThrough(
      entryNumbers(mappedLinesOf(mapped, ignored, name), `${name} mapped`),
      shellOriginal,
      `${name} mapped region`,
    );

    if (portOnlyCount > 0) {
      assert.ok(
        portOnly !== null,
        `${name}: portOnly is ${portOnlyCount} but there are no inventory:port-only markers`,
      );
      assertExactlyOneThrough(
        entryNumbers(portOnly.lines, `${name} port-only`),
        portOnlyCount,
        `${name} port-only region`,
      );
    } else {
      assert.equal(
        portOnly,
        null,
        `${name}: portOnly is 0 but inventory:port-only markers are present`,
      );
    }

    for (const [portPath, expectedSites] of portEntries) {
      assert.ok(
        Number.isInteger(expectedSites) &&
          /** @type {number} */ (expectedSites) > 0,
        `${name}: ${portPath} must declare a positive static call-site count`,
      );
      let portSource;
      try {
        portSource = readFileSync(join(ROOT, portPath), "utf8");
      } catch {
        return assert.fail(`${name}: port file could not be read: ${portPath}`);
      }
      // The counter recognizes one binding form. An aliased import or a
      // describe/it style would be invisible to it, so require the form and
      // fail closed rather than miscount. All 31 suite files use it.
      assert.ok(
        TEST_IMPORT.test(portSource),
        `${name}: ${portPath} must import the runner as \`import test from "node:test";\` for the call-site count to be meaningful`,
      );
      assert.equal(
        testCallSites(portSource),
        expectedSites,
        `${name}: ${portPath} static test( call-site count disagrees with the declaration`,
      );
    }

    const proseMatch = PROSE_TOTAL.exec(source);
    assert.ok(
      proseMatch !== null,
      `${name}: Cardinality is missing the anchored "- Shell original: **N** assertions" line`,
    );
    assert.equal(
      Number(proseMatch[1]),
      shellOriginal,
      `${name}: the Cardinality prose total disagrees with the declaration block`,
    );

    // Three fix rounds in a row (Tasks 7, 8, and 9) shipped a prose count of
    // this exact shape that disagreed with the file's own bold markers, and
    // the gate above cannot see it: shellOriginal/portOnly/ports/1..N never
    // touch this sentence. This does.
    assertStatedCountMatchesMarkers(
      source,
      RECORDED_MERGES_RE,
      /\*\*merged\*\*/gi,
      "recorded merges",
      name,
      STATED_COUNT_MARKER_CHECK_EXEMPT,
    );
    assertStatedCountMatchesMarkers(
      source,
      RETIRED_ITEMS_RE,
      /\*\*retired\*\*/gi,
      "retired items",
      name,
      STATED_COUNT_MARKER_CHECK_EXEMPT,
    );

    assertNetArithmeticSelfConsistent(source, name);
  });
}

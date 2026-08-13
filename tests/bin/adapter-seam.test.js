// @ts-check
// One gate, plus the three cases that keep it from going vacuous. PRESENT
// STATE, re-derived 2026-08-11 (PR 11.5 slice 4b Task 9): every
// SEAM_DEPENDENT entry is { intercept: 0, log: 0 }, and no parseable
// seamDependency DECLARATION is left in the SEAM_SOURCES files — Task 6
// (2026-08-10) discharged all thirty, and the count case below re-derives
// that 0 on every run.
//
// The reader count is no longer zero, and was not zero at Task 9 either:
// tests/bin/install-commands.test.js and tests/bin/uninstall-commands.test.js
// each hold literal readLog(c.adapterLog) sites again, every one of them
// inside that file's row-18 tripwire case (the exact tally stays out of this
// prose — adapter-seam.js's own opening paragraph is where a reader count is
// asserted). They are the inverse of the residue these
// gates hunt. One asserts the log is EMPTY because the in-process subject
// never spawns the fake adapter; the other asserts the line a directly
// spawned fake adapter leaves before the tripwire refuses it. Neither can
// quietly keep passing once the seam goes: the whole case is built on the
// fake adapter and disappears with it in slice 4c/6.
//
// Know this before trusting the classification gate below. Its property is
// `readers === 0 || declared > 0`, so with readers nonzero the second
// disjunct is the one holding it up. `declared` must therefore count actual
// declarations, not the case builder's `seamDependency: options.seamDependency`
// passthrough: only `DECLARATION` can establish the protection this gate asks
// for.
//
// HISTORY, which is why the gates were written: before Task 6 there were 9
// reader sites and 30 declaring cases, and both would have gone vacuous when
// slice 4 removed the seam, in exactly the way five cli-parity assertions did
// in slice 3.4 — silently, with the suite still green.
//
// The surviving gate is "no adapter-log reader is left unclassified". The
// other three cases keep it from going vacuous: the count case ties
// SEAM_DEPENDENT to the declarations it claims to protect, and the two
// membership cases keep SEAM_SOURCE_FILES — the scan set the gate walks — from
// being emptied ahead of the residue it is supposed to find.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  SEAM_DEPENDENT,
  SEAM_REASONS,
  SEAM_SOURCE_FILES,
  SEAM_SOURCES,
} from "./adapter-seam.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// Site pattern: what counts as "a declaration," shared by the count case and
// the tree-derived membership case below (declaringFiles()). If the two ever
// drifted, the tree scan could miss a form the count scan credits — the
// unclassified-residue hole all over again, one level up.
//
// `[^}]*` stops at the first `}`, so this depends on every site being flat —
// no nested object inside a seamDependency declaration. Verified against the
// tree while widening this pattern (matrix row 19's follow-up): all 30 sites
// match with none truncated by a nested brace.
//
// Order-tolerant deliberately: property order carries no meaning in JS, so a
// pattern anchored on `reason` before `script` (this file's prior shape)
// rejects a well-formed declaration written script-first, not a malformed
// one — property order was never the thing worth gating. `reason:` and
// `script:` are matched independently against each site below, so either
// order is accepted; a site where either field fails to parse is the actual
// malformed declaration, and the count case below fails loud on it, naming
// the file and the missing field, rather than surfacing as a confusing count
// mismatch.
//
// Non-global on purpose; the count case adds the `g` flag where it needs
// matchAll, so no `lastIndex` is ever carried between .test() calls.
const DECLARATION = /seamDependency:\s*\{[^}]*\}/;
const REASON_FIELD = /reason:\s*"(\w+)"/;
const SCRIPT_FIELD = /script:\s*"(\w+)"/;

// Declared, never derived. These are the intentional row-18 tripwire
// readers: with no live seam declarations left, an added reader must not hide
// among them. A file that regains a real declaration keeps the deliberately
// weak, per-file classification below — attributing individual readers to
// cases needs a parser this repository does not have.
const INTENTIONAL_NON_SEAM_READERS = new Map([
  ["tests/bin/install-commands.test.js", 2],
  ["tests/bin/uninstall-commands.test.js", 2],
]);

/**
 * Type-guards a string against SEAM_REASONS. The cast is only on the
 * `.includes` receiver, to a widened `readonly string[]` view that accepts a
 * plain string argument — SEAM_REASONS's own declared element type is
 * untouched, so this is the real runtime membership check, not a bypass of
 * it, and the `reason is ...` return type still narrows the caller.
 * @param {string} reason
 * @returns {reason is (typeof SEAM_REASONS)[number]}
 */
function isSeamReason(reason) {
  return /** @type {readonly string[]} */ (SEAM_REASONS).includes(reason);
}

void test("each declared count matches the declarations in its sources", () => {
  // The count is declared, but checked against the source: a case removed
  // without decrementing would otherwise leave the gate demanding protection
  // for cases that no longer exist.
  //
  // The scan set is SEAM_SOURCE_FILES, NOT Object.values(SEAM_SOURCES).flat():
  // the derived set drops a file the moment slice 4 removes its last
  // SEAM_DEPENDENT key, which is exactly when that file's leftover
  // declarations must still be counted. See SEAM_SOURCE_FILES's comment.
  /** @type {Record<string, { intercept: number, log: number }>} */
  const found = {};
  for (const script of Object.keys(SEAM_DEPENDENT)) {
    found[script] = { intercept: 0, log: 0 };
  }
  for (const relative of SEAM_SOURCE_FILES) {
    const source = readFileSync(join(ROOT, relative), "utf8");
    for (const m of source.matchAll(new RegExp(DECLARATION, "g"))) {
      const site = m[0];
      const foundReason = REASON_FIELD.exec(site);
      assert.ok(
        foundReason,
        `${relative} has a seamDependency declaration with no parseable ` +
          `reason field: ${site}`,
      );
      const foundScript = SCRIPT_FIELD.exec(site);
      assert.ok(
        foundScript,
        `${relative} has a seamDependency declaration with no parseable ` +
          `script field: ${site}`,
      );
      const reason = /** @type {string} */ (foundReason[1]);
      const script = /** @type {string} */ (foundScript[1]);
      assert.ok(
        Object.hasOwn(found, script),
        `${relative} declares script "${script}", absent from SEAM_DEPENDENT`,
      );
      assert.ok(
        isSeamReason(reason),
        `${relative} declares reason "${reason}" for script "${script}", ` +
          "which is neither intercept nor log",
      );
      found[script][reason] += 1;
    }
  }
  assert.deepEqual(found, SEAM_DEPENDENT);
});

void test("adapter-log readers have a declaration or their explicit non-seam baseline", () => {
  // A reader in a case with no seamDependency is a reader whose channel dies
  // unannounced. All three modes still write adapter.log, so `delegate` is the
  // mode most likely to look harmless here.
  //
  // Deliberately per-FILE, not per-case: one case can hold several readers,
  // and a declared case can hold none, so a count comparison would be wrong.
  // Per-case attribution needs a parser this repo has no dependency for, and
  // tests/bin/migration-inventory.test.js's history is a standing argument
  // against approximating one with a regex. A file with a real declaration
  // therefore keeps the old weak classification. A file without one must be
  // empty unless it has an explicit intentional-reader baseline.
  //
  // Scans SEAM_SOURCE_FILES for the reason test 3 above does: the derived set
  // would stop visiting a file exactly when slice 4 empties its SEAM_DEPENDENT
  // entry, leaving live readers unclassified with this loop body never run.
  //
  // A file slice 4 has legitimately emptied of both readers and declarations
  // is not a defect, so its implicit baseline is zero. The two row-18
  // tripwire files state their intentional readers above; any other reader in
  // a declaration-free file fails rather than being covered by a bare
  // `seamDependency:` mention in the case builder.
  for (const relative of SEAM_SOURCE_FILES) {
    const source = readFileSync(join(ROOT, relative), "utf8");
    const readers = (source.match(/readLog\(c\.adapterLog\)/g) ?? []).length;
    const declared = (source.match(new RegExp(DECLARATION, "g")) ?? []).length;
    if (declared > 0) continue;
    const expected = INTENTIONAL_NON_SEAM_READERS.get(relative) ?? 0;
    assert.equal(
      readers,
      expected,
      `${relative} has ${readers} adapter-log readers and no seamDependency ` +
        `declarations; its explicit non-seam baseline is ${expected}`,
    );
  }
});

void test("every SEAM_SOURCES file is listed in SEAM_SOURCE_FILES", () => {
  // SEAM_SOURCE_FILES is independent of SEAM_DEPENDENT's keys on purpose, so
  // nothing structural stops a new SEAM_SOURCES entry naming a file the two
  // scans above never open. This is the one link back.
  for (const [script, sources] of Object.entries(SEAM_SOURCES)) {
    for (const relative of sources) {
      assert.ok(
        SEAM_SOURCE_FILES.includes(relative),
        `SEAM_SOURCES.${script} names ${relative}, absent from ` +
          "SEAM_SOURCE_FILES, so the count and classification gates would " +
          "never scan it",
      );
    }
  }
});

void test("every file declaring a seamDependency is in SEAM_SOURCE_FILES", () => {
  // The converse the case above CANNOT state, derived from the TREE rather
  // than from any map. The distinction is the whole point, and the two fail in
  // opposite directions:
  //
  //   A query over SEAM_SOURCES empties when an engineer edits a map. That is
  //   why deriving the scan set from it was the original defect, and why the
  //   case above deliberately checks only one direction.
  //
  //   A query over the tree empties only when the residue is actually gone —
  //   which is exactly slice 4's success condition. So it can safely demand
  //   the direction the map query must not.
  //
  // Without this, retiring `uninstall` from SEAM_DEPENDENT, SEAM_SOURCES and
  // SEAM_SOURCE_FILES together — the procedure gate 1's own diagnostic
  // prescribes — turns every other case green while
  // uninstall-commands.test.js still holds live declarations and live
  // readLog(c.adapterLog) readers. An entry may leave SEAM_SOURCE_FILES only
  // after its file's residue is zero, and this is what enforces that order.
  //
  // Self-excluding by construction: every seamDependency mention in this file
  // and in adapter-seam.js is prose, or the escaped regex source above — never
  // a literal `{` (mod whitespace) immediately following `seamDependency:`,
  // which is what DECLARATION's site pattern requires. In the regex source
  // that position holds a backslash instead, so it can never match its own
  // definition.
  for (const relative of declaringFiles()) {
    assert.ok(
      SEAM_SOURCE_FILES.includes(relative),
      `${relative} declares a seamDependency but is absent from ` +
        "SEAM_SOURCE_FILES, so both gates skip it entirely. Re-base or " +
        "retire its declarations and its adapter-log readers BEFORE " +
        "removing its SEAM_SOURCE_FILES entry, not after.",
    );
  }
});

/**
 * Every path under tests/ whose contents hold a seamDependency declaration,
 * repository-relative and posix-spelled to match SEAM_SOURCE_FILES.
 *
 * @returns {string[]}
 */
function declaringFiles() {
  const found = [];
  for (const entry of readdirSync(join(ROOT, "tests"), { recursive: true })) {
    const relative = join("tests", String(entry));
    if (!relative.endsWith(".js")) continue;
    if (relative.split("/").includes("node_modules")) continue;
    const absolute = join(ROOT, relative);
    if (!statSync(absolute).isFile()) continue;
    if (DECLARATION.test(readFileSync(absolute, "utf8"))) found.push(relative);
  }
  return found;
}

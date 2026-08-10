// @ts-check
// Two gates, plus the four cases that keep them from going vacuous. Without
// them, the 9 literal readLog(c.adapterLog) reader sites in the SEAM_SOURCES
// files, and the 30 cases that declare a seamDependency, go vacuous when slice
// 4 removes the seam, in exactly the way five cli-parity assertions did in
// slice 3.4 — silently, with the suite still green. Both numbers are counted
// from the tree; the count case below re-derives the 30 on every run.
//
// The two gates are "every script with seam-dependent cases still exists" and
// "no adapter-log reader is left unclassified". The other four cases exist
// only because each gate has a way to stop asserting: the injection proof
// shows gate 1 can still fail, the count case ties SEAM_DEPENDENT to the
// declarations it claims to protect, and the two membership cases keep
// SEAM_SOURCE_FILES — the scan set both gates now walk — from being emptied
// ahead of the residue it is supposed to find.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertSeamScriptsPresent,
  SEAM_DEPENDENT,
  SEAM_SOURCE_FILES,
  SEAM_SOURCES,
} from "./adapter-seam.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// One source of truth for what a declaration looks like, shared by the count
// case and the tree-derived membership case below. If the two ever drifted,
// the tree scan could miss a form the count scan credits — which is the
// unclassified-residue hole all over again, one level up. Non-global on
// purpose; the count case adds the `g` flag where it needs matchAll, so no
// `lastIndex` is ever carried between .test() calls.
//
// Captures reason and script. Two groups, not one: the count gate now
// reconciles the 9/21 split, which was prose until slice 4a (matrix row 19).
// Order is `reason` then `script` at all 30 declaration sites; a pattern
// tolerant of either order would also match a malformed declaration.
const DECLARATION =
  /seamDependency:\s*\{[^}]*reason:\s*"(\w+)",\s*script:\s*"(\w+)"/;

void test("every script with seam-dependent cases still exists", () => {
  assertSeamScriptsPresent(ROOT, existsSync);
});

void test("the gate fails when a depended-on script is gone", () => {
  // Mutation proof by INJECTION, not by editing src/ or scripts/. The gate's
  // inputs are a root and an existence predicate, so a predicate that denies
  // one script reproduces slice 4's deletion exactly, with no tracked file
  // touched and no build step involved.
  //
  // `gone` is built with join() deliberately — see the join() comment in
  // adapter-seam.js's assertSeamScriptsPresent. The predicate can only deny
  // the path the gate actually probes, so this line also pins path-spelling
  // agreement between the two. Simplifying it to a template literal
  // reintroduces the bug commit 0d9a53c fixed: the gate would probe a
  // double-slash spelling the predicate never matches, and would silently
  // stop observing its own failure mode.
  const gone = join(ROOT, "scripts", "install");
  assert.throws(
    () => assertSeamScriptsPresent(ROOT, (p) => p !== gone && existsSync(p)),
    /scripts\/install is gone, but \d+ of its cases still depend on the SPW_ADAPTER seam/,
  );
});

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
      const reason = /** @type {string} */ (m[1]);
      const script = /** @type {string} */ (m[2]);
      assert.ok(
        Object.hasOwn(found, script),
        `${relative} declares script "${script}", absent from SEAM_DEPENDENT`,
      );
      assert.ok(
        reason === "intercept" || reason === "log",
        `${relative} declares reason "${reason}" for script "${script}", ` +
          "which is neither intercept nor log",
      );
      found[script][reason] += 1;
    }
  }
  assert.deepEqual(found, SEAM_DEPENDENT);
});

void test("no adapter-log reader is left unclassified", () => {
  // A reader in a case with no seamDependency is a reader whose channel dies
  // unannounced. All three modes still write adapter.log, so `delegate` is the
  // mode most likely to look harmless here.
  //
  // Deliberately per-FILE, not per-case: one case can hold several readers,
  // and a declared case can hold none, so a count comparison would be wrong.
  // Per-case attribution needs a parser this repo has no dependency for, and
  // tests/bin/migration-inventory.test.js's history is a standing argument
  // against approximating one with a regex. This check's job is only to catch
  // the whole-file regression — a source that reads the log while declaring
  // nothing — and it must stay that weak on purpose.
  //
  // Scans SEAM_SOURCE_FILES for the reason test 3 above does: the derived set
  // would stop visiting a file exactly when slice 4 empties its SEAM_DEPENDENT
  // entry, leaving live readers unclassified with this loop body never run.
  //
  // The property is `readers === 0 || declared > 0`, not `declared > 0`: a
  // file slice 4 has legitimately emptied of both readers and declarations is
  // not a defect, and asserting on `declared` alone would fail it with a
  // message describing readers that are not there.
  for (const relative of SEAM_SOURCE_FILES) {
    const source = readFileSync(join(ROOT, relative), "utf8");
    const readers = (source.match(/readLog\(c\.adapterLog\)/g) ?? []).length;
    const declared = (source.match(/seamDependency:/g) ?? []).length;
    assert.ok(
      readers === 0 || declared > 0,
      `${relative} has ${readers} adapter-log readers and no seamDependency ` +
        "declarations at all",
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
  // Self-excluding by construction: this file and adapter-seam.js mention
  // seamDependency only in prose and in escaped regex source, neither of which
  // matches DECLARATION's literal `: {`.
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

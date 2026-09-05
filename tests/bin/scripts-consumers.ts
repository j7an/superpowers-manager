// D2a's executable audit of the test tree's references into production
// scripts/, with a disposition per hit.
//
// SLICE 4C RECORD. The lifecycle tree is deleted in this slice, so the
// declaration map below is permanently empty. This module remains the single
// source for the audit command and its fail-closed parser: the positive control
// in scripts-consumers.test.js proves a zero-row real-tree audit means no hits,
// not a command that silently stopped matching.
//
// Declared, never globbed. A query over mutable state empties exactly when the
// deletion it should catch happens — the argument
// tests/bin/migration-inventory.test.js makes, turned on this list. What is
// derived here is the OBSERVED set (runScriptsAudit); the DECLARED set below is
// hand-written, and the gate is the equality between them.
//
// PER HIT, not per file. A per-file disposition COUNT lets two hits exchange
// classifications with the gate still green — the undetectable-in-both-
// directions failure matrix row 7 records about the 29-ID table.
//
// Keyed by { file, normalized matched text, occurrence ordinal within that
// file }. NOT by line number: this milestone shifted a citation a prior fix had
// just corrected in three consecutive rounds, so a line key goes stale on every
// edit ABOVE a hit while still reading as authoritative. The ordinal key is
// stable under exactly those edits and still names one hit.
//
// `normalized` is the matched line with runs of whitespace collapsed to one
// space and leading/trailing space removed — enough to survive reformatting,
// not so much that two different hits collide.
//
// DISPOSITIONS — three, not four:
//   retire      — the hit's text does not survive 4c. Either its consumer is
//                 deleted outright, or the hit is prose whose subject ceases to
//                 exist and whose sentence goes with it.
//   re-express  — the property the hit serves survives, restated against the
//                 ported TypeScript; for a citation, re-pointed at it.
//   relocate    — the shell file the hit names moves to tests/fixtures/protocol/
//                 and the hit's path is rewritten. Slice 5 deletes both.
//
// `comment-only, no action` is WITHDRAWN (spec D2a as amended 2026-08-10): it
// cannot coexist with 4c's zero-rows exit gate. Comment-form hits are therefore
// dispositioned like every other hit, under the three values above — see THE
// FILTER below for which of D2a's two options that is, and why.
//
// Each entry carries its exact target, not just its class. "re-express" with no
// named target is a deferral wearing a disposition's clothes. This module
// requires a non-empty target for ALL THREE dispositions, which is stronger
// than D2a's floor of "non-empty for re-express and relocate": a retire whose
// target names nothing is the same deferral in the other costume, so a retire
// target names the 4c work item that removes the text.
//
// WHAT THIS GATE DOES AND DOES NOT BUY. It proves the declared set and the
// observed set are the same hits — no hit unclassified, no entry stale, and no
// silent substitution of one hit for another. It CANNOT prove a disposition is
// correct; no gate can. What per-hit keying buys over per-file counts is
// ATTRIBUTION: a wrong disposition is readable as a wrong disposition, attached
// to the one hit it misdescribes, instead of hiding inside a total that still
// sums. That is a reviewability property, not a mechanical one.
//
// TASK 1 RELOCATION RATIONALE, now discharged. Before Task 1, the withdrawn
// five-file figure obscured two facts that sized the work (spec D2a, amended
// 2026-08-10 post-merge):
//
//   1. The one protocol suite formerly held 29 literal production-script path
//      sites, within 52 across the four surviving shell and Python drivers.
//      Those historical figures sized the relocation; Task 1 removed the 30
//      protocol declarations and retired their sizing assertion. The current
//      executable contract is per-hit reconciliation of the remaining observed
//      and declared sets.
//   2. Before relocation, the adapter derived the repository root from its own
//      directory and sourced "$root/scripts/core/common.sh". The relocated
//      fixture now derives a protocol root for `core/common.sh` and a separate
//      repository root for `dist/adapter-cli.js`. Keeping those roots distinct
//      preserves both fixture sourcing and execution of the existing build.
//
// THE FILTER (D2a's Step 1a reconciliation). D2a offers two ways to make the
// audit's exclusion filter agree with the disposition vocabulary and forbids
// splitting the difference. This module takes the SECOND: the comment exclusion
// is left exactly as the spec wrote it — `grep -v ':[0-9]*: *//'`, which drops
// only lines whose content begins with // — and every comment-form hit it does
// not drop (block-comment continuations, trailing comments, markdown prose)
// carries a retire or re-express disposition with a target, so 4c's zero-rows
// gate and "every hit is dispositioned" describe the same set. Extending the
// exclusion instead would have left prose citing a deleted tree behind a green
// gate.
//
// THE DESCRIPTIVE-ARTIFACT EXCLUSIONS are not the comment question. This module
// and its test live under tests/, and this map quotes every matched line
// verbatim. Without `grep -v '^tests/bin/scripts-consumers\.'` the map cannot be
// closed under its own audit at all — each entry added would add a row demanding
// another entry, without limit. The command likewise excludes migration
// inventories, plus exactly tests/citation-ledger.json and
// tests/bin/citations.test.js: those two new artifacts describe deleted script
// referents and citation fixture strings; neither executes against scripts/.
// The two exact-file filters include grep's trailing output delimiter so a
// similarly named executable consumer remains audited.
//
// AUDIT_COMMAND is exported so 4c's zero-rows exit check imports it rather than
// retyping it. Two invocations differing by a `grep -v` turn "every hit is
// dispositioned" and "zero rows remain" into claims about different sets, and
// the gap between them is invisible from either side (spec §6.3).

import { spawnSync } from "node:child_process";

/**
 * D2a's audit command. Defined ONCE, here, for both 4b's reconciliation gate
 * and 4c's zero-rows exit check. It takes no input: every byte is a literal,
 * and nothing is interpolated into it at any call site.
 *
 * String.raw, not a plain template literal: the alternations in the basic
 * regular expression are `\|`, and a plain template literal would collapse each
 * one to a bare `|`, silently changing the pattern to one that matches nothing.
 */
export const AUDIT_COMMAND = String.raw`grep -rn 'scripts/core/\|scripts/adapters/\|"scripts"\|scripts/probe\|scripts/prepare\|scripts/install\|scripts/update\|scripts/uninstall' tests/ \
  | grep -v '^tests/migration-inventory/' | grep -v '^tests/bin/scripts-consumers\.' | grep -v '^tests/citation-ledger\.json:' | grep -v '^tests/bin/citations\.test\.ts:' | grep -v ':[0-9]*: *//'`;

/** The disposition vocabulary. Three values; `comment-only` is withdrawn. */
export const DISPOSITIONS = ["retire", "re-express", "relocate"] as const;

export type AuditHit = {
  file: string;
  line: number;
  normalized: string;
  ordinal: number;
};

export type ScriptsConsumer = {
  file: string;
  normalized: string;
  ordinal: number;
  disposition: "retire" | "re-express" | "relocate";
  target: string;
};

/**
 * The matched line with runs of whitespace collapsed to one space and leading
 * and trailing space removed.
 */
export function normalizeAuditLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The stable key: file, normalized text, ordinal. No line number.
 */
export function auditKey(hit: {
  file: string;
  normalized: string;
  ordinal: number;
}): string {
  return `${hit.file} :: ${hit.normalized} :: #${hit.ordinal}`;
}

/**
 * Runs AUDIT_COMMAND and returns one keyed hit per row.
 *
 * Ordinals are assigned per file in ascending line order, so they never depend
 * on grep's directory traversal order. Status 1 — grep matched nothing — is a
 * legitimate result and returns an empty array; it is exactly 4c's success
 * condition. Any other status throws rather than reporting an empty audit,
 * because an audit that failed to run and an audit that found nothing are the
 * same value otherwise.
 *
 * The exit-status guard alone does NOT deliver that, and cannot.
 * AUDIT_COMMAND is a three-stage pipeline; POSIX `sh` reports only the last
 * stage's status and `pipefail` is not POSIX, so a producing `grep` that dies
 * — an unreadable or missing `tests/`, a traversal error mid-walk — is masked
 * behind the trailing `grep -v`'s own status 1. Before this guard,
 * `runScriptsAudit` on a root with no `tests/` returned zero rows and threw
 * nothing. That is harmless for 4b, whose every call goes through
 * scripts-consumers.test.js's `observe()` and its `rows.length > 0` check,
 * and a live fail-open for 4c, whose exit check asserts the OPPOSITE — zero
 * rows — and would read a broken audit as the exit condition met.
 *
 * A failing stage writes a diagnostic to stderr while a legitimately empty
 * match is silent, so a non-empty stderr is the signal the status cannot
 * carry. It is fatal here. That keeps AUDIT_COMMAND a single byte-identical
 * literal for 4c to import, which decomposing the pipeline into per-stage
 * spawns would not.
 */
export function runScriptsAudit(root: string): AuditHit[] {
  const result = spawnSync("sh", ["-c", AUDIT_COMMAND], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: Infinity,
  });
  if (result.error) {
    throw new Error("scripts-consumers: could not run the D2a audit command");
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `scripts-consumers: the D2a audit command exited ${String(result.status)}`,
    );
  }
  if (result.stderr !== "") {
    throw new Error(
      "scripts-consumers: the D2a audit command wrote to stderr, so the " +
        "audit did not run to completion and its rows cannot be trusted:\n" +
        result.stderr,
    );
  }

  const rows: AuditHit[] = [];
  for (const row of result.stdout.split("\n")) {
    if (row === "") continue;
    const match = /^([^:]+):(\d+):([\s\S]*)$/.exec(row);
    if (!match) {
      throw new Error(
        "scripts-consumers: the D2a audit emitted a row that is not file:line:text",
      );
    }
    rows.push({
      file: match[1],
      line: Number(match[2]),
      normalized: normalizeAuditLine(match[3]),
      ordinal: 0,
    });
  }
  rows.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1,
  );

  const seen: Map<string, number> = new Map();
  for (const row of rows) {
    const bucket = `${row.file} :: ${row.normalized}`;
    const ordinal = (seen.get(bucket) ?? 0) + 1;
    seen.set(bucket, ordinal);
    row.ordinal = ordinal;
  }
  return rows;
}

/**
 * Multiset comparison of declared keys against observed keys.
 *
 * A multiset, not a set: a duplicated declaration is a defect too, and set
 * equality would absorb it. `undeclared` holds observed keys the map does not
 * cover — a new hit, or an entry someone deleted. `stale` holds declared keys
 * with no observed hit — an entry left behind, or one declared twice.
 */
export function reconcileAudit(
  observed: readonly AuditHit[],
  declared: readonly ScriptsConsumer[],
): { undeclared: string[]; stale: string[] } {
  const tally = (
    hits: readonly { file: string; normalized: string; ordinal: number }[],
  ): Map<string, number> => {
    const counts: Map<string, number> = new Map();
    for (const hit of hits) {
      const key = auditKey(hit);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const observedCounts = tally(observed);
  const declaredCounts = tally(declared);

  const undeclared: string[] = [];

  const stale: string[] = [];
  for (const [key, count] of observedCounts) {
    const surplus = count - (declaredCounts.get(key) ?? 0);
    for (let index = 0; index < surplus; index += 1) undeclared.push(key);
  }
  for (const [key, count] of declaredCounts) {
    const surplus = count - (observedCounts.get(key) ?? 0);
    for (let index = 0; index < surplus; index += 1) stale.push(key);
  }
  undeclared.sort();
  stale.sort();
  return { undeclared, stale };
}

/**
 * The declared disposition map: one entry per current audit hit. The test
 * reconciles this array against the observed set and validates each entry's
 * disposition and target. Historical sizing figures in the header above are
 * no longer executable assertions after Task 1 discharged the relocation.
 */
export const SCRIPTS_CONSUMERS: ScriptsConsumer[] = [];

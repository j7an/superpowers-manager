// @ts-check
// D2a's executable audit of the test tree's references into production
// scripts/, with a disposition per hit.
//
// Declared, never globbed. A query over mutable state empties exactly when the
// deletion it should catch happens — the argument tests/bin/adapter-seam.js and
// tests/bin/migration-inventory.test.js both make, turned on this list. What is
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
// TWO FACTS 4c PLANS AGAINST, recorded here because the withdrawn five-file
// figure obscured both (spec D2a, amended 2026-08-10 post-merge):
//
//   1. There is ONE protocol suite, not two, and it holds 29 literal scripts/
//      path sites (tests/test_adapter_protocol.sh). Across all four surviving
//      shell and Python drivers there are 52. Both figures are re-derived from
//      this map by the test rather than asserted in prose here.
//   2. THE MOVED ADAPTER RESOLVES ITS OWN LOCATION. The shipped adapter
//      computes its root from its own directory and then sources
//      "$root/scripts/core/common.sh" (scripts/adapters/codex/adapter:4-5), so
//      relocating it breaks BOTH the "../../.." depth and the scripts/core/
//      path. The fixture layout, the adapter's internal path resolution, and
//      every suite-side path must be specified together; moving the files
//      without rewriting the adapter's own resolution produces a fixture that
//      cannot run.
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
// ONE exclusion IS added, and it is not the comment question: this module and
// its test live under tests/, and this map quotes every matched line verbatim.
// Without `grep -v '^tests/bin/scripts-consumers\.'` the map cannot be closed
// under its own audit at all — each entry added would add a row demanding
// another entry, without limit. It is the same kind of exclusion the command
// already carries for tests/migration-inventory/: a file that DESCRIBES the
// migration is not a file that EXECUTES against scripts/.
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
  | grep -v '^tests/migration-inventory/' | grep -v '^tests/bin/scripts-consumers\.' | grep -v ':[0-9]*: *//'`;

/** The disposition vocabulary. Three values; `comment-only` is withdrawn. */
export const DISPOSITIONS = /** @type {const} */ ([
  "retire",
  "re-express",
  "relocate",
]);

/**
 * @typedef {object} AuditHit
 * @property {string} file repository-relative path
 * @property {number} line 1-based line number, informational only and NOT part
 *   of the key, because an edit above a hit moves it
 * @property {string} normalized matched line, whitespace-collapsed and trimmed
 * @property {number} ordinal 1-based occurrence of `normalized` within `file`
 */

/**
 * @typedef {object} ScriptsConsumer
 * @property {string} file
 * @property {string} normalized
 * @property {number} ordinal
 * @property {"retire" | "re-express" | "relocate"} disposition
 * @property {string} target
 */

/**
 * The matched line with runs of whitespace collapsed to one space and leading
 * and trailing space removed.
 * @param {string} text
 * @returns {string}
 */
export function normalizeAuditLine(text) {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The stable key: file, normalized text, ordinal. No line number.
 * @param {{ file: string, normalized: string, ordinal: number }} hit
 * @returns {string}
 */
export function auditKey(hit) {
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
 * @param {string} root repository root the command runs in
 * @returns {AuditHit[]}
 */
export function runScriptsAudit(root) {
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
  /** @type {AuditHit[]} */
  const rows = [];
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
  /** @type {Map<string, number>} */
  const seen = new Map();
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
 * @param {readonly AuditHit[]} observed
 * @param {readonly ScriptsConsumer[]} declared
 * @returns {{ undeclared: string[], stale: string[] }}
 */
export function reconcileAudit(observed, declared) {
  /**
   * @param {readonly { file: string, normalized: string, ordinal: number }[]} hits
   * @returns {Map<string, number>}
   */
  const tally = (hits) => {
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const hit of hits) {
      const key = auditKey(hit);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const observedCounts = tally(observed);
  const declaredCounts = tally(declared);
  /** @type {string[]} */
  const undeclared = [];
  /** @type {string[]} */
  const stale = [];
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
 * The declared disposition map: one entry per audit hit. Every count the header
 * above cites is re-derived from this array by
 * tests/bin/scripts-consumers.test.js, never asserted in prose here.
 * @type {ScriptsConsumer[]}
 */
export const SCRIPTS_CONSUMERS = [
  // tests/baseline/cli-parity.test.js (1)
  {
    file: "tests/baseline/cli-parity.test.js",
    normalized:
      "* `scripts/core/adapter.sh`: the moment `update` dispatches in-process it is",
    ordinal: 1,
    disposition: "retire",
    target:
      "the `scripts/core/adapter.sh` clause is deleted in 4c with the SPW_ADAPTER seam it names; the surrounding 'Converted, not retired (Task 8, Step 5b)' note survives without it.",
  },
  // tests/baseline/ref-resolution.test.js (2)
  {
    file: "tests/baseline/ref-resolution.test.js",
    normalized: 'const COMMON_SH = join(ROOT, "scripts/core/common.sh");',
    ordinal: 1,
    disposition: "re-express",
    target:
      "tests/unit/adapter.test.js's NODE_OPTIONS/NODE_PATH scrub case over src/adapter.ts:116-122. The git-child half of the case has no TypeScript subject - src/git.ts:32 pins LC_ALL and GIT_TERMINAL_PROMPT and does not scrub NODE_* - and lands as a divergence note in tests/migration-inventory/ref-resolution.md.",
  },
  {
    file: "tests/baseline/ref-resolution.test.js",
    normalized: 'const UPSTREAM_SH = join(ROOT, "scripts/core/upstream.sh");',
    ordinal: 1,
    disposition: "re-express",
    target:
      "tests/unit/adapter.test.js's NODE_OPTIONS/NODE_PATH scrub case over src/adapter.ts:116-122. The git-child half of the case has no TypeScript subject - src/git.ts:32 pins LC_ALL and GIT_TERMINAL_PROMPT and does not scrub NODE_* - and lands as a divergence note in tests/migration-inventory/ref-resolution.md.",
  },
  // tests/baseline/selection-location.test.js (4)
  {
    file: "tests/baseline/selection-location.test.js",
    normalized: 'const COMMON_SH = join(ROOT, "scripts/core/common.sh");',
    ordinal: 1,
    disposition: "re-express",
    target:
      "src/cli.ts:314-316, which is spw_usage_error's surviving contract - `error: <msg>` on stderr followed by the usage block, exit 2. Record the re-anchor in tests/migration-inventory/selection-state.md.",
  },
  {
    file: "tests/baseline/selection-location.test.js",
    normalized:
      'const PROVENANCE_SH = join(ROOT, "scripts/core/provenance.sh");',
    ordinal: 1,
    disposition: "retire",
    target:
      "closes STRUCTURALLY in 4c: selection state is read in-process by src/selection-store.ts, so there is no child Node process for NODE_OPTIONS to reach and no helper file left to be missing. Retirement note in tests/migration-inventory/selection-state.md.",
  },
  {
    file: "tests/baseline/selection-location.test.js",
    normalized: 'const UPSTREAM_SH = join(ROOT, "scripts/core/upstream.sh");',
    ordinal: 1,
    disposition: "retire",
    target:
      "closes STRUCTURALLY in 4c: selection state is read in-process by src/selection-store.ts, so there is no child Node process for NODE_OPTIONS to reach and no helper file left to be missing. Retirement note in tests/migration-inventory/selection-state.md.",
  },
  {
    file: "tests/baseline/selection-location.test.js",
    normalized: 'const SELECTION_SH = join(ROOT, "scripts/core/selection.sh");',
    ordinal: 1,
    disposition: "retire",
    target:
      "closes STRUCTURALLY in 4c: selection state is read in-process by src/selection-store.ts, so there is no child Node process for NODE_OPTIONS to reach and no helper file left to be missing. Retirement note in tests/migration-inventory/selection-state.md.",
  },
  // tests/baseline/support.js (3)
  {
    file: "tests/baseline/support.js",
    normalized:
      'cpSync(join(ROOT, "scripts"), join(pkg, "scripts"), { recursive: true });',
    ordinal: 1,
    disposition: "retire",
    target:
      "line deleted in 4c - D2a's mechanical class; the baseline sandbox stops carrying a scripts/ tree and would otherwise ENOENT at construction.",
  },
  {
    file: "tests/baseline/support.js",
    normalized: 'const script = join(sandbox.pkg, "scripts", command);',
    ordinal: 1,
    disposition: "retire",
    target:
      "installDispatchStubs is deleted in 4c: after the flip all eight commands are in-process, so both stub kinds guard a path no command takes, and a regressed spawn fails as ENOENT once the tree is gone.",
  },
  {
    file: "tests/baseline/support.js",
    normalized: '"scripts",',
    ordinal: 1,
    disposition: "retire",
    target:
      "the sandbox's `runtimeAdapter` field is deleted in 4c (spec section 6.3, tests/baseline/support.js row: runtimeAdapter, adapterState, adapterLog and stateful-adapter).",
  },
  // tests/bin/adapter-seam.js (2)
  {
    file: "tests/bin/adapter-seam.js",
    normalized:
      "* SEAM_SOURCES and this list in one step, alongside scripts/uninstall — leaves",
    ordinal: 1,
    disposition: "retire",
    target:
      "the `alongside scripts/uninstall` clause goes when 4c deletes the script; the retirement-order paragraph it sits in survives until slice 6 deletes this module (spec section 5.3).",
  },
  {
    file: "tests/bin/adapter-seam.js",
    normalized: 'if (!exists(join(root, "scripts", script))) {',
    ordinal: 1,
    disposition: "retire",
    target:
      "assertSeamScriptsPresent's existence check has no subject once 4c deletes scripts/; retire the function and its two call sites, leaving SEAM_DEPENDENT's four zeroed entries and SEAM_SOURCE_FILES for slice 6 (spec sections 5.3, 6.3).",
  },
  // tests/bin/adapter-seam.test.js (1)
  {
    file: "tests/bin/adapter-seam.test.js",
    normalized: 'const gone = join(ROOT, "scripts", "install");',
    ordinal: 1,
    disposition: "retire",
    target:
      "the injection mutation-proof ('the gate fails when a depended-on script is gone') retires with assertSeamScriptsPresent in 4c; no path under scripts/ survives for it to name.",
  },
  // tests/bin/bootstrap.test.js (8)
  {
    file: "tests/bin/bootstrap.test.js",
    normalized: '"scripts/adapters/codex/adapter",',
    ordinal: 1,
    disposition: "re-express",
    target:
      "inverted per spec section 6.3 into bootstrap.test.js's absence set - the file stops being a shipped repository file - with tests/migration-inventory/bootstrap.md updated in the same commit.",
  },
  {
    file: "tests/bin/bootstrap.test.js",
    normalized: '"scripts/core/validate-adapter-response.py",',
    ordinal: 1,
    disposition: "re-express",
    target:
      "inverted per spec section 6.3 into bootstrap.test.js's absence set - the file stops being a shipped repository file - with tests/migration-inventory/bootstrap.md updated in the same commit.",
  },
  {
    file: "tests/bin/bootstrap.test.js",
    normalized:
      'join(ROOT, "scripts/adapters/codex/validate-generated-plugin.py"),',
    ordinal: 1,
    disposition: "retire",
    target:
      "retired at the gap in tests/migration-inventory/bootstrap.md: an absence assertion over a path inside a deleted tree is vacuous.",
  },
  {
    file: "tests/bin/bootstrap.test.js",
    normalized: '"scripts/core/selection-state.py",',
    ordinal: 1,
    disposition: "retire",
    target:
      "retired at the gap in tests/migration-inventory/bootstrap.md: an absence assertion over a path inside a deleted tree is vacuous.",
  },
  {
    file: "tests/bin/bootstrap.test.js",
    normalized: '"scripts/adapters/codex/validate-generated-plugin.py",',
    ordinal: 1,
    disposition: "retire",
    target:
      "retired at the gap in tests/migration-inventory/bootstrap.md: an absence assertion over a path inside a deleted tree is vacuous.",
  },
  {
    file: "tests/bin/bootstrap.test.js",
    normalized: '"scripts/adapters/codex/lib.sh",',
    ordinal: 1,
    disposition: "retire",
    target:
      "retired at the gap in tests/migration-inventory/bootstrap.md: an absence assertion over a path inside a deleted tree is vacuous.",
  },
  {
    file: "tests/bin/bootstrap.test.js",
    normalized: '"scripts/adapters/codex/materialize-hooks.py",',
    ordinal: 1,
    disposition: "retire",
    target:
      "retired at the gap in tests/migration-inventory/bootstrap.md: an absence assertion over a path inside a deleted tree is vacuous.",
  },
  {
    file: "tests/bin/bootstrap.test.js",
    normalized:
      '["tests/expected_tarball_contents.txt", "scripts/core/selection.sh", true],',
    ordinal: 1,
    disposition: "re-express",
    target:
      "inverted to `false` per spec section 6.3 when 4c removes the scripts/ block from tests/expected_tarball_contents.txt; tests/migration-inventory/bootstrap.md updated in the same commit.",
  },
  // tests/bin/dispatch-fixture.js (4)
  {
    file: "tests/bin/dispatch-fixture.js",
    normalized: 'mkdirSync(join(root, "scripts"), { recursive: true });',
    ordinal: 1,
    disposition: "retire",
    target:
      "deleted in 4c with scripts/ itself, as tests/bin/bin-dispatch.test.js:605-606 already records: `scripts` and `missingScripts` survive as runDispatch options with no consumer, and a regressed spawn now fails as ENOENT rather than through a stub.",
  },
  {
    file: "tests/bin/dispatch-fixture.js",
    normalized:
      'writeExecutable(join(root, "scripts"), command, loggingStub(command));',
    ordinal: 1,
    disposition: "retire",
    target:
      "deleted in 4c with scripts/ itself, as tests/bin/bin-dispatch.test.js:605-606 already records: `scripts` and `missingScripts` survive as runDispatch options with no consumer, and a regressed spawn now fails as ENOENT rather than through a stub.",
  },
  {
    file: "tests/bin/dispatch-fixture.js",
    normalized: 'writeExecutable(join(copy, "scripts"), name, body);',
    ordinal: 1,
    disposition: "retire",
    target:
      "deleted in 4c with scripts/ itself, as tests/bin/bin-dispatch.test.js:605-606 already records: `scripts` and `missingScripts` survive as runDispatch options with no consumer, and a regressed spawn now fails as ENOENT rather than through a stub.",
  },
  {
    file: "tests/bin/dispatch-fixture.js",
    normalized: 'rmSync(join(copy, "scripts", name), { force: true });',
    ordinal: 1,
    disposition: "retire",
    target:
      "deleted in 4c with scripts/ itself, as tests/bin/bin-dispatch.test.js:605-606 already records: `scripts` and `missingScripts` survive as runDispatch options with no consumer, and a regressed spawn now fails as ENOENT rather than through a stub.",
  },
  // tests/bin/install-commands.test.js (11)
  {
    file: "tests/bin/install-commands.test.js",
    normalized:
      '* the scenario above it. `scripts/core/status.sh:15-16` returns "needs prepare"',
    ordinal: 1,
    disposition: "re-express",
    target:
      "src/status.ts:21, which is where the needs-prepare rule now lives.",
  },
  {
    file: "tests/bin/install-commands.test.js",
    normalized:
      "* recording adapter, rather than spawning `scripts/prepare` through the",
    ordinal: 1,
    disposition: "retire",
    target:
      "the Task 6 conversion note's `scripts/prepare` clause is deleted in 4c with the shell it contrasts the injected double against.",
  },
  {
    file: "tests/bin/install-commands.test.js",
    normalized:
      '* `scripts/prepare` is the only thing that prints "prepared <ref> at <commit>",',
    ordinal: 1,
    disposition: "re-express",
    target:
      "src/commands/prepare.ts, which prints the prepared-<ref>-at-<commit> banner after the port.",
  },
  {
    file: "tests/bin/install-commands.test.js",
    normalized:
      "* and `scripts/install:23-25` runs it only on the needs-prepare branch. Its",
    ordinal: 1,
    disposition: "re-express",
    target:
      "src/commands/install.ts's needs-prepare branch, which is what runs prepare after the port.",
  },
  {
    file: "tests/bin/install-commands.test.js",
    normalized:
      "* carries the gate message, because scripts/install:54 emits the same string",
    ordinal: 1,
    disposition: "re-express",
    target:
      "src/commands/install.ts's gate-message site, the ported source of the same string on the other branch.",
  },
  {
    file: "tests/bin/install-commands.test.js",
    normalized:
      "* ANCHORED, not a bare substring. `scripts/prepare:117` prints its banner at",
    ordinal: 1,
    disposition: "re-express",
    target:
      "src/commands/prepare.ts's banner write, the ported source of the anchored line.",
  },
  {
    file: "tests/bin/install-commands.test.js",
    normalized:
      "* the start of a line, but `scripts/core/lifecycle.sh:116` also carries the",
    ordinal: 1,
    disposition: "re-express",
    target:
      "src/lifecycle.ts's 'does not match the prepared plugin after install.' string, the ported source of the mid-sentence collision this anchor defends against.",
  },
  {
    file: "tests/bin/install-commands.test.js",
    normalized: 'const scriptsRoot = join(ROOT, "scripts");',
    ordinal: 1,
    disposition: "re-express",
    target:
      "the same hook-trust scan over src/ and bin/, which is where production code lives after 4c; the invariant is AGENTS.md's 'the manager never creates managed hooks or mutates Codex trust state'. Record the re-anchor in tests/migration-inventory/install-commands.md.",
  },
  {
    file: "tests/bin/install-commands.test.js",
    normalized: '"scripts/install",',
    ordinal: 1,
    disposition: "retire",
    target:
      "the packaged-root executability precondition drops its scripts/ entries in 4c; the three dist/ entries beside them stay.",
  },
  {
    file: "tests/bin/install-commands.test.js",
    normalized: '"scripts/adapters/codex/adapter",',
    ordinal: 1,
    disposition: "retire",
    target:
      "the packaged-root executability precondition drops its scripts/ entries in 4c; the three dist/ entries beside them stay.",
  },
  {
    file: "tests/bin/install-commands.test.js",
    normalized:
      'join(c.pkg, "scripts/adapters/codex/validate-generated-plugin.py"),',
    ordinal: 1,
    disposition: "retire",
    target:
      "retired at the gap in tests/migration-inventory/install-commands.md: a not-packaged negative over a path inside a deleted tree is vacuous.",
  },
  // tests/bin/lifecycle-fakes.js (2)
  {
    file: "tests/bin/lifecycle-fakes.js",
    normalized:
      "* adapter, `scripts/adapters/codex/adapter` has no fixture consumer.",
    ordinal: 1,
    disposition: "retire",
    target:
      "deleted with delegateToRealAdapter in 4c, as tests/bin/lifecycle-fakes.js:326-327 already states: once no case spawns the adapter it has no fixture consumer.",
  },
  {
    file: "tests/bin/lifecycle-fakes.js",
    normalized:
      'const real = join(pkgRoot, "scripts", "adapters", "codex", "adapter");',
    ordinal: 1,
    disposition: "retire",
    target:
      "deleted with delegateToRealAdapter in 4c, as tests/bin/lifecycle-fakes.js:326-327 already states: once no case spawns the adapter it has no fixture consumer.",
  },
  // tests/bin/lifecycle-fakes.test.js (3)
  {
    file: "tests/bin/lifecycle-fakes.test.js",
    normalized: 'const dir = join(pkg, "scripts", "adapters", "codex");',
    ordinal: 1,
    disposition: "retire",
    target:
      "deleted with delegateToRealAdapter in 4c, as tests/bin/lifecycle-fakes.js:326-327 already states: once no case spawns the adapter it has no fixture consumer.",
  },
  {
    file: "tests/bin/lifecycle-fakes.test.js",
    normalized:
      'const real = join(pkgRoot, "scripts", "adapters", "codex", "adapter");',
    ordinal: 1,
    disposition: "retire",
    target:
      "deleted with delegateToRealAdapter in 4c, as tests/bin/lifecycle-fakes.js:326-327 already states: once no case spawns the adapter it has no fixture consumer.",
  },
  {
    file: "tests/bin/lifecycle-fakes.test.js",
    normalized:
      'const real = join(pkgRoot, "scripts", "adapters", "codex", "adapter");',
    ordinal: 2,
    disposition: "retire",
    target:
      "deleted with delegateToRealAdapter in 4c, as tests/bin/lifecycle-fakes.js:326-327 already states: once no case spawns the adapter it has no fixture consumer.",
  },
  // tests/bin/lifecycle-fixture.js (2)
  {
    file: "tests/bin/lifecycle-fixture.js",
    normalized: 'for (const entry of ["bin", "scripts", "config", "dist"]) {',
    ordinal: 1,
    disposition: "retire",
    target:
      "drop `\"scripts\"` from buildSnapshot's copy list in 4c - D2a's mechanical class; the entry ENOENTs the moment the tree goes.",
  },
  {
    file: "tests/bin/lifecycle-fixture.js",
    normalized:
      "* across every case: `scripts/prepare` only ever fetches from it, which is",
    ordinal: 1,
    disposition: "re-express",
    target:
      "src/commands/prepare.ts's fetch (src/upstream.ts's fetchExactCommit through src/git.ts), which is what reads the shared upstream repo after the flip.",
  },
  // tests/bin/lifecycle-fixture.test.js (5)
  {
    file: "tests/bin/lifecycle-fixture.test.js",
    normalized:
      "* scripts/uninstall — used only where a test needs realistic timing (the",
    ordinal: 1,
    disposition: "re-express",
    target:
      "the `uninstall` command the fixture now launches through bin/superpowers-manager.js - src/commands/uninstall.ts.",
  },
  {
    file: "tests/bin/lifecycle-fixture.test.js",
    normalized: '"scripts/install",',
    ordinal: 1,
    disposition: "retire",
    target:
      "dropped from the package-root contents case in 4c; dist/cli.js, package.json and the plugin template are what the ported subject needs.",
  },
  {
    file: "tests/bin/lifecycle-fixture.test.js",
    normalized: '"scripts/uninstall",',
    ordinal: 1,
    disposition: "retire",
    target:
      "dropped from the package-root contents case in 4c; dist/cli.js, package.json and the plugin template are what the ported subject needs.",
  },
  {
    file: "tests/bin/lifecycle-fixture.test.js",
    normalized: '"scripts/core/common.sh",',
    ordinal: 1,
    disposition: "retire",
    target:
      "dropped from the package-root contents case in 4c; dist/cli.js, package.json and the plugin template are what the ported subject needs.",
  },
  {
    file: "tests/bin/lifecycle-fixture.test.js",
    normalized: '"scripts/adapters/codex/adapter",',
    ordinal: 1,
    disposition: "retire",
    target:
      "dropped from the package-root contents case in 4c; dist/cli.js, package.json and the plugin template are what the ported subject needs.",
  },
  // tests/bin/uninstall-commands.test.js (8)
  {
    file: "tests/bin/uninstall-commands.test.js",
    normalized:
      "* --json` does not contain it as a substring, and nothing else scripts/uninstall",
    ordinal: 1,
    disposition: "re-express",
    target:
      "src/commands/uninstall.ts's ownership-inspect / adapter-uninstall / re-inspect sequence, which is what these codex.log-anchored helpers now describe.",
  },
  {
    file: "tests/bin/uninstall-commands.test.js",
    normalized:
      "* scripts/uninstall:23-29 brackets `spw_adapter_uninstall` between two",
    ordinal: 1,
    disposition: "re-express",
    target:
      "src/commands/uninstall.ts's ownership-inspect / adapter-uninstall / re-inspect sequence, which is what these codex.log-anchored helpers now describe.",
  },
  {
    file: "tests/bin/uninstall-commands.test.js",
    normalized:
      "* scripts/uninstall:27 entirely — which each case's own subject diagnostic",
    ordinal: 1,
    disposition: "re-express",
    target:
      "src/commands/uninstall.ts's ownership-inspect / adapter-uninstall / re-inspect sequence, which is what these codex.log-anchored helpers now describe.",
  },
  {
    file: "tests/bin/uninstall-commands.test.js",
    normalized: "* at scripts/uninstall:29 exists only on that path.",
    ordinal: 1,
    disposition: "re-express",
    target:
      "src/commands/uninstall.ts's ownership-inspect / adapter-uninstall / re-inspect sequence, which is what these codex.log-anchored helpers now describe.",
  },
  {
    file: "tests/bin/uninstall-commands.test.js",
    normalized:
      "* themselves prove scripts/uninstall:27 ran, since :23 and :29 emit one each.",
    ordinal: 1,
    disposition: "re-express",
    target:
      "src/commands/uninstall.ts's ownership-inspect / adapter-uninstall / re-inspect sequence, which is what these codex.log-anchored helpers now describe.",
  },
  {
    file: "tests/bin/uninstall-commands.test.js",
    normalized:
      'const uninstall = readFileSync(join(ROOT, "scripts", "uninstall"), "utf8");',
    ordinal: 1,
    disposition: "re-express",
    target:
      "a source gate over src/commands/uninstall.ts beside tests/unit/ctx-adapter-provenance.test.js's no-runAdapter-import gate: the layering claim is that the public uninstall path holds no Codex-adapter internals. Record in tests/migration-inventory/uninstall-commands.md.",
  },
  {
    file: "tests/bin/uninstall-commands.test.js",
    normalized: '!uninstall.includes("scripts/adapters/codex/lib.sh"),',
    ordinal: 1,
    disposition: "re-express",
    target:
      "the same source gate over src/commands/uninstall.ts. The needle is already inert in one direction - scripts/adapters/codex/lib.sh does not exist in the tree, and tests/bin/bootstrap.test.js:163-167 asserts it is absent from the tarball - so the re-expression must name a needle the port could actually contain.",
  },
  {
    file: "tests/bin/uninstall-commands.test.js",
    normalized: 'join(ROOT, "scripts", "core", "lifecycle.sh"),',
    ordinal: 1,
    disposition: "re-express",
    target:
      "the same claim over src/lifecycle.ts: a source gate asserting no SPW_PLUGIN_ID / SPW_MARKETPLACE_NAME Codex-owned identifier reaches shared lifecycle code.",
  },
  // tests/bin/units.test.js (9)
  {
    file: "tests/bin/units.test.js",
    normalized:
      'fs.existsSync(path.join(REPOSITORY_ROOT, "scripts", "probe")),',
    ordinal: 1,
    disposition: "retire",
    target:
      "removed in 4c with the script it guards (spec section 6.3, 'Retention guards | Removed from units.test.js').",
  },
  {
    file: "tests/bin/units.test.js",
    normalized:
      '"scripts/probe is still executed by scripts/install and scripts/update",',
    ordinal: 1,
    disposition: "retire",
    target:
      "removed in 4c with the script it guards (spec section 6.3, 'Retention guards | Removed from units.test.js').",
  },
  {
    file: "tests/bin/units.test.js",
    normalized:
      'fs.readFileSync(path.join(REPOSITORY_ROOT, "scripts", caller), "utf8"),',
    ordinal: 1,
    disposition: "retire",
    target:
      "removed in 4c with the script it guards (spec section 6.3, 'Retention guards | Removed from units.test.js').",
  },
  {
    file: "tests/bin/units.test.js",
    normalized: "`scripts/${caller} must still invoke scripts/probe`,",
    ordinal: 1,
    disposition: "retire",
    target:
      "removed in 4c with the script it guards (spec section 6.3, 'Retention guards | Removed from units.test.js').",
  },
  {
    file: "tests/bin/units.test.js",
    normalized:
      'fs.existsSync(path.join(REPOSITORY_ROOT, "scripts", "prepare")),',
    ordinal: 1,
    disposition: "retire",
    target:
      "removed in 4c with the script it guards (spec section 6.3, 'Retention guards | Removed from units.test.js').",
  },
  {
    file: "tests/bin/units.test.js",
    normalized:
      '"scripts/prepare is still executed by scripts/install and scripts/update",',
    ordinal: 1,
    disposition: "retire",
    target:
      "removed in 4c with the script it guards (spec section 6.3, 'Retention guards | Removed from units.test.js').",
  },
  {
    file: "tests/bin/units.test.js",
    normalized:
      'fs.readFileSync(path.join(REPOSITORY_ROOT, "scripts", caller), "utf8"),',
    ordinal: 2,
    disposition: "retire",
    target:
      "removed in 4c with the script it guards (spec section 6.3, 'Retention guards | Removed from units.test.js').",
  },
  {
    file: "tests/bin/units.test.js",
    normalized: "`scripts/${caller} must still invoke scripts/prepare`,",
    ordinal: 1,
    disposition: "retire",
    target:
      "removed in 4c with the script it guards (spec section 6.3, 'Retention guards | Removed from units.test.js').",
  },
  {
    file: "tests/bin/units.test.js",
    normalized:
      'fs.existsSync(path.join(REPOSITORY_ROOT, "scripts", retained)),',
    ordinal: 1,
    disposition: "retire",
    target:
      "removed in 4c with the script it guards (spec section 6.3, 'Retention guards | Removed from units.test.js').",
  },
  // tests/expected_tarball_contents.txt (14)
  {
    file: "tests/expected_tarball_contents.txt",
    normalized: "scripts/adapters/codex/adapter",
    ordinal: 1,
    disposition: "retire",
    target:
      "removed from tests/expected_tarball_contents.txt when 4c deletes the tree; tests/bin/bootstrap.test.js's paired case and tests/migration-inventory/bootstrap.md move in the same commit.",
  },
  {
    file: "tests/expected_tarball_contents.txt",
    normalized: "scripts/core/adapter.sh",
    ordinal: 1,
    disposition: "retire",
    target:
      "removed from tests/expected_tarball_contents.txt when 4c deletes the tree; tests/bin/bootstrap.test.js's paired case and tests/migration-inventory/bootstrap.md move in the same commit.",
  },
  {
    file: "tests/expected_tarball_contents.txt",
    normalized: "scripts/core/common.sh",
    ordinal: 1,
    disposition: "retire",
    target:
      "removed from tests/expected_tarball_contents.txt when 4c deletes the tree; tests/bin/bootstrap.test.js's paired case and tests/migration-inventory/bootstrap.md move in the same commit.",
  },
  {
    file: "tests/expected_tarball_contents.txt",
    normalized: "scripts/core/lifecycle.sh",
    ordinal: 1,
    disposition: "retire",
    target:
      "removed from tests/expected_tarball_contents.txt when 4c deletes the tree; tests/bin/bootstrap.test.js's paired case and tests/migration-inventory/bootstrap.md move in the same commit.",
  },
  {
    file: "tests/expected_tarball_contents.txt",
    normalized: "scripts/core/provenance.sh",
    ordinal: 1,
    disposition: "retire",
    target:
      "removed from tests/expected_tarball_contents.txt when 4c deletes the tree; tests/bin/bootstrap.test.js's paired case and tests/migration-inventory/bootstrap.md move in the same commit.",
  },
  {
    file: "tests/expected_tarball_contents.txt",
    normalized: "scripts/core/selection.sh",
    ordinal: 1,
    disposition: "retire",
    target:
      "removed from tests/expected_tarball_contents.txt when 4c deletes the tree; tests/bin/bootstrap.test.js's paired case and tests/migration-inventory/bootstrap.md move in the same commit.",
  },
  {
    file: "tests/expected_tarball_contents.txt",
    normalized: "scripts/core/status.sh",
    ordinal: 1,
    disposition: "retire",
    target:
      "removed from tests/expected_tarball_contents.txt when 4c deletes the tree; tests/bin/bootstrap.test.js's paired case and tests/migration-inventory/bootstrap.md move in the same commit.",
  },
  {
    file: "tests/expected_tarball_contents.txt",
    normalized: "scripts/core/upstream.sh",
    ordinal: 1,
    disposition: "retire",
    target:
      "removed from tests/expected_tarball_contents.txt when 4c deletes the tree; tests/bin/bootstrap.test.js's paired case and tests/migration-inventory/bootstrap.md move in the same commit.",
  },
  {
    file: "tests/expected_tarball_contents.txt",
    normalized: "scripts/core/validate-adapter-response.py",
    ordinal: 1,
    disposition: "retire",
    target:
      "removed from tests/expected_tarball_contents.txt when 4c deletes the tree; tests/bin/bootstrap.test.js's paired case and tests/migration-inventory/bootstrap.md move in the same commit.",
  },
  {
    file: "tests/expected_tarball_contents.txt",
    normalized: "scripts/install",
    ordinal: 1,
    disposition: "retire",
    target:
      "removed from tests/expected_tarball_contents.txt when 4c deletes the tree; tests/bin/bootstrap.test.js's paired case and tests/migration-inventory/bootstrap.md move in the same commit.",
  },
  {
    file: "tests/expected_tarball_contents.txt",
    normalized: "scripts/prepare",
    ordinal: 1,
    disposition: "retire",
    target:
      "removed from tests/expected_tarball_contents.txt when 4c deletes the tree; tests/bin/bootstrap.test.js's paired case and tests/migration-inventory/bootstrap.md move in the same commit.",
  },
  {
    file: "tests/expected_tarball_contents.txt",
    normalized: "scripts/probe",
    ordinal: 1,
    disposition: "retire",
    target:
      "removed from tests/expected_tarball_contents.txt when 4c deletes the tree; tests/bin/bootstrap.test.js's paired case and tests/migration-inventory/bootstrap.md move in the same commit.",
  },
  {
    file: "tests/expected_tarball_contents.txt",
    normalized: "scripts/uninstall",
    ordinal: 1,
    disposition: "retire",
    target:
      "removed from tests/expected_tarball_contents.txt when 4c deletes the tree; tests/bin/bootstrap.test.js's paired case and tests/migration-inventory/bootstrap.md move in the same commit.",
  },
  {
    file: "tests/expected_tarball_contents.txt",
    normalized: "scripts/update",
    ordinal: 1,
    disposition: "retire",
    target:
      "removed from tests/expected_tarball_contents.txt when 4c deletes the tree; tests/bin/bootstrap.test.js's paired case and tests/migration-inventory/bootstrap.md move in the same commit.",
  },
  // tests/fixtures/baseline/overlay-parity/divergent/README.md (1)
  {
    file: "tests/fixtures/baseline/overlay-parity/divergent/README.md",
    normalized:
      "with `scripts/adapters/codex/apply-manifest-overlay.py` raises",
    ordinal: 1,
    disposition: "re-express",
    target:
      "rewrite the sentence to name the CPython int() limit and the withdrawn Python overlay applier without a live path: scripts/adapters/codex/apply-manifest-overlay.py was deleted from the tree before this slice, so the citation is already stale today. The surviving subject is src/python-json-format.ts's formatPythonNumber, which the same README already names.",
  },
  // tests/test_adapter_protocol.py (1)
  {
    file: "tests/test_adapter_protocol.py",
    normalized:
      'VALIDATOR = ROOT / "scripts/core/validate-adapter-response.py"',
    ordinal: 1,
    disposition: "relocate",
    target: "tests/fixtures/protocol/core/validate-adapter-response.py",
  },
  // tests/test_adapter_protocol.sh (29)
  {
    file: "tests/test_adapter_protocol.sh",
    normalized: '. "$root/scripts/core/common.sh"',
    ordinal: 1,
    disposition: "relocate",
    target: "tests/fixtures/protocol/core/common.sh",
  },
  {
    file: "tests/test_adapter_protocol.sh",
    normalized: '. "$root/scripts/core/provenance.sh"',
    ordinal: 1,
    disposition: "relocate",
    target: "tests/fixtures/protocol/core/provenance.sh",
  },
  {
    file: "tests/test_adapter_protocol.sh",
    normalized: '. "$root/scripts/core/adapter.sh"',
    ordinal: 1,
    disposition: "relocate",
    target: "tests/fixtures/protocol/core/adapter.sh",
  },
  {
    file: "tests/test_adapter_protocol.sh",
    normalized:
      '[ "$SPW_ADAPTER_RESPONSE_VALIDATOR" = "$root/scripts/core/validate-adapter-response.py" ]',
    ordinal: 1,
    disposition: "relocate",
    target: "tests/fixtures/protocol/core/validate-adapter-response.py",
  },
  {
    file: "tests/test_adapter_protocol.sh",
    normalized: 'SPW_ADAPTER="$root/scripts/adapters/codex/adapter" \\',
    ordinal: 1,
    disposition: "relocate",
    target:
      'tests/fixtures/protocol/adapters/codex/adapter. D2a amendment 2: the adapter resolves its own root as `$(dirname "$0")/../../..` and sources `"$root/scripts/core/common.sh"` (scripts/adapters/codex/adapter:4-5), so the move must rewrite that resolution together with this call site.',
  },
  {
    file: "tests/test_adapter_protocol.sh",
    normalized: 'SPW_ADAPTER="$root/scripts/adapters/codex/adapter" \\',
    ordinal: 2,
    disposition: "relocate",
    target:
      'tests/fixtures/protocol/adapters/codex/adapter. D2a amendment 2: the adapter resolves its own root as `$(dirname "$0")/../../..` and sources `"$root/scripts/core/common.sh"` (scripts/adapters/codex/adapter:4-5), so the move must rewrite that resolution together with this call site.',
  },
  {
    file: "tests/test_adapter_protocol.sh",
    normalized: 'SPW_ADAPTER="$root/scripts/adapters/codex/adapter" \\',
    ordinal: 3,
    disposition: "relocate",
    target:
      'tests/fixtures/protocol/adapters/codex/adapter. D2a amendment 2: the adapter resolves its own root as `$(dirname "$0")/../../..` and sources `"$root/scripts/core/common.sh"` (scripts/adapters/codex/adapter:4-5), so the move must rewrite that resolution together with this call site.',
  },
  {
    file: "tests/test_adapter_protocol.sh",
    normalized: 'SPW_ADAPTER="$root/scripts/adapters/codex/adapter" \\',
    ordinal: 4,
    disposition: "relocate",
    target:
      'tests/fixtures/protocol/adapters/codex/adapter. D2a amendment 2: the adapter resolves its own root as `$(dirname "$0")/../../..` and sources `"$root/scripts/core/common.sh"` (scripts/adapters/codex/adapter:4-5), so the move must rewrite that resolution together with this call site.',
  },
  {
    file: "tests/test_adapter_protocol.sh",
    normalized: '( SPW_ADAPTER="$root/scripts/adapters/codex/adapter" \\',
    ordinal: 1,
    disposition: "relocate",
    target:
      'tests/fixtures/protocol/adapters/codex/adapter. D2a amendment 2: the adapter resolves its own root as `$(dirname "$0")/../../..` and sources `"$root/scripts/core/common.sh"` (scripts/adapters/codex/adapter:4-5), so the move must rewrite that resolution together with this call site.',
  },
  {
    file: "tests/test_adapter_protocol.sh",
    normalized:
      'if "$root/scripts/adapters/codex/adapter" install "--bad-$control" \\',
    ordinal: 1,
    disposition: "relocate",
    target:
      'tests/fixtures/protocol/adapters/codex/adapter. D2a amendment 2: the adapter resolves its own root as `$(dirname "$0")/../../..` and sources `"$root/scripts/core/common.sh"` (scripts/adapters/codex/adapter:4-5), so the move must rewrite that resolution together with this call site.',
  },
  {
    file: "tests/test_adapter_protocol.sh",
    normalized: 'if "$root/scripts/adapters/codex/adapter" "buildé" \\',
    ordinal: 1,
    disposition: "relocate",
    target:
      'tests/fixtures/protocol/adapters/codex/adapter. D2a amendment 2: the adapter resolves its own root as `$(dirname "$0")/../../..` and sources `"$root/scripts/core/common.sh"` (scripts/adapters/codex/adapter:4-5), so the move must rewrite that resolution together with this call site.',
  },
  {
    file: "tests/test_adapter_protocol.sh",
    normalized:
      'if LC_ALL=C "$root/scripts/adapters/codex/adapter" "bad-$surrogate" \\',
    ordinal: 1,
    disposition: "relocate",
    target:
      'tests/fixtures/protocol/adapters/codex/adapter. D2a amendment 2: the adapter resolves its own root as `$(dirname "$0")/../../..` and sources `"$root/scripts/core/common.sh"` (scripts/adapters/codex/adapter:4-5), so the move must rewrite that resolution together with this call site.',
  },
  {
    file: "tests/test_adapter_protocol.sh",
    normalized:
      'if "$root/scripts/adapters/codex/adapter" >"$zero_out" 2>/dev/null; then',
    ordinal: 1,
    disposition: "relocate",
    target:
      'tests/fixtures/protocol/adapters/codex/adapter. D2a amendment 2: the adapter resolves its own root as `$(dirname "$0")/../../..` and sources `"$root/scripts/core/common.sh"` (scripts/adapters/codex/adapter:4-5), so the move must rewrite that resolution together with this call site.',
  },
  {
    file: "tests/test_adapter_protocol.sh",
    normalized: 'if "$root/scripts/adapters/codex/adapter" "" \\',
    ordinal: 1,
    disposition: "relocate",
    target:
      'tests/fixtures/protocol/adapters/codex/adapter. D2a amendment 2: the adapter resolves its own root as `$(dirname "$0")/../../..` and sources `"$root/scripts/core/common.sh"` (scripts/adapters/codex/adapter:4-5), so the move must rewrite that resolution together with this call site.',
  },
  {
    file: "tests/test_adapter_protocol.sh",
    normalized: 'if "$root/scripts/adapters/codex/adapter" future-operation \\',
    ordinal: 1,
    disposition: "relocate",
    target:
      'tests/fixtures/protocol/adapters/codex/adapter. D2a amendment 2: the adapter resolves its own root as `$(dirname "$0")/../../..` and sources `"$root/scripts/core/common.sh"` (scripts/adapters/codex/adapter:4-5), so the move must rewrite that resolution together with this call site.',
  },
  {
    file: "tests/test_adapter_protocol.sh",
    normalized: 'SPW_ADAPTER="$root/scripts/adapters/codex/adapter" \\',
    ordinal: 5,
    disposition: "relocate",
    target:
      'tests/fixtures/protocol/adapters/codex/adapter. D2a amendment 2: the adapter resolves its own root as `$(dirname "$0")/../../..` and sources `"$root/scripts/core/common.sh"` (scripts/adapters/codex/adapter:4-5), so the move must rewrite that resolution together with this call site.',
  },
  {
    file: "tests/test_adapter_protocol.sh",
    normalized: 'SPW_ADAPTER="$root/scripts/adapters/codex/adapter" \\',
    ordinal: 6,
    disposition: "relocate",
    target:
      'tests/fixtures/protocol/adapters/codex/adapter. D2a amendment 2: the adapter resolves its own root as `$(dirname "$0")/../../..` and sources `"$root/scripts/core/common.sh"` (scripts/adapters/codex/adapter:4-5), so the move must rewrite that resolution together with this call site.',
  },
  {
    file: "tests/test_adapter_protocol.sh",
    normalized: 'SPW_ADAPTER="$root/scripts/adapters/codex/adapter" \\',
    ordinal: 7,
    disposition: "relocate",
    target:
      'tests/fixtures/protocol/adapters/codex/adapter. D2a amendment 2: the adapter resolves its own root as `$(dirname "$0")/../../..` and sources `"$root/scripts/core/common.sh"` (scripts/adapters/codex/adapter:4-5), so the move must rewrite that resolution together with this call site.',
  },
  {
    file: "tests/test_adapter_protocol.sh",
    normalized: 'SPW_ADAPTER="$root/scripts/adapters/codex/adapter"',
    ordinal: 1,
    disposition: "relocate",
    target:
      'tests/fixtures/protocol/adapters/codex/adapter. D2a amendment 2: the adapter resolves its own root as `$(dirname "$0")/../../..` and sources `"$root/scripts/core/common.sh"` (scripts/adapters/codex/adapter:4-5), so the move must rewrite that resolution together with this call site.',
  },
  {
    file: "tests/test_adapter_protocol.sh",
    normalized: 'SPW_ADAPTER="$root/scripts/adapters/codex/adapter"',
    ordinal: 2,
    disposition: "relocate",
    target:
      'tests/fixtures/protocol/adapters/codex/adapter. D2a amendment 2: the adapter resolves its own root as `$(dirname "$0")/../../..` and sources `"$root/scripts/core/common.sh"` (scripts/adapters/codex/adapter:4-5), so the move must rewrite that resolution together with this call site.',
  },
  {
    file: "tests/test_adapter_protocol.sh",
    normalized: 'SPW_ADAPTER="$root/scripts/adapters/codex/adapter"',
    ordinal: 3,
    disposition: "relocate",
    target:
      'tests/fixtures/protocol/adapters/codex/adapter. D2a amendment 2: the adapter resolves its own root as `$(dirname "$0")/../../..` and sources `"$root/scripts/core/common.sh"` (scripts/adapters/codex/adapter:4-5), so the move must rewrite that resolution together with this call site.',
  },
  {
    file: "tests/test_adapter_protocol.sh",
    normalized: 'SPW_ADAPTER="$root/scripts/adapters/codex/adapter"',
    ordinal: 4,
    disposition: "relocate",
    target:
      'tests/fixtures/protocol/adapters/codex/adapter. D2a amendment 2: the adapter resolves its own root as `$(dirname "$0")/../../..` and sources `"$root/scripts/core/common.sh"` (scripts/adapters/codex/adapter:4-5), so the move must rewrite that resolution together with this call site.',
  },
  {
    file: "tests/test_adapter_protocol.sh",
    normalized: 'SPW_ADAPTER="$root/scripts/adapters/codex/adapter"',
    ordinal: 5,
    disposition: "relocate",
    target:
      'tests/fixtures/protocol/adapters/codex/adapter. D2a amendment 2: the adapter resolves its own root as `$(dirname "$0")/../../..` and sources `"$root/scripts/core/common.sh"` (scripts/adapters/codex/adapter:4-5), so the move must rewrite that resolution together with this call site.',
  },
  {
    file: "tests/test_adapter_protocol.sh",
    normalized: 'SPW_ADAPTER="$root/scripts/adapters/codex/adapter" \\',
    ordinal: 8,
    disposition: "relocate",
    target:
      'tests/fixtures/protocol/adapters/codex/adapter. D2a amendment 2: the adapter resolves its own root as `$(dirname "$0")/../../..` and sources `"$root/scripts/core/common.sh"` (scripts/adapters/codex/adapter:4-5), so the move must rewrite that resolution together with this call site.',
  },
  {
    file: "tests/test_adapter_protocol.sh",
    normalized: 'SPW_ADAPTER="$root/scripts/adapters/codex/adapter" \\',
    ordinal: 9,
    disposition: "relocate",
    target:
      'tests/fixtures/protocol/adapters/codex/adapter. D2a amendment 2: the adapter resolves its own root as `$(dirname "$0")/../../..` and sources `"$root/scripts/core/common.sh"` (scripts/adapters/codex/adapter:4-5), so the move must rewrite that resolution together with this call site.',
  },
  {
    file: "tests/test_adapter_protocol.sh",
    normalized: 'SPW_ADAPTER="$root/scripts/adapters/codex/adapter" \\',
    ordinal: 10,
    disposition: "relocate",
    target:
      'tests/fixtures/protocol/adapters/codex/adapter. D2a amendment 2: the adapter resolves its own root as `$(dirname "$0")/../../..` and sources `"$root/scripts/core/common.sh"` (scripts/adapters/codex/adapter:4-5), so the move must rewrite that resolution together with this call site.',
  },
  {
    file: "tests/test_adapter_protocol.sh",
    normalized: 'SPW_ADAPTER="$root/scripts/adapters/codex/adapter" \\',
    ordinal: 11,
    disposition: "relocate",
    target:
      'tests/fixtures/protocol/adapters/codex/adapter. D2a amendment 2: the adapter resolves its own root as `$(dirname "$0")/../../..` and sources `"$root/scripts/core/common.sh"` (scripts/adapters/codex/adapter:4-5), so the move must rewrite that resolution together with this call site.',
  },
  {
    file: "tests/test_adapter_protocol.sh",
    normalized: 'SPW_ADAPTER="$root/scripts/adapters/codex/adapter" \\',
    ordinal: 12,
    disposition: "relocate",
    target:
      'tests/fixtures/protocol/adapters/codex/adapter. D2a amendment 2: the adapter resolves its own root as `$(dirname "$0")/../../..` and sources `"$root/scripts/core/common.sh"` (scripts/adapters/codex/adapter:4-5), so the move must rewrite that resolution together with this call site.',
  },
  {
    file: "tests/test_adapter_protocol.sh",
    normalized: 'SPW_ADAPTER="$root/scripts/adapters/codex/adapter" \\',
    ordinal: 13,
    disposition: "relocate",
    target:
      'tests/fixtures/protocol/adapters/codex/adapter. D2a amendment 2: the adapter resolves its own root as `$(dirname "$0")/../../..` and sources `"$root/scripts/core/common.sh"` (scripts/adapters/codex/adapter:4-5), so the move must rewrite that resolution together with this call site.',
  },
  // tests/test_marketplace_reconcile.sh (11)
  {
    file: "tests/test_marketplace_reconcile.sh",
    normalized: '. "$root/scripts/core/common.sh"',
    ordinal: 1,
    disposition: "re-express",
    target:
      "the tests/baseline/ port of tests/test_marketplace_reconcile.sh (spec section 5.4 driver ledger, 6.3), with its 3 traceability rows re-pointed and a new tests/migration-inventory/marketplace-reconcile.md (spec section 5.5).",
  },
  {
    file: "tests/test_marketplace_reconcile.sh",
    normalized: '. "$root/scripts/core/provenance.sh"',
    ordinal: 1,
    disposition: "re-express",
    target:
      "the tests/baseline/ port of tests/test_marketplace_reconcile.sh (spec section 5.4 driver ledger, 6.3), with its 3 traceability rows re-pointed and a new tests/migration-inventory/marketplace-reconcile.md (spec section 5.5).",
  },
  {
    file: "tests/test_marketplace_reconcile.sh",
    normalized: '. "$root/scripts/core/status.sh"',
    ordinal: 1,
    disposition: "re-express",
    target:
      "the tests/baseline/ port of tests/test_marketplace_reconcile.sh (spec section 5.4 driver ledger, 6.3), with its 3 traceability rows re-pointed and a new tests/migration-inventory/marketplace-reconcile.md (spec section 5.5).",
  },
  {
    file: "tests/test_marketplace_reconcile.sh",
    normalized: '. "$root/scripts/core/lifecycle.sh"',
    ordinal: 1,
    disposition: "re-express",
    target:
      "the tests/baseline/ port of tests/test_marketplace_reconcile.sh (spec section 5.4 driver ledger, 6.3), with its 3 traceability rows re-pointed and a new tests/migration-inventory/marketplace-reconcile.md (spec section 5.5).",
  },
  {
    file: "tests/test_marketplace_reconcile.sh",
    normalized: '. "$root/scripts/core/adapter.sh"',
    ordinal: 1,
    disposition: "re-express",
    target:
      "the tests/baseline/ port of tests/test_marketplace_reconcile.sh (spec section 5.4 driver ledger, 6.3), with its 3 traceability rows re-pointed and a new tests/migration-inventory/marketplace-reconcile.md (spec section 5.5).",
  },
  {
    file: "tests/test_marketplace_reconcile.sh",
    normalized: 'SPW_ADAPTER="$root/scripts/adapters/codex/adapter" \\',
    ordinal: 1,
    disposition: "re-express",
    target:
      "the tests/baseline/ port of tests/test_marketplace_reconcile.sh (spec section 5.4 driver ledger, 6.3), with its 3 traceability rows re-pointed and a new tests/migration-inventory/marketplace-reconcile.md (spec section 5.5).",
  },
  {
    file: "tests/test_marketplace_reconcile.sh",
    normalized: 'SPW_ADAPTER="$root/scripts/adapters/codex/adapter" \\',
    ordinal: 2,
    disposition: "re-express",
    target:
      "the tests/baseline/ port of tests/test_marketplace_reconcile.sh (spec section 5.4 driver ledger, 6.3), with its 3 traceability rows re-pointed and a new tests/migration-inventory/marketplace-reconcile.md (spec section 5.5).",
  },
  {
    file: "tests/test_marketplace_reconcile.sh",
    normalized:
      'SPW_ADAPTER="$root/scripts/adapters/codex/adapter" SUPERPOWERS_CODEX="$fake_codex" \\',
    ordinal: 1,
    disposition: "re-express",
    target:
      "the tests/baseline/ port of tests/test_marketplace_reconcile.sh (spec section 5.4 driver ledger, 6.3), with its 3 traceability rows re-pointed and a new tests/migration-inventory/marketplace-reconcile.md (spec section 5.5).",
  },
  {
    file: "tests/test_marketplace_reconcile.sh",
    normalized:
      'SPW_ADAPTER="$root/scripts/adapters/codex/adapter" SUPERPOWERS_CODEX="$fake_codex" \\',
    ordinal: 2,
    disposition: "re-express",
    target:
      "the tests/baseline/ port of tests/test_marketplace_reconcile.sh (spec section 5.4 driver ledger, 6.3), with its 3 traceability rows re-pointed and a new tests/migration-inventory/marketplace-reconcile.md (spec section 5.5).",
  },
  {
    file: "tests/test_marketplace_reconcile.sh",
    normalized:
      'if (SPW_ADAPTER="$root/scripts/adapters/codex/adapter" SUPERPOWERS_CODEX="$fake_codex" \\',
    ordinal: 1,
    disposition: "re-express",
    target:
      "the tests/baseline/ port of tests/test_marketplace_reconcile.sh (spec section 5.4 driver ledger, 6.3), with its 3 traceability rows re-pointed and a new tests/migration-inventory/marketplace-reconcile.md (spec section 5.5).",
  },
  {
    file: "tests/test_marketplace_reconcile.sh",
    normalized:
      'if (SPW_ADAPTER="$root/scripts/adapters/codex/adapter" SUPERPOWERS_CODEX="$fake_codex" \\',
    ordinal: 2,
    disposition: "re-express",
    target:
      "the tests/baseline/ port of tests/test_marketplace_reconcile.sh (spec section 5.4 driver ledger, 6.3), with its 3 traceability rows re-pointed and a new tests/migration-inventory/marketplace-reconcile.md (spec section 5.5).",
  },
  // tests/test_node_cli_helper.sh (1)
  {
    file: "tests/test_node_cli_helper.sh",
    normalized: '. "$root/scripts/core/common.sh"',
    ordinal: 1,
    disposition: "retire",
    target:
      "the driver is retired in 4c (spec section 5.4); its one surviving case is the NODE_OPTIONS/NODE_PATH scrub unit test 4b added over src/adapter.ts:116-122, recorded in the new tests/migration-inventory/node-cli-helper.md (spec section 5.5).",
  },
  // tests/test_probe.sh (11)
  {
    file: "tests/test_probe.sh",
    normalized: '. "$root/scripts/core/common.sh"',
    ordinal: 1,
    disposition: "retire",
    target:
      "deleted with tests/test_probe.sh in 4c (spec sections 3.3, 5.4, 6.3); tests/baseline/probe.test.js replaced the driver in slice 2.",
  },
  {
    file: "tests/test_probe.sh",
    normalized: '. "$root/scripts/core/provenance.sh"',
    ordinal: 1,
    disposition: "retire",
    target:
      "deleted with tests/test_probe.sh in 4c (spec sections 3.3, 5.4, 6.3); tests/baseline/probe.test.js replaced the driver in slice 2.",
  },
  {
    file: "tests/test_probe.sh",
    normalized: '. "$root/scripts/core/upstream.sh"',
    ordinal: 1,
    disposition: "retire",
    target:
      "deleted with tests/test_probe.sh in 4c (spec sections 3.3, 5.4, 6.3); tests/baseline/probe.test.js replaced the driver in slice 2.",
  },
  {
    file: "tests/test_probe.sh",
    normalized: '. "$root/scripts/core/selection.sh"',
    ordinal: 1,
    disposition: "retire",
    target:
      "deleted with tests/test_probe.sh in 4c (spec sections 3.3, 5.4, 6.3); tests/baseline/probe.test.js replaced the driver in slice 2.",
  },
  {
    file: "tests/test_probe.sh",
    normalized: '. "$root/scripts/core/status.sh"',
    ordinal: 1,
    disposition: "retire",
    target:
      "deleted with tests/test_probe.sh in 4c (spec sections 3.3, 5.4, 6.3); tests/baseline/probe.test.js replaced the driver in slice 2.",
  },
  {
    file: "tests/test_probe.sh",
    normalized: '. "$root/scripts/core/lifecycle.sh"',
    ordinal: 1,
    disposition: "retire",
    target:
      "deleted with tests/test_probe.sh in 4c (spec sections 3.3, 5.4, 6.3); tests/baseline/probe.test.js replaced the driver in slice 2.",
  },
  {
    file: "tests/test_probe.sh",
    normalized: '. "$root/scripts/core/common.sh"',
    ordinal: 2,
    disposition: "retire",
    target:
      "deleted with tests/test_probe.sh in 4c (spec sections 3.3, 5.4, 6.3); tests/baseline/probe.test.js replaced the driver in slice 2.",
  },
  {
    file: "tests/test_probe.sh",
    normalized: '. "$root/scripts/core/provenance.sh"',
    ordinal: 2,
    disposition: "retire",
    target:
      "deleted with tests/test_probe.sh in 4c (spec sections 3.3, 5.4, 6.3); tests/baseline/probe.test.js replaced the driver in slice 2.",
  },
  {
    file: "tests/test_probe.sh",
    normalized: 'exec "$pkg/scripts/adapters/codex/adapter" "\\$@"',
    ordinal: 1,
    disposition: "retire",
    target:
      "deleted with tests/test_probe.sh in 4c (spec sections 3.3, 5.4, 6.3); tests/baseline/probe.test.js replaced the driver in slice 2.",
  },
  {
    file: "tests/test_probe.sh",
    normalized: '/bin/sh "$pkg/scripts/probe" --porcelain',
    ordinal: 1,
    disposition: "retire",
    target:
      "deleted with tests/test_probe.sh in 4c (spec sections 3.3, 5.4, 6.3); tests/baseline/probe.test.js replaced the driver in slice 2.",
  },
  {
    file: "tests/test_probe.sh",
    normalized: 'set -- "$@" /bin/sh "$pkg/scripts/probe"',
    ordinal: 1,
    disposition: "retire",
    target:
      "deleted with tests/test_probe.sh in 4c (spec sections 3.3, 5.4, 6.3); tests/baseline/probe.test.js replaced the driver in slice 2.",
  },
  // tests/unit/commands-install.test.js (1)
  {
    file: "tests/unit/commands-install.test.js",
    normalized:
      "void test('argv is ignored, matching scripts/install never reading \"$@\"', async () => {",
    ordinal: 1,
    disposition: "re-express",
    target:
      "rename the case to cite src/commands/install.ts, the surviving subject; the property (the port ignores argv) survives unchanged. Not a frozen name - only tests/baseline/cli-parity.test.js's names are frozen (tests/baseline/traceability.test.js:240).",
  },
  // tests/unit/commands-uninstall.test.js (1)
  {
    file: "tests/unit/commands-uninstall.test.js",
    normalized:
      "void test('argv is ignored, matching scripts/uninstall never reading \"$@\"', async () => {",
    ordinal: 1,
    disposition: "re-express",
    target:
      "rename the case to cite src/commands/uninstall.ts, the surviving subject; the property (the port ignores argv) survives unchanged. Not a frozen name - only tests/baseline/cli-parity.test.js's names are frozen (tests/baseline/traceability.test.js:240).",
  },
  // tests/unit/commands-update.test.js (1)
  {
    file: "tests/unit/commands-update.test.js",
    normalized:
      "void test('argv is ignored, matching scripts/update never reading \"$@\"', async () => {",
    ordinal: 1,
    disposition: "re-express",
    target:
      "rename the case to cite src/commands/update.ts, the surviving subject; the property (the port ignores argv) survives unchanged. Not a frozen name - only tests/baseline/cli-parity.test.js's names are frozen (tests/baseline/traceability.test.js:240).",
  },
  // tests/unit/provenance.test.js (1)
  {
    file: "tests/unit/provenance.test.js",
    normalized:
      '"the metadata path must match scripts/core/lifecycle.sh:28-31",',
    ordinal: 1,
    disposition: "re-express",
    target:
      "src/provenance.ts:98's generatedMetadataPath, which is the surviving definition of the path the message appeals to.",
  },
];

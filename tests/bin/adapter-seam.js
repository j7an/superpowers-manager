// @ts-check
// The SPW_ADAPTER seam's declared dependencies, and the gates that stop slice
// 4 removing the seam out from under them.
//
// SPW_ADAPTER is honoured only by scripts/core/adapter.sh; the in-process
// runAdapter ignores it. Every assertion reading a fake adapter's log or
// depending on its interception dies silently when the seam goes — the same
// shape that left five cli-parity assertions vacuous in slice 3.4, at a larger
// scale. At their peak (027c42e, before PR 11.5 slice 4b Task 6) the two
// SEAM_SOURCES files held 9 literal readLog(c.adapterLog) sites and 30 cases
// declared a seamDependency (the sum of SEAM_DEPENDENT below); the two
// differed because one case could hold several readers and a case could be
// seam-dependent through interception without reading the log at all. Task 6
// discharged all thirty and all nine — see the dated comment above
// SEAM_DEPENDENT below for how each one went. Both counts are re-derived from
// the tree on every test run (adapter-seam.test.js), not carried as history:
// this paragraph is the only place either number is now asserted in prose.
//
// Most re-anchored onto codex.log, because every mutation the adapter
// performs reaches Codex through codexBin (src/adapter.ts:591-676). What
// could not re-anchor converted to an injected recording double instead
// (tests/bin/command-context.js) or, for the two genuinely unreachable
// transport-fault cases, retired at the gap. SEAM_DEPENDENT stays declared
// rather than deleted, at zero, because an emptied gate — not an absent one —
// is what proves the seam's removal is safe.

import { join } from "node:path";

/** What the fake does. */
export const SEAM_MODES = /** @type {const} */ ([
  "delegate",
  "tripwire",
  "intercept",
]);

/**
 * Why a case cannot survive the seam's removal. Independent of the mode: all
 * three modes still write adapter.log, so a `delegate` case that reads it is
 * seam-dependent too.
 */
export const SEAM_REASONS = /** @type {const} */ (["intercept", "log"]);

// Keyed by the script runScript actually spawns, NOT by the file the case
// lives in. tests/bin/install-commands.test.js holds cases that run `update`
// and `prepare`; keying by file would let scripts/update be deleted with this
// gate green.
//
// Declared, never derived by globbing. A query over mutable state empties
// exactly when the deletion it should catch happens — the same argument
// tests/bin/migration-inventory.test.js:20-24 makes about DECLARED.
//
// Slice 4 empties this map as it cleans each script. Slice 6 deletes this
// module, both gates, and tests/baseline/support.js's ADAPTER_SEAM_RETIRED:
// test-support residue that outlives the seam on purpose, because an emptied
// gate is what proves slice 4 finished.
//
// 2026-08-10, Task 6 of PR 11.5 slice 4b: all thirty discharged, none by
// deleting a map entry. Every case that declared a seamDependency now either
// calls its command function (`runInstall` / `runUpdate` / `runUninstall` /
// `runPrepare`) in-process through an injected recording adapter
// (tests/bin/command-context.js), asserting a structural claim about which
// operations the double answered, or — for the two cases below marked
// RETIRED — has no surviving subject to convert at all. The shell is still
// what `bin/superpowers-manager.js` dispatches to for every other case in
// these two files; only the cases that were declared here bypass it, calling
// the ported TypeScript module directly. The reasoning below is preserved
// because it explains WHY each class had no surviving channel other than a
// double, which the mechanical fact "converted" does not; 4c and slice 6 read
// it when they delete the seam and this registry.
//
//   install:
//     intercept (6): two ("malformed update-control output exits exactly 1",
//                "malformed fingerprint output is rejected by response
//                validation") are RETIRED, not converted — see
//                tests/migration-inventory/install-commands.md items 22-24 and
//                107-111, the two retirement notes that own them. (Items 26-27,
//                cited here before, belong to the FAILED update-control case,
//                which converted.) These two are the ONLY transport-fault
//                retirements: the whole fixture schema offers exactly two
//                levers that make the fake adapter process emit non-JSON —
//                install-fakes.js:234 and :285 — so there is no third.
//                Both fixture configs forced the FAKE ADAPTER PROCESS to write
//                a bare `{` to stdout: a transport-level, non-JSON-parseable
//                fault. `ctx.adapter` is an in-process function call that
//                returns an already-typed AdapterResult, with no
//                serialization boundary for a double to corrupt, so the
//                subject these two cases tested no longer exists. The other
//                four ("...blocks a direct install", "needs-prepare install
//                reinspects after prepare and rejects drift", "needs-install
//                path inspects ownership then update control, then installs",
//                "the fresh gate, not the initial probe, controls mutation
//                authority") convert cleanly: each is now a double answering
//                `inspect --view update-control` with a fixed or call-counted
//                value, asserted over the double's own recorded `calls`.
//     log (15):  the two identity-state cases, legacy and both, converted by
//                converting their shared helper (`assertLegacyIdentityStops`)
//                to call `runInstall` in-process — its `^build ` negative,
//                which had no Codex-level footprint because the adapter's
//                build operation issues no Codex command at all, is now
//                `!adapter.calls.some((c) => c[0] === "build" || c[0] ===
//                "install")`. THIRTEEN more came from a single shared helper,
//                `prepareGeneratedTree`, converted the same way: it now calls
//                `runPrepare` in-process and asserts its double's calls are
//                exactly `["build"]`, discharging all thirteen callers'
//                declarations at once without touching the callers
//                themselves (they still dispatch their OWN subject call
//                however they did before).
//   update:
//     intercept (2): both convert. "unsupported update control blocks the
//                update fast path" and "failed update-control inspection
//                exits exactly 1" both answer `inspect --view update-control`
//                directly — the second with a well-formed `ok: false`
//                envelope (`failureResult`), which is NOT the transport fault
//                the two install retirements above were, and is reachable
//                through a double exactly as it was through the fixture.
//     log (3):   "update rejects mixed legacy state even when the fingerprint
//                is current" converts the same way as the two identity-state
//                cases above (inline, not through the shared helper, because
//                it dispatches `update` rather than `install`), plus the two
//                `prepareGeneratedTree` callers that run `update` — already
//                discharged by that helper's own conversion.
//   uninstall:
//     intercept (1): "selection-independent recovery" converts: `runUninstall`
//                (unlike install/update) never calls gatherProbe and
//                structurally never issues an update-control inspect at all,
//                so the double's own construction (answering only ownership
//                and uninstall) now IS the proof.
//     log (2):   "missing Codex" converts: the double answers the ownership
//                inspect with the same well-formed failureResult the real
//                adapter's requireCodex check would produce for a missing
//                binary, and the double's own call list (exactly one call)
//                replaces the adapter-log read as evidence codex.log could
//                never supply (Codex is unreached by construction either
//                way). "both present" does NOT convert to a double: most of
//                its claims re-anchor onto codex.log (ownership inspection has
//                a Codex-level footprint via `plugin list --json`), and the
//                one claim that does not ("adapter uninstall must receive
//                booleans, not provider names") is dropped because it was
//                inert — its needle `other@x` is defined by no fixture in this
//                repository, so no behaviour of the subject could ever have
//                produced it. One further claim in that case, the
//                exactly-once count on the adapter uninstall op, is a genuine
//                (narrow) DROP rather than a re-anchor — see
//                tests/migration-inventory/uninstall-commands.md items 28 and
//                35 for both arguments.
//   prepare:
//     log (1):   "prepare is capability-independent" converts: the double
//                answers only `build` and fails the case by exhaustion on any
//                other call, including `inspect --view update-control` and
//                `install --package-root` — structurally stronger than the
//                adapter-log negatives it replaces.
/**
 * Per script, split by the reason a case cannot survive the seam's removal.
 * All thirty discharged as of 2026-08-10 — see the comment above.
 * @type {Record<string, { intercept: number, log: number }>}
 */
export const SEAM_DEPENDENT = {
  install: { intercept: 0, log: 0 },
  update: { intercept: 0, log: 0 },
  uninstall: { intercept: 0, log: 0 },
  prepare: { intercept: 0, log: 0 },
};

/** @type {Record<string, string[]>} */
export const SEAM_SOURCES = {
  install: ["tests/bin/install-commands.test.js"],
  update: ["tests/bin/install-commands.test.js"],
  uninstall: ["tests/bin/uninstall-commands.test.js"],
  prepare: ["tests/bin/install-commands.test.js"],
};

/**
 * Every file that may hold a seamDependency declaration or an adapter-log
 * reader. Independent of SEAM_DEPENDENT's keys ON PURPOSE: deriving it from
 * them — `new Set(Object.values(SEAM_SOURCES).flat())` — empties the scan set
 * exactly when slice 4 removes the last key for a file, which is the moment
 * that file's residue must be counted. That is this module's own argument at
 * the SEAM_DEPENDENT comment above ("a query over mutable state empties
 * exactly when the deletion it should catch happens") turned back on itself:
 * the count gate's own diagnostic ("declares script X, absent from
 * SEAM_DEPENDENT") is silenced by deleting the SEAM_SOURCES key, which would
 * turn both gates green with every residue site intact.
 *
 * RETIRING AN ENTRY. Emptying this list is as dangerous as deriving it, and
 * for the same reason: a file that leaves it stops being scanned by both
 * gates, residue and all. Gate 1's diagnostic below says "remove this entry
 * before deleting the script", and that instruction is about SEAM_DEPENDENT
 * only. For THIS list the order is the reverse:
 *
 *   1. Re-base or retire the file's seamDependency declarations and its
 *      readLog(c.adapterLog) readers, until its residue is zero.
 *   2. Only then remove its SEAM_SOURCE_FILES entry.
 *
 * Doing it the other way round — retiring `uninstall` from SEAM_DEPENDENT,
 * SEAM_SOURCES and this list in one step, alongside scripts/uninstall — leaves
 * every gate green over a file that still holds live declarations and live
 * readers. adapter-seam.test.js's "every file declaring a seamDependency is in
 * SEAM_SOURCE_FILES" enforces step 1 before step 2 by scanning the TREE, not
 * these maps: a tree query empties only when the residue is genuinely gone,
 * which is precisely slice 4's success condition. Its sibling case asserts
 * every SEAM_SOURCES value is a member here, so the two lists cannot drift
 * apart either.
 *
 * @type {string[]}
 */
export const SEAM_SOURCE_FILES = [
  "tests/bin/install-commands.test.js",
  "tests/bin/uninstall-commands.test.js",
];

/**
 * A lifecycle case's live condition is the NODE entrypoint, not a script's
 * existence. runScript spawns process.execPath with
 * bin/superpowers-manager.js and the subcommand as its argument
 * (tests/bin/lifecycle-fixture.js:342-345), so every lifecycle case routes
 * through src/cli.ts's DISPATCH, which PR 11.5 slice 4b flipped to
 * "in-process" for all eight subcommands (src/cli.ts:65-74). DISPATCH now
 * governs these cases entirely, and deleting scripts/<script> does not
 * affect them.
 *
 * Before that flip runScript spawned /bin/sh scripts/<script> directly and
 * script existence WAS the condition — that is the history SEAM_DEPENDENT's
 * keying by script name still reflects, and the reason this gate is written
 * over script paths at all. Read together with the paragraph below: with
 * every SEAM_DEPENDENT total at zero, the existence check never runs, so the
 * gate is dormant rather than merely unnecessary. It re-arms if a nonzero
 * count reappears, which is what keeps it worth carrying into slice 4c.
 *
 * `dependent` defaults to the real, gated SEAM_DEPENDENT but is injectable so
 * adapter-seam.test.js's mutation proof ("the gate fails when a depended-on
 * script is gone") can still exercise the throw path below now that every
 * real entry is legitimately zero: with the real map, `total === 0` skips
 * every script before the existence check ever runs, and there is no longer
 * a nonzero entry to inject a missing script against. The parameter is never
 * used to feed a real gate call a non-default map: adapter-seam.test.js holds
 * exactly TWO call sites, and the only non-default one is the injection proof
 * itself, "the gate fails when a depended-on script is gone"
 * (adapter-seam.test.js:102). The other — "every script with seam-dependent
 * cases still exists" (adapter-seam.test.js:98), the real gate — takes the
 * default.
 * @param {string} root repository root
 * @param {(path: string) => boolean} exists
 * @param {Record<string, { intercept: number, log: number }>} [dependent]
 * @returns {void}
 */
export function assertSeamScriptsPresent(
  root,
  exists,
  dependent = SEAM_DEPENDENT,
) {
  for (const [script, counts] of Object.entries(dependent)) {
    const total = counts.intercept + counts.log;
    if (total === 0) continue;
    // Named before it is used: without this, a key added to SEAM_DEPENDENT and
    // forgotten in SEAM_SOURCES would surface as a TypeError on undefined
    // instead of the diagnostic below.
    const sources = SEAM_SOURCES[script];
    if (!sources) {
      throw new Error(
        `adapter-seam: ${script} is in SEAM_DEPENDENT with no SEAM_SOURCES ` +
          "entry, so the gate cannot name the files that would need re-basing",
      );
    }
    // join(), not string concatenation: root is a fileURLToPath(new URL("../..",
    // import.meta.url)) result, which always carries a trailing slash, so
    // `${root}/scripts/${script}` would double the slash. That spelling still
    // resolves through a real existsSync (the OS collapses it), but it is a
    // different string than the join()-built path adapter-seam.test.js's
    // mutation-proof compares against — so an injected "this path doesn't
    // exist" predicate would never match and the gate would never observe its
    // own failure mode. Keeping join() here is what lets that test prove
    // anything at all.
    if (!exists(join(root, "scripts", script))) {
      throw new Error(
        `adapter-seam: scripts/${script} is gone, but ${total} of its cases ` +
          "still depend on the SPW_ADAPTER seam — a seam the in-process " +
          "runAdapter ignores. Re-base or retire those cases in " +
          `${sources.join(", ")} and remove this entry before ` +
          "deleting the script, or their assertions read a dead channel.",
      );
    }
  }
}

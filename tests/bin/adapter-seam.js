// @ts-check
// The SPW_ADAPTER seam's declared dependencies, and the gates that stop slice
// 4 removing the seam out from under them.
//
// SPW_ADAPTER is honoured only by scripts/core/adapter.sh; the in-process
// runAdapter ignores it. Every assertion reading a fake adapter's log or
// depending on its interception dies silently when the seam goes — the same
// shape that left five cli-parity assertions vacuous in slice 3.4, at a larger
// scale. Both numbers are counted from the tree, not from the design: the two
// SEAM_SOURCES files hold 9 literal readLog(c.adapterLog) sites, and 30 cases
// declare a seamDependency (the sum of SEAM_DEPENDENT below). The two differ
// because one case can hold several readers and a case can be seam-dependent
// through interception without reading the log at all.
//
// Most of those re-anchor onto codex.log, because every mutation the adapter
// performs reaches Codex through codexBin (src/adapter.ts:575-660). What
// cannot re-anchor is declared here.

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
// Counted per script from the seamDependency declarations actually written —
// `grep -c 'script: "<name>"'` over SEAM_SOURCES, not from any plan table.
// Cases are named, not line-numbered, because these two files move under edit:
//
//   install   21 = 6 intercept + 15 log
//     intercept: "unsupported update control blocks a direct install";
//                "malformed update-control output exits exactly 1";
//                "needs-prepare install reinspects after prepare and rejects
//                 drift"; "needs-install path inspects ownership then update
//                 control, then installs" (count only, default config);
//                "the fresh gate, not the initial probe, controls mutation
//                 authority"; "malformed fingerprint output is rejected by
//                 response validation".
//     log:       the two identity-state cases, legacy and both, which reach
//                assertLegacyIdentityStops — its `^build ` negative has no
//                Codex-level footprint because the adapter's build operation
//                issues no Codex command at all. THIRTEEN more come from a
//                single shared helper: prepareGeneratedTree reads adapter.log
//                to prove prepare did not inspect update control, and that
//                property is observable nowhere else. Re-basing that one
//                helper collapses most of this number at once.
//   update    5 = 2 intercept + 3 log
//     intercept: "unsupported update control blocks the update fast path";
//                "failed update-control inspection exits exactly 1".
//     log:       "update rejects mixed legacy state even when the fingerprint
//                is current" (same `^build ` negative), plus the two
//                prepareGeneratedTree callers that run `update`.
//   uninstall 3 = 1 intercept + 2 log
//     intercept: "selection-independent recovery".
//     log:       "missing Codex" (codex.log is empty by construction, so it
//                can witness nothing); "both present" (asserts the adapter's
//                own argv shape, which Codex never sees).
//   prepare   1 = 1 log
//     log:       "prepare is capability-independent" — adapter operation names
//                on a path that makes no Codex call at all, which is the very
//                property the case asserts.
/** @type {Record<string, number>} */
export const SEAM_DEPENDENT = {
  install: 21,
  update: 5,
  uninstall: 3,
  prepare: 1,
};

/** @type {Record<string, string[]>} */
export const SEAM_SOURCES = {
  install: ["tests/bin/install-commands.test.js"],
  update: ["tests/bin/install-commands.test.js"],
  uninstall: ["tests/bin/uninstall-commands.test.js"],
  prepare: ["tests/bin/install-commands.test.js"],
};

/**
 * The live condition for a lifecycle case is the SCRIPT's existence, not its
 * dispatch mode: runScript spawns /bin/sh scripts/<script> directly
 * (tests/bin/lifecycle-fixture.js:268) and never routes through
 * bin/superpowers, so DISPATCH does not govern these cases at all.
 *
 * @param {string} root repository root
 * @param {(path: string) => boolean} exists
 * @returns {void}
 */
export function assertSeamScriptsPresent(root, exists) {
  for (const [script, count] of Object.entries(SEAM_DEPENDENT)) {
    if (count === 0) continue;
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
        `adapter-seam: scripts/${script} is gone, but ${count} of its cases ` +
          "still depend on the SPW_ADAPTER seam — a seam the in-process " +
          "runAdapter ignores. Re-base or retire those cases in " +
          `${sources.join(", ")} and remove this entry before ` +
          "deleting the script, or their assertions read a dead channel.",
      );
    }
  }
}

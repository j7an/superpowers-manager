// @ts-check
// Ported from tests/test_bin_dispatch.sh (see
// tests/migration-inventory/bin-dispatch.md for the numbered assertion
// inventory this file maps to 1:1).
//
// Every case names the tools present on its PATH at the assertion. The shell
// mutated one shared fakebin in place and restored it — `:174-178` asserted
// three commands work with git absent, a fact that lived 17 lines earlier at
// `:157`. That is the isolation-sensitive class this port exists to make
// visible.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { makePackageRoot, runDispatch } from "./dispatch-fixture.js";

const ALL_TOOLS = ["git", "python3", "codex"];

// --- inventory items 2-3: an unbuilt checkout ------------------------------

void test("an unbuilt checkout gets only the actionable build diagnostic", () => {
  const result = runDispatch({
    tools: ALL_TOOLS,
    args: ["--version"],
    packageRoot: makePackageRoot("none"),
  });
  assert.equal(result.status, 1);
  assert.ok(
    result.stderr.includes(
      "dist/ not built — run `pnpm install --frozen-lockfile && pnpm run build`",
    ),
  );
});

// --- inventory items 4-6: a present module that fails during import --------

void test("a dist/cli.js that throws keeps its real error and is not relabelled", () => {
  const result = runDispatch({
    tools: ALL_TOOLS,
    args: ["--version"],
    packageRoot: makePackageRoot("throwing"),
  });
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes("synthetic dist import failure"));
  assert.ok(
    !result.stderr.includes("dist/ not built"),
    "a real import failure was mislabelled as an unbuilt checkout",
  );
});

// --- inventory items 7-14: routing ----------------------------------------

// The `ROUTING_CASES` table and its loop stood here until PR 11.5 slice 4b
// (Task 8) flipped the last three spawned commands in-process. `probe`
// (formerly item 7), `prepare` (formerly item 8), `pin` (formerly item 9),
// `track-latest` (formerly item 10) and `unpin` (formerly item 11) had already
// left it one flip at a time; `install` (item 12), `uninstall` (item 13) and
// `update` (item 14) leave now, emptying it. The table and its loop are deleted
// rather than left with zero entries, because a `for` over `[]` reports success
// without asserting anything — the same reasoning that deleted `NO_CODEX_CASES`
// at slice 3.4. `SPAWN_COMMANDS`, which sized the table from production, is
// deleted from tests/bin/dispatch-fixture.js with it: at 8/8 in-process the
// subset is permanently empty. See the retirement notes for items 7-14 in
// tests/migration-inventory/bin-dispatch.md and the dedicated in-process
// routing cases below.

void test("routing: `track-latest` succeeds in-process", () => {
  const result = runDispatch({ tools: ALL_TOOLS, args: ["track-latest"] });
  assert.equal(result.status, 0);
});

void test("routing: `unpin` succeeds in-process", () => {
  const result = runDispatch({ tools: ALL_TOOLS, args: ["unpin"] });
  assert.equal(result.status, 0);
});

void test("routing: `pin` succeeds in-process", () => {
  const result = runDispatch({
    tools: ["python3", "codex"],
    args: ["pin", "v1.0.0"],
    pinUpstream: true,
  });
  assert.equal(result.status, 0);
});

// The unregistered-handler backstop case stood here until PR 11.5 slice 4b
// (Task 8, Step 5a) and is RETIRED at the gap, with `dispatchOverride`,
// `patchDispatch` and the "dispatchOverride rejects an override that changes
// nothing" test that followed it.
//
// It reached src/cli.ts's `!handler` guard by patching a case-local copy of the
// compiled DISPATCH table, flipping a "spawn" entry to "in-process" so the name
// dispatched was one IN_PROCESS_HANDLERS does not carry. At 8/8 in-process
// there was no "spawn" entry left to flip, and `patchDispatch` rejected a no-op
// override by design, so the fixture could not construct the condition at all.
// The test's own comment had already scheduled this: "in slice 4 it throws
// instead, which is when this test should be deleted."
//
// Decision (Step 5a, option (b)): the compile-time exhaustiveness guard —
// `IN_PROCESS_HANDLERS: Record<Subcommand, InProcessHandler>` (slice 6 retyped
// it from `Record<InProcessCommand, InProcessHandler>`; the guarantee is
// unchanged, the same decision one indirection shorter) — is accepted as the
// whole protection. Reaching the runtime guard would now require surgically
// deleting a key from a compiled registry, which asserts only that a hand-mutilated
// build reports rather than crashes. `src/cli.ts`'s `!handler` guard STAYS as
// an unreachable, documented fail-closed backstop; it is three lines and its
// removal would trade a named diagnostic for a TypeError.
//
// `dispatchOverride`'s only other consumer was a test of the fixture itself
// ("rejects an override that changes nothing"), so it goes with it: a fixture
// whose only remaining test is a test of itself is residue, not coverage. See
// the retirement notes for port-only items 41-43 in
// tests/migration-inventory/bin-dispatch.md.

// --- inventory items 15-19: unknown subcommand -----------------------------

void test("an unknown subcommand fails with usage", () => {
  const result = runDispatch({ tools: ALL_TOOLS, args: ["bogus"] });
  assert.equal(result.status, 2);
  assert.ok(result.stderr.includes("unknown subcommand: bogus"));
  assert.ok(result.stderr.includes("usage:"));
});

// --- inventory items 20-23: a stray flag must not fall through to update ---

void test("a stray flag fails with usage", () => {
  const result = runDispatch({ tools: ALL_TOOLS, args: ["--porcelain"] });
  assert.equal(result.status, 2);
  assert.ok(result.stderr.includes("unknown subcommand: --porcelain"));
  assert.ok(result.stderr.includes("usage:"));
});

// --- inventory items 24-28: --help and --version ---------------------------

void test("--help exits 0 with usage on stdout and empty stderr", () => {
  const result = runDispatch({ tools: ALL_TOOLS, args: ["--help"] });
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes("usage:"));
  assert.equal(result.stderr, "");
});

void test("--version prints exactly the package version", () => {
  const result = runDispatch({ tools: ALL_TOOLS, args: ["--version"] });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "9.9.9-test");
});

void test("--version through a symlink resolves, as npm and npx invoke bins", () => {
  const result = runDispatch({
    tools: ALL_TOOLS,
    args: ["--version"],
    viaSymlink: true,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "9.9.9-test");
});

// --- inventory item 29: exit-code propagation --------------------------------
//
// RETIRED at the gap (PR 11.5 slice 4b, Task 8). The case asserted that a
// spawned child's exit status reaches the caller unchanged, using `install` as
// a vehicle and a `scripts: { install: "exit 42" }` override to produce the
// status. The CLI spawns no child for any command now, so there is no child
// status to propagate: `main` exits with the value its in-process handler
// returns. That successor property is not this one — it is asserted per command
// by the unit suites (tests/unit/commands-{install,update,uninstall}.test.js)
// and by the exit statuses every case in this file already checks. `scripts` as
// a `runDispatch` option did not survive: it was deleted, along with the
// `scripts/` fixture tree, in slice 4c.

// --- inventory items 30-31: env passthrough ---------------------------------
//
// RETIRED at the gap (PR 11.5 slice 4b, Task 8). The case asserted that
// SUPERPOWERS_REF and SUPERPOWERS_VALIDATOR reach `scripts/update`'s
// environment. `update` is
// in-process, so no environment is handed to a child at all: the command reads
// `ctx.env`, which is `process.env` itself (src/cli.ts's single CommandContext
// construction site). There is no "passthrough" left to break. The surviving
// property — that a SUPERPOWERS_* variable actually changes what the command
// does — is asserted directly by the two `prepare` cases below
// (SUPERPOWERS_VALIDATOR flipping preflight's `python3` requirement) and, for
// the full ten-variable set, by tests/baseline/cli-parity.test.js's
// CLI-ENV-PASSTHROUGH-01.

// --- inventory items 32-34: preflight, git absent ---------------------------

// Item 33's substring check became EXACT at PR 11.5 slice 4b, Task 8, and both
// git cases below carry the change. Before the flip, `install` with `git`
// absent could only fail at preflight, because the command was spawned and the
// spawn never happened. In-process it reaches `gatherProbe`, whose ref
// resolution shells out to `git` and emits its own
// `error: required command not found: git` — no em-dash suffix — so a
// substring check is satisfied by either producer. Measured: with `git`
// removed from `COMMAND_REQUIREMENTS.install` in a mutated `dist/`, the old
// substring form still passed. Preflight's own diagnostic is the contract
// here, so the assertion pins its exact text, as port-only item 49 already
// does for `python3`.
void test("missing git fails before dispatch and names the tool", () => {
  const result = runDispatch({
    tools: ["python3", "codex"],
    args: ["install"],
  });
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "error: required command not found: git — install git and re-run\n",
  );
});

// New (PR 11.5, Task 7): the generic case above uses `install` — a command
// that has always required `git`. `pin` becoming in-process
// (`COMMAND_REQUIREMENTS.pin`, src/cli.ts) drops it from `["git",
// "python3"]` to `["git"]`, so this is the regression net for that specific
// row: `git` must still be required for `pin` even though `python3` no
// longer is (see the `python3`-absent case in the "commands that need no
// git" section below).
void test("`pin` fails preflight when git is absent from PATH", () => {
  const result = runDispatch({
    tools: ["python3", "codex"],
    args: ["pin", "v1.0.0"],
  });
  assert.equal(result.status, 1);
  // Exact, for the reason recorded on the `install` case above: `pin`'s own
  // ref resolution shells out to `git` too, so a substring check no longer
  // discriminates preflight's diagnostic from the resolver's.
  assert.equal(
    result.stderr,
    "error: required command not found: git — install git and re-run\n",
  );
});

// --- inventory items 35-37: invalid pin syntax precedes preflight ----------

void test("an invalid pin ref is a usage error decided before any tool lookup", () => {
  // git and python3 are both absent; if preflight ran first, this would fail
  // on the missing tool instead of on the usage error.
  const result = runDispatch({
    tools: ["codex"],
    args: ["pin", "main"],
  });
  assert.equal(result.status, 2);
  assert.ok(
    result.stderr.includes(
      "pin REF must be an exact v-prefixed SemVer tag or full 40-hex commit",
    ),
  );
});

// --- inventory items 38-40: commands that need no git -----------------------

// The `NO_GIT_CASES` table and its loop stood here. `track-latest` (formerly
// item 38) and `unpin` (formerly item 39) left it as each went in-process;
// `uninstall` (formerly item 40) — its last entry — left the same way at slice
// 4b's flip, so the table and its loop are deleted rather than left with zero
// entries, for the same reason `NO_CODEX_CASES` was. See the retirement notes
// for items 38, 39 and 40 in tests/migration-inventory/bin-dispatch.md and the
// dedicated cases just below.

// Item 40's successor. `uninstall`'s shell contract was that preflight does not
// require `git` for it, observed through a dispatch. In-process there is no
// dispatch, and the command cannot succeed here either — the `exit 0` `codex`
// stub answers no listing, so `runUninstall` fails closed — so the surviving
// contract is the one item 40 actually protected: preflight admits the command
// with `git` absent, and no script is spawned.
void test("`uninstall` runs in-process with git absent from PATH", () => {
  const result = runDispatch({
    tools: ["python3", "codex"],
    args: ["uninstall"],
  });
  assert.ok(
    !result.stderr.includes("required command not found: git"),
    `preflight must not require git for uninstall: ${result.stderr}`,
  );
});

void test("`track-latest` succeeds in-process with git absent from PATH", () => {
  const result = runDispatch({
    tools: ["python3", "codex"],
    args: ["track-latest"],
  });
  assert.equal(result.status, 0);
});

void test("`unpin` succeeds in-process with git absent from PATH", () => {
  const result = runDispatch({
    tools: ["python3", "codex"],
    args: ["unpin"],
  });
  assert.equal(result.status, 0);
});

// --- inventory item 41: unpin needs no shell, python, codex, or git ---------
//
// unpin's in-process flip (PR 11.5) made every one of these properties true
// at once, since preflight's commandRequirements (src/cli.ts:209) no longer
// discovers a shell for it either. The two cases below cover the property
// item 41 actually protects — success —
// plus a new sibling for `sh` absent, which was previously unwriteable
// through this fixture (`sh` was unconditionally on PATH).

void test("`unpin` succeeds in-process with python3 absent from PATH", () => {
  const result = runDispatch({
    tools: ["git", "codex"],
    args: ["unpin"],
  });
  assert.equal(result.status, 0);
});

void test("`unpin` succeeds in-process with no POSIX shell on PATH", () => {
  const result = runDispatch({
    tools: ["git", "python3", "codex"],
    args: ["unpin"],
    omitShell: true,
  });
  assert.equal(result.status, 0);
});

// `track-latest` never required `sh` (spawn dispatch required it for every
// command uniformly), but it did require `python3` before this flip — the
// shell's `spw_require_command python3` at scripts/track-latest:11. Neither
// property has any shell counterpart, unlike unpin's analogous cases above:
// there was never a shell driver in which `track-latest` could run without
// `python3` at all. Both tools are checked absent together in one case
// rather than split like unpin's, since the combination is what the flip
// newly enables and no numbered inventory item claims either half alone.
void test("`track-latest` succeeds in-process with python3 and no POSIX shell on PATH", () => {
  const result = runDispatch({
    tools: ["git", "codex"],
    args: ["track-latest"],
    omitShell: true,
  });
  assert.equal(result.status, 0);
});

// New (PR 11.5, Task 7). `pin`, unlike `track-latest`/`unpin`, still requires
// `git` after its in-process flip — its own resolution shells out to it —
// so it has no analogue of the two "needs no git" cases above. It does drop
// `python3` (`COMMAND_REQUIREMENTS.pin` moves from `["git", "python3"]` to
// `["git"]`), which is a wholly new property: the shell's `scripts/pin`
// genuinely required `python3` (`spw_require_command python3`,
// `scripts/pin:17`), so no shell counterpart to "succeeds with `python3`
// absent" ever existed for `pin`. This needs real git resolution to succeed
// (`pinUpstream: true` composes a real `git` and upstream onto `fakeBin`
// alongside `tools`, unlike every other case in this file), and, unlike
// `track-latest`'s combined case above, is kept as its own case so it
// actually discriminates `python3`'s absence: `codex` stays present here,
// and the sibling case below flips which of the two is absent.
void test("`pin` succeeds in-process with python3 absent from PATH", () => {
  const result = runDispatch({
    tools: ["codex"],
    args: ["pin", "v1.0.0"],
    pinUpstream: true,
  });
  assert.equal(result.status, 0);
});

// New (PR 11.5, Task 7). No POSIX shell counterpart exists in the shell
// driver for `pin` either — it required `sh` unconditionally, same as every
// other spawn-dispatched command. `python3` stays present here so this case
// discriminates `sh`'s absence specifically, not the combination.
void test("`pin` succeeds in-process with no POSIX shell on PATH", () => {
  const result = runDispatch({
    tools: ["python3", "codex"],
    args: ["pin", "v1.0.0"],
    pinUpstream: true,
    omitShell: true,
  });
  assert.equal(result.status, 0);
});

// --- inventory items 42-47: codex required for probe and install ------------

// NOT a vehicle: `probe` is the subject here. `COMMAND_REQUIREMENTS.probe`
// keeps `codex` after slice 2's in-process flip (only `python3` leaves), and
// this is the end-to-end net for that row. The per-case `scripts` override the
// shell mirrored here went away with the flip — probe no longer reaches any
// script, so a stub for one could no longer observe relevant behavior.
void test("missing codex blocks `probe` before dispatch and names the tool", () => {
  const result = runDispatch({
    tools: ["git", "python3"],
    args: ["probe"],
  });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("required command not found: codex"));
});

void test("missing codex blocks `install` before dispatch and names the tool", () => {
  const result = runDispatch({
    tools: ["git", "python3"],
    args: ["install"],
  });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("required command not found: codex"));
});

// --- prepare's conditional python3 requirement -------------------------------
// The accessor is unit-tested in units.test.js; these prove preflight reads it.
// Without them, reverting preflight to the static COMMAND_REQUIREMENTS table is
// green everywhere and a configured validator fails late, inside runValidator,
// after the clone and the build (PR 11.5 slice 3, D5).
void test("`prepare` does not require python3 when no validator is configured", () => {
  // The exact status and stderr are asserted, not just the diagnostic's
  // absence, because an absence alone is satisfied by a preflight rejection
  // on some other tool, which is the regression this case exists to catch.
  const result = runDispatch({ tools: ["git", "codex"], args: ["prepare"] });
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "error: no stable semver tag found for latest-release\n",
  );
});

void test("`prepare` requires python3 once SUPERPOWERS_VALIDATOR names one", () => {
  const result = runDispatch({
    tools: ["git", "codex"],
    args: ["prepare"],
    env: { SUPERPOWERS_VALIDATOR: "/nonexistent/validator.py" },
  });
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "error: required command not found: python3 — install python3 and re-run\n",
  );
});

// --- inventory items 48-51: commands that need no codex ----------------------

// A `NO_CODEX_CASES` table and its `for` loop used to stand here. `pin`
// (formerly item 48), `track-latest` (formerly item 49), and `unpin`
// (formerly item 50) left it as each went in-process, and `prepare` (formerly
// item 51) — its last entry — left the same way at slice 3.4. The
// table and its loop are deleted rather than left with zero entries, because a
// `for` over `[]` reports success without asserting anything. See the
// retirement notes for items 48, 49, 50, and 51 in
// tests/migration-inventory/bin-dispatch.md; the four standalone cases below
// carry the analogous in-process properties.
void test("`prepare` runs in-process with codex absent from PATH", () => {
  // Item 51's shell contract was that preflight does not require Codex for
  // prepare, observed through a dispatch. In-process there is no dispatch, so
  // the surviving contract is: preflight admits the command, and no script is
  // spawned.
  // The exact status and stderr are asserted, not just the diagnostic's
  // absence, because an absence alone is satisfied by a preflight rejection
  // on some other tool, which is the regression this case exists to catch.
  const result = runDispatch({ tools: ["git", "python3"], args: ["prepare"] });
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "error: no stable semver tag found for latest-release\n",
  );
});

void test("`track-latest` succeeds in-process with codex absent from PATH", () => {
  const result = runDispatch({
    tools: ["git", "python3"],
    args: ["track-latest"],
  });
  assert.equal(result.status, 0);
});

void test("`unpin` succeeds in-process with codex absent from PATH", () => {
  const result = runDispatch({ tools: ["git", "python3"], args: ["unpin"] });
  assert.equal(result.status, 0);
});

void test("`pin` succeeds in-process with codex absent from PATH", () => {
  const result = runDispatch({
    tools: ["python3"],
    args: ["pin", "v1.0.0"],
    pinUpstream: true,
  });
  assert.equal(result.status, 0);
});

// --- matrix row 13: the pin fixture's git sits behind one egress refusal ---

void test("the pin dispatch fixture refuses a network git remote before git runs", () => {
  // Matrix row 13. Asserted through runDispatch, not against a standalone
  // shim: before consolidation this fixture symlinked the real git straight
  // into the case bin, and a test that exercised only the shim would stay
  // green if that symlink came back.
  //
  // The sentinel is what makes the refusal observable. A non-zero status alone
  // proves nothing — a failing git produces one too. An EMPTY sentinel proves
  // the shim refused BEFORE anything reached git.
  const refused = runDispatch({
    tools: [],
    pinUpstream: true,
    gitSentinel: true,
    args: ["pin", "v1.0.0"],
    env: { SUPERPOWERS_UPSTREAM_URL: "https://example.invalid/upstream" },
  });
  assert.match(refused.stderr, /sandbox refuses network git remote/);
  // Reverting the fixture's adoption (a symlink to REAL_GIT instead of the
  // shim) does not turn the sentinel below non-empty: the recording stub is
  // off PATH entirely in that case, so git still runs but against a real
  // network target, which fails with git's own DNS error rather than the
  // shim's refusal text. It is the stderr match above that goes red under
  // that mutation, not the emptiness check below — see the mutation proof
  // in the task report. That check still matters: it is what distinguishes
  // "the shim refused before git ran" from "something else made git fail
  // first".
  assert.ok(existsSync(refused.gitSentinel), "the sentinel was never created");
  assert.equal(
    readFileSync(refused.gitSentinel, "utf8").trim().length > 0,
    false,
    "git ran despite the egress refusal",
  );

  // The positive control. Without it the case above is satisfied by a shim
  // that refuses everything, which would break every real pin case while this
  // test stayed green.
  const allowed = runDispatch({
    tools: [],
    pinUpstream: true,
    gitSentinel: true,
    args: ["pin", "v1.0.0"],
  });
  assert.equal(allowed.status, 0);
  assert.match(
    readFileSync(allowed.gitSentinel, "utf8"),
    /ls-remote|rev-parse|clone|tag/,
    "the local-upstream path did not reach git at all",
  );
});

// --- inventory items 52-53: missing script file ------------------------------
//
// RETIRED at the gap (PR 11.5 slice 4b, Task 8). The case removed
// `scripts/uninstall` from a case-local package root and asserted the bin
// reported `missing script` and exited 1. `main` no longer looks for a
// `scripts/<command>` file for any command — the `existsSync` check and the
// diagnostic it guarded are deleted from src/cli.ts with the spawn path — so
// the condition cannot occur in either direction. There is no successor: a
// missing command module is now an ESM import failure at load, which
// `bin/superpowers-manager.js` already reports through the two dist-integrity
// cases at the top of this file. The unused `missingScripts` `runDispatch`
// option was deleted in 4c with the `scripts/` fixture tree itself.

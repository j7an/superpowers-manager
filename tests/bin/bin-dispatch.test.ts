// Command-dispatch tests.
//
// Every case names the tools present on its PATH at the assertion. The shell
// mutated one shared fakebin in place and restored it. The successor block
// carries the three git-absent cases.
// That is the isolation-sensitive class this port exists to make
// visible.

import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { makePackageRoot, runDispatch } from "./dispatch-fixture.ts";

const ALL_TOOLS = ["git", "python3", "codex"];

// --- an unbuilt checkout ----------------------------------------------------

void test("native checkout works without dist", () => {
  const root = makePackageRoot("real");
  assert.equal(existsSync(join(root, "dist")), false);
  const result = runDispatch({
    tools: ALL_TOOLS,
    args: ["--version"],
    packageRoot: root,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "9.9.9-test");
  assert.equal(result.stderr, "");
  assert.equal(existsSync(join(root, "dist")), false);
});

// --- a present module that fails during import ------------------------------

void test("a source module that throws keeps its real error and is not relabelled", () => {
  const result = runDispatch({
    tools: ALL_TOOLS,
    args: ["--version"],
    packageRoot: makePackageRoot("throwing"),
  });
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes("synthetic source import failure"));
  assert.doesNotMatch(result.stderr, /dist\/ not built|pnpm run build|prepack/);
});

// --- routing ----------------------------------------------------------------

// The `ROUTING_CASES` table and its loop stood here until PR 11.5 slice 4b
// (Task 8) flipped the last three spawned commands in-process. `probe`
// `probe`, `prepare`, `pin`, `track-latest`, and `unpin` had already left it
// one flip at a time; `install`, `uninstall`, and `update` leave now, emptying
// it. The table and its loop are deleted
// rather than left with zero entries, because a `for` over `[]` reports success
// without asserting anything — the same reasoning that deleted `NO_CODEX_CASES`
// at slice 3.4. `SPAWN_COMMANDS`, which sized the table from production, is
// deleted from tests/bin/dispatch-fixture.js with it: at 8/8 in-process the
// subset is permanently empty. The dedicated in-process routing cases are below.

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
// the fixture itself is residue, not coverage.

// --- unknown subcommand -----------------------------------------------------

void test("an unknown subcommand fails with usage", () => {
  const result = runDispatch({ tools: ALL_TOOLS, args: ["bogus"] });
  assert.equal(result.status, 2);
  assert.ok(result.stderr.includes("unknown subcommand: bogus"));
  assert.ok(result.stderr.includes("usage:"));
});

// --- a stray flag must not fall through to update ---------------------------

void test("a stray flag fails with usage", () => {
  const result = runDispatch({ tools: ALL_TOOLS, args: ["--porcelain"] });
  assert.equal(result.status, 2);
  assert.ok(result.stderr.includes("unknown subcommand: --porcelain"));
  assert.ok(result.stderr.includes("usage:"));
});

// --- --help and --version ---------------------------------------------------

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

// --- exit-code propagation --------------------------------------------------
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

// --- env passthrough --------------------------------------------------------
//
// RETIRED at the gap (PR 11.5 slice 4b, Task 8). The case asserted that
// SUPERPOWERS_REF and SUPERPOWERS_VALIDATOR reach `scripts/update`'s
// environment. `update` is
// in-process, so no environment is handed to a child at all: the command reads
// `ctx.env`, which is `process.env` itself (src/cli.ts's single CommandContext
// construction site). There is no "passthrough" left to break. The surviving
// property — that a SUPERPOWERS_* variable actually changes what the command
// does — is asserted directly by the `prepare` retirement case below and, for
// the full ten-variable set, by tests/baseline/cli-parity.test.js's
// CLI-ENV-PASSTHROUGH-01.

// --- preflight, git absent --------------------------------------------------

// The substring check became exact at PR 11.5 slice 4b, Task 8, and both
// git cases below carry the change. Before the flip, `install` with `git`
// absent could only fail at preflight, because the command was spawned and the
// spawn never happened. In-process it reaches `gatherProbe`, whose ref
// resolution shells out to `git` and emits its own
// `error: required command not found: git` — no em-dash suffix — so a
// substring check is satisfied by either producer. Measured: with `git`
// removed from `COMMAND_REQUIREMENTS.install` in a mutated `dist/`, the old
// substring form still passed. Preflight's own diagnostic is the contract
// here, so the assertion pins its exact text.
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

// --- invalid pin syntax precedes preflight ---------------------------------

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

// --- commands that need no git ----------------------------------------------

// The `NO_GIT_CASES` table and its loop stood here. Its commands moved
// in-process, so the table and loop are deleted rather than left with zero
// entries, for the same reason `NO_CODEX_CASES` was.

// `uninstall`'s shell contract was that preflight does not
// require `git` for it, observed through a dispatch. In-process there is no
// dispatch, and the command cannot succeed here either — the `exit 0` `codex`
// stub answers no listing, so `runUninstall` fails closed — so the surviving
// contract is: preflight admits the command
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

// --- unpin needs no shell, python, codex, or git ----------------------------
//
// unpin's in-process flip (PR 11.5) made every one of these properties true
// at once, since `COMMAND_REQUIREMENTS.unpin` no longer names a shell
// either. The two cases below cover successful execution plus a new sibling
// for `sh` absent, which was
// previously unwriteable through this fixture (`sh` was unconditionally on
// PATH).

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
// shell's `spw_require_command python3` at `git show 349fe2ed405b371ec2de1347bb3fc50c6bc15dc4:scripts/track-latest:11::spw_require_command`. Neither
// property has any shell counterpart, unlike unpin's analogous cases above:
// there was never a shell driver in which `track-latest` could run without
// `python3` at all. Both tools are checked absent together in one case
// rather than split like unpin's, since the combination is what the flip
// newly enables and no individual case claims either half alone.
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
// `git show 349fe2ed405b371ec2de1347bb3fc50c6bc15dc4:scripts/pin:17::python3`), so no shell counterpart to "succeeds with `python3`
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

// --- codex required for probe and install -----------------------------------

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

void test("`prepare` rejects the retired validator before tool discovery", () => {
  const result = runDispatch({
    tools: ["git", "codex"],
    args: ["prepare"],
    env: { SUPERPOWERS_VALIDATOR: "/nonexistent/validator.py" },
  });
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "error: SUPERPOWERS_VALIDATOR has been removed; unset it and configure SUPERPOWERS_VALIDATOR_EXECUTABLE with an executable validator.\n",
  );
});

// --- commands that need no codex ---------------------------------------------

// A `NO_CODEX_CASES` table and its `for` loop used to stand here. `pin`
// `track-latest`, and `unpin` left it as each went in-process, and `prepare`
// left the same way at slice 3.4. The
// table and its loop are deleted rather than left with zero entries, because a
// `for` over `[]` reports success without asserting anything. See the
// four standalone cases below carry the analogous in-process properties.
void test("`prepare` runs in-process with codex absent from PATH", () => {
  // The shell contract was that preflight does not require Codex for
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

// --- missing script file -----------------------------------------------------
//
// RETIRED at the gap (PR 11.5 slice 4b, Task 8). The case removed
// `scripts/uninstall` from a case-local package root and asserted the bin
// reported `missing script` and exited 1. `main` no longer looks for a
// `scripts/<command>` file for any command — the `existsSync` check and the
// diagnostic it guarded are deleted from src/cli.ts with the spawn path — so
// the condition cannot occur in either direction. There is no successor: a
// missing command module is now an ESM import failure at load, which
// the native source import-failure case at the top of this file exercises
// directly. The unused `missingScripts` `runDispatch`
// option was deleted in 4c with the `scripts/` fixture tree itself.

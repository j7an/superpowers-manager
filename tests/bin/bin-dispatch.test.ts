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

// --- preflight, git absent --------------------------------------------------

// Pin the exact preflight diagnostic: a substring could admit a later failure.
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

// `pin` resolves refs through git, so it still requires git.
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

// Check both absent tools together because this case asserts their joint
// successful execution.
void test("`track-latest` succeeds in-process with python3 and no POSIX shell on PATH", () => {
  const result = runDispatch({
    tools: ["git", "codex"],
    args: ["track-latest"],
    omitShell: true,
  });
  assert.equal(result.status, 0);
});

// This case needs real git resolution and isolates `python3`'s absence.
void test("`pin` succeeds in-process with python3 absent from PATH", () => {
  const result = runDispatch({
    tools: ["codex"],
    args: ["pin", "v1.0.0"],
    pinUpstream: true,
  });
  assert.equal(result.status, 0);
});

// `python3` stays present here so this case discriminates `sh`'s absence.
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

// Probe must fail preflight when Codex is unavailable.
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

void test("`prepare` runs in-process with codex absent from PATH", () => {
  // Preflight admits prepare without Codex; no script is spawned.
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

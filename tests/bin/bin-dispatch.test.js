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

// `track-latest` (formerly item 10), `unpin` (formerly item 11), and `pin`
// (formerly item 9) are no longer in this table: PR 11.5 flipped all three to
// in-process commands (src/cli.ts DISPATCH), so none of them ever reaches its
// `scripts/<name>` and none of them ever logs to the dispatch log. See the
// retirement notes for items 9, 10, and 11 in
// tests/migration-inventory/bin-dispatch.md and the dedicated in-process
// routing cases just below this loop.
/** @type {Array<[string[], string]>} */
const ROUTING_CASES = [
  [["probe", "--porcelain"], "probe --porcelain ref="],
  [["prepare", "--ref", "test"], "prepare --ref test ref="],
  [["install", "--dry-run"], "install --dry-run ref="],
  [["uninstall", "--purge"], "uninstall --purge ref="],
  [[], "update  ref="],
];
assert.equal(
  ROUTING_CASES.length,
  5,
  "ROUTING_CASES lost or gained a case — update tests/migration-inventory/bin-dispatch.md",
);

for (const [args, expected] of ROUTING_CASES) {
  void test(`routing: \`${args.join(" ") || "(bare)"}\` reaches its script with its args`, () => {
    const result = runDispatch({ tools: ALL_TOOLS, args });
    assert.equal(result.status, 0);
    assert.deepEqual(result.log, [expected]);
  });
}

void test("routing: `track-latest` succeeds in-process and never reaches its script", () => {
  const result = runDispatch({ tools: ALL_TOOLS, args: ["track-latest"] });
  assert.equal(result.status, 0);
  // If routing regressed and dispatched scripts/track-latest anyway, the
  // shared loggingStub would have appended a line here.
  assert.deepEqual(result.log, []);
});

void test("routing: `unpin` succeeds in-process and never reaches its script", () => {
  const result = runDispatch({ tools: ALL_TOOLS, args: ["unpin"] });
  assert.equal(result.status, 0);
  // If routing regressed and dispatched scripts/unpin anyway, the shared
  // loggingStub would have appended a line here.
  assert.deepEqual(result.log, []);
});

void test("routing: `pin` succeeds in-process and never reaches its script", () => {
  const result = runDispatch({
    tools: ["python3", "codex"],
    args: ["pin", "v1.0.0"],
    pinUpstream: true,
  });
  assert.equal(result.status, 0);
  // If routing regressed and dispatched scripts/pin anyway, the shared
  // loggingStub would have appended a line here.
  assert.deepEqual(result.log, []);
});

// --- inventory items 15-19: unknown subcommand -----------------------------

void test("an unknown subcommand fails with usage and dispatches nothing", () => {
  const result = runDispatch({ tools: ALL_TOOLS, args: ["bogus"] });
  assert.equal(result.status, 2);
  assert.ok(result.stderr.includes("unknown subcommand: bogus"));
  assert.ok(result.stderr.includes("usage:"));
  assert.deepEqual(result.log, []);
});

// --- inventory items 20-23: a stray flag must not fall through to update ---

void test("a stray flag fails with usage and dispatches nothing", () => {
  const result = runDispatch({ tools: ALL_TOOLS, args: ["--porcelain"] });
  assert.equal(result.status, 2);
  assert.ok(result.stderr.includes("unknown subcommand: --porcelain"));
  assert.ok(result.stderr.includes("usage:"));
  assert.deepEqual(result.log, []);
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

void test("a script's exit code propagates unchanged", () => {
  const result = runDispatch({
    tools: ALL_TOOLS,
    args: ["probe"],
    scripts: { probe: "#!/bin/sh\nexit 42\n" },
  });
  assert.equal(result.status, 42);
});

// --- inventory items 30-31: env passthrough ---------------------------------

void test("SUPERPOWERS_* env vars reach the dispatched script", () => {
  const result = runDispatch({
    tools: ALL_TOOLS,
    args: ["update"],
    env: {
      SUPERPOWERS_REF: "abc123",
      // Opaque passthrough value, never a path this test writes to.
      SUPERPOWERS_VALIDATOR: "/tmp/custom-validator.py",
    },
  });
  assert.equal(result.status, 0);
  assert.deepEqual(result.log, [
    "update  ref=abc123",
    "update validator=/tmp/custom-validator.py",
  ]);
});

// --- inventory items 32-34: preflight, git absent ---------------------------

void test("missing git fails before dispatch and names the tool", () => {
  const result = runDispatch({
    tools: ["python3", "codex"],
    args: ["install"],
  });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("required command not found: git"));
  assert.deepEqual(result.log, []);
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
  assert.ok(result.stderr.includes("required command not found: git"));
  assert.deepEqual(result.log, []);
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
  assert.deepEqual(result.log, []);
});

// --- inventory items 38-40: commands that need no git -----------------------

// `track-latest` (formerly item 38) and `unpin` (formerly item 39) are no
// longer in this table: both are in-process now and never log to the
// dispatch log regardless of `git`'s presence. See the retirement notes for
// items 38 and 39 in tests/migration-inventory/bin-dispatch.md and the
// dedicated cases just below this loop.
/** @type {Array<[string, string]>} */
const NO_GIT_CASES = [["uninstall", "uninstall  ref="]];

for (const [command, expected] of NO_GIT_CASES) {
  void test(`\`${command}\` dispatches with git absent from PATH`, () => {
    const result = runDispatch({
      tools: ["python3", "codex"],
      args: [command],
    });
    assert.equal(result.status, 0);
    assert.deepEqual(result.log, [expected]);
  });
}

void test("`track-latest` succeeds in-process with git absent from PATH", () => {
  const result = runDispatch({
    tools: ["python3", "codex"],
    args: ["track-latest"],
  });
  assert.equal(result.status, 0);
  assert.deepEqual(result.log, []);
});

void test("`unpin` succeeds in-process with git absent from PATH", () => {
  const result = runDispatch({
    tools: ["python3", "codex"],
    args: ["unpin"],
  });
  assert.equal(result.status, 0);
  assert.deepEqual(result.log, []);
});

// --- inventory item 41: unpin needs no shell, python, codex, or git ---------
//
// unpin's in-process flip (PR 11.5) made every one of these properties true
// at once, since DISPATCH-gated preflight (src/cli.ts:243) no longer
// discovers a shell for it either. The two cases below cover the property
// item 41 actually protects — success, not a specific dispatch-log line —
// plus a new sibling for `sh` absent, which was previously unwriteable
// through this fixture (`sh` was unconditionally on PATH).

void test("`unpin` succeeds in-process with python3 absent from PATH", () => {
  const result = runDispatch({
    tools: ["git", "codex"],
    args: ["unpin"],
  });
  assert.equal(result.status, 0);
  assert.deepEqual(result.log, []);
});

void test("`unpin` succeeds in-process with no POSIX shell on PATH", () => {
  const result = runDispatch({
    tools: ["git", "python3", "codex"],
    args: ["unpin"],
    omitShell: true,
  });
  assert.equal(result.status, 0);
  assert.deepEqual(result.log, []);
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
  assert.deepEqual(result.log, []);
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
  assert.deepEqual(result.log, []);
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
  assert.deepEqual(result.log, []);
});

// --- inventory items 42-47: codex required for probe and install ------------

void test("missing codex blocks `probe` before dispatch and names the tool", () => {
  const result = runDispatch({
    tools: ["git", "python3"],
    args: ["probe"],
    // Logs unconditionally if reached, so "did not dispatch" is proven rather
    // than assumed.
    scripts: {
      probe:
        "#!/bin/sh\nprintf 'probe ran\\n' >> \"$SPW_DISPATCH_LOG\"\nexit 0\n",
    },
  });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("required command not found: codex"));
  assert.deepEqual(result.log, []);
});

void test("missing codex blocks `install` before dispatch and names the tool", () => {
  const result = runDispatch({
    tools: ["git", "python3"],
    args: ["install"],
  });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("required command not found: codex"));
  assert.deepEqual(result.log, []);
});

// --- inventory items 48-51: commands that need no codex ----------------------

// `track-latest` (formerly item 49), `unpin` (formerly item 50), and `pin`
// (formerly item 48) are no longer in this table: all three are in-process
// now and never log to the dispatch log regardless of `codex`'s presence.
// See the retirement notes for items 48, 49, and 50 in
// tests/migration-inventory/bin-dispatch.md and the dedicated cases just
// below this loop.
/** @type {Array<[string[], string]>} */
const NO_CODEX_CASES = [[["prepare"], "prepare  ref="]];

for (const [args, expected] of NO_CODEX_CASES) {
  void test(`\`${args.join(" ")}\` dispatches with codex absent from PATH`, () => {
    const result = runDispatch({ tools: ["git", "python3"], args });
    assert.equal(result.status, 0);
    assert.deepEqual(result.log, [expected]);
  });
}

void test("`track-latest` succeeds in-process with codex absent from PATH", () => {
  const result = runDispatch({
    tools: ["git", "python3"],
    args: ["track-latest"],
  });
  assert.equal(result.status, 0);
  assert.deepEqual(result.log, []);
});

void test("`unpin` succeeds in-process with codex absent from PATH", () => {
  const result = runDispatch({ tools: ["git", "python3"], args: ["unpin"] });
  assert.equal(result.status, 0);
  assert.deepEqual(result.log, []);
});

void test("`pin` succeeds in-process with codex absent from PATH", () => {
  const result = runDispatch({
    tools: ["python3"],
    args: ["pin", "v1.0.0"],
    pinUpstream: true,
  });
  assert.equal(result.status, 0);
  assert.deepEqual(result.log, []);
});

// --- inventory items 52-53: missing script file ------------------------------

void test("a missing script file produces a diagnostic and a non-zero exit", () => {
  const result = runDispatch({
    tools: ALL_TOOLS,
    args: ["uninstall"],
    missingScripts: ["uninstall"],
  });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("missing script"));
});

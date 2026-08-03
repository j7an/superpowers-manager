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

/** @type {Array<[string[], string]>} */
const ROUTING_CASES = [
  [["probe", "--porcelain"], "probe --porcelain ref="],
  [["prepare", "--ref", "test"], "prepare --ref test ref="],
  [["pin", "v6.1.1"], "pin v6.1.1 ref="],
  [["track-latest"], "track-latest  ref="],
  [["unpin"], "unpin  ref="],
  [["install", "--dry-run"], "install --dry-run ref="],
  [["uninstall", "--purge"], "uninstall --purge ref="],
  [[], "update  ref="],
];
assert.equal(
  ROUTING_CASES.length,
  8,
  "ROUTING_CASES lost or gained a case — update tests/migration-inventory/bin-dispatch.md",
);

for (const [args, expected] of ROUTING_CASES) {
  void test(`routing: \`${args.join(" ") || "(bare)"}\` reaches its script with its args`, () => {
    const result = runDispatch({ tools: ALL_TOOLS, args });
    assert.equal(result.status, 0);
    assert.deepEqual(result.log, [expected]);
  });
}

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

/** @type {Array<[string, string]>} */
const NO_GIT_CASES = [
  ["track-latest", "track-latest  ref="],
  ["unpin", "unpin  ref="],
  ["uninstall", "uninstall  ref="],
];

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

// --- inventory item 41: unpin needs no python --------------------------------

void test("`unpin` dispatches with python3 absent from PATH", () => {
  const result = runDispatch({
    tools: ["git", "codex"],
    args: ["unpin"],
  });
  assert.equal(result.status, 0);
  assert.deepEqual(result.log, ["unpin  ref="]);
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

/** @type {Array<[string[], string]>} */
const NO_CODEX_CASES = [
  [["pin", "v6.1.1"], "pin v6.1.1 ref="],
  [["track-latest"], "track-latest  ref="],
  [["unpin"], "unpin  ref="],
  [["prepare"], "prepare  ref="],
];

for (const [args, expected] of NO_CODEX_CASES) {
  void test(`\`${args.join(" ")}\` dispatches with codex absent from PATH`, () => {
    const result = runDispatch({ tools: ["git", "python3"], args });
    assert.equal(result.status, 0);
    assert.deepEqual(result.log, [expected]);
  });
}

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

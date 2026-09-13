import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  capture,
  observingCoordinator,
  operationNames,
  scriptedAdapter,
  successfulNonzeroResult,
} from "../lib/command-doubles.ts";

import { runUninstall } from "../../src/commands/uninstall.ts";
import { successResult, failureResult } from "../../src/adapter-result.ts";
import { workspaceRemovalFailure } from "../../src/workspace.ts";
import { codexOwnershipInspection } from "../../src/harnesses/codex/lifecycle.ts";

function ownership(identityState: string, plugin = false, marketplace = false) {
  return codexOwnershipInspection(
    identityState,
    { pluginPresent: plugin, marketplacePresent: marketplace },
    [],
  );
}

void test("a remaining legacy state is REPORTED on stdout, not stderr", async () => {
  // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/lifecycle.sh:75-77::remains` has no `>&2`, unlike :53. The retired
  // shell driver witnessed the split through its capture form; LegacyVerdict
  // carries no channel by design, so this is the only witness after 4a.
  // Spec §6.2.3 item 2.
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", ownership("both"), []),
    successResult("uninstall", {}, []),
    successResult("inspect", ownership("both"), []),
  ]);
  const status = await runUninstall([], {
    root: "/nowhere",
    env: { HOME: "/nowhere" },
    stdout: out.stream,
    stderr: err.stream,
    options: { harness: "codex", allowExperimental: false },
    coordination: observingCoordinator(),
    adapter,
  });
  assert.equal(status, 0);
  const stdout = out.text();
  assert.ok(
    stdout.includes(
      "Legacy superpowers-wrapper Codex state remains installed.\n",
    ),
    `report line missing from stdout:\n${stdout}`,
  );
  assert.ok(
    stdout.includes("Run: npx superpowers-wrapper@0.1.1 uninstall\n"),
    `report line 2 missing from stdout:\n${stdout}`,
  );
  // The converse is the half that fails silently: a caller that wrote both
  // verdicts to stderr would satisfy a stdout-only assertion nowhere and a
  // "contains" assertion on the joined output everywhere.
  assert.equal(
    err.text().includes("remains installed"),
    false,
    "the report must NOT reach stderr",
  );
  assert.equal(calls.length, 5);
});

void test("the two closing lines port verbatim except for the prepare invocation", async () => {
  const out = capture();
  const err = capture();
  const { adapter } = scriptedAdapter([
    successResult("inspect", ownership("neither"), []),
    successResult("uninstall", {}, []),
    successResult("inspect", ownership("neither"), []),
  ]);
  const status = await runUninstall([], {
    root: "/nowhere",
    env: { HOME: "/nowhere" },
    stdout: out.stream,
    stderr: err.stream,
    options: { harness: "codex", allowExperimental: false },
    coordination: observingCoordinator(),
    adapter,
  });
  assert.equal(status, 0);
  assert.equal(
    out.text(),
    "uninstall complete\n" +
      "note: local generated artifacts under plugins/superpowers/ and " +
      ".cache/upstream/ were left in place; remove them manually or " +
      "regenerate with npx superpowers-manager prepare.\n",
  );
  assert.equal(err.text(), "");
});

void test("the adapter calls are issued in order with the FIRST inspection's read presence booleans", async () => {
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", ownership("neither", true, false), []),
    successResult("uninstall", {}, []),
    successResult("inspect", ownership("neither"), []),
  ]);
  const status = await runUninstall([], {
    root: "/nowhere",
    env: { HOME: "/nowhere" },
    stdout: out.stream,
    stderr: err.stream,
    options: { harness: "codex", allowExperimental: false },
    coordination: observingCoordinator(),
    adapter,
  });
  assert.equal(status, 0);
  assert.deepEqual(operationNames(calls), [
    "preparation-location",
    "mutation-roots",
    "inspect-ownership",
    "remove",
    "inspect-ownership",
  ]);
  assert.deepEqual(calls[3]?.input, {
    pluginPresent: true,
    marketplacePresent: false,
  });
});

void test("a plugin resource still installed after removal is a distinct, named failure", async () => {
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", ownership("neither"), []),
    successResult("uninstall", {}, []),
    successResult("inspect", ownership("neither", true, false), []),
  ]);
  const status = await runUninstall([], {
    root: "/nowhere",
    env: { HOME: "/nowhere" },
    stdout: out.stream,
    stderr: err.stream,
    options: { harness: "codex", allowExperimental: false },
    coordination: observingCoordinator(),
    adapter,
  });
  assert.equal(status, 1);
  assert.equal(
    err.text(),
    "error: owned plugin resource is still installed after removal\n",
  );
  assert.equal(out.text(), "");
  assert.equal(calls.length, 5);
});

void test("an unrecognised identity state after removal is a distinct, named failure", async () => {
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", ownership("neither"), []),
    successResult("uninstall", {}, []),
    successResult("inspect", ownership("wat"), []),
  ]);
  const status = await runUninstall([], {
    root: "/nowhere",
    env: { HOME: "/nowhere" },
    stdout: out.stream,
    stderr: err.stream,
    options: { harness: "codex", allowExperimental: false },
    coordination: observingCoordinator(),
    adapter,
  });
  assert.equal(status, 1);
  assert.equal(err.text(), "error: unknown adapter identity state: wat\n");
  assert.equal(out.text(), "");
  assert.equal(calls.length, 5);
});

void test("stage 1 (inspect ownership) failure stops with ONLY the replayed diagnostic", async () => {
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    failureResult(
      "inspect",
      "E_ADAPTER",
      "cannot inspect ownership",
      ["check codex is installed"],
      [],
    ),
  ]);
  const status = await runUninstall([], {
    root: "/nowhere",
    env: { HOME: "/nowhere" },
    stdout: out.stream,
    stderr: err.stream,
    options: { harness: "codex", allowExperimental: false },
    coordination: observingCoordinator(),
    adapter,
  });
  assert.equal(status, 1);
  // Clause 2: replayOutcome already wrote the adapter's own error:/hint:
  // lines. NO second, command-authored line may follow them.
  assert.equal(
    err.text(),
    "error: cannot inspect ownership\nhint: check codex is installed\n",
  );
  assert.equal(out.text(), "");
  assert.deepEqual(operationNames(calls), [
    "preparation-location",
    "mutation-roots",
    "inspect-ownership",
  ]);
});

void test("stage 1 clause 3: outcome.ok but status !== 0 gets its own hand-written message", async () => {
  // Spec §4.2a clause 3. successResult/failureResult cannot express this
  // input -- successResult always pairs ok:true with status:0, failureResult
  // always pairs ok:false with status:1 -- so the outcome is hand-built here
  // to reach the one combination invoke()'s gate must distinguish from both
  // clause 2 (!outcome.ok, replay-only) and clause 4 (a malformed but
  // successful result).
  const out = capture();
  const err = capture();

  const { adapter: scripted, calls } = scriptedAdapter([]);
  const adapter = {
    ...scripted,
    async inspectOwnership() {
      calls.push({ operation: "inspect-ownership" });
      return successfulNonzeroResult("inspect", {
        installEligibility: { kind: "allowed" as const },
        removalInput: { pluginPresent: false, marketplacePresent: false },
        removalVerification: { kind: "allowed" as const },
        postRemovalOutput: { stdout: [], stderr: [] },
        presentationValue: "manager",
      });
    },
  };
  const status = await runUninstall([], {
    root: "/nowhere",
    env: { HOME: "/nowhere" },
    stdout: out.stream,
    stderr: err.stream,
    options: { harness: "codex", allowExperimental: false },
    coordination: observingCoordinator(),
    adapter,
  });
  assert.equal(status, 1);
  assert.equal(
    err.text(),
    "error: adapter reported a failure status for inspect --view ownership\n",
  );
  assert.equal(out.text(), "");
  assert.deepEqual(operationNames(calls), [
    "preparation-location",
    "mutation-roots",
    "inspect-ownership",
  ]);
});

void test("stage 2 (uninstall) failure stops before the post-removal inspection", async () => {
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", ownership("neither", true, true), []),
    failureResult(
      "uninstall",
      "E_ADAPTER",
      "cannot remove owned resources",
      [],
      [],
    ),
  ]);
  const status = await runUninstall([], {
    root: "/nowhere",
    env: { HOME: "/nowhere" },
    stdout: out.stream,
    stderr: err.stream,
    options: { harness: "codex", allowExperimental: false },
    coordination: observingCoordinator(),
    adapter,
  });
  assert.equal(status, 1);
  assert.equal(err.text(), "error: cannot remove owned resources\n");
  assert.equal(out.text(), "");
  assert.deepEqual(operationNames(calls), [
    "preparation-location",
    "mutation-roots",
    "inspect-ownership",
    "remove",
  ]);
  assert.deepEqual(calls[3]?.input, {
    pluginPresent: true,
    marketplacePresent: true,
  });
});

void test("stage 3 (post-removal inspect ownership) failure stops with ONLY the replayed diagnostic", async () => {
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", ownership("neither"), []),
    successResult("uninstall", {}, []),
    failureResult(
      "inspect",
      "E_ADAPTER",
      "cannot inspect ownership after removal",
      [],
      [],
    ),
  ]);
  const status = await runUninstall([], {
    root: "/nowhere",
    env: { HOME: "/nowhere" },
    stdout: out.stream,
    stderr: err.stream,
    options: { harness: "codex", allowExperimental: false },
    coordination: observingCoordinator(),
    adapter,
  });
  assert.equal(status, 1);
  assert.equal(err.text(), "error: cannot inspect ownership after removal\n");
  assert.equal(out.text(), "");
  assert.deepEqual(operationNames(calls), [
    "preparation-location",
    "mutation-roots",
    "inspect-ownership",
    "remove",
    "inspect-ownership",
  ]);
});

void test("argv is ignored by src/commands/uninstall.ts", async () => {
  const out = capture();
  const err = capture();
  const { adapter } = scriptedAdapter([
    successResult("inspect", ownership("neither"), []),
    successResult("uninstall", {}, []),
    successResult("inspect", ownership("neither"), []),
  ]);
  const status = await runUninstall(["--bogus", "extra"], {
    root: "/nowhere",
    env: { HOME: "/nowhere" },
    stdout: out.stream,
    stderr: err.stream,
    options: { harness: "codex", allowExperimental: false },
    coordination: observingCoordinator(),
    adapter,
  });
  assert.equal(status, 0);
});

// --- Post-success withWorkspace cleanup failure (onCleanupFailure) ---
//
// `src/workspace.ts:134-141::await remove`: with `onCleanupFailure` supplied and the callback
// not failed, a post-success cleanup failure is suppressed and the callback's
// return value survives. uninstall.ts passes it, so the UninstallOutcome the
// callback computed still reaches the operator, and the leaked workspace is
// reported on stderr with exit 1 on top of it.
//
// This is what scripts/uninstall did. It echoed "uninstall complete" and the
// note at :34-35 before the exit trap ran, and spw_cleanup_workspace_trap
// (`git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/common.sh:25-30::spw_cleanup_workspace_trap(`) is `rm -rf "$path" || :`, so the removal
// failure never suppressed either line. An earlier port dropped both, frozen
// by this test asserting stdout was the first inspection's note alone; the
// shell is the authority and that assertion was pinning the defect.
//
// Outcomes collected before the cleanup failure still replay, which is the
// property this case originally existed to hold (DIAG-ADAPTER-01).

void test("a post-success withWorkspace cleanup failure keeps the computed outcome and every outcome before it", async () => {
  if (process.getuid?.() === 0) return; // chmod does not gate root
  const parent = mkdtempSync(join(tmpdir(), "spw-uninstall-workspace-"));
  try {
    const out = capture();
    const err = capture();
    const responses = [
      successResult("inspect", ownership("neither"), [
        { channel: "stdout", text: "note: first inspection ran" },
      ]),
      successResult("uninstall", {}, []),
      successResult("inspect", ownership("neither"), []),
    ];
    const { adapter: scripted, calls } = scriptedAdapter(responses);
    // No test double for the filesystem: the THIRD (and final) call chmods
    // the workspace's own PARENT directory read-only, after the first two
    // calls have already pushed their outcomes. By the time
    // withWorkspace's post-callback `rm(workspace, ...)` runs, the parent
    // cannot be written to, so the removal genuinely fails with EACCES/EPERM
    // -- a real filesystem failure, not a mocked one.
    const adapter = {
      ...scripted,
      async inspectOwnership(
        adapterCtx: Parameters<typeof scripted.inspectOwnership>[0],
      ) {
        const result = await scripted.inspectOwnership(adapterCtx);
        if (calls.length === 5) chmodSync(parent, 0o500);
        return result;
      },
    };
    const status = await runUninstall([], {
      root: "/nowhere",
      env: { HOME: "/nowhere", TMPDIR: parent },
      stdout: out.stream,
      stderr: err.stream,
      options: { harness: "codex", allowExperimental: false },
      coordination: observingCoordinator(),
      adapter,
    });
    assert.equal(status, 1);
    assert.equal(calls.length, 5);
    // The outcome collected from the FIRST call -- well before the cleanup
    // failure -- still reaches stdout, AND the domain outcome survives it,
    // exactly as `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/uninstall:34-35::complete` behaved. Dropping either half is a
    // divergence from the shell.
    assert.equal(
      out.text(),
      "note: first inspection ran\n" +
        "uninstall complete\n" +
        "note: local generated artifacts under plugins/superpowers/ and " +
        ".cache/upstream/ were left in place; remove them manually or " +
        "regenerate with npx superpowers-manager prepare.\n",
    );
    const entries = readdirSync(parent);
    assert.equal(
      entries.length,
      1,
      `expected exactly one leftover workspace directory in ${parent}, found: ${entries.join(", ")}`,
    );
    const workspace = join(parent, entries[0]);
    assert.equal(err.text(), `error: ${workspaceRemovalFailure(workspace)}\n`);
  } finally {
    try {
      chmodSync(parent, 0o700);
    } catch {
      // Best-effort: the real cleanup below tolerates a missing or
      // already-writable directory either way.
    }
    rmSync(parent, { recursive: true, force: true });
  }
});

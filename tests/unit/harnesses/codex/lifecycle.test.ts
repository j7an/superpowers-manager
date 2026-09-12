#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import {
  codexControlInspection,
  codexOwnershipInspection,
  requireNoLegacyState,
  reportLegacyState,
  requireManagedUpdateControl,
} from "../../../../src/harnesses/codex/lifecycle.ts";
import {
  codexInstallReceipt,
  codexPresentation,
} from "../../../../src/harnesses/codex/presentation.ts";

// Frozen operator text. `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/lifecycle.sh:50-53::'Legacy superpowers-wrapper Codex state is` and :75-77 print these
// verbatim; tests/test_codex_state_units.sh matched them with `grep -Fxq`, so
// they are whole-line exact and this suite keeps them that way.
const BLOCKED_LINES = [
  "Legacy superpowers-wrapper Codex state is installed.",
  "Run: npx superpowers-wrapper@0.1.1 uninstall",
  "Then run: npx superpowers-manager install",
];
const REPORT_LINES = [
  "Legacy superpowers-wrapper Codex state remains installed.",
  "Run: npx superpowers-wrapper@0.1.1 uninstall",
];

void test("typed Codex policy builders retain ownership and control decisions", () => {
  const clean = codexOwnershipInspection(
    "manager",
    { pluginPresent: true, marketplacePresent: true },
    [],
  );
  assert.equal(clean.installEligibility.kind, "allowed");
  assert.equal(clean.removalVerification.kind, "blocked");
  assert.deepEqual(clean.removalInput, {
    pluginPresent: true,
    marketplacePresent: true,
  });
  const conflict = codexOwnershipInspection(
    "manager",
    { pluginPresent: true, marketplacePresent: true },
    ["active Codex plugin superpowers@another-provider"],
  );
  assert.equal(conflict.installEligibility.kind, "blocked");
  assert.equal(
    codexOwnershipInspection(
      "legacy",
      { pluginPresent: false, marketplacePresent: false },
      [],
    ).installEligibility.kind,
    "blocked",
  );
  assert.equal(
    codexControlInspection("managed").mutationEligibility.kind,
    "allowed",
  );
  assert.equal(
    codexControlInspection("unsupported").mutationEligibility.kind,
    "blocked",
  );
  assert.equal(
    codexControlInspection("unrecognized").mutationEligibility.kind,
    "blocked",
  );
});

void test("receipt construction omits unsafe verification hints", () => {
  for (const hint of ["unsafe\nline", "\u001b[31munsafe", "\ud800"]) {
    const receipt = codexInstallReceipt(hint, hint);
    assert.equal(receipt.missingVerificationOutput.stderr.length, 1);
    assert.equal(receipt.mismatchVerificationOutput.stderr.length, 1);
  }
  const receipt = codexInstallReceipt(
    "verify installation",
    "retry installation",
  );
  assert.equal(
    receipt.missingVerificationOutput.stderr.at(-1),
    "hint: verify installation",
  );
  assert.equal(
    receipt.mismatchVerificationOutput.stderr.at(-1),
    "hint: retry installation",
  );
});

void test("requireNoLegacyState admits the two clean identity states", () => {
  for (const state of ["neither", "manager"]) {
    assert.deepEqual(requireNoLegacyState(state), { kind: "ok" }, state);
  }
});

void test("requireNoLegacyState blocks legacy and both with the frozen text", () => {
  for (const state of ["legacy", "both"]) {
    assert.deepEqual(
      requireNoLegacyState(state),
      { kind: "blocked", lines: BLOCKED_LINES },
      state,
    );
  }
});

void test("reportLegacyState is silent for the two clean identity states", () => {
  for (const state of ["neither", "manager"]) {
    assert.deepEqual(reportLegacyState(state), { kind: "ok" }, state);
  }
});

void test("reportLegacyState reports legacy and both with the frozen text", () => {
  for (const state of ["legacy", "both"]) {
    assert.deepEqual(
      reportLegacyState(state),
      { kind: "report", lines: REPORT_LINES },
      state,
    );
  }
});

// PORT-ONLY. tests/test_codex_state_units.sh never exercised the `*)` arms of
// either case statement (`git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/lifecycle.sh:56-58::spw_die "unknown adapter identity state: $identity_state` and :81-83), so the
// spw_die path was unwitnessed on the shell side. Recorded as port-only items
// 1-4 in the historical migration record — the port-only region
// restarts at 1 rather than continuing the mapped region's numbering.
void test("both predicates reject an unrecognised identity state", () => {
  assert.deepEqual(requireNoLegacyState("garbage"), {
    kind: "unknown",
    message: "unknown adapter identity state: garbage",
  });
  assert.deepEqual(reportLegacyState("garbage"), {
    kind: "unknown",
    message: "unknown adapter identity state: garbage",
  });
});

void test("an empty identity state is unrecognised, not clean", () => {
  assert.deepEqual(requireNoLegacyState(""), {
    kind: "unknown",
    message: "unknown adapter identity state: ",
  });
  assert.deepEqual(reportLegacyState(""), {
    kind: "unknown",
    message: "unknown adapter identity state: ",
  });
});

/**
 * Minimal AdapterResult builders. Local to this suite on purpose: importing a
 * production builder would make these tests agree with the code by
 * construction rather than by assertion.
 */
function ok(result: unknown): any {
  return {
    status: 0,
    outcome: {
      operation: "inspect",
      ok: true,
      messages: [],
      result,
      error: null,
    },
  };
}

function failed(): any {
  return {
    status: 1,
    outcome: {
      operation: "inspect",
      ok: false,
      messages: [],
      result: null,
      error: { code: "inspect-failed", message: "boom", hints: [] },
    },
  };
}

void test("requireManagedUpdateControl admits only managed", () => {
  assert.deepEqual(requireManagedUpdateControl("managed"), { ok: true });
});

void test("requireManagedUpdateControl rejects unsupported with its own text", () => {
  assert.deepEqual(requireManagedUpdateControl("unsupported"), {
    ok: false,
    message: "adapter cannot guarantee manager-controlled updates",
  });
});

void test("requireManagedUpdateControl rejects an unrecognised capability", () => {
  assert.deepEqual(requireManagedUpdateControl("weird"), {
    ok: false,
    message: "unknown adapter update-control capability: weird",
  });
});

void test("install verification accepts an exact commit match", () => {
  const desired = "a".repeat(40);
  const receipt = ok(codexInstallReceipt("", ""));
  const inspection = ok({ kind: "current", observedIdentity: desired });
  const output = codexPresentation.renderInstallVerification(
    desired,
    receipt,
    inspection,
  );
  assert.equal(inspection.outcome.ok, true);
  if (!inspection.outcome.ok) assert.fail("expected normalized inspection");
  assert.equal(inspection.outcome.result.kind, "current");
  assert.deepEqual(output.stdout, [
    `desired_commit=${desired}`,
    `installed_commit=${desired}`,
    "manager updated",
  ]);
  assert.deepEqual(output.stderr, []);
});

void test("install verification accepts the seven-character short form", () => {
  // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/status.sh:7::cut` compares against `cut -c 1-7`, and commitMatches
  // in src/status.ts keeps that rule. This case is what pins the two together.
  const desired = "b".repeat(40);
  const receipt = ok(codexInstallReceipt("", ""));
  const inspection = ok({
    kind: "current",
    observedIdentity: desired.slice(0, 7),
  });
  const output = codexPresentation.renderInstallVerification(
    desired,
    receipt,
    inspection,
  );
  assert.equal(inspection.outcome.ok, true);
  if (!inspection.outcome.ok) assert.fail("expected normalized inspection");
  assert.equal(inspection.outcome.result.kind, "current");
  assert.deepEqual(output.stderr, []);
});

void test("install verification reports a failed inspection", () => {
  const desired = "c".repeat(40);
  const receipt = ok(codexInstallReceipt("", ""));
  const inspection = failed();
  const output = codexPresentation.renderInstallVerification(
    desired,
    receipt,
    inspection,
  );
  assert.equal(inspection.outcome.ok, false);
  assert.deepEqual(output.stdout, []);
  assert.deepEqual(output.stderr, [
    "error: installed manager fingerprint inspection failed after install.",
  ]);
});

void test("install verification reports a mismatch and surfaces its hint", () => {
  const desired = "d".repeat(40);
  const receipt = ok(codexInstallReceipt("", "try reinstalling"));
  const inspection = ok({
    kind: "mismatch",
    observedIdentity: "e".repeat(40),
  });
  const output = codexPresentation.renderInstallVerification(
    desired,
    receipt,
    inspection,
  );
  assert.equal(inspection.outcome.ok, true);
  if (!inspection.outcome.ok) assert.fail("expected normalized inspection");
  assert.equal(inspection.outcome.result.kind, "mismatch");
  assert.deepEqual(output.stderr, [
    "error: installed manager fingerprint does not match the prepared plugin after install.",
    "hint: try reinstalling",
  ]);
});

void test("install verification reports an undetectable fingerprint and its own hint", () => {
  // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/lifecycle.sh:108-112::mismatch` chooses between two hint keys on whether
  // the installed commit is empty. A null fingerprint reads as empty, matching
  // the typed installed-state absence contract
  // (`src/harness.ts:58::| { readonly kind: "absent"; readonly observedIdentity: "" }`).
  const desired = "f".repeat(40);
  const receipt = ok(codexInstallReceipt("codex reported nothing", ""));
  const inspection = ok({ kind: "absent", observedIdentity: "" });
  const output = codexPresentation.renderInstallVerification(
    desired,
    receipt,
    inspection,
  );
  assert.equal(inspection.outcome.ok, true);
  if (!inspection.outcome.ok) assert.fail("expected normalized inspection");
  assert.equal(inspection.outcome.result.kind, "absent");
  assert.deepEqual(output.stderr, [
    "error: installed manager fingerprint is not detectable after install.",
    "hint: codex reported nothing",
  ]);
});

void test("install verification omits the hint line when no hint is present", () => {
  const desired = "0".repeat(40);
  const receipt = ok(codexInstallReceipt("", ""));
  const inspection = ok({
    kind: "mismatch",
    observedIdentity: "1".repeat(40),
  });
  const output = codexPresentation.renderInstallVerification(
    desired,
    receipt,
    inspection,
  );
  assert.equal(inspection.outcome.ok, true);
  if (!inspection.outcome.ok) assert.fail("expected normalized inspection");
  assert.equal(inspection.outcome.result.kind, "mismatch");
  assert.equal(output.stderr.length, 1);
});

void test("ADAPTER-TERMINAL-01 install verification omits a hint carrying a terminal control", () => {
  const esc = String.fromCharCode(0x1b);
  const desired = "d".repeat(40);
  const receipt = ok(codexInstallReceipt("", `try ${esc}]0;title`));
  const inspection = ok({
    kind: "mismatch",
    observedIdentity: "e".repeat(40),
  });
  const output = codexPresentation.renderInstallVerification(
    desired,
    receipt,
    inspection,
  );
  assert.equal(inspection.outcome.ok, true);
  if (!inspection.outcome.ok) assert.fail("expected normalized inspection");
  assert.equal(inspection.outcome.result.kind, "mismatch");
  // The error line stands; only the hint line is dropped.
  assert.deepEqual(output.stderr, [
    "error: installed manager fingerprint does not match the prepared plugin after install.",
  ]);
});

void test("ADAPTER-SURROGATE-01 install verification omits a hint carrying a lone surrogate", () => {
  // BOTH halves of the surrogate range, in one test() rather than two:
  // The second value is a row here rather than a case of its own.
  //
  // hasTerminalControl covers 0xd800-0xdfff (`src/adapter-result.ts:199::(code >= 0xd800`).
  // U+D800 alone leaves that clause under-constrained: narrowing it to
  // `code <= 0xdbff` keeps a high-surrogate row green while admitting every
  // low surrogate. 0xdc9b is the value the retiring Python witness drove
  // through verification_hints.missing (`git show 41c99390f51a0cbeb552ab0a0bff26fc1c5c07df:tests/test_adapter_protocol.py:544::udc9b` at
  // fd94d7d).
  //
  // String.fromCharCode, never an inline escape: an escape typed into an
  // editing tool arrives in the file as the raw byte it denotes, and a lone
  // surrogate is not representable as a byte at all.
  for (const code of [0xd800, 0xdc9b]) {
    const lone = String.fromCharCode(code);
    const desired = "f".repeat(40);
    const receipt = ok(codexInstallReceipt(`codex said ${lone}`, ""));
    const inspection = ok({ kind: "absent", observedIdentity: "" });
    const output = codexPresentation.renderInstallVerification(
      desired,
      receipt,
      inspection,
    );
    assert.equal(inspection.outcome.ok, true, code.toString(16));
    if (!inspection.outcome.ok) assert.fail("expected normalized inspection");
    assert.equal(inspection.outcome.result.kind, "absent", code.toString(16));
    assert.deepEqual(
      output.stderr,
      ["error: installed manager fingerprint is not detectable after install."],
      code.toString(16),
    );
  }
});

void test("removal verification accepts both resources absent", () => {
  const normalized = codexOwnershipInspection(
    "manager",
    { pluginPresent: false, marketplacePresent: false },
    [],
  );
  assert.deepEqual(normalized.removalVerification, {
    kind: "allowed",
  });
});

void test("removal verification rejects a surviving plugin", () => {
  const normalized = codexOwnershipInspection(
    "manager",
    { pluginPresent: true, marketplacePresent: false },
    [],
  );
  assert.deepEqual(normalized.removalVerification, {
    kind: "blocked",
    output: {
      stdout: [],
      stderr: ["error: owned plugin resource is still installed after removal"],
    },
  });
});

void test("removal verification rejects a surviving marketplace", () => {
  const normalized = codexOwnershipInspection(
    "manager",
    { pluginPresent: false, marketplacePresent: true },
    [],
  );
  assert.deepEqual(normalized.removalVerification, {
    kind: "blocked",
    output: {
      stdout: [],
      stderr: [
        "error: owned marketplace resource is still registered after removal",
      ],
    },
  });
});

// ADAPTER-UPDATE-CONTROL-01 was owned by tests/test_adapter_protocol.py until
// PR 11.5 slice 5, and its contract SPLITS.
//
// The recognition rule -- only `managed` and `unsupported` are known values,
// and a third is rejected -- survives in-process here.
//
// The reportability half -- that an inspection can emit `unsupported` --
// retires with the transport. src/harnesses/codex/adapter.ts's update-control view returns
// the literal `managed`; the old witness at
// `git show 41c99390f51a0cbeb552ab0a0bff26fc1c5c07df:tests/test_adapter_protocol.sh:102-104::run_adapter update` ran a fixture SHELL adapter emitting
// a canned outcome, and no shell adapters remain. The historical migration
// record instructs slice 5 to port that witness; it cannot be
// ported, because there is nothing in-process that produces the value.

void test("ADAPTER-UPDATE-CONTROL-01 update-control recognizes exactly managed and unsupported and rejects a third value", () => {
  assert.deepEqual(requireManagedUpdateControl("managed"), { ok: true });
  assert.deepEqual(requireManagedUpdateControl("unsupported"), {
    ok: false,
    message: "adapter cannot guarantee manager-controlled updates",
  });
  // A third value is rejected with a DIFFERENT message than `unsupported`.
  // Asserting only `ok: false` would pass if the two collapsed into one
  // branch, which is exactly the closed-enumeration property at stake.
  for (const value of ["", "MANAGED", "unknown", "unsupported "]) {
    assert.deepEqual(
      requireManagedUpdateControl(value),
      {
        ok: false,
        message: `unknown adapter update-control capability: ${value}`,
      },
      value,
    );
  }
});

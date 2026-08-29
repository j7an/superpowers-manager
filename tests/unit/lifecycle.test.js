#!/usr/bin/env node
// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

/** @type {typeof import("../../src/lifecycle.js")} */
const {
  requireNoLegacyState,
  reportLegacyState,
  requireManagedUpdateControl,
  verifyInstalledFingerprint,
  verifyUninstalledResources,
} = await import(new URL("../../dist/lifecycle.js", import.meta.url).href);

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
// 1-4 in tests/migration-inventory/codex-state-units.md — the port-only region
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
 * @param {unknown} result
 * @returns {any}
 */
function ok(result) {
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

/** @returns {any} */
function failed() {
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

void test("verifyInstalledFingerprint accepts an exact commit match", () => {
  const desired = "a".repeat(40);
  const verdict = verifyInstalledFingerprint(
    desired,
    ok({}),
    ok({ view: "fingerprint", fingerprint: desired }),
  );
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.stdout, [
    `desired_commit=${desired}`,
    `installed_commit=${desired}`,
    "manager updated",
  ]);
  assert.deepEqual(verdict.stderr, []);
});

void test("verifyInstalledFingerprint accepts the seven-character short form", () => {
  // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/status.sh:7::cut` compares against `cut -c 1-7`, and commitMatches
  // in src/status.ts keeps that rule. This case is what pins the two together.
  const desired = "b".repeat(40);
  const verdict = verifyInstalledFingerprint(
    desired,
    ok({}),
    ok({ view: "fingerprint", fingerprint: desired.slice(0, 7) }),
  );
  assert.equal(verdict.ok, true);
});

void test("verifyInstalledFingerprint reports a failed inspection", () => {
  const verdict = verifyInstalledFingerprint("c".repeat(40), ok({}), failed());
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.stdout, []);
  assert.deepEqual(verdict.stderr, [
    "error: installed manager fingerprint inspection failed after install.",
  ]);
});

void test("verifyInstalledFingerprint reports a mismatch and surfaces its hint", () => {
  const desired = "d".repeat(40);
  const verdict = verifyInstalledFingerprint(
    desired,
    ok({ verification_hints: { mismatch: "try reinstalling" } }),
    ok({ view: "fingerprint", fingerprint: "e".repeat(40) }),
  );
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.stderr, [
    "error: installed manager fingerprint does not match the prepared plugin after install.",
    "hint: try reinstalling",
  ]);
});

void test("verifyInstalledFingerprint reports an undetectable fingerprint and its own hint", () => {
  // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/lifecycle.sh:108-112::mismatch` chooses between two hint keys on whether
  // the installed commit is empty. A null fingerprint reads as empty, matching
  // the Python reader's behaviour for JSON null (`src/commands/probe.ts:261-267::const value`).
  const verdict = verifyInstalledFingerprint(
    "f".repeat(40),
    ok({ verification_hints: { missing: "codex reported nothing" } }),
    ok({ view: "fingerprint", fingerprint: null }),
  );
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.stderr, [
    "error: installed manager fingerprint is not detectable after install.",
    "hint: codex reported nothing",
  ]);
});

void test("verifyInstalledFingerprint omits the hint line when no hint is present", () => {
  const verdict = verifyInstalledFingerprint(
    "0".repeat(40),
    ok({}),
    ok({ view: "fingerprint", fingerprint: "1".repeat(40) }),
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.stderr.length, 1);
});

void test("ADAPTER-TERMINAL-01 verifyInstalledFingerprint omits a hint carrying a terminal control", () => {
  const esc = String.fromCharCode(0x1b);
  const verdict = verifyInstalledFingerprint(
    "d".repeat(40),
    ok({ verification_hints: { mismatch: `try ${esc}]0;title` } }),
    ok({ view: "fingerprint", fingerprint: "e".repeat(40) }),
  );
  assert.equal(verdict.ok, false);
  // The error line stands; only the hint line is dropped.
  assert.deepEqual(verdict.stderr, [
    "error: installed manager fingerprint does not match the prepared plugin after install.",
  ]);
});

void test("ADAPTER-SURROGATE-01 verifyInstalledFingerprint omits a hint carrying a lone surrogate", () => {
  // BOTH halves of the surrogate range, in one test() rather than two:
  // tests/migration-inventory/codex-state-units.md pins this file at 28 static
  // `test(` call sites, so the second value is a row here rather than a case
  // of its own.
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
    const verdict = verifyInstalledFingerprint(
      "f".repeat(40),
      ok({ verification_hints: { missing: `codex said ${lone}` } }),
      ok({ view: "fingerprint", fingerprint: null }),
    );
    assert.equal(verdict.ok, false, code.toString(16));
    assert.deepEqual(
      verdict.stderr,
      ["error: installed manager fingerprint is not detectable after install."],
      code.toString(16),
    );
  }
});

void test("verifyUninstalledResources accepts both resources absent", () => {
  assert.deepEqual(
    verifyUninstalledResources(
      ok({ resources: { plugin: false, marketplace: false } }),
    ),
    { ok: true },
  );
});

void test("verifyUninstalledResources rejects a surviving plugin", () => {
  assert.deepEqual(
    verifyUninstalledResources(
      ok({ resources: { plugin: true, marketplace: false } }),
    ),
    {
      ok: false,
      message: "owned plugin resource is still installed after removal",
    },
  );
});

void test("verifyUninstalledResources rejects a surviving marketplace", () => {
  assert.deepEqual(
    verifyUninstalledResources(
      ok({ resources: { plugin: false, marketplace: true } }),
    ),
    {
      ok: false,
      message: "owned marketplace resource is still registered after removal",
    },
  );
});

void test("verifyUninstalledResources fails closed on a non-Boolean resource", () => {
  // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/adapter.sh:58-73::spw_adapter_result_boolean` died with `expected Boolean adapter result`
  // rather than treating an unparseable value as absent. Unparseable state is
  // never success — spec §4.3 rule 4.
  assert.deepEqual(
    verifyUninstalledResources(
      ok({ resources: { plugin: "false", marketplace: false } }),
    ),
    {
      ok: false,
      message: "expected a Boolean adapter result at resources.plugin",
    },
  );
});

void test("verifyUninstalledResources fails closed on a failed inspection", () => {
  const verdict = verifyUninstalledResources(failed());
  assert.equal(verdict.ok, false);
});

void test("an unparseable fingerprint result names parsing, not inspection", () => {
  // Previously unreached by any test. Reachable since the resultObject split
  // (spec §6.2.3 item 3b): the outcome is well-formed, the result is not an
  // object. This is the branch that makes the shell's `grep -Fq "parse"`
  // satisfiable.
  const verdict = verifyInstalledFingerprint(
    "abcdef1234567890abcdef1234567890abcdef12",
    ok({}),
    ok("not-an-object"),
  );
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.stderr, [
    "error: cannot parse installed manager fingerprint inspection result after install.",
  ]);
  assert.deepEqual(verdict.stdout, []);
});

void test("a non-string fingerprint is unparseable, not empty", () => {
  // PORT-ONLY. The shell cannot construct this: `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/provenance.sh:62::print(value` stringifies
  // any non-null scalar. Pinned so the branch cannot be deleted as dead.
  const verdict = verifyInstalledFingerprint(
    "abcdef1234567890abcdef1234567890abcdef12",
    ok({}),
    ok({ fingerprint: 42 }),
  );
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.stderr, [
    "error: cannot parse installed manager fingerprint inspection result after install.",
  ]);
});

void test("an unreadable ownership inspection names reading, with its text", () => {
  // Reached today, but the existing case asserts only ok === false, so the
  // operator string was unpinned.
  const verdict = verifyUninstalledResources(failed());
  assert.equal(verdict.ok, false);
  assert.equal(
    verdict.ok === false ? verdict.message : "",
    "cannot read the adapter ownership inspection after removal",
  );
});

void test("the marketplace Boolean check names its own key", () => {
  // The loop covers both keys but only the `plugin` interpolation was
  // asserted, so a template that hardcoded "plugin" would have passed.
  const verdict = verifyUninstalledResources(
    ok({ resources: { plugin: false, marketplace: "yes" } }),
  );
  assert.equal(verdict.ok, false);
  assert.equal(
    verdict.ok === false ? verdict.message : "",
    "expected a Boolean adapter result at resources.marketplace",
  );
});

void test("a non-object resources falls through to the Boolean message", () => {
  // Parity with `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/adapter.sh:70::expected` for input {} — the input
  // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:tests/test_marketplace_reconcile.sh:224::printf '%s\n' '{}` writes. The distinct
  // "expected an object adapter result at resources" message was DELETED by
  // spec §6.2.3 item 3a; this case is what stops it coming back.
  const verdict = verifyUninstalledResources(ok({}));
  assert.equal(verdict.ok, false);
  assert.equal(
    verdict.ok === false ? verdict.message : "",
    "expected a Boolean adapter result at resources.plugin",
  );
});

// ADAPTER-UPDATE-CONTROL-01 was owned by tests/test_adapter_protocol.py until
// PR 11.5 slice 5, and its contract SPLITS.
//
// The recognition rule -- only `managed` and `unsupported` are known values,
// and a third is rejected -- survives in-process here.
//
// The reportability half -- that an inspection can emit `unsupported` --
// retires with the transport. src/adapter.ts's update-control view returns
// the literal `managed`; the old witness at
// `git show 41c99390f51a0cbeb552ab0a0bff26fc1c5c07df:tests/test_adapter_protocol.sh:102-104::run_adapter update` ran a fixture SHELL adapter emitting
// a canned outcome, and no shell adapters remain. tests/migration-inventory/
// probe.md item 92 instructs slice 5 to port that witness; it cannot be
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

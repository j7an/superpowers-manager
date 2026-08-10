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

// Frozen operator text. scripts/core/lifecycle.sh:50-53 and :75-77 print these
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
// either case statement (scripts/core/lifecycle.sh:56-58 and :81-83), so the
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
    envelope: {
      protocol: 1,
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
    envelope: {
      protocol: 1,
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
  // scripts/core/status.sh:7 compares against `cut -c 1-7`, and commitMatches
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
  // scripts/core/lifecycle.sh:108-112 chooses between two hint keys on whether
  // the installed commit is empty. A null fingerprint reads as empty, matching
  // the Python reader's behaviour for JSON null (src/commands/probe.ts:243-248).
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
  // scripts/core/adapter.sh:58-73 died with `expected Boolean adapter result`
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

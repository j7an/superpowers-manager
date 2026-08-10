#!/usr/bin/env node
// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

/** @type {typeof import("../../src/lifecycle.js")} */
const { requireNoLegacyState, reportLegacyState } = await import(
  new URL("../../dist/lifecycle.js", import.meta.url).href
);

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

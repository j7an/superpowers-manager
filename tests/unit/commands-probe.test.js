#!/usr/bin/env node
// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import { capture } from "./helpers/command-harness.js";

/** @type {typeof import("../../src/commands/probe.js")} */
const {
  formatPorcelain,
  formatHuman,
  replayEnvelope,
  PROBE_PORCELAIN_KEYS,
  PROBE_USAGE,
  runProbe,
} = await import(new URL("../../dist/commands/probe.js", import.meta.url).href);

/** Every field populated, so ordering and labelling are the only variables. */
const FULL = {
  requestedRef: "v1.2.3",
  resolvedRef: "v1.2.3",
  desiredCommit: "a".repeat(40),
  generatedCommit: "b".repeat(40),
  installedCommit: "c".repeat(40),
  identityState: "manager",
  status: "current",
  selectionOrigin: "user-config",
  selectionMode: "pinned",
  upstreamSourceOrigin: "user-config",
  effectiveSource: "https://example.invalid/upstream",
  savedMode: "pinned",
  savedSource: "https://example.invalid/upstream",
  savedRequestedRef: "v1.2.3",
  savedResolvedRef: "v1.2.3",
  savedCommit: "a".repeat(40),
  updateControl: "managed",
};

// Amended 2026-08-07 after adjudication finding 4. This list was previously
// exported from THIS FILE for tests/baseline/probe.test.js to import — but
// importing a *.test.js module re-executes and re-registers its tests inside
// the importing suite (tests/run-node-suites.js:15,106-140 registers every
// top-level *.test.js). The list now lives in production, derived from the one
// ordered fields() table, and both suites import it from dist/. That is
// strictly better than any test-side copy: the expectation cannot drift from
// the implementation because it IS the implementation.
const EXPECTED_KEYS = [
  "requested_ref",
  "resolved_ref",
  "desired_commit",
  "generated_commit",
  "installed_commit",
  "identity_state",
  "status",
  "selection_origin",
  "selection_mode",
  "upstream_source_origin",
  "effective_source",
  "saved_mode",
  "saved_source",
  "saved_requested_ref",
  "saved_resolved_ref",
  "saved_commit",
  "update_control",
];

// EXPECTED_KEYS is the one place the frozen key list is written by hand, and
// the ordering test below compares against it for that reason -- NOT against
// PROBE_PORCELAIN_KEYS, which is derived from the same fields() table
// formatPorcelain walks and so could not catch the two moving together. Do not
// "simplify" either assertion to reuse PROBE_PORCELAIN_KEYS: this one is what
// pins the contract to the 17 names scripts/probe:43-59 emits, and the
// ordering one is what pins formatPorcelain's output to the same list.
void test("the exported key list is the frozen seventeen", () => {
  assert.deepEqual([...PROBE_PORCELAIN_KEYS], EXPECTED_KEYS);
});

void test("porcelain emits exactly seventeen keys in the frozen order", () => {
  // Whole-list equality, not per-key membership: a `includes` check passes
  // while the order drifts, and tests/test_probe.sh:413 asserted the order.
  const lines = formatPorcelain(FULL).split("\n").slice(0, -1);
  assert.deepEqual(
    lines.map((line) => line.slice(0, line.indexOf("="))),
    EXPECTED_KEYS,
  );
  assert.equal(lines.length, 17);
});

void test("porcelain emits each value verbatim after its key", () => {
  const text = formatPorcelain(FULL);
  assert.match(text, /^desired_commit=a{40}$/m);
  assert.match(text, /^saved_mode=pinned$/m);
  assert.match(text, /^update_control=managed$/m);
});

void test("porcelain leaves an empty value empty", () => {
  const text = formatPorcelain({
    ...FULL,
    generatedCommit: "",
    installedCommit: "",
    savedSource: "",
  });
  assert.match(text, /^generated_commit=$/m);
  assert.match(text, /^installed_commit=$/m);
  assert.match(text, /^saved_source=$/m);
});

void test("human mode substitutes the two absence labels", () => {
  // scripts/probe:64-65 — these two fields, and only these two, print a
  // stand-in rather than an empty value.
  const text = formatHuman({
    ...FULL,
    generatedCommit: "",
    installedCommit: "",
    savedSource: "",
  });
  assert.match(text, /^generated plugin commit: not present$/m);
  assert.match(
    text,
    /^installed manager commit or fingerprint: not detected$/m,
  );
  assert.match(text, /^saved source: $/m);
});

void test("human mode warns only when the two origins disagree", () => {
  const WARNING =
    "warning: effective ref and source have mixed origins " +
    "(ref: environment, source: user-config)\n";
  assert.equal(formatHuman(FULL).includes("warning:"), false);
  const mixed = formatHuman({ ...FULL, selectionOrigin: "environment" });
  assert.equal(mixed.endsWith(WARNING), true);
});

void test("an unrecognised argument is a usage error on stderr", async () => {
  for (const argv of [["--porcelaine"], ["--porcelain", "extra"], ["extra"]]) {
    const out = capture();
    const err = capture();
    const status = await runProbe(argv, {
      root: "/unused",
      env: {},
      stdout: out.stream,
      stderr: err.stream,
    });
    assert.equal(status, 2);
    assert.equal(out.text(), "");
    assert.equal(err.text(), PROBE_USAGE);
  }
});

void test("a thrown selection failure is an operational failure", async () => {
  const out = capture();
  const err = capture();
  // HOME absent and no SUPERPOWERS_CONFIG_DIR: selectionConfigDir throws a
  // hand-written SafetyError before anything else runs.
  const status = await runProbe([], {
    root: "/unused",
    env: {},
    stdout: out.stream,
    stderr: err.stream,
  });
  assert.equal(status, 1);
  assert.equal(out.text(), "");
  assert.equal(
    err.text(),
    "error: HOME is required to locate selection state\n",
  );
});

// --- Envelope replay (spec §3.3, added 2026-08-07 after adjudication) ---
//
// scripts/core/validate-adapter-response.py ran on every adapter response and
// did two things the first draft of this port dropped: replay(messages) at
// :235-238 wrote each message to its own declared stream in array order, and
// :269-272 printed `error: <message>` followed by one `hint: <h>` per hint.
// DIAG-ADAPTER-01 is a retained contract (docs/baseline/protocol-disposition.md:53).
// These tests hold it at the command level; tests/unit/adapter.test.js holds
// it at the envelope level.

/** @param {Partial<import("../../src/adapter-protocol.js").AdapterEnvelope>} over */
function envelopeWith(over) {
  return /** @type {any} */ ({
    protocol: 1,
    operation: "inspect",
    ok: true,
    messages: [],
    result: null,
    error: null,
    ...over,
  });
}

void test("replay writes each message to its declared stream in array order", () => {
  const out = capture();
  const err = capture();
  replayEnvelope(
    envelopeWith({
      messages: [
        { channel: "stdout", text: "first" },
        { channel: "stderr", text: "second" },
        { channel: "stdout", text: "third" },
      ],
    }),
    { root: "/unused", env: {}, stdout: out.stream, stderr: err.stream },
  );
  // Per-stream sequence, so a reversal inside one stream is caught. The
  // cross-stream interleave is not observable through separate captures and
  // is not asserted.
  assert.equal(out.text(), "first\nthird\n");
  assert.equal(err.text(), "second\n");
});

void test("replay emits the error line then one hint line per hint", () => {
  const out = capture();
  const err = capture();
  replayEnvelope(
    envelopeWith({
      ok: false,
      messages: [{ channel: "stderr", text: "context" }],
      result: null,
      error: {
        code: "inspect-failed",
        message: "cannot list",
        hints: ["a", "b"],
      },
    }),
    { root: "/unused", env: {}, stdout: out.stream, stderr: err.stream },
  );
  assert.equal(out.text(), "");
  // Whole-string equality: the messages precede the error, and the hints
  // follow it in array order. Three separate `match` calls would pass on any
  // permutation of the same three lines.
  assert.equal(err.text(), "context\nerror: cannot list\nhint: a\nhint: b\n");
});

void test("replay on a clean success envelope writes nothing", () => {
  const out = capture();
  const err = capture();
  replayEnvelope(envelopeWith({}), {
    root: "/unused",
    env: {},
    stdout: out.stream,
    stderr: err.stream,
  });
  assert.equal(out.text(), "");
  assert.equal(err.text(), "");
});

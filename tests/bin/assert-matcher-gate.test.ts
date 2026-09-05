import looseAssert from "node:assert";
import * as namespaceAssert from "node:assert";
import assert from "node:assert/strict";
import test from "node:test";
import { admitsMatcher } from "../assert-matcher-gate.ts";

// The eight rejected rows are written through eight distinct SOURCE forms
// that converge on three runtime values: undefined, null, and string. That
// convergence is the point of the gate rather than an accident of the table
// — `node:assert` vacuity is a property of the value's type, so every way of
// spelling a string is caught by one check. The rows are kept distinct so a
// reader asking "is a template literal caught?" gets a named answer.
const LABEL = "a plain string";
const holder = { text: "a member expression" };

const REJECTED: [string, unknown][] = [
  ["absent second argument", undefined],
  ["string literal", "a string literal"],
  ["string variable", LABEL],
  ["template literal", `a template ${LABEL}`],
  ["concatenation", "a " + "concatenation"],
  ["function result", String(42)],
  ["member access", holder.text],
  ["null", null],
];

class SampleError extends Error {}

const ADMITTED: [string, unknown][] = [
  ["error class", SampleError],
  ["RegExp", /a message/],
  ["object matcher", { message: "a message" }],
  ["validation function", (error: unknown) => error instanceof SampleError],
];

void test("every vacuous matcher form is rejected", () => {
  for (const [name, value] of REJECTED) {
    assert.equal(admitsMatcher(value), false, name);
  }
});

void test("every constraining matcher form is admitted", () => {
  for (const [name, value] of ADMITTED) {
    assert.equal(admitsMatcher(value), true, name);
  }
});

void test("the predicate rejects rather than admits an unrecognized type", () => {
  // The allowlist's whole purpose: a form nobody enumerated lands on the
  // reject side. These are already rejected by node itself, so the gate
  // never has to be right about them — but it must not be the thing that
  // lets a novel form through.
  for (const value of [42, true, Symbol("s"), 7n]) {
    assert.equal(admitsMatcher(value), false, String(typeof value));
  }
});

// The predicate being correct proves nothing about whether it is INSTALLED on
// the surfaces callers actually use. Without this matrix, dropping the loose
// target, dropping `rejects`, or omitting syncBuiltinESMExports() leaves every
// other test in this file green.
void test("every promised patch surface rejects a vacuous matcher", () => {
  const boom = () => {
    throw new SampleError("boom");
  };

  const SURFACES: [string, { throws: Function; rejects: Function }][] = [
    ["strict default", assert],
    ["loose default", looseAssert],
    ["namespace binding", namespaceAssert],
  ];
  for (const [name, surface] of SURFACES) {
    assert.throws(
      () => surface.throws(boom, "a label"),
      /constrains nothing/,
      `${name} throws`,
    );
    assert.throws(
      // `void` because the wrapper throws synchronously before delegating; if
      // it does not, the call returns a settled promise this test discards.
      // The inner function throws so the unpatched path settles rather than
      // rejecting, keeping the RED clean.
      () =>
        void surface.rejects(async () => {
          throw new SampleError("boom");
        }, "a label"),
      /constrains nothing/,
      `${name} rejects`,
    );
  }
});

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER = fileURLToPath(new URL("../run-node-suites.ts", import.meta.url));

const VACUOUS_SUITE = [
  'import assert from "node:assert/strict";',
  'import test from "node:test";',
  'test("vacuous", () => {',
  '  assert.throws(() => { throw new Error("boom"); }, "a label");',
  "});",
  "",
].join("\n");

const CONSTRAINED_SUITE = [
  'import assert from "node:assert/strict";',
  'import test from "node:test";',
  'test("constrained", () => {',
  '  assert.throws(() => { throw new Error("boom"); }, /boom/);',
  "});",
  "",
].join("\n");

/**
 * An isolated ESM repository root with one registered native test suite.
 */
function fakeRoot(
  t: import("node:test").TestContext,
  suiteSource: string,
): string {
  const root = mkdtempSync(join(tmpdir(), "spw-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  for (const dir of ["tests/bin", "tests/unit", "tests/baseline"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, "tests", "unit", "a.test.ts"), suiteSource, "utf8");
  writeFileSync(
    join(root, "tests", "suites.json"),
    JSON.stringify({ suites: ["tests/unit/a.test.ts"] }, null, 2),
    "utf8",
  );
  return root;
}

function runIn(
  runner: string,
  root: string,
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [runner], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, SPW_RUNNER_ROOT: root },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

void test("the runner gates a vacuous matcher in a suite it runs", (t) => {
  const root = fakeRoot(t, VACUOUS_SUITE);
  const r = runIn(RUNNER, root);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /constrains nothing/);
});

void test("the runner leaves a constraining matcher alone", (t) => {
  // The control. Without it, a gate that rejects everything passes the suite.
  // Exit 0 alone does not distinguish that from a fixture root where
  // `node --test` executed zero files, so also assert the suite actually ran.
  const root = fakeRoot(t, CONSTRAINED_SUITE);
  const r = runIn(RUNNER, root);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /pass 1/);
});

void test("the runner fails closed when the gate module is unreadable", (t) => {
  // "Absent" and "unreadable" are different failures. An unreadable file
  // still exists, so an existence probe passes it through and the child dies
  // with a raw EACCES and a stack — the outcome the no-errno rule forbids,
  // produced by the branch meant to prevent it.
  const root = fakeRoot(t, CONSTRAINED_SUITE);
  const copiedRunner = join(root, "run-node-suites.ts");
  copyFileSync(RUNNER, copiedRunner);
  const copiedGate = join(root, "assert-matcher-gate.ts");
  copyFileSync(join(dirname(RUNNER), "assert-matcher-gate.ts"), copiedGate);
  chmodSync(copiedGate, 0o000);
  // A privileged user ignores the permission bit; skip rather than assert a
  // guarantee the environment does not provide. Same guard as
  // `tests/baseline/suite-runner.test.ts:453-455::Root ignores the mode bits`.
  let readable = true;
  try {
    readFileSync(copiedGate);
  } catch {
    readable = false;
  }
  if (readable) {
    t.skip("cannot make a file unreadable in this environment");
    return;
  }
  const r = runIn(copiedRunner, root);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /matcher gate/);
  for (const stream of [r.stdout, r.stderr]) {
    assert.doesNotMatch(stream, /ENOENT|EACCES|ENOTDIR|errno/);
    assert.doesNotMatch(stream, /\n\s+at /);
  }
});

void test("the runner fails closed when the gate module is absent", (t) => {
  // The real runner resolves the gate next to itself, so its absence cannot
  // be simulated in a fixture root — it needs a runner copy with no gate
  // beside it.
  const root = fakeRoot(t, CONSTRAINED_SUITE);
  const copiedRunner = join(root, "run-node-suites.ts");
  copyFileSync(RUNNER, copiedRunner);
  const r = runIn(copiedRunner, root);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /matcher gate/);
  // Failing closed must not mean leaking a module-resolution stack.
  for (const stream of [r.stdout, r.stderr]) {
    assert.doesNotMatch(stream, /ENOENT|EACCES|ENOTDIR|errno/);
    assert.doesNotMatch(stream, /\n\s+at /);
  }
});

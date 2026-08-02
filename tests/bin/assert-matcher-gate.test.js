// @ts-check
import looseAssert from "node:assert";
import * as namespaceAssert from "node:assert";
import assert from "node:assert/strict";
import test from "node:test";
import { admitsMatcher } from "../assert-matcher-gate.js";

// The eight rejected rows are written through eight distinct SOURCE forms
// that converge on three runtime values: undefined, null, and string. That
// convergence is the point of the gate rather than an accident of the table
// — `node:assert` vacuity is a property of the value's type, so every way of
// spelling a string is caught by one check. The rows are kept distinct so a
// reader asking "is a template literal caught?" gets a named answer.
const LABEL = "a plain string";
const holder = { text: "a member expression" };

/** @type {[string, unknown][]} */
const REJECTED = [
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

/** @type {[string, unknown][]} */
const ADMITTED = [
  ["error class", SampleError],
  ["RegExp", /a message/],
  ["object matcher", { message: "a message" }],
  [
    "validation function",
    (/** @type {unknown} */ error) => error instanceof SampleError,
  ],
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
  /** @type {[string, {throws: Function, rejects: Function}][]} */
  const SURFACES = [
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

// @ts-check
import loose from "node:assert";
import strict from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";

/**
 * Whether a second argument to `assert.throws`/`assert.rejects` constrains
 * the error at all.
 *
 * Vacuity here is a property of the argument's runtime TYPE, not of its
 * source text: `node:assert` reads any value that happens to be a string as
 * the failure *label*, whatever expression produced it, and treats `undefined`
 * and `null` as no constraint. Verified by execution on Node v24.18.0 —
 * `undefined`, `null`, and any string all pass against an unrelated error,
 * while node itself already rejects empty objects, arrays, and the wrong
 * primitive types with its own diagnostics.
 *
 * Written as an allowlist so a form nobody enumerated lands on the reject
 * side by default. A RegExp needs no clause of its own: `typeof /x/` is
 * "object".
 *
 * @param {unknown} matcher
 * @returns {boolean}
 */
export function admitsMatcher(matcher) {
  return (
    typeof matcher === "function" ||
    (typeof matcher === "object" && matcher !== null)
  );
}

/**
 * @param {typeof strict | typeof loose} target
 * @param {"throws" | "rejects"} name
 * @returns {void}
 */
function enforce(target, name) {
  const original = target[name];
  /** @type {(...args: unknown[]) => unknown} */
  const wrapper = (...args) => {
    if (!admitsMatcher(args[1])) {
      // The value is deliberately not interpolated: a matcher argument can
      // hold arbitrary text, and this message reaches the stream.
      throw new Error(
        `assert.${name} was called with a second argument that constrains nothing, so it passes on any error. Supply an error class, a RegExp, an object matcher, or a validation function that returns true.`,
      );
    }
    return /** @type {(...a: unknown[]) => unknown} */ (
      /** @type {unknown} */ (original)
    )(...args);
  };
  // Assigning over an overloaded readonly signature needs a cast through
  // `unknown`; verified to typecheck clean under checkJs + strict.
  const slot = /** @type {Record<string, unknown>} */ (
    /** @type {unknown} */ (target)
  );
  slot[name] = wrapper;
}

// Both module objects are patched. Patching the strict default also covers
// `assert.strict.throws`, which is the same function object. Namespace
// bindings (`import * as assert from "node:assert"`) are covered separately,
// below, via `syncBuiltinESMExports()`.
/** @type {("throws" | "rejects")[]} */
const GUARDED = ["throws", "rejects"];
for (const target of [strict, loose]) {
  for (const name of GUARDED) {
    enforce(target, name);
  }
}

// Patching the default exports does not reach a namespace binding:
// tests/bin/units.test.js:4 uses `import * as assert from "node:assert"` and
// calls assert.throws at :133. Verified by execution on Node v24.18.0 — that
// binding still resolves to the ORIGINAL function after the patch above, and
// this call is what updates it. Without this line the gate is absent from the
// one file that would have exposed its absence.
syncBuiltinESMExports();

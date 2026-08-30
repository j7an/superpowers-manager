// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { registerScratch } from "./fixture-scratch.js";
import {
  CONSTRUCTOR_MATCHER_EXEMPTIONS,
  auditConstructorMatchers,
  exactError,
  matchingError,
} from "../lib/error-assertions.js";

class ExpectedError extends Error {}
const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

void test("exactError requires the expected class and exact message", () => {
  assert.throws(
    () => {
      throw new ExpectedError("right");
    },
    exactError(ExpectedError, "right"),
  );
  assert.throws(
    () =>
      assert.throws(
        () => {
          throw new ExpectedError("wrong");
        },
        exactError(ExpectedError, "right"),
      ),
    { name: "AssertionError", message: /right/ },
  );
});

void test("matchingError anchors the allowed variable field", () => {
  assert.throws(
    () => {
      throw new ExpectedError("cannot read /tmp/case/input.json");
    },
    matchingError(ExpectedError, /^cannot read \/.+\/input\.json$/),
  );
});

void test("constructor audit sees aliases, unexecuted paths, and custom subclasses", () => {
  const root = mkdtempSync(join(tmpdir(), "spw-error-audit-"));
  registerScratch(root);
  mkdirSync(join(root, "tests", "unit"), { recursive: true });
  writeFileSync(
    join(root, "tests", "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: true,
        noEmit: true,
        strict: true,
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2024",
        types: ["node"],
        typeRoots: [join(PACKAGE_ROOT, "node_modules", "@types")],
      },
      include: ["unit/**/*.js"],
    }),
  );
  writeFileSync(
    join(root, "tests", "unit", "subject.test.js"),
    `import assert, { throws as namedThrows } from "node:assert/strict";
import * as loose from "node:assert";
import test from "node:test";
class CustomError extends Error {}
const Alias = CustomError;
/** @param {unknown} error */
const predicate = (error) => error instanceof Error;
void test("fixture", async () => {
  if (false) assert.throws(() => { throw new Alias("a"); }, Alias);
  namedThrows(() => { throw new CustomError("b"); }, CustomError);
  loose.strict.throws(() => { throw new CustomError("d"); }, CustomError);
  await assert.rejects(Promise.reject(new CustomError("e")), CustomError);
  assert.throws(() => { throw new Error("c"); }, predicate);
});
`,
  );
  assert.deepEqual(
    auditConstructorMatchers({
      root,
      tsconfigPath: join(root, "tests", "tsconfig.json"),
      exemptions: [],
    }).map(({ path, test: name, matcher }) => ({ path, test: name, matcher })),
    [
      { path: "tests/unit/subject.test.js", test: "fixture", matcher: "Alias" },
      { path: "tests/unit/subject.test.js", test: "fixture", matcher: "CustomError" },
      { path: "tests/unit/subject.test.js", test: "fixture", matcher: "CustomError" },
      { path: "tests/unit/subject.test.js", test: "fixture", matcher: "CustomError" },
    ],
  );
  assert.throws(
    () =>
      auditConstructorMatchers({
        root,
        tsconfigPath: join(root, "tests", "tsconfig.json"),
        exemptions: [
          {
            path: "tests/unit/subject.test.js",
            test: "fixture",
            matcher: "MissingError",
            rationale: "controlled stale-exemption fixture",
          },
        ],
      }),
    { message: /unused constructor matcher exemption/ },
  );
  assert.deepEqual(CONSTRUCTOR_MATCHER_EXEMPTIONS, []);
});

void test("constructor audit fails closed when the configured project is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "spw-error-audit-fail-"));
  registerScratch(root);
  assert.throws(
    () =>
      auditConstructorMatchers({
        root,
        tsconfigPath: join(root, "tests", "missing.json"),
        exemptions: [],
      }),
    { message: /could not open/ },
  );
});

void test("constructor audit fails closed on a dynamically destructured Node assert", () => {
  const root = mkdtempSync(join(tmpdir(), "spw-error-audit-shape-"));
  registerScratch(root);
  mkdirSync(join(root, "tests", "unit"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  writeFileSync(
    join(root, "tests", "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: true,
        noEmit: true,
        strict: true,
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2024",
        types: ["node"],
        typeRoots: [join(PACKAGE_ROOT, "node_modules", "@types")],
      },
      include: ["unit/**/*.js"],
    }),
  );
  writeFileSync(
    join(root, "tests", "unit", "dynamic.test.js"),
    `const { throws: dynamicThrows } = await import("node:assert/strict");
class DynamicError extends Error {}
dynamicThrows(() => { throw new DynamicError("dynamic"); }, DynamicError);
`,
  );
  assert.throws(
    () =>
      auditConstructorMatchers({
        root,
        tsconfigPath: join(root, "tests", "tsconfig.json"),
        exemptions: [],
      }),
    {
      message:
        /unresolved node:assert call shape: tests\/unit\/dynamic\.test\.js:3/,
    },
  );
});

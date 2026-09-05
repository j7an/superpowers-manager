import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { registerScratch } from "./fixture-scratch.ts";
import {
  CONSTRUCTOR_MATCHER_EXEMPTIONS,
  auditConstructorMatchers,
  exactError,
  matchingError,
} from "../lib/error-assertions.ts";

class ExpectedError extends Error {}
const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

void test("repository has no unreviewed constructor-only error matcher", () => {
  assert.deepEqual(CONSTRUCTOR_MATCHER_EXEMPTIONS, []);
  assert.deepEqual(
    auditConstructorMatchers({
      root: PACKAGE_ROOT,
      tsconfigPath: join(PACKAGE_ROOT, "tests", "tsconfig.json"),
      exemptions: CONSTRUCTOR_MATCHER_EXEMPTIONS,
    }),
    [],
  );
});

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
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(
    join(root, "tests", "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2024",
        types: ["node"],
        typeRoots: [join(PACKAGE_ROOT, "node_modules", "@types")],
      },
      include: ["unit/**/*.ts"],
    }),
  );
  writeFileSync(
    join(root, "tests", "unit", "subject.test.ts"),
    `import assert, { throws as namedThrows } from "node:assert/strict";
import * as loose from "node:assert";
import test from "node:test";
class CustomError extends Error {}
const Alias = CustomError;
const predicate = (error: unknown) => error instanceof Error;
void test("fixture", async () => {
  if (false) assert.throws(() => { throw new Alias("a"); }, Alias);
  namedThrows(() => { throw new CustomError("b"); }, CustomError);
  loose.strict.throws(() => { throw new CustomError("d"); }, CustomError);
  await assert.rejects(Promise.reject(new CustomError("e")), CustomError);
  assert.throws(() => { throw new Error("c"); }, predicate);
});
`,
  );
  const typedCase = [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'const fail = (): never => { throw new Error("expected"); };',
    'test("typed matcher", () => assert.throws(fail, /expected/));',
  ].join("\n");
  writeFileSync(join(root, "tests", "unit", "typed.test.ts"), typedCase);
  assert.deepEqual(
    auditConstructorMatchers({
      root,
      tsconfigPath: join(root, "tests", "tsconfig.json"),
      exemptions: [],
    }).map(({ path, test: name, matcher }) => ({ path, test: name, matcher })),
    [
      { path: "tests/unit/subject.test.ts", test: "fixture", matcher: "Alias" },
      {
        path: "tests/unit/subject.test.ts",
        test: "fixture",
        matcher: "CustomError",
      },
      {
        path: "tests/unit/subject.test.ts",
        test: "fixture",
        matcher: "CustomError",
      },
      {
        path: "tests/unit/subject.test.ts",
        test: "fixture",
        matcher: "CustomError",
      },
    ],
  );
  assert.throws(
    () =>
      auditConstructorMatchers({
        root,
        tsconfigPath: join(root, "tests", "tsconfig.json"),
        exemptions: [
          {
            path: "tests/unit/subject.test.ts",
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

void test("constructor audit excludes shadowed user-defined assertion methods", () => {
  const root = mkdtempSync(join(tmpdir(), "spw-error-audit-shadow-"));
  registerScratch(root);
  mkdirSync(join(root, "tests", "unit"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(
    join(root, "tests", "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2024",
        types: ["node"],
        typeRoots: [join(PACKAGE_ROOT, "node_modules", "@types")],
      },
      include: ["unit/**/*.ts"],
    }),
  );
  writeFileSync(
    join(root, "tests", "unit", "shadowed.test.ts"),
    `import assert from "node:assert/strict";
class CustomError extends Error {}
async function exercise(assert: {
  throws(callback: () => void, expected: typeof CustomError): void;
  rejects(value: Promise<unknown>, expected: typeof CustomError): Promise<void>;
}) {
  assert.throws(() => {}, CustomError);
  await assert.rejects(Promise.resolve(), CustomError);
}
void exercise;
`,
  );
  assert.deepEqual(
    auditConstructorMatchers({
      root,
      tsconfigPath: join(root, "tests", "tsconfig.json"),
      exemptions: [],
    }),
    [],
  );
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
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(
    join(root, "tests", "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2024",
        types: ["node"],
        typeRoots: [join(PACKAGE_ROOT, "node_modules", "@types")],
      },
      include: ["unit/**/*.ts"],
    }),
  );
  writeFileSync(
    join(root, "tests", "unit", "dynamic.test.ts"),
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
        /unresolved node:assert call shape: tests\/unit\/dynamic\.test\.ts:3/,
    },
  );
});

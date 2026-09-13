import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { registerScratch } from "./fixture-scratch.ts";
import {
  auditConstructorMatchers,
  exactError,
  matchingError,
} from "../lib/error-assertions.ts";

class ExpectedError extends Error {}
const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function auditProject(source: string): { root: string; tsconfigPath: string } {
  const root = mkdtempSync(join(tmpdir(), "spw-error-audit-"));
  registerScratch(root);
  mkdirSync(join(root, "tests", "unit"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  const tsconfigPath = join(root, "tests", "tsconfig.json");
  writeFileSync(
    tsconfigPath,
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
  writeFileSync(join(root, "tests", "unit", "subject.test.ts"), source);
  return { root, tsconfigPath };
}

void test("repository has no unreviewed constructor-only error matcher", () => {
  assert.deepEqual(
    auditConstructorMatchers({
      root: PACKAGE_ROOT,
      tsconfigPath: join(PACKAGE_ROOT, "tests", "tsconfig.json"),
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
  const { root, tsconfigPath } = auditProject(
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
      tsconfigPath,
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
});

void test("constructor audit excludes shadowed user-defined assertion methods", () => {
  const { root, tsconfigPath } = auditProject(
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
      tsconfigPath,
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
      }),
    { message: /could not open/ },
  );
});

void test("constructor audit fails closed on a dynamically destructured Node assert", () => {
  const { root, tsconfigPath } = auditProject(
    `const { throws: dynamicThrows } = await import("node:assert/strict");
class DynamicError extends Error {}
dynamicThrows(() => { throw new DynamicError("dynamic"); }, DynamicError);
`,
  );
  assert.throws(
    () =>
      auditConstructorMatchers({
        root,
        tsconfigPath,
      }),
    {
      message:
        /unresolved node:assert call shape: tests\/unit\/subject\.test\.ts:3/,
    },
  );
});

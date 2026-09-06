// The internal boundary must not become a renamed external seam or leak its
// concrete Codex implementation into shared commands.
//
// `ctx.adapter` is an interface field, not a public selector — but only while
// nothing under src/ reads it back out of the environment. Two properties,
// one file, because they fail together: a shared command that imports any
// concrete Codex module has no generic boundary at all, and a module that
// derives the adapter from env has an environment seam wearing an interface's
// clothes.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SyntaxKind } from "typescript/unstable/ast";
import {
  isCallExpression,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isPropertyAssignment,
  isStringLiteral,
} from "typescript/unstable/ast/is";
import { API } from "typescript/unstable/sync";
import type {} from "../../src/adapter.ts";
import type {} from "../../src/codex-harness.ts";
import type {} from "../../src/hooks.ts";
import type {} from "../../src/lifecycle.ts";
import type {} from "../../src/provenance.ts";
import type {} from "../../src/status.ts";
import type {} from "../../src/upstream-version.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...tsFiles(relative));
    else if (entry.name.endsWith(".ts")) out.push(relative);
  }
  return out;
}

// LIMITS, stated rather than implied: this pattern catches a direct named,
// aliased, or default import of `runAdapter` (`import { runAdapter } …`,
// `import { runAdapter as ra } …`, `import runAdapter from …`) and a dynamic
// `import(...)` whose OWN statement also names `runAdapter` before the next
// `;` — e.g. `(await import(…)).runAdapter(…)` or
// `import(…).then(m => m.runAdapter(…))`. Note this gap is `[^;]*`, not the
// `[^;,{}]` used by the provenance gate below: it DOES cross `,`, `{` and `}`,
// so a braced `.then(m => { return m.runAdapter(x) })` body is caught too.
// It does NOT catch:
//   - a namespace import used to reach the same binding
//     (`import * as adapterMod from "../adapter.js"; … adapterMod.runAdapter(…)`);
//   - a re-export (`export { runAdapter } from "../adapter.js";`);
//   - the idiomatic destructured dynamic import
//     (`const { runAdapter } = await import("../adapter.js");`) — here the
//     bound identifier PRECEDES the `import` keyword, so `\bimport\b[^;]*
//     \brunAdapter\b` never sees `runAdapter` after `import` in the same
//     statement.
// All three are real imports of `runAdapter` into a command module and would
// sail through this gate uncaught.
function moduleSpecifiers(
  parsed: import("typescript/unstable/ast").SourceFile,
): string[] {
  const specifiers: string[] = [];
  const visit = (node: import("typescript/unstable/ast").Node): void => {
    if (
      (isImportDeclaration(node) || isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      isCallExpression(node) &&
      node.expression.kind === SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      isStringLiteral(node.arguments[0]!)
    ) {
      specifiers.push(node.arguments[0]!.text);
    }
    node.forEachChild(visit);
  };
  visit(parsed);
  return specifiers;
}

function isConcreteCodexModule(specifier: string): boolean {
  const name = specifier.split("/").at(-1) ?? "";
  return (
    name === "adapter.ts" ||
    name.startsWith("codex-") ||
    [
      "hooks.ts",
      "lifecycle.ts",
      "provenance.ts",
      "status.ts",
      "upstream-version.ts",
    ].includes(name)
  );
}

void test("no module under src/commands/ imports runAdapter", () => {
  const api = new API({ cwd: ROOT });
  const snapshot = api.updateSnapshot({
    openProjects: [join(ROOT, "tsconfig.json")],
  });
  const project = snapshot.getProjects()[0]!;
  const offenders = tsFiles("src/commands").filter((relative) => {
    const source = project.program.getSourceFile(join(ROOT, relative));
    assert.ok(source, `parser did not load ${relative}`);
    return moduleSpecifiers(source).some(isConcreteCodexModule);
  });
  snapshot.dispose();
  api.close();
  assert.deepEqual(
    offenders,
    [],
    "a command module importing a concrete Codex module bypasses ctx.adapter, so an " +
      "injected double observes nothing — see spec §4.5",
  );
});

function concreteBindings(
  parsed: import("typescript/unstable/ast").SourceFile,
): number {
  let count = 0;
  const visit = (node: import("typescript/unstable/ast").Node): void => {
    if (
      isPropertyAssignment(node) &&
      ((isIdentifier(node.name) && node.name.text === "adapter") ||
        (isStringLiteral(node.name) && node.name.text === "adapter")) &&
      isIdentifier(node.initializer) &&
      node.initializer.text === "codexHarness"
    ) {
      count += 1;
    }
    node.forEachChild(visit);
  };
  visit(parsed);
  return count;
}

void test("the CLI is the only production concrete harness binding", () => {
  const api = new API({ cwd: ROOT });
  const snapshot = api.updateSnapshot({
    openProjects: [join(ROOT, "tsconfig.json")],
  });
  const project = snapshot.getProjects()[0]!;
  const bindings = tsFiles("src").flatMap((relative) => {
    const source = project.program.getSourceFile(join(ROOT, relative));
    assert.ok(source, `parser did not load ${relative}`);
    return Array.from({ length: concreteBindings(source) }, () => relative);
  });
  snapshot.dispose();
  api.close();
  assert.deepEqual(bindings, ["src/cli.ts"]);
});

// A BOUNDED HEURISTIC, and labelled as one. The repo has no parser dependency
// and AGENTS.md requires asking before adding one, so this cannot be
// syntax-aware. Two properties get it close enough to be worth having:
//
//   FORMATTING-IMMUNE — whitespace is collapsed before matching, so
//   `adapter =\n  process.env.SPW_ADAPTER` (what prettier produces once the
//   line grows) reads the same as the one-line form. A same-line regex misses
//   it entirely.
//
//   BOUNDED TO ONE VALUE — the gap excludes `; , { }`, so a match cannot span
//   from one property or statement into the next. Without that bound the
//   pattern fires all over src/adapter.ts, where the word "adapter" appears in
//   prose on nearly every page and `env.` on most of them. `adapter` must be
//   in an ASSIGNMENT or PROPERTY position (`adapter:` / `adapter =`), not
//   merely mentioned.
//
// LIMITS, stated rather than implied: this gate catches a derivation whose
// deriving expression is a BRACE-FREE assignment or property value on the
// identifier `adapter` itself — the `[^;,{}]` gap is what makes it brace-free,
// and that bound is deliberate (see BOUNDED TO ONE VALUE above): widening or
// dropping it would false-positive throughout src/adapter.ts, where the word
// "adapter" appears in prose on nearly every page with `env.` nearby. It does
// NOT catch one laundered through a helper (`adapter: pickAdapter(env)`), an
// intermediate variable (`const chosen = env.X ? load(env.X) : runAdapter; …
// { adapter: chosen }`), a destructuring (`const { SPW_ADAPTER } = env; … {
// adapter: SPW_ADAPTER ? load(…) : runAdapter }`), or a braced function body
// (`adapter: (a, c) => { const p = env.X; return p ? load(p)(a, c) :
// runAdapter(a, c); }`) — all four are real derivations from the environment
// that would sail through this gate uncaught, and no regex without a parser
// will close that gap. A gate whose stated scope exceeds its reach is worse
// than a narrow one, because the next reader stops looking.
const GAP = 80;

function derivesAdapterFromEnv(source: string): boolean {
  const flat = source.replace(/\s+/g, " ");
  return new RegExp(
    `\\badapter\\??\\s*[:=]\\s*[^;,{}]{0,${GAP}}?(?:process\\.env|\\benv\\b|\\bargv\\b)\\s*(?:\\[|\\.)`,
    "i",
  ).test(flat);
}

void test("no src/ module derives its adapter from env or argv", () => {
  const offenders = tsFiles("src").filter((relative) =>
    derivesAdapterFromEnv(readFileSync(join(ROOT, relative), "utf8")),
  );
  assert.deepEqual(
    offenders,
    [],
    "an adapter derived from the environment is SPW_ADAPTER reborn — see " +
      "spec §4.5 and §9",
  );
});

void test("both gates reject every evasion form they claim to cover", () => {
  // Mutation proof for the actual syntax-aware import gate. These type-only
  // imports are inert at runtime, but the same project parser and classifier
  // used above must discover and reject every concrete policy/artifact module.
  const api = new API({ cwd: ROOT });
  const snapshot = api.updateSnapshot({
    openProjects: [join(ROOT, "tests/tsconfig.json")],
  });
  const project = snapshot.getProjects()[0]!;
  const source = project.program.getSourceFile(
    join(ROOT, "tests/unit/ctx-adapter-provenance.test.ts"),
  );
  assert.ok(source, "parser did not load its boundary-gate self-check");
  const imported = moduleSpecifiers(source);
  for (const specifier of [
    "../../src/adapter.ts",
    "../../src/codex-harness.ts",
    "../../src/hooks.ts",
    "../../src/lifecycle.ts",
    "../../src/provenance.ts",
    "../../src/status.ts",
    "../../src/upstream-version.ts",
  ]) {
    assert.ok(
      imported.includes(specifier) && isConcreteCodexModule(specifier),
      `concrete import gate missed: ${specifier}`,
    );
  }
  snapshot.dispose();
  api.close();

  const DERIVATIONS = [
    "const adapter = process.env.SPW_ADAPTER;",
    // Prettier's output once the line grows — the form the same-line regex
    // missed, and the reason this gate normalizes first.
    "const adapter =\n  process.env.SPW_ADAPTER ??\n  runAdapter;",
    'const adapter = env["SPW_ADAPTER"];',
    "const ctx = {\n  root,\n  adapter: argv[2] ? load(argv[2]) : runAdapter,\n};",
  ];
  for (const form of DERIVATIONS) {
    assert.ok(
      derivesAdapterFromEnv(form),
      `derivation gate missed: ${JSON.stringify(form)}`,
    );
  }

  // It must NOT fire on the legitimate spellings, or Task 1 cannot land and
  // src/adapter.ts becomes unmaintainable. These three are the ones that
  // nearly broke it.
  const ALLOWED = [
    // src/cli.ts's own construction site: `env: process.env` and
    // `adapter: runAdapter` sit in ONE object literal. Only the `; , { }`
    // bound keeps the pattern from reading across the comma between them.
    "const ctx: CommandContext = {\n  root,\n  env: process.env,\n" +
      "  stdout: process.stdout,\n  adapter: runAdapter,\n};",
    // src/adapter.ts's prose. "adapter" as a word, "env." nearby, no
    // assignment position — the shape that made an unbounded pattern useless.
    "// The adapter replays its messages, then reads env.SUPERPOWERS_CODEX.",
    // The interface declaration itself, which is a TYPE not a derivation.
    "readonly adapter: (argv: readonly string[], ctx: AdapterContext) =>" +
      " Promise<AdapterResult>;",
  ];
  for (const form of ALLOWED) {
    assert.equal(
      derivesAdapterFromEnv(form),
      false,
      `derivation gate false-positives on: ${JSON.stringify(form)}`,
    );
  }
});

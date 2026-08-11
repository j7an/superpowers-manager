// @ts-check
// The seam this slice adds must not become the seam it is removing.
//
// SPW_ADAPTER was settable from outside the process. `ctx.adapter` is an
// interface field, which is not — but only while nothing under src/ reads it
// back out of the environment. Two properties, one file, because they fail
// together: a command module that imports runAdapter has no seam at all, and
// a module that derives the adapter from env has an environment seam wearing
// an interface's clothes.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * @param {string} dir
 * @returns {string[]} repo-relative paths of every .ts file under dir
 */
function tsFiles(dir) {
  /** @type {string[]} */
  const out = [];
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
// `import(...).runAdapter(...)` in the same statement-free stretch. It does
// NOT catch a namespace import used to reach the same binding
// (`import * as adapterMod from "../adapter.js"; … adapterMod.runAdapter(…)`)
// or a re-export (`export { runAdapter } from "../adapter.js";`) — both are
// real imports of `runAdapter` into a command module and would sail through
// this gate uncaught.
void test("no module under src/commands/ imports runAdapter", () => {
  const offenders = tsFiles("src/commands").filter((relative) =>
    /\bimport\b[^;]*\brunAdapter\b/s.test(
      readFileSync(join(ROOT, relative), "utf8"),
    ),
  );
  assert.deepEqual(
    offenders,
    [],
    "a command module importing runAdapter bypasses ctx.adapter, so an " +
      "injected double observes nothing — see spec §4.5",
  );
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

/** @param {string} source @returns {boolean} */
function derivesAdapterFromEnv(source) {
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
  // Mutation proof for BOTH regexes. The first draft of this file proved only
  // the import one, which is how a gate ships passing for the wrong reason —
  // the seam registry's own order-sensitive pattern failed open through 4a
  // for exactly that reason.
  const IMPORTS = [
    'import { runAdapter } from "../adapter.js";',
    'import {\n  runAdapter,\n} from "../adapter.js";',
    'import runAdapter from "../adapter.js";',
  ];
  for (const form of IMPORTS) {
    assert.ok(
      /\bimport\b[^;]*\brunAdapter\b/s.test(form),
      `import gate missed: ${JSON.stringify(form)}`,
    );
  }

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

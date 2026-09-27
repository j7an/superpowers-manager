import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

// Every test runs a copy of the real tests/run.sh in an isolated root, so a
// runner line that stops doing its job fails here instead of silently
// narrowing or passing the shared phase.
const RUN_SH = fileURLToPath(new URL("../run.sh", import.meta.url));
const GATE = fileURLToPath(
  new URL("../assert-matcher-gate.ts", import.meta.url),
);
const PACKAGE_RUNTIME = fileURLToPath(
  new URL("../lib/package-runtime.ts", import.meta.url),
);

function suite(body: string): string {
  return [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'test("fixture", () => {',
    `  ${body}`,
    "});",
    "",
  ].join("\n");
}

const VACUOUS = suite(
  'assert.throws(() => { throw new Error("boom"); }, "a label");',
);
const CONSTRAINED = suite(
  'assert.throws(() => { throw new Error("boom"); }, /boom/);',
);
const FAILING = suite("assert.equal(1, 2);");
const NEEDS_FLAG = suite(
  'assert.equal(process.env.SPW_REQUIRE_PACKAGE_NODE, "1");',
);

type Gate = "copy" | "absent" | "unreadable";

function fixtureRoot(
  t: TestContext,
  files: Readonly<Record<string, string>>,
  gate: Gate = "copy",
): string {
  const root = mkdtempSync(join(tmpdir(), "spw-run-sh-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, "package.json"),
    '{"type":"module","engines":{"node":">=24"}}\n',
  );
  for (const dir of [
    "tests/bin",
    "tests/unit",
    "tests/baseline",
    "tests/lib",
  ]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  copyFileSync(RUN_SH, join(root, "tests", "run.sh"));
  copyFileSync(
    PACKAGE_RUNTIME,
    join(root, "tests", "lib", "package-runtime.ts"),
  );
  const packageNode = join(root, "package-node");
  writeFileSync(packageNode, '#!/bin/sh\nprintf "v24.0.0\\n"\n', "utf8");
  chmodSync(packageNode, 0o755);
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source, "utf8");
  }
  if (gate !== "absent") {
    const copied = join(root, "tests", "assert-matcher-gate.ts");
    copyFileSync(GATE, copied);
    if (gate === "unreadable") chmodSync(copied, 0o000);
  }
  return root;
}

function runScript(
  root: string,
  args: readonly string[] = [],
  environment: NodeJS.ProcessEnv = {},
): { status: number; stdout: string; stderr: string } {
  const env = { ...process.env };
  // Inherited from the outer `node --test`, these make the inner run treat
  // itself as nested and skip every file with exit 0.
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  // CI runs the outer suite with --require-package-node. Inheriting the
  // variable would let the flag test's control case pass without the flag.
  delete env.SPW_REQUIRE_PACKAGE_NODE;
  delete env.SPW_PACKAGE_NODE;
  Object.assign(env, environment);
  const result = spawnSync("sh", [join(root, "tests", "run.sh"), ...args], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

// run.sh exits with its failed count, and the sentinel is its last line.
function assertCompleted(
  r: { status: number; stdout: string },
  failed: 0 | 1,
): void {
  assert.equal(r.status, failed);
  assert.match(
    r.stdout,
    new RegExp(`tests/run\\.sh: complete failed=${failed}\\n$`),
  );
}

void test("run.sh gates a vacuous matcher in a suite it runs", (t) => {
  const root = fixtureRoot(t, { "tests/unit/a.test.ts": VACUOUS });
  const r = runScript(root);
  assertCompleted(r, 1);
  assert.match(r.stdout + r.stderr, /constrains nothing/);
});

void test("run.sh leaves a constraining matcher alone", (t) => {
  // The control. Without it, a gate that rejects everything passes the
  // suite. Exit 0 alone does not distinguish that from a run that executed
  // zero files, so also assert the suite actually ran.
  const root = fixtureRoot(t, { "tests/unit/a.test.ts": CONSTRAINED });
  const r = runScript(root);
  assertCompleted(r, 0);
  assert.match(r.stdout, /pass 1/);
});

void test("run.sh fails closed when the gate module is unreadable", (t) => {
  const root = fixtureRoot(
    t,
    { "tests/unit/a.test.ts": CONSTRAINED },
    "unreadable",
  );
  // A privileged user ignores the permission bit; skip rather than assert a
  // guarantee the environment does not provide.
  let readable = true;
  try {
    readFileSync(join(root, "tests", "assert-matcher-gate.ts"));
  } catch {
    readable = false;
  }
  if (readable) {
    t.skip("cannot make a file unreadable in this environment");
    return;
  }
  assertCompleted(runScript(root), 1);
});

void test("run.sh fails closed when the gate module is absent", (t) => {
  const root = fixtureRoot(
    t,
    { "tests/unit/a.test.ts": CONSTRAINED },
    "absent",
  );
  assertCompleted(runScript(root), 1);
});

void test("run.sh fails when discovery finds no test files", (t) => {
  // node --test exits 0 when it has nothing to run; run.sh must not.
  const root = fixtureRoot(t, {});
  const r = runScript(root);
  assertCompleted(r, 1);
  assert.match(r.stderr, /found no test files/);
});

void test("run.sh fails when discovery cannot read a suite directory", (t) => {
  // A passing suite beside the unreadable directory: if find's error were
  // masked, run.sh would run it and pass a partial tree.
  const root = fixtureRoot(t, { "tests/bin/a.test.ts": CONSTRAINED });
  const locked = join(root, "tests", "unit", "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  try {
    // A privileged user ignores the permission bit; skip rather than assert a
    // guarantee the environment does not provide.
    let readable = true;
    try {
      readdirSync(locked);
    } catch {
      readable = false;
    }
    if (readable) {
      t.skip("cannot make a directory unreadable in this environment");
      return;
    }
    const r = runScript(root);
    assertCompleted(r, 1);
    assert.match(r.stderr, /test discovery failed/);
  } finally {
    // Restored before the fixture's recursive removal, which cannot read it.
    chmodSync(locked, 0o755);
  }
});

void test("one failing file among passing files fails the run", (t) => {
  // The nested passing file also pins recursive discovery: most real suites
  // sit below tests/unit/harnesses/<harness>/.
  const root = fixtureRoot(t, {
    "tests/unit/a.test.ts": CONSTRAINED,
    "tests/bin/b.test.ts": FAILING,
    "tests/baseline/deep/nested/c.test.ts": CONSTRAINED,
  });
  const r = runScript(root);
  assertCompleted(r, 1);
  assert.match(r.stdout, /pass 2/);
  assert.match(r.stdout, /fail 1/);
});

void test("--require-package-node reaches suites as SPW_REQUIRE_PACKAGE_NODE", (t) => {
  const root = fixtureRoot(t, { "tests/unit/a.test.ts": NEEDS_FLAG });
  const flagged = runScript(root, ["--require-package-node"], {
    SPW_PACKAGE_NODE: join(root, "package-node"),
  });
  assertCompleted(flagged, 0);
  assert.match(flagged.stdout, /pass 1/);
  // Control: the same suite fails without the flag, so the pass above is the
  // flag's doing.
  assertCompleted(runScript(root), 1);
});

void test("--require-package-node checks missing and invalid evidence before filtered suites", (t) => {
  const root = fixtureRoot(t, { "tests/unit/a.test.ts": CONSTRAINED });
  const args = ["--require-package-node", "--test-name-pattern", "^NOPE$"];
  const missing = runScript(root, args);
  assertCompleted(missing, 1);
  assert.match(missing.stdout + missing.stderr, /SPW_PACKAGE_NODE is required/);
  const invalid = runScript(root, args, {
    SPW_PACKAGE_NODE: join(root, "fake-node"),
  });
  assertCompleted(invalid, 1);
  assert.match(
    invalid.stdout + invalid.stderr,
    /SPW_PACKAGE_NODE could not be verified/,
  );
});

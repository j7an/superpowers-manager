// @ts-check
// Ported from tests/test_workflows.sh (see
// tests/migration-inventory/workflows.md for the numbered assertion
// inventory this file maps to 1:1).
//
// YAML is parsed by the `yaml` devDependency rather than by a hand-written
// subset parser. See
// docs/superpowers/specs/2026-08-02-pr11.1-workflow-driver-migration-design.md
// section 3.1 for that decision and its evidence.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  actionPinPair,
  collectExternalTargets,
  findLiteralActionPinSnapshots,
  loadWorkflow,
} from "./workflow-support.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WORKFLOW_DIR = join(ROOT, ".github", "workflows");

// --- port-only: the YAML version this project parses under --------------
void test("workflow documents parse under YAML 1.2, keeping `on` a string key", () => {
  const ci = loadWorkflow(join(WORKFLOW_DIR, "ci.yml"));

  assert.ok(
    Object.hasOwn(ci, "on"),
    "expected the string key `on` — YAML 1.2 does not coerce it",
  );
  assert.ok(
    !Object.hasOwn(ci, "true"),
    "found a boolean `true` key: the parser is applying YAML 1.1 `on` coercion",
  );
  assert.equal(typeof ci.on, "object");
});

// --- inventory items 19-22: the external-pin inventory ----------------
// The expected inventory is a fixture this test defines for itself: it
// asserts which workflow references which external target, never which SHA
// that target is pinned to. The SHA is Dependabot's to move; asserting it
// would red-light this test on every unrelated bump.
const EXPECTED_EXTERNAL_PINS = [
  [".github/workflows/ci.yml", "step-security/harden-runner"],
  [".github/workflows/ci.yml", "actions/checkout"],
  [".github/workflows/ci.yml", "actions/setup-node"],
  [
    ".github/workflows/dependency-safety.yml",
    "j7an/shared-workflows/.github/workflows/dependency-safety.yml",
  ],
  [
    ".github/workflows/dependency-safety-non-bot-gate.yml",
    "j7an/shared-workflows/.github/workflows/dependency-safety-non-bot-gate.yml",
  ],
  [
    ".github/workflows/release.yml",
    "j7an/shared-workflows/.github/workflows/publish-npm.yml",
  ],
  [
    ".github/workflows/security.yml",
    "j7an/shared-workflows/.github/workflows/security-scan.yml",
  ],
  [
    ".github/workflows/tag-release.yml",
    "j7an/shared-workflows/.github/workflows/tag-release.yml",
  ],
];

assert.equal(
  EXPECTED_EXTERNAL_PINS.length,
  8,
  "EXPECTED_EXTERNAL_PINS lost or gained a case — update tests/migration-inventory/workflows.md",
);

// --- inventory items 97-98: manifest-fixture shape guards --------------
// The shell's `load_expected_external_pins` parsed a tab-separated manifest
// *file* and raised on a malformed line (item 97) or a duplicate row
// (item 98) — both are claims about tracked repository content
// (`write_expected_external_pins`, a maintainer-edited literal), reinstated
// on controller adjudication. The port has no manifest text to malform —
// EXPECTED_EXTERNAL_PINS is a JS array literal, not parsed from a file — but
// both underlying claims still apply to that literal, and @ts-check does not
// catch either defect: the array is inferred as `string[][]`, not a
// fixed-length tuple type, so a row with the wrong field count or an empty
// field passes typechecking silently.
void test("external-pin manifest fixture entries are well-formed (item 97)", () => {
  for (const [index, entry] of EXPECTED_EXTERNAL_PINS.entries()) {
    assert.equal(
      entry.length,
      2,
      `EXPECTED_EXTERNAL_PINS[${index}] must have exactly two fields (path, target), got ${entry.length}`,
    );
    for (const field of entry) {
      assert.ok(
        typeof field === "string" && field.length > 0,
        `EXPECTED_EXTERNAL_PINS[${index}] has an empty or non-string field`,
      );
    }
  }
});

void test("external-pin manifest fixture has no duplicate entries (item 98)", () => {
  const serialized = EXPECTED_EXTERNAL_PINS.map((pair) => pair.join("\t"));
  assert.equal(
    new Set(serialized).size,
    serialized.length,
    "EXPECTED_EXTERNAL_PINS contains a duplicate (workflow, target) entry",
  );
});

function workflowFiles() {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => ({
      relativePath: `.github/workflows/${name}`,
      absolutePath: join(WORKFLOW_DIR, name),
    }));
}

void test("external action inventory matches the workflows", () => {
  const actual = workflowFiles()
    .flatMap(({ relativePath, absolutePath }) =>
      collectExternalTargets(loadWorkflow(absolutePath), relativePath).map(
        (target) => [relativePath, target],
      ),
    )
    .map((pair) => pair.join("\t"));

  const unique = [...new Set(actual)].sort();
  const expected = EXPECTED_EXTERNAL_PINS.map((pair) => pair.join("\t")).sort();

  assert.deepEqual(unique, expected);
});

void test("every inventoried pin is a semantic 40-hex pin", () => {
  for (const [relativePath, target] of EXPECTED_EXTERNAL_PINS) {
    const block = readFileSync(join(ROOT, relativePath), "utf8");
    // actionPinPair throws unless the reference is a 40-hex lowercase SHA
    // with an agreeing semver comment. Not throwing IS the assertion.
    // Do NOT add `assert.match(pair.sha, /^[0-9a-f]{40}$/)` here: the
    // function already rejects everything that pattern would catch, so the
    // check could never fail — a vacuous assertion inside a suite whose
    // subject is vacuous assertions. Removed 2026-08-02 after review.
    assert.doesNotThrow(
      () => actionPinPair(block, target),
      `${relativePath} does not pin ${target} to an agreeing 40-hex SHA`,
    );
  }
});

void test("all shared-workflows pins agree with one another", () => {
  const shared = EXPECTED_EXTERNAL_PINS.filter(([, target]) =>
    target.startsWith("j7an/shared-workflows/"),
  );
  assert.equal(
    shared.length,
    5,
    "shared-workflows pin count changed — update tests/migration-inventory/workflows.md",
  );

  const pairs = shared.map(([relativePath, target]) =>
    actionPinPair(readFileSync(join(ROOT, relativePath), "utf8"), target),
  );
  for (const pair of pairs) {
    assert.deepEqual(
      pair,
      pairs[0],
      "shared-workflows pins disagree across callers",
    );
  }
});

// --- inventory item 23: the literal-pin source policy -----------------
const POLICY_EXTENSIONS = [".sh", ".py", ".js", ".mjs"];

void test("no test source embeds a literal action pin snapshot", () => {
  const testsDir = join(ROOT, "tests");
  const scanned = readdirSync(testsDir, { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => POLICY_EXTENSIONS.some((ext) => entry.endsWith(ext)))
    .map((entry) => join(testsDir, entry))
    .filter((path) => statSync(path).isFile())
    .sort();

  assert.ok(
    scanned.length > 0,
    "the source-policy scan matched no files — the walk is broken, not the tree clean",
  );

  assert.deepEqual(findLiteralActionPinSnapshots(scanned), []);
});

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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  actionPinPair,
  assertNoForbidden,
  collectExternalTargets,
  findLiteralActionPinSnapshots,
  loadWorkflow,
  uniqueRunStepIndex,
  uniqueStepTargetIndex,
  usesTarget,
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

// --- inventory items 42-71: the CI workflow contract -------------------

/**
 * Assert a value is a non-null object and return it narrowed.
 *
 * The Ruby original raised on a non-mapping; JS optional chaining would
 * yield `undefined` and let a following negative assertion pass trivially.
 *
 * @param {unknown} value
 * @param {string} path
 * @returns {Record<string, any>}
 */
function requireMapping(value, path) {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `expected a mapping at ${path}`,
  );
  return /** @type {Record<string, any>} */ (value);
}

void test("ci.yml declares the expected top-level contract", () => {
  const ci = requireMapping(loadWorkflow(join(WORKFLOW_DIR, "ci.yml")), "ci");

  assert.deepEqual(ci.permissions, {});
  const jobs = requireMapping(ci.jobs, "jobs");
  assert.deepEqual(Object.keys(jobs), ["test", "toolchain"]);
});

void test("ci.yml `test` job runs the container acceptance suite in order", () => {
  const ci = requireMapping(loadWorkflow(join(WORKFLOW_DIR, "ci.yml")), "ci");
  const jobs = requireMapping(ci.jobs, "jobs");
  const testJob = requireMapping(jobs.test, "jobs.test");

  assert.ok(
    !Object.hasOwn(testJob, "continue-on-error"),
    "jobs.test must not use continue-on-error",
  );
  assert.equal(testJob["runs-on"], "ubuntu-latest");
  assert.equal(
    requireMapping(testJob.permissions, "jobs.test.permissions").contents,
    "read",
  );

  const steps = testJob.steps;
  assert.ok(Array.isArray(steps), "expected jobs.test.steps to be an array");

  const hardenIndex = uniqueStepTargetIndex(
    steps,
    "step-security/harden-runner",
  );
  const checkoutIndex = uniqueStepTargetIndex(steps, "actions/checkout");

  /** @type {{ index: number, command: string }[]} */
  const containerInvocations = [];
  steps.forEach((step, index) => {
    if (step === null || typeof step !== "object") return;
    if (typeof step.run !== "string") return;
    for (const line of step.run.split("\n")) {
      const words = line.trim().split(/\s+/).filter(Boolean);
      if (words[0] !== "sh" || words[1] !== "tests/container.sh") continue;
      containerInvocations.push({ index, command: words.join(" ") });
    }
  });

  assert.ok(
    !containerInvocations.some(
      (entry) => entry.command === "sh tests/container.sh codex-spike",
    ),
    "retired codex-spike container invocation is forbidden",
  );
  assert.equal(
    containerInvocations.length,
    1,
    "expected exactly one tests/container.sh invocation",
  );

  const acceptance = containerInvocations[0];
  assert.equal(acceptance.command, "sh tests/container.sh");
  assert.ok(
    hardenIndex < checkoutIndex && checkoutIndex < acceptance.index,
    "expected harden runner, checkout, and container acceptance in that order",
  );

  const harden = requireMapping(steps[hardenIndex], "harden runner step");
  assert.equal(
    requireMapping(harden.with, "harden runner step.with")["egress-policy"],
    "audit",
  );

  const checkout = requireMapping(steps[checkoutIndex], "checkout step");
  assert.equal(
    requireMapping(checkout.with, "checkout step.with")["persist-credentials"],
    false,
  );

  const acceptanceStep = requireMapping(
    steps[acceptance.index],
    "container acceptance step",
  );
  assert.ok(
    !Object.hasOwn(acceptanceStep, "continue-on-error"),
    "container acceptance step must not use continue-on-error",
  );
});

void test("ci.yml `toolchain` job runs the checks in order", () => {
  const ci = requireMapping(loadWorkflow(join(WORKFLOW_DIR, "ci.yml")), "ci");
  const jobs = requireMapping(ci.jobs, "jobs");
  const toolchain = requireMapping(jobs.toolchain, "jobs.toolchain");

  assert.ok(
    !Object.hasOwn(toolchain, "continue-on-error"),
    "jobs.toolchain must not use continue-on-error",
  );
  assert.equal(toolchain["runs-on"], "ubuntu-latest");
  assert.equal(
    requireMapping(toolchain.permissions, "jobs.toolchain.permissions")
      .contents,
    "read",
  );

  const steps = toolchain.steps;
  assert.ok(
    Array.isArray(steps),
    "expected jobs.toolchain.steps to be an array",
  );

  const order = [
    uniqueStepTargetIndex(steps, "step-security/harden-runner"),
    uniqueStepTargetIndex(steps, "actions/checkout"),
    uniqueStepTargetIndex(steps, "actions/setup-node"),
    uniqueRunStepIndex(steps, "corepack enable"),
    uniqueRunStepIndex(steps, "pnpm install --frozen-lockfile"),
    uniqueRunStepIndex(steps, "pnpm run check"),
  ];
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    "toolchain steps are out of order",
  );

  const setupNode = requireMapping(steps[order[2]], "setup-node step");
  assert.equal(
    requireMapping(setupNode.with, "setup-node step.with")["node-version"],
    "24",
  );
});

void test("ci.yml exists and blocking mode creates no compatibility workflow", () => {
  assert.ok(existsSync(join(WORKFLOW_DIR, "ci.yml")));
  assert.ok(
    !existsSync(join(WORKFLOW_DIR, "codex-compatibility.yml")),
    "blocking mode must not create codex-compatibility.yml",
  );
});

// --- inventory items 72-83: the release workflow contract --------------
const EXPECTED_VERIFY_COMMAND = `attempt=1
for delay in 0 30 60 90 120 150; do
  if [ "$delay" -gt 0 ]; then
    echo "npx verification attempt \${attempt}/6: sleeping \${delay}s"
    sleep "$delay"
  else
    echo "npx verification attempt \${attempt}/6: checking before sleep"
  fi
  cache="\${RUNNER_TEMP:-/tmp}/superpowers-manager-npx-\${GITHUB_RUN_ID:-local}-\${GITHUB_RUN_ATTEMPT:-1}-\${attempt}"
  if actual=$(npm_config_cache="$cache" npx --yes "\${PACKAGE}@\${VERSION}" --version); then
    if [ "$actual" = "$VERSION" ]; then
      echo "npx resolved \${PACKAGE}@\${VERSION}"
      exit 0
    fi
    echo "::error::npx resolved \${PACKAGE}@\${VERSION} with unexpected version \${actual}" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
done
echo "::error::npx verification failed after 6 attempts" >&2
exit 1
`;

void test("release.yml triggers only on version tags", () => {
  const release = requireMapping(
    loadWorkflow(join(WORKFLOW_DIR, "release.yml")),
    "release",
  );

  assert.ok(
    Object.hasOwn(release, "on"),
    "expected the string key `on` — YAML 1.2 does not coerce it",
  );
  assert.ok(
    !Object.hasOwn(release, "true"),
    "found a boolean `true` key: the parser is applying YAML 1.1 coercion",
  );

  const push = requireMapping(requireMapping(release.on, "on").push, "on.push");
  assert.deepEqual(push.tags, ["v*.*.*"]);
});

void test("release.yml publish job delegates to the shared workflow", () => {
  const release = requireMapping(
    loadWorkflow(join(WORKFLOW_DIR, "release.yml")),
    "release",
  );
  const publish = requireMapping(
    requireMapping(release.jobs, "jobs").publish,
    "jobs.publish",
  );

  assert.equal(
    usesTarget(publish.uses, "jobs.publish.uses"),
    "j7an/shared-workflows/.github/workflows/publish-npm.yml",
  );

  const permissions = requireMapping(
    publish.permissions,
    "jobs.publish.permissions",
  );
  assert.equal(permissions.contents, "write");
  assert.equal(permissions["id-token"], "write");

  const withBlock = requireMapping(publish.with, "jobs.publish.with");
  assert.equal(withBlock.tag, "${{ github.ref_name }}");
  assert.equal(withBlock["package-name"], "superpowers-manager");
  assert.equal(
    withBlock["test-command"],
    "corepack enable && pnpm install --frozen-lockfile && pnpm run build && sh tests/container.sh",
  );
  assert.equal(
    withBlock["pack-contents-script"],
    "tests/assert_pack_contents.sh",
  );
  assert.equal(withBlock["verify-command"], EXPECTED_VERIFY_COMMAND);
});

void test("release.yml contains no forbidden publish configuration", () => {
  const release = loadWorkflow(join(WORKFLOW_DIR, "release.yml"));
  assert.doesNotThrow(() => assertNoForbidden(release, "workflow"));
});

void test("the forbidden-publish detector rejects a planted violation", () => {
  assert.throws(
    () =>
      assertNoForbidden(
        { jobs: { publish: { run: "npm publish" } } },
        "workflow",
      ),
    /forbidden publish configuration/,
  );
});

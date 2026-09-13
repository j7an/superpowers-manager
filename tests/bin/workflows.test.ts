// Workflow contract tests.
//
// YAML is parsed by the `yaml` devDependency rather than by a hand-written
// subset parser. See
// docs/superpowers/specs/2026-08-02-pr11.1-workflow-driver-migration-design.md
// section 3.1 for that decision and its evidence.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import {
  actionPinPair,
  assertNoForbidden,
  collectExternalTargets,
  findLiteralActionPinSnapshots,
  uniqueRunStepIndex,
  uniqueStepTargetIndex,
  usesTarget,
} from "./workflow-support.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WORKFLOW_DIR = join(ROOT, ".github", "workflows");

// --- port-only: the YAML version this project parses under --------------
void test("workflow documents parse under YAML 1.2, keeping `on` a string key", () => {
  const ci = parse(readFileSync(join(WORKFLOW_DIR, "ci.yml"), "utf8"));

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

// --- the external-pin inventory ----------------------------------------
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
    ".github/workflows/pnpm-packagemanager-update.yml",
    "j7an/shared-workflows/.github/workflows/pnpm-packagemanager-update.yml",
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
      collectExternalTargets(
        parse(readFileSync(absolutePath, "utf8")),
        relativePath,
      ).map((target) => [relativePath, target]),
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
    6,
    "shared-workflows pin count changed; review the shared workflow contract",
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

// --- the literal-pin source policy -------------------------------------
const POLICY_EXTENSIONS = [".sh", ".py", ".js", ".mjs", ".ts"];

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

// --- the CI workflow contract ------------------------------------------

/**
 * Assert a value is a non-null object and return it narrowed.
 *
 * The Ruby original raised on a non-mapping; JS optional chaining would
 * yield `undefined` and let a following negative assertion pass trivially.
 *
 */
function requireMapping(value: unknown, path: string): Record<string, any> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `expected a mapping at ${path}`,
  );
  return value as Record<string, any>;
}

function assertNoNativeSelectorEnv(
  scope: Record<string, any>,
  path: string,
): void {
  if (!Object.hasOwn(scope, "env")) return;

  const env = requireMapping(scope.env, `${path}.env`);
  assert.ok(
    !Object.hasOwn(env, "SPW_NATIVE_NODE_VERSION"),
    `${path}.env must not set SPW_NATIVE_NODE_VERSION`,
  );
}

const FULL_SHARED_PACKAGE_ALIASES = new Set([
  "test",
  "check",
  "test:acceptance",
]);
const NATIVE_COMPATIBILITY_COMMAND = `${[
  "node --import ./tests/assert-matcher-gate.ts --test tests/bin/native-source.test.ts",
  "node --import ./tests/assert-matcher-gate.ts --test tests/bin/assert-matcher-gate.test.ts",
  "node --import ./tests/assert-matcher-gate.ts --test --test-name-pattern='^(compiler failure yields no package metadata or artifact|one staged package is delivered and all staging is removed)$' tests/bin/pack.test.ts",
].join("\n")}\n`;

const RELEASE_CLASSIFIER_JOB = "classify-release";
const RELEASE_TEST_CONDITION =
  "${{ !cancelled() && (needs.classify-release.result != 'success' || needs.classify-release.outputs.skip_tests != 'true') }}";
const RELEASE_CONCURRENCY_GROUP =
  "${{ github.workflow }}-${{ github.ref }}-${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && github.actor_id == '275375463' && github.actor == 'shared-workflows-release-bot[bot]' && 'release-bot' || 'ordinary' }}";

function isFullSharedCommandLine(line: string): boolean {
  const words = line.trim().split(/\s+/).filter(Boolean);
  if (words[0] === "sh" && words[1] === "tests/run.sh") return true;
  if (words[0] !== "pnpm") return false;

  const alias = words[1] === "run" ? words[2] : words[1];
  return FULL_SHARED_PACKAGE_ALIASES.has(alias);
}

void test("ci.yml declares the expected top-level contract", () => {
  const ci = requireMapping(
    parse(readFileSync(join(WORKFLOW_DIR, "ci.yml"), "utf8")),
    "ci",
  );

  assertNoNativeSelectorEnv(ci, "ci");
  assert.equal(requireMapping(ci.on, "ci.on").pull_request, null);
  assert.deepEqual(requireMapping(ci.on, "ci.on").push.branches, ["main"]);
  assert.equal(
    requireMapping(ci.concurrency, "ci.concurrency").group,
    RELEASE_CONCURRENCY_GROUP,
  );
  assert.equal(
    requireMapping(ci.concurrency, "ci.concurrency")["cancel-in-progress"],
    true,
  );
  assert.deepEqual(ci.permissions, {});
  const jobs = requireMapping(ci.jobs, "jobs");

  const classifier = requireMapping(
    jobs[RELEASE_CLASSIFIER_JOB],
    "jobs.classify-release",
  );
  assert.equal(classifier.if, "github.event_name == 'push'");
  assert.equal(classifier["runs-on"], "ubuntu-latest");
  assert.deepEqual(classifier.permissions, { contents: "read" });
  assert.equal(
    classifier.outputs.skip_tests,
    "${{ steps.classify.outputs.skip_tests }}",
  );
  const classifierSteps = classifier.steps;
  assert.ok(
    Array.isArray(classifierSteps),
    "expected jobs.classify-release.steps to be an array",
  );
  assert.equal(
    classifierSteps.length,
    4,
    "classifier must run only harden, checkout, setup, and classification",
  );
  const classifierHarden = requireMapping(
    classifierSteps[0],
    "classifier harden step",
  );
  const classifierCheckout = requireMapping(
    classifierSteps[1],
    "classifier checkout step",
  );
  const classifierSetup = requireMapping(
    classifierSteps[2],
    "classifier setup step",
  );
  const classification = requireMapping(
    classifierSteps[3],
    "classification step",
  );
  const harness = requireMapping(jobs["harness-codex"], "jobs.harness-codex");
  const harnessSteps = harness.steps as unknown[];
  const harnessHarden = requireMapping(harnessSteps[0], "harness harden step");
  const harnessCheckout = requireMapping(
    harnessSteps[1],
    "harness checkout step",
  );
  assert.equal(
    classifierHarden.uses,
    harnessHarden.uses,
    "classifier must reuse the existing harden-runner pin",
  );
  assert.equal(
    classifierCheckout.uses,
    harnessCheckout.uses,
    "classifier must reuse the existing checkout pin",
  );
  assert.equal(
    classifierSetup.uses,
    requireMapping(
      requireMapping(jobs.toolchain, "jobs.toolchain").steps[4],
      "toolchain setup step",
    ).uses,
    "classifier must reuse the existing setup-node pin",
  );
  assert.deepEqual(
    classifierHarden.with,
    harnessHarden.with,
    "classifier must retain the harness hardening configuration",
  );
  assert.equal(
    requireMapping(classifierCheckout.with, "classifier checkout.with")[
      "persist-credentials"
    ],
    false,
  );
  assert.equal(
    requireMapping(classifierCheckout.with, "classifier checkout.with")[
      "fetch-depth"
    ],
    0,
  );
  assert.equal(
    requireMapping(classifierCheckout.with, "classifier checkout.with").ref,
    "${{ github.sha }}",
  );
  assert.equal(
    requireMapping(classifierSetup.with, "classifier setup.with")[
      "node-version"
    ],
    "24",
  );
  assert.equal(classification.id, "classify");
  assert.equal(classification.run, "node tests/tools/classify-release-bump.ts");
  for (const key of ["harness-codex", "harness-pi", "toolchain"]) {
    const job = requireMapping(jobs[key], `jobs.${key}`);
    assert.deepEqual(job.permissions, { contents: "read" });
    assert.equal(job.needs, RELEASE_CLASSIFIER_JOB);
    assert.equal(job.if, RELEASE_TEST_CONDITION);
    assert.ok(!Object.hasOwn(job, "continue-on-error"));
  }
});

type HarnessJobContract = {
  readonly key: "harness-codex" | "harness-pi";
  readonly name: string;
  readonly selector: string;
};

const HARNESS_JOBS: readonly HarnessJobContract[] = [
  {
    key: "harness-codex",
    name: "Codex harness integration",
    selector: "harness-codex",
  },
  {
    key: "harness-pi",
    name: "Pi harness integration",
    selector: "harness-pi",
  },
];

function validateCiHarnessJob(
  document: unknown,
  contract: HarnessJobContract,
): void {
  const ci = requireMapping(document, "ci");
  const jobs = requireMapping(ci.jobs, "jobs");
  const path = `jobs.${contract.key}`;
  const harnessJob = requireMapping(jobs[contract.key], path);

  assert.ok(
    !Object.hasOwn(harnessJob, "continue-on-error"),
    `${path} must not use continue-on-error`,
  );
  assert.equal(harnessJob.if, RELEASE_TEST_CONDITION);
  assert.equal(harnessJob.needs, RELEASE_CLASSIFIER_JOB);
  assertNoNativeSelectorEnv(harnessJob, path);
  assert.equal(harnessJob.name, contract.name);
  assert.equal(harnessJob["runs-on"], "ubuntu-latest");
  assert.equal(
    requireMapping(harnessJob.permissions, `${path}.permissions`).contents,
    "read",
  );

  assert.ok(
    !Object.hasOwn(harnessJob, "strategy"),
    `${contract.name} must run once at the container's latest-24 default`,
  );

  const steps = harnessJob.steps;
  assert.ok(Array.isArray(steps), `expected ${path}.steps to be an array`);
  const expectedCommand = `sh tests/container.sh ${contract.selector}`;
  const commands = steps.flatMap((candidate, index) => {
    const step = requireMapping(candidate, `${path}.steps[${index}]`);
    return typeof step.run === "string" ? [{ index, command: step.run }] : [];
  });
  assert.deepEqual(
    commands.map(({ command }) => command),
    [expectedCommand],
    `${path} must contain only its integration-only harness command`,
  );
  steps.forEach((candidate, index) => {
    const step = requireMapping(candidate, `${path}.steps[${index}]`);
    assertNoNativeSelectorEnv(step, `${path}.steps[${index}]`);
    assert.ok(
      !Object.hasOwn(step, "continue-on-error"),
      `${path}.steps[${index}] must remain blocking`,
    );
  });

  const hardenIndex = uniqueStepTargetIndex(
    steps,
    "step-security/harden-runner",
  );
  const checkoutIndex = uniqueStepTargetIndex(steps, "actions/checkout");

  const acceptance = commands[0];
  assert.ok(
    hardenIndex < checkoutIndex && checkoutIndex < acceptance.index,
    `expected harden runner, checkout, and ${contract.name} in that order`,
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

  const checkoutWith = requireMapping(checkout.with, "checkout step.with");
  const depth = checkoutWith["fetch-depth"];
  assert.ok(
    depth === undefined || depth === 1,
    "harness checkout must be shallow",
  );

  const acceptanceStep = requireMapping(
    steps[acceptance.index],
    "container acceptance step",
  );
  assert.ok(
    !Object.hasOwn(acceptanceStep, "env"),
    `${contract.name} must use tests/container.sh's latest-24 default`,
  );
  assert.ok(
    !Object.hasOwn(acceptanceStep, "if"),
    `${contract.name} must run in the PR job`,
  );
}

void test("ci.yml native harness jobs run one independent integration each", async (t) => {
  const ci = parse(readFileSync(join(WORKFLOW_DIR, "ci.yml"), "utf8"));
  for (const contract of HARNESS_JOBS) {
    await t.test(`${contract.name} has its isolated selector`, () => {
      assert.doesNotThrow(() => validateCiHarnessJob(ci, contract));
    });

    await t.test(contract.name + " rejects unnecessary full history", () => {
      const mutant = structuredClone(ci);
      const jobs = requireMapping(requireMapping(mutant, "ci").jobs, "jobs");
      const job = requireMapping(jobs[contract.key], "harness job");
      const steps = job.steps as Record<string, unknown>[];
      const checkout = requireMapping(
        steps[uniqueStepTargetIndex(steps, "actions/checkout")],
        "checkout step",
      );
      requireMapping(checkout.with, "checkout step.with")["fetch-depth"] = 0;
      assert.throws(
        () => validateCiHarnessJob(mutant, contract),
        /harness checkout must be shallow/,
      );
    });

    await t.test(
      `${contract.name} rejects the combined container suite`,
      () => {
        const mutant = structuredClone(ci);
        const steps = requireMapping(
          requireMapping(requireMapping(mutant, "ci").jobs, "jobs")[
            contract.key
          ],
          `jobs.${contract.key}`,
        ).steps as unknown[];
        const integration = steps.find(
          (step) =>
            typeof step === "object" &&
            step !== null &&
            typeof (step as Record<string, unknown>).run === "string",
        ) as Record<string, unknown>;
        integration.run = "sh tests/container.sh";
        assert.throws(
          () => validateCiHarnessJob(mutant, contract),
          /integration-only harness command/,
        );
      },
    );

    await t.test(`${contract.name} rejects a duplicate shared suite`, () => {
      const mutant = structuredClone(ci);
      const harnessJob = requireMapping(
        requireMapping(requireMapping(mutant, "ci").jobs, "jobs")[contract.key],
        `jobs.${contract.key}`,
      );
      (harnessJob.steps as unknown[]).push({ run: "pnpm test" });
      assert.throws(
        () => validateCiHarnessJob(mutant, contract),
        /integration-only harness command/,
      );
    });

    await t.test(`${contract.name} rejects nonblocking execution`, () => {
      const mutant = structuredClone(ci);
      const harnessJob = requireMapping(
        requireMapping(requireMapping(mutant, "ci").jobs, "jobs")[contract.key],
        `jobs.${contract.key}`,
      );
      harnessJob["continue-on-error"] = true;
      assert.throws(
        () => validateCiHarnessJob(mutant, contract),
        new RegExp(
          `jobs\\.${contract.key} must not use continue-on-error`.replaceAll(
            "-",
            "\\-",
          ),
        ),
      );
    });
  }
});

function validateCiToolchain(document: unknown): void {
  const ci = requireMapping(document, "ci");
  const jobs = requireMapping(ci.jobs, "jobs");
  const toolchain = requireMapping(jobs.toolchain, "jobs.toolchain");

  assert.ok(
    !Object.hasOwn(toolchain, "continue-on-error"),
    "jobs.toolchain must not use continue-on-error",
  );
  assert.equal(toolchain.if, RELEASE_TEST_CONDITION);
  assert.equal(toolchain.needs, RELEASE_CLASSIFIER_JOB);
  assertNoNativeSelectorEnv(toolchain, "jobs.toolchain");
  assert.equal(toolchain["runs-on"], "ubuntu-latest");
  assert.equal(
    requireMapping(toolchain.permissions, "jobs.toolchain.permissions")
      .contents,
    "read",
  );

  const strategy: Record<string, unknown> = requireMapping(
    toolchain.strategy,
    "jobs.toolchain.strategy",
  );
  assert.equal(strategy["fail-fast"], false);
  const matrix: Record<string, unknown> = requireMapping(
    strategy.matrix,
    "jobs.toolchain.strategy.matrix",
  );
  assert.deepEqual(matrix.include, [
    { native: "24.12.0", static: false },
    { native: "24", static: true },
  ]);

  const steps = toolchain.steps;
  assert.ok(
    Array.isArray(steps),
    "expected jobs.toolchain.steps to be an array",
  );

  steps.forEach((candidate, index) => {
    const step = requireMapping(candidate, `jobs.toolchain.steps[${index}]`);
    assertNoNativeSelectorEnv(step, `jobs.toolchain.steps[${index}]`);
    assert.ok(
      !Object.hasOwn(step, "continue-on-error"),
      `jobs.toolchain.steps[${index}] must remain blocking`,
    );
  });

  const setups = steps.filter(
    (step: any) =>
      typeof step.uses === "string" &&
      usesTarget(step.uses, "setup.uses") === "actions/setup-node",
  );
  assert.equal(setups.length, 2, "expected exactly two setup-node steps");
  const packageSetup = setups.find((step: any) => step.if === "matrix.static");
  assert.ok(
    packageSetup,
    "package minimum setup must run only on matrix.static",
  );
  const mainSetup = setups.find(
    (step: any) =>
      !Object.hasOwn(step, "if") &&
      requireMapping(step.with, "main setup.with")["node-version"] ===
        "${{ matrix.native }}",
  );
  assert.ok(mainSetup, "main setup must restore the matrix native runtime");

  const packageManifest = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  );
  const packageEngine = packageManifest.engines.node;
  const minimum = `${/^>=(\d+)$/.exec(packageEngine)![1]}.0.0`;
  const packageScripts = requireMapping(
    packageManifest.scripts,
    "package.json scripts",
  );
  for (const alias of FULL_SHARED_PACKAGE_ALIASES) {
    assert.equal(
      typeof packageScripts[alias],
      "string",
      `full shared package alias must remain registered: ${alias}`,
    );
  }
  const packageWith = requireMapping(packageSetup.with, "package setup.with");
  assert.equal(packageWith["node-version"], minimum);
  assert.equal(packageWith["package-manager-cache"], false);
  const mainWith = requireMapping(mainSetup.with, "main setup.with");
  assert.equal(mainWith["node-version"], "${{ matrix.native }}");
  assert.equal(mainWith["check-latest"], "${{ matrix.static }}");
  assert.equal(
    packageSetup.uses,
    mainSetup.uses,
    "setup-node steps must use the same semantic pin",
  );

  const captureSteps = steps.filter(
    (step: any) =>
      typeof step.run === "string" && step.run.includes("SPW_PACKAGE_NODE="),
  );
  assert.equal(
    captureSteps.length,
    1,
    "expected exactly one package minimum runtime capture",
  );
  const capture = requireMapping(captureSteps[0], "package runtime capture");
  assert.equal(
    capture.if,
    "matrix.static",
    "package runtime capture must run only on matrix.static",
  );
  assert.match(capture.run, /require\("\.\/package\.json"\)\.engines\.node/);
  assert.match(capture.run, /process\.execPath/);
  assert.match(capture.run, /process\.versions\.node/);
  assert.match(capture.run, /SPW_PACKAGE_NODE=%s\\n/);
  assert.match(capture.run, /SPW_PACKAGE_NODE_VERSION=%s\\n/);
  assert.equal(
    (capture.run.match(/>> "\$GITHUB_ENV"/g) ?? []).length,
    2,
    "capture must persist both the absolute executable and observed version",
  );

  const nativeCompatibilitySteps = steps.filter(
    (step) =>
      step !== null &&
      typeof step === "object" &&
      typeof (step as Record<string, unknown>).run === "string" &&
      (step as Record<string, string>).run.includes(
        "tests/bin/native-source.test.ts",
      ),
  );
  assert.equal(
    nativeCompatibilitySteps.length,
    1,
    "expected exactly one focused native compatibility step",
  );
  const nativeCompatibility = requireMapping(
    nativeCompatibilitySteps[0],
    "native compatibility step",
  );
  assert.equal(
    nativeCompatibility.if,
    "matrix.native == '24.12.0'",
    "native compatibility must run only at the supported source floor",
  );
  assert.deepEqual(
    nativeCompatibility.run,
    NATIVE_COMPATIBILITY_COMMAND,
    "native compatibility must run the source, gate, and package producer checks",
  );

  const sharedInvocations = steps.flatMap((step: any, index) =>
    typeof step.run === "string"
      ? step.run
          .split("\n")
          .filter(isFullSharedCommandLine)
          .map((command: string) => ({ command, index }))
      : [],
  );
  assert.equal(
    sharedInvocations.length,
    1,
    "expected exactly one full shared invocation",
  );
  const sharedInvocation = sharedInvocations[0];
  const shared = requireMapping(
    steps[sharedInvocation.index],
    "full shared step",
  );
  assert.equal(
    shared.run,
    "sh tests/run.sh --require-package-node",
    "full shared run must require package-minimum evidence without narrowing",
  );
  assert.equal(
    shared.if,
    "matrix.static",
    "full shared run must run only on matrix.static",
  );

  assert.ok(
    !steps.some(
      (step: any) =>
        typeof step.run === "string" &&
        (step.run.includes("tests/bin/tooling-coverage.test.ts") ||
          step.run.includes("tests/bin/citations.test.ts")),
    ),
    "toolchain must not duplicate standalone tooling or citation suites",
  );

  const order = [
    uniqueStepTargetIndex(steps, "step-security/harden-runner"),
    uniqueStepTargetIndex(steps, "actions/checkout"),
    steps.indexOf(packageSetup),
    steps.indexOf(captureSteps[0]),
    steps.indexOf(mainSetup),
    uniqueRunStepIndex(steps, "corepack enable"),
    uniqueRunStepIndex(steps, "pnpm install --frozen-lockfile"),
    steps.indexOf(nativeCompatibilitySteps[0]),
    uniqueRunStepIndex(steps, "pnpm run check:static"),
    sharedInvocation.index,
  ];
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    "toolchain steps are out of order",
  );
  for (const index of order.slice(6)) {
    const step = requireMapping(steps[index], "toolchain validation step");
    if (index === order[7]) {
      assert.equal(
        step.if,
        "matrix.native == '24.12.0'",
        "native compatibility runs only at the source floor",
      );
    } else if (index === order[8] || index === order[9]) {
      assert.equal(
        step.if,
        "matrix.static",
        "static and Git-backed checks run on latest native only",
      );
    } else {
      assert.ok(!Object.hasOwn(step, "if"), "installation must always run");
    }
  }

  const checkout = requireMapping(steps[order[1]], "toolchain checkout step");
  assert.equal(
    requireMapping(checkout.with, "toolchain checkout step.with")[
      "fetch-depth"
    ],
    0,
  );
  for (const candidate of steps) {
    const step: Record<string, unknown> = requireMapping(
      candidate,
      "toolchain step",
    );
    if (typeof step.run === "string") {
      assert.doesNotMatch(step.run, /\bpnpm run (?:build|check)(?:\s|$)/);
    }
  }
}

void test("ci.yml `toolchain` job runs one full shared suite in order", async (t) => {
  const ci = parse(readFileSync(join(WORKFLOW_DIR, "ci.yml"), "utf8"));
  assert.doesNotThrow(() => validateCiToolchain(ci));

  function toolchainSteps(document: unknown): Record<string, any>[] {
    const steps = requireMapping(
      requireMapping(requireMapping(document, "ci").jobs, "jobs").toolchain,
      "jobs.toolchain",
    ).steps;
    assert.ok(
      Array.isArray(steps),
      "expected jobs.toolchain.steps to be an array",
    );
    return steps;
  }

  await t.test("rejects a missing package runtime capture", () => {
    const mutant = structuredClone(ci);
    const steps = toolchainSteps(mutant);
    const index = steps.findIndex(
      (step) =>
        typeof step.run === "string" && step.run.includes("SPW_PACKAGE_NODE="),
    );
    steps.splice(index, 1);
    assert.throws(
      () => validateCiToolchain(mutant),
      /exactly one package minimum runtime capture/,
    );
  });

  await t.test("rejects capture after the matrix runtime setup", () => {
    const mutant = structuredClone(ci);
    const steps = toolchainSteps(mutant);
    const captureIndex = steps.findIndex(
      (step) =>
        typeof step.run === "string" && step.run.includes("SPW_PACKAGE_NODE="),
    );
    const capture = steps.splice(captureIndex, 1)[0];
    const mainIndex = steps.findIndex(
      (step) => step.with?.["node-version"] === "${{ matrix.native }}",
    );
    steps.splice(mainIndex + 1, 0, capture);
    assert.throws(() => validateCiToolchain(mutant), /steps are out of order/);
  });

  await t.test(
    "rejects a package capture without the latest-only condition",
    () => {
      const mutant = structuredClone(ci);
      const capture = toolchainSteps(mutant).find(
        (step) =>
          typeof step.run === "string" &&
          step.run.includes("SPW_PACKAGE_NODE="),
      )!;
      delete capture.if;
      assert.throws(
        () => validateCiToolchain(mutant),
        /capture must run only on matrix.static/,
      );
    },
  );

  for (const [name, command] of [
    [
      "a narrowed shared group",
      "sh tests/run.sh --group unit --require-package-node",
    ],
    ["shared tests without package evidence", "sh tests/run.sh"],
  ] as const) {
    await t.test(`rejects ${name}`, () => {
      const mutant = structuredClone(ci);
      const shared = toolchainSteps(mutant).find(
        (step) =>
          typeof step.run === "string" &&
          /\bsh tests\/run\.sh\b/.test(step.run),
      )!;
      shared.run = command;
      assert.throws(
        () => validateCiToolchain(mutant),
        /must require package-minimum evidence without narrowing/,
      );
    });
  }

  for (const command of [
    "pnpm test",
    "pnpm run test",
    "pnpm run check",
    "pnpm run test:acceptance",
  ]) {
    await t.test(`rejects duplicate full shared alias: ${command}`, () => {
      const mutant = structuredClone(ci);
      toolchainSteps(mutant).push({ if: "matrix.static", run: command });
      assert.throws(
        () => validateCiToolchain(mutant),
        /expected exactly one full shared invocation/,
      );
    });
  }

  await t.test("rejects a duplicate standalone tooling run", () => {
    const mutant = structuredClone(ci);
    toolchainSteps(mutant).push({
      if: "matrix.static",
      run: "node --test tests/bin/tooling-coverage.test.ts tests/bin/citations.test.ts",
    });
    assert.throws(
      () => validateCiToolchain(mutant),
      /must not duplicate standalone tooling or citation suites/,
    );
  });

  await t.test("rejects a nonblocking toolchain step", () => {
    const mutant = structuredClone(ci);
    toolchainSteps(mutant).find(
      (step) => step.run === "pnpm run check:static",
    )!["continue-on-error"] = true;
    assert.throws(() => validateCiToolchain(mutant), /must remain blocking/);
  });

  await t.test("rejects weakened native-floor coverage", () => {
    const mutant = structuredClone(ci);
    const native = toolchainSteps(mutant).find(
      (step) =>
        typeof step.run === "string" &&
        step.run.includes("tests/bin/native-source.test.ts"),
    )!;
    native.run = native.run
      .split("\n")
      .filter(
        (line: string) =>
          !line.includes("tests/bin/assert-matcher-gate.test.ts"),
      )
      .join("\n");
    assert.throws(
      () => validateCiToolchain(mutant),
      /native compatibility must run the source, gate, and package producer checks/,
    );
  });
});

void test("ci.yml exists and blocking mode creates no compatibility workflow", () => {
  assert.ok(existsSync(join(WORKFLOW_DIR, "ci.yml")));
  assert.ok(
    !existsSync(join(WORKFLOW_DIR, "codex-compatibility.yml")),
    "blocking mode must not create codex-compatibility.yml",
  );
});

void test("pnpm packageManager updates delegate on the weekly and manual triggers", () => {
  const workflow = requireMapping(
    parse(
      readFileSync(
        join(WORKFLOW_DIR, "pnpm-packagemanager-update.yml"),
        "utf8",
      ),
    ),
    "pnpm packageManager update workflow",
  );
  const triggers = requireMapping(workflow.on, "on");

  assert.deepEqual(Object.keys(triggers).sort(), [
    "schedule",
    "workflow_dispatch",
  ]);
  assert.deepEqual(triggers.schedule, [{ cron: "0 6 * * 1" }]);
  assert.deepEqual(triggers.workflow_dispatch ?? {}, {});
  assert.deepEqual(workflow.permissions, {});

  const jobs = requireMapping(workflow.jobs, "jobs");
  const update = requireMapping(jobs.update, "jobs.update");
  assert.deepEqual(update.permissions, {
    contents: "write",
    "pull-requests": "write",
    statuses: "write",
  });
  assert.equal(
    usesTarget(update.uses, "jobs.update.uses"),
    "j7an/shared-workflows/.github/workflows/pnpm-packagemanager-update.yml",
  );
  assert.deepEqual(requireMapping(update.secrets, "jobs.update.secrets"), {
    RELEASE_BOT_PRIVATE_KEY: "${{ secrets.RELEASE_BOT_PRIVATE_KEY }}",
  });
  assert.equal(
    requireMapping(update.with, "jobs.update.with").minimum_release_age_days,
    5,
  );
});

// --- the release workflow contract -------------------------------------
type VerifyScenario = {
  readonly name: string;
  readonly failures: number;
  readonly wrong: number;
  readonly status: number;
  readonly calls: number;
  readonly sleeps: readonly string[];
};

const VERIFY_SCENARIOS: readonly VerifyScenario[] = [
  {
    name: "immediate success",
    failures: 0,
    wrong: 0,
    status: 0,
    calls: 1,
    sleeps: [],
  },
  {
    name: "retry succeeds",
    failures: 2,
    wrong: 0,
    status: 0,
    calls: 3,
    sleeps: ["30", "60"],
  },
  {
    name: "wrong version fails immediately",
    failures: 0,
    wrong: 1,
    status: 1,
    calls: 1,
    sleeps: [],
  },
  {
    name: "bounded exhaustion",
    failures: 6,
    wrong: 0,
    status: 1,
    calls: 6,
    sleeps: ["30", "60", "90", "120", "150"],
  },
];

function runVerifyCommand(
  t: test.TestContext,
  command: string,
  scenario: VerifyScenario,
) {
  const root = mkdtempSync(join(tmpdir(), "spw-release-verify-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const calls = join(root, "calls");
  const caches = join(root, "caches");
  const sleeps = join(root, "sleeps");
  mkdirSync(bin);
  mkdirSync(home);
  writeFileSync(calls, "0\n");
  writeFileSync(caches, "");
  writeFileSync(sleeps, "");
  const npx = join(bin, "npx");
  const sleep = join(bin, "sleep");
  writeFileSync(
    npx,
    `#!/bin/sh
set -eu
count=$(cat "$SPW_NPX_CALLS")
count=$((count + 1))
printf '%s\\n' "$count" > "$SPW_NPX_CALLS"
printf '%s\\n' "$npm_config_cache" >> "$SPW_CACHE_LOG"
test "$1" = --yes
test "$2" = "$PACKAGE@$VERSION"
test "$3" = --version
if [ "$count" -le "$SPW_NPX_FAILURES" ]; then exit 1; fi
if [ "$SPW_NPX_WRONG" = 1 ]; then
  printf '%s\\n' wrong-version
else
  printf '%s\\n' "$VERSION"
fi
`,
  );
  writeFileSync(
    sleep,
    `#!/bin/sh
set -eu
printf '%s\\n' "$1" >> "$SPW_SLEEP_LOG"
`,
  );
  chmodSync(npx, 0o755);
  chmodSync(sleep, 0o755);
  assert.ok(statSync(npx).mode & 0o111, "fake npx must be executable");

  const result = spawnSync("/bin/sh", ["-eu", "-c", command], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home,
      RUNNER_TEMP: root,
      GITHUB_RUN_ID: "release-test",
      GITHUB_RUN_ATTEMPT: "2",
      PACKAGE: "superpowers-manager",
      VERSION: "1.2.3",
      SPW_NPX_CALLS: calls,
      SPW_CACHE_LOG: caches,
      SPW_SLEEP_LOG: sleeps,
      SPW_NPX_FAILURES: String(scenario.failures),
      SPW_NPX_WRONG: String(scenario.wrong),
    },
    timeout: 5_000,
  });
  return {
    ...result,
    root,
    calls: Number(readFileSync(calls, "utf8").trim()),
    caches: readFileSync(caches, "utf8").trim().split("\n").filter(Boolean),
    sleeps: readFileSync(sleeps, "utf8").trim().split("\n").filter(Boolean),
  };
}

void test("release.yml triggers only on version tags", () => {
  const release = requireMapping(
    parse(readFileSync(join(WORKFLOW_DIR, "release.yml"), "utf8")),
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

void test("release.yml publish job delegates to the shared workflow", async (t) => {
  const release = requireMapping(
    parse(readFileSync(join(WORKFLOW_DIR, "release.yml"), "utf8")),
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
    "corepack enable && pnpm install --frozen-lockfile && pnpm run check:static && SPW_NATIVE_NODE_VERSION=24.12.0 sh tests/container.sh && SPW_NATIVE_NODE_VERSION=24 sh tests/container.sh",
  );
  assert.equal(
    withBlock["pack-command"],
    "node tests/tools/pack.ts --out-dir .",
  );
  assert.equal(withBlock["package-dir"] ?? ".", ".");
  assert.equal(
    withBlock["pack-contents-script"],
    "tests/assert_pack_contents.sh",
  );
  const command = withBlock["verify-command"];
  assert.equal(
    typeof command,
    "string",
    "verify-command must be a shell script",
  );

  for (const scenario of VERIFY_SCENARIOS) {
    await t.test(`verify-command ${scenario.name}`, () => {
      const result = runVerifyCommand(t, command, scenario);
      assert.equal(
        result.error,
        undefined,
        "the shell must launch successfully",
      );
      assert.equal(
        result.signal,
        null,
        "verification must not time out or signal",
      );
      assert.equal(result.status, scenario.status);
      assert.equal(result.calls, scenario.calls);
      assert.deepEqual(result.sleeps, scenario.sleeps);
      assert.equal(result.caches.length, scenario.calls);
      assert.equal(new Set(result.caches).size, scenario.calls);
      assert.ok(
        result.caches.every((cache) =>
          cache.startsWith(
            `${result.root}/superpowers-manager-npx-release-test-2-`,
          ),
        ),
        "each npx attempt must use the invocation-specific cache root",
      );

      const stdout = result.stdout.toString();
      const stderr = result.stderr.toString();
      if (scenario.wrong) {
        assert.match(stderr, /unexpected version wrong-version/);
        assert.doesNotMatch(stderr, /failed after 6 attempts/);
      } else if (scenario.failures === 6) {
        assert.match(stderr, /failed after 6 attempts/);
        assert.doesNotMatch(stderr, /unexpected version/);
      } else {
        assert.match(stdout, /npx resolved superpowers-manager@1\.2\.3/);
      }
    });
  }
});

void test("release.yml contains no forbidden publish configuration", () => {
  const release = parse(
    readFileSync(join(WORKFLOW_DIR, "release.yml"), "utf8"),
  );
  // Establish the document is a mapping BEFORE asserting nothing forbidden
  // is in it. `assertNoForbidden` returns without throwing on null/undefined
  // — neither matches its object, array, or string branch — so without this
  // guard the assertion below would pass vacuously against an empty parse.
  // Same rule this suite enforces everywhere: a negative assertion must
  // first establish the node it negates about exists.
  requireMapping(release, "workflow");
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

// --- the tag-release workflow contract ---------------------------------
const EXPECTED_BUMP_OPTIONS = ["auto", "patch", "minor", "major"];
const STABLE_SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function bumpOptions(document: unknown): string[] {
  const inputs = requireMapping(
    requireMapping(requireMapping(document, "workflow").on, "on")
      .workflow_dispatch,
    "on.workflow_dispatch",
  ).inputs;
  const bump = requireMapping(
    requireMapping(inputs, "on.workflow_dispatch.inputs").bump,
    "on.workflow_dispatch.inputs.bump",
  );
  assert.ok(
    Array.isArray(bump.options),
    "expected on.workflow_dispatch.inputs.bump.options to be a sequence",
  );
  return bump.options;
}

function parseStableSemver(value: unknown, label: string): string {
  if (typeof value !== "string" || !STABLE_SEMVER.test(value)) {
    throw new Error(`${label} is not stable semver: ${JSON.stringify(value)}`);
  }
  return value;
}

void test("tag-release.yml wires the shared tag-release workflow", () => {
  const tagRelease = requireMapping(
    parse(readFileSync(join(WORKFLOW_DIR, "tag-release.yml"), "utf8")),
    "tag-release",
  );

  const on = requireMapping(tagRelease.on, "on");
  assert.ok(
    Object.hasOwn(on, "workflow_dispatch"),
    "tag-release.yml must be manually dispatchable",
  );
  const bump = requireMapping(
    requireMapping(on.workflow_dispatch, "on.workflow_dispatch").inputs,
    "on.workflow_dispatch.inputs",
  ).bump;
  assert.equal(
    requireMapping(bump, "on.workflow_dispatch.inputs.bump").type,
    "choice",
  );
  assert.equal(
    requireMapping(bump, "on.workflow_dispatch.inputs.bump").required,
    true,
  );
  assert.equal(
    requireMapping(bump, "on.workflow_dispatch.inputs.bump").default,
    "auto",
  );

  const tagJob = requireMapping(
    requireMapping(tagRelease.jobs, "jobs").tag,
    "jobs.tag",
  );
  const withBlock = requireMapping(tagJob.with, "jobs.tag.with");
  assert.equal(withBlock.bump, "${{ inputs.bump }}");
  assert.equal(withBlock["tag-prefix"], "v");

  const secrets = requireMapping(tagJob.secrets, "jobs.tag.secrets");
  assert.equal(
    secrets.RELEASE_BOT_PRIVATE_KEY,
    "${{ secrets.RELEASE_BOT_PRIVATE_KEY }}",
  );
});

void test("tag-release.yml exposes the bump input contract", async (t) => {
  const tagRelease = parse(
    readFileSync(join(WORKFLOW_DIR, "tag-release.yml"), "utf8"),
  );
  await t.test("allows only the supported choices", () => {
    assert.deepEqual(bumpOptions(tagRelease), EXPECTED_BUMP_OPTIONS);
  });

  await t.test("reads bump rather than a sibling input", () => {
    const fixture = parse(`on:
  workflow_dispatch:
    inputs:
      unrelated:
        options: [auto, patch, minor, major]
      bump:
        options: [auto, patch, minor, major, prerelease]
`);
    assert.deepEqual(bumpOptions(fixture), [
      ...EXPECTED_BUMP_OPTIONS,
      "prerelease",
    ]);
  });

  await t.test("rejects duplicate bump option keys", () => {
    assert.throws(
      () =>
        parse(`on:
  workflow_dispatch:
    inputs:
      bump:
        options: [auto]
        options: [patch]
`),
      /Map keys must be unique/,
    );
  });
});

void test(".version-bump.json declares the package.json version field", () => {
  const bump = JSON.parse(
    readFileSync(join(ROOT, ".version-bump.json"), "utf8"),
  );
  assert.deepEqual(bump, {
    files: [{ path: "package.json", field: "version" }],
  });
});

void test("package.json carries stable manager and harness discovery metadata", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(manifest.name, "superpowers-manager");
  // Shape only. The literal version is the release workflow's to move.
  parseStableSemver(manifest.version, "package.json version");
  assert.match(manifest.description, /\bCodex\b/);
  assert.match(manifest.description, /\bPi\b/);

  const keywords = manifest.keywords;
  assert.ok(Array.isArray(keywords), "package.json keywords must be an array");
  assert.equal(
    new Set(keywords).size,
    keywords.length,
    "keywords must be unique",
  );
  for (const keyword of [
    "superpowers",
    "obra-superpowers",
    "agent-skills",
    "ai-coding-agent",
    "coding-agent",
    "agent-harness",
    "codex",
    "codex-plugin",
    "plugin-manager",
    "cli",
    "installer",
    "updater",
    "pi",
    "pi-coding-agent",
  ]) {
    assert.ok(
      keywords.includes(keyword),
      `missing discovery keyword: ${keyword}`,
    );
  }

  assert.equal(
    manifest.scripts["test:harness:codex"],
    "sh tests/container.sh harness-codex",
  );
  assert.equal(
    manifest.scripts["test:harness:pi"],
    "sh tests/container.sh harness-pi",
  );
  assert.equal(manifest.scripts["test:acceptance"], "sh tests/acceptance.sh");
});

void test("the stable-semver check rejects a prerelease", () => {
  assert.throws(
    () => parseStableSemver("1.2.3-beta.1", "test version"),
    /not stable semver/,
  );
});

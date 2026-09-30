// Workflow contract tests.
//
// YAML is parsed by the `yaml` devDependency rather than by a hand-written
// subset parser.

import { scratch } from "../lib/scratch.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import {
  assertNoForbidden,
  collectExternalTargets,
  findLiteralActionPinSnapshots,
  uniqueStepTargetIndex,
  usesTarget,
} from "./workflow-support.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WORKFLOW_DIR = join(ROOT, ".github", "workflows");

// --- action pins --------------------------------------------------------
// Every external `uses:` is pinned to a full commit SHA with a version
// comment, and every shared-workflows caller carries the same pin. Only the
// form is asserted: the SHAs are Dependabot's to move, and asserting one
// would red-light this test on every unrelated bump.
const USES_LINE = /^\s*(?:-\s+)?uses:\s*/;
const PINNED_USES =
  /^\s*(?:-\s+)?uses:\s*(["']?)([^@\s"']+)@([0-9a-f]{40})\1 # (v\d+\.\d+\.\d+)$/;

function workflowFiles() {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => ({
      relativePath: `.github/workflows/${name}`,
      absolutePath: join(WORKFLOW_DIR, name),
    }));
}

void test("every external action is pinned to a commit SHA with a version comment", () => {
  let total = 0;
  const sharedPins = new Set<string>();
  for (const { relativePath, absolutePath } of workflowFiles()) {
    const text = readFileSync(absolutePath, "utf8");
    let external = 0;
    text.split("\n").forEach((line, index) => {
      if (!USES_LINE.test(line)) return;
      const value = line.replace(USES_LINE, "").replace(/^["']/, "");
      if (value.startsWith("./")) return;
      external += 1;
      const pin = PINNED_USES.exec(line);
      assert.ok(
        pin,
        `${relativePath}:${index + 1} is not pinned to a commit SHA with a version comment`,
      );
      if (pin[2].startsWith("j7an/shared-workflows/")) {
        sharedPins.add(`${pin[3]} # ${pin[4]}`);
      }
    });
    // A `uses:` the line scan cannot see (a flow mapping, say) must fail
    // here rather than escape the pin check.
    assert.equal(
      external,
      collectExternalTargets(parse(text), relativePath).length,
      `${relativePath} has an external uses: the line scan did not check`,
    );
    total += external;
  }
  assert.ok(
    total > 0,
    "the pin scan matched no uses: lines — the scan is broken, not the tree clean",
  );
  assert.equal(
    sharedPins.size,
    1,
    `shared-workflows callers must share one pin; found ${sharedPins.size}`,
  );
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

void test("ci.yml declares the expected top-level contract", () => {
  const ci = requireMapping(
    parse(readFileSync(join(WORKFLOW_DIR, "ci.yml"), "utf8")),
    "ci",
  );

  // PR-only is the contract: strict up-to-date merges make post-merge CI
  // redundant, and Release validates the tagged commit.
  assert.deepEqual(ci.on, { pull_request: null });
  assert.equal(
    requireMapping(ci.concurrency, "ci.concurrency").group,
    "${{ github.workflow }}-${{ github.ref }}",
  );
  assert.equal(
    requireMapping(ci.concurrency, "ci.concurrency")["cancel-in-progress"],
    true,
  );
  assert.deepEqual(ci.permissions, {});
  const jobs = requireMapping(ci.jobs, "jobs");

  assert.deepEqual(Object.keys(jobs), ["harness", "toolchain", "coverage"]);
  for (const key of ["harness", "toolchain", "coverage"]) {
    const job = requireMapping(jobs[key], `jobs.${key}`);
    assert.deepEqual(job.permissions, { contents: "read" });
    assert.ok(!Object.hasOwn(job, "needs"));
    assert.ok(!Object.hasOwn(job, "if"));
    assert.ok(!Object.hasOwn(job, "continue-on-error"));
  }
});

// One matrix job runs every native harness integration. The include list is
// the contract: each entry is one isolated `tests/container.sh` selector.
const HARNESS_MATRIX = [
  { name: "Codex", selector: "harness-codex" },
  { name: "Pi", selector: "harness-pi" },
  { name: "OpenCode", selector: "harness-opencode" },
  { name: "Claude Code", selector: "harness-claude-code" },
];

void test("ci.yml harness matrix runs one independent integration per selector", () => {
  const ci = requireMapping(
    parse(readFileSync(join(WORKFLOW_DIR, "ci.yml"), "utf8")),
    "ci",
  );
  const jobs = requireMapping(ci.jobs, "jobs");
  const path = "jobs.harness";
  const harnessJob = requireMapping(jobs.harness, path);

  assert.ok(
    !Object.hasOwn(harnessJob, "continue-on-error"),
    `${path} must not use continue-on-error`,
  );
  assert.equal(harnessJob.name, "${{ matrix.name }} harness integration");
  assert.equal(harnessJob["runs-on"], "ubuntu-latest");
  assert.equal(
    requireMapping(harnessJob.permissions, `${path}.permissions`).contents,
    "read",
  );

  const strategy = requireMapping(harnessJob.strategy, `${path}.strategy`);
  assert.equal(strategy["fail-fast"], false);
  assert.deepEqual(
    requireMapping(strategy.matrix, `${path}.strategy.matrix`),
    { include: HARNESS_MATRIX },
    "each harness integration runs once at the container's latest-24 default",
  );

  const steps = harnessJob.steps;
  assert.ok(Array.isArray(steps), `expected ${path}.steps to be an array`);
  const commands = steps.flatMap((candidate, index) => {
    const step = requireMapping(candidate, `${path}.steps[${index}]`);
    return typeof step.run === "string" ? [{ index, command: step.run }] : [];
  });
  assert.deepEqual(
    commands.map(({ command }) => command),
    ['sh tests/container.sh "$SPW_HARNESS_SELECTOR"'],
    `${path} must contain only its integration-only harness command`,
  );
  steps.forEach((candidate, index) => {
    const step = requireMapping(candidate, `${path}.steps[${index}]`);
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
    "expected harden runner, checkout, and the harness integration in that order",
  );

  const harden = requireMapping(steps[hardenIndex], "harden runner step");
  assert.equal(
    requireMapping(harden.with, "harden runner step.with")["egress-policy"],
    "audit",
  );

  const checkout = requireMapping(steps[checkoutIndex], "checkout step");
  const checkoutWith = requireMapping(checkout.with, "checkout step.with");
  assert.equal(checkoutWith["persist-credentials"], false);
  const depth = checkoutWith["fetch-depth"];
  assert.ok(
    depth === undefined || depth === 1,
    "harness checkout must be shallow",
  );

  const acceptanceStep = requireMapping(
    steps[acceptance.index],
    "container acceptance step",
  );
  // The selector is the only environment the step may carry.
  assert.deepEqual(
    acceptanceStep.env,
    { SPW_HARNESS_SELECTOR: "${{ matrix.selector }}" },
    "harness step env must carry only the matrix selector",
  );
  assert.ok(
    !Object.hasOwn(acceptanceStep, "if"),
    "the harness integration must run in the PR job",
  );
});

void test("ci.yml `toolchain` job runs one full shared suite in order", () => {
  const ci = requireMapping(
    parse(readFileSync(join(WORKFLOW_DIR, "ci.yml"), "utf8")),
    "ci",
  );
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

  assert.ok(
    !Object.hasOwn(toolchain, "strategy"),
    "jobs.toolchain runs once at latest Node 24",
  );

  const steps = toolchain.steps;
  assert.ok(
    Array.isArray(steps),
    "expected jobs.toolchain.steps to be an array",
  );

  steps.forEach((candidate, index) => {
    const step = requireMapping(candidate, `jobs.toolchain.steps[${index}]`);
    assert.ok(
      !Object.hasOwn(step, "continue-on-error"),
      `jobs.toolchain.steps[${index}] must remain blocking`,
    );
    assert.ok(
      !Object.hasOwn(step, "if"),
      `jobs.toolchain.steps[${index}] must run unconditionally`,
    );
  });

  const setups = steps.filter(
    (step: any) =>
      typeof step.uses === "string" &&
      usesTarget(step.uses, "setup.uses") === "actions/setup-node",
  );
  assert.equal(setups.length, 2, "expected exactly two setup-node steps");
  const packageEngine = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  ).engines.node;
  const minimum = `${/^>=(\d+)$/.exec(packageEngine)![1]}.0.0`;
  const packageSetup = setups.find(
    (step: any) =>
      requireMapping(step.with, "package setup.with")["node-version"] ===
      minimum,
  );
  assert.ok(packageSetup, "package minimum setup must install engines.node");
  const mainSetup = setups.find(
    (step: any) =>
      requireMapping(step.with, "main setup.with")["node-version"] === "24",
  );
  assert.ok(mainSetup, "main setup must restore latest Node 24");
  const packageWith = requireMapping(packageSetup.with, "package setup.with");
  assert.equal(packageWith["node-version"], minimum);
  assert.equal(packageWith["package-manager-cache"], false);
  const mainWith = requireMapping(mainSetup.with, "main setup.with");
  assert.equal(mainWith["check-latest"], true);

  // The run steps are the job's contract: one package-minimum capture, then
  // exactly one full shared suite that requires that evidence. The exact
  // list also rejects a duplicate, narrowed, or standalone suite run.
  const [capture, ...commands] = steps.filter(
    (step: any) => typeof step.run === "string",
  );
  assert.deepEqual(
    commands.map((step: any) => step.run),
    [
      "corepack enable",
      "pnpm install --frozen-lockfile",
      "pnpm run check:static",
      "sh tests/run.sh --require-package-node",
    ],
  );
  assert.match(capture.run, /require\("\.\/package\.json"\)\.engines\.node/);
  assert.match(capture.run, /process\.execPath/);
  assert.match(capture.run, /process\.versions\.node/);
  assert.match(capture.run, /SPW_PACKAGE_NODE=%s\\n/);
  assert.equal(
    (capture.run.match(/>> "\$GITHUB_ENV"/g) ?? []).length,
    1,
    "capture must persist only the absolute package-minimum executable",
  );
  // Nothing else may run inside the capture step: every line is the runtime
  // check or one of its GITHUB_ENV writes, so no suite command can hide there
  // and escape the exact list above.
  for (const line of capture.run.trim().split("\n")) {
    assert.match(
      line,
      /^(?:node -e '[^']*'|printf 'SPW_PACKAGE_NODE\w*=%s\\n' "\$\(node -p '[\w.]+'\)" >> "\$GITHUB_ENV")$/,
      `package runtime capture must not run other commands: ${line}`,
    );
  }

  const order = [
    uniqueStepTargetIndex(steps, "step-security/harden-runner"),
    uniqueStepTargetIndex(steps, "actions/checkout"),
    steps.indexOf(packageSetup),
    steps.indexOf(capture),
    steps.indexOf(mainSetup),
    steps.indexOf(commands[0]),
  ];
  assert.ok(
    order.every((index, i) => i === 0 || order[i - 1] < index),
    "toolchain steps are out of order",
  );

  const checkout = requireMapping(steps[order[1]], "toolchain checkout step");
  assert.equal(
    requireMapping(checkout.with, "toolchain checkout step.with")[
      "fetch-depth"
    ],
    0,
  );
});

// The coverage job runs the shared suite once and gates it twice: Node
// enforces a total line floor over src/, and the shared action enforces
// changed-line coverage from the same LCOV report. Thresholds are asserted
// numeric rather than exact: they are policy, and moving one is a reviewed
// workflow diff, not a contract break.
void test("ci.yml `coverage` job gates total and changed-line coverage of src/", () => {
  const ci = requireMapping(
    parse(readFileSync(join(WORKFLOW_DIR, "ci.yml"), "utf8")),
    "ci",
  );
  const jobs = requireMapping(ci.jobs, "jobs");
  const coverage = requireMapping(jobs.coverage, "jobs.coverage");
  assert.equal(coverage["runs-on"], "ubuntu-latest");
  assert.ok(
    !Object.hasOwn(coverage, "strategy"),
    "jobs.coverage measures once at latest Node 24",
  );

  const steps = coverage.steps;
  assert.ok(
    Array.isArray(steps),
    "expected jobs.coverage.steps to be an array",
  );
  steps.forEach((candidate, index) => {
    const step = requireMapping(candidate, `jobs.coverage.steps[${index}]`);
    assert.ok(
      !Object.hasOwn(step, "continue-on-error"),
      `jobs.coverage.steps[${index}] must remain blocking`,
    );
    assert.ok(
      !Object.hasOwn(step, "if"),
      `jobs.coverage.steps[${index}] must run unconditionally`,
    );
  });

  const checkoutIndex = uniqueStepTargetIndex(steps, "actions/checkout");
  const checkoutWith = requireMapping(
    steps[checkoutIndex].with,
    "coverage checkout step.with",
  );
  assert.equal(checkoutWith["persist-credentials"], false);
  // diff-cover needs the merge base with the PR base commit.
  assert.equal(checkoutWith["fetch-depth"], 0);

  const setupIndex = uniqueStepTargetIndex(steps, "actions/setup-node");
  const setupWith = requireMapping(
    steps[setupIndex].with,
    "coverage setup-node step.with",
  );
  assert.equal(setupWith["node-version"], "24");
  assert.equal(setupWith["check-latest"], true);

  const runIndex = (pattern: RegExp, label: string) => {
    const matches = steps.flatMap((step: any, index: number) =>
      typeof step.run === "string" && pattern.test(step.run) ? [index] : [],
    );
    assert.equal(matches.length, 1, `expected exactly one ${label} step`);
    return matches[0];
  };
  const installIndex = runIndex(/pnpm install --frozen-lockfile/, "install");
  const diffCoverIndex = runIndex(/pip install 'diff-cover/, "diff-cover");
  const suiteIndex = runIndex(/^sh tests\/run\.sh /, "suite");

  const diffCover = steps[diffCoverIndex].run;
  assert.match(diffCover, /python3 -m venv "\$RUNNER_TEMP\/diff-cover"/);
  assert.match(
    diffCover,
    /DIFF_COVER_PATH=%s\\n' "\$RUNNER_TEMP\/diff-cover\/bin\/diff-cover" >> "\$GITHUB_ENV"/,
  );

  const flags = steps[suiteIndex].run.replace(/\\\n/g, " ").trim().split(/\s+/);
  assert.ok(flags.includes("--experimental-test-coverage"));
  assert.ok(
    flags.includes("'--test-coverage-include=src/**'"),
    "the total floor must measure src/ only, not test files",
  );
  const floor = flags
    .map((flag: string) => /^--test-coverage-lines=(\d+)$/.exec(flag))
    .filter(Boolean);
  assert.equal(floor.length, 1, "expected exactly one total line floor");
  assert.ok(Number(floor[0]![1]) > 0 && Number(floor[0]![1]) <= 100);
  const lcov = flags.indexOf("--test-reporter=lcov");
  assert.ok(lcov >= 0, "the suite must emit an LCOV report");
  const destination = /^--test-reporter-destination=(.+)$/.exec(
    flags[lcov + 1],
  );
  assert.ok(destination, "the LCOV reporter must name its destination");

  const gateIndex = uniqueStepTargetIndex(
    steps,
    "j7an/shared-workflows/actions/coverage",
  );
  const gate = requireMapping(steps[gateIndex].with, "coverage gate.with");
  assert.equal(gate["report-path"], destination[1]);
  assert.equal(gate["diff-cover-path"], "${{ env.DIFF_COVER_PATH }}");
  assert.equal(gate["base-sha"], "${{ github.event.pull_request.base.sha }}");
  assert.match(gate.minimum, /^\d+$/);
  assert.ok(Number(gate.minimum) > 0 && Number(gate.minimum) <= 100);
  assert.equal(gate["source-paths"], "src/");
  assert.ok(
    !Object.hasOwn(gate, "exclude-paths"),
    "every src/ file is judged by changed-line coverage",
  );

  const order = [
    uniqueStepTargetIndex(steps, "step-security/harden-runner"),
    checkoutIndex,
    setupIndex,
    installIndex,
    diffCoverIndex,
    suiteIndex,
    gateIndex,
  ];
  assert.ok(
    order.every((index, i) => i === 0 || order[i - 1] < index),
    "coverage steps are out of order",
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
  const root = scratch(t, "spw-release-verify-");
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
    "corepack enable && pnpm install --frozen-lockfile && pnpm run check:static",
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

void test("release.yml validates the container suite before publish", () => {
  const release = requireMapping(
    parse(readFileSync(join(WORKFLOW_DIR, "release.yml"), "utf8")),
    "release",
  );
  const jobs = requireMapping(release.jobs, "jobs");
  const validate = requireMapping(jobs.validate, "jobs.validate");
  assert.ok(Array.isArray(validate.steps), "expected jobs.validate.steps");
  assert.ok(
    validate.steps.some(
      (step: unknown) =>
        requireMapping(step, "jobs.validate.steps[]").run ===
        "sh tests/container.sh",
    ),
    "validate must run tests/container.sh",
  );
  const publish = requireMapping(jobs.publish, "jobs.publish");
  const needs = Array.isArray(publish.needs) ? publish.needs : [publish.needs];
  assert.ok(needs.includes("validate"), "publish must depend on validate");
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
  assert.deepEqual(
    requireMapping(bump, "on.workflow_dispatch.inputs.bump").options,
    EXPECTED_BUMP_OPTIONS,
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
  assert.match(manifest.version, STABLE_SEMVER);
  assert.match(manifest.description, /\bCodex\b/);
  assert.match(manifest.description, /\bPi\b/);
  assert.match(manifest.description, /\bOpenCode\b/);
  assert.match(manifest.description, /\bClaude Code\b/);

  const keywords = manifest.keywords;
  assert.ok(Array.isArray(keywords), "package.json keywords must be an array");
  // Exact set is the contract: each harness gets its bare name, `<harness>-skills`,
  // and its native artifact term, except `pi-package`, which opts into Pi's
  // package gallery for a CLI `pi install` cannot use. Order is free.
  assert.deepEqual(
    [...(keywords as string[])].sort(),
    [
      "superpowers",
      "obra-superpowers",
      "agent-skills",
      "skills",
      "ai-agent",
      "ai-coding-agent",
      "coding-agent",
      "agent-harness",
      "cli",
      "installer",
      "updater",
      "plugin-manager",
      "version-manager",
      "version-pinning",
      "codex",
      "openai-codex",
      "codex-plugin",
      "codex-skills",
      "pi",
      "pi-coding-agent",
      "pi-skills",
      "opencode",
      "opencode-plugin",
      "opencode-skills",
      "claude",
      "claude-code",
      "claude-code-plugin",
      "claude-code-skills",
    ].sort(),
  );

  assert.equal(
    manifest.scripts["test:harness:codex"],
    "sh tests/container.sh harness-codex",
  );
  assert.equal(
    manifest.scripts["test:harness:pi"],
    "sh tests/container.sh harness-pi",
  );
  assert.equal(
    manifest.scripts["test:harness:opencode"],
    "sh tests/container.sh harness-opencode",
  );
  assert.equal(
    manifest.scripts["test:harness:claude-code"],
    "sh tests/container.sh harness-claude-code",
  );
  assert.equal(manifest.scripts["test:acceptance"], "sh tests/acceptance.sh");
});

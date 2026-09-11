import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  classifyReleaseBump,
  type ClassificationInput,
} from "../tools/classify-release-bump.ts";

const BOT_LOGIN = "shared-workflows-release-bot[bot]";
const BOT_ID = "275375463";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TOOL = join(ROOT, "tests", "tools", "classify-release-bump.ts");

interface FixtureOptions {
  beforePackage?: string;
  afterPackage?: string | null;
  beforeConfig?: string;
  afterConfig?: string | null;
  extraAfter?: Record<string, string>;
  packageMode?: number;
  packageSymlink?: boolean;
  topology?: "single" | "two-commit" | "merge";
}

interface Fixture {
  cwd: string;
  before: string;
  after: string;
  input: ClassificationInput;
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function packageText(version: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: "release-fixture",
    private: true,
    version,
    ...extra,
  });
}

function bumpConfig() {
  return JSON.stringify({
    files: [{ path: "package.json", field: "version" }],
  });
}

function fixture(t: test.TestContext, options: FixtureOptions = {}): Fixture {
  const cwd = mkdtempSync(join(tmpdir(), "spw-release-bump-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const afterPackage =
    options.afterPackage === undefined
      ? packageText("1.2.4")
      : options.afterPackage;
  const afterConfig =
    options.afterConfig === undefined
      ? (options.beforeConfig ?? bumpConfig())
      : options.afterConfig;
  git(cwd, "init", "--quiet", "--initial-branch=main");
  git(cwd, "config", "user.name", "release fixture");
  git(cwd, "config", "user.email", "release-fixture@example.invalid");
  git(cwd, "config", "commit.gpgsign", "false");
  writeFileSync(
    join(cwd, "package.json"),
    options.beforePackage ?? packageText("1.2.3"),
  );
  writeFileSync(
    join(cwd, ".version-bump.json"),
    options.beforeConfig ?? bumpConfig(),
  );
  if (options.packageSymlink && afterPackage !== null) {
    writeFileSync(join(cwd, "package-target.json"), afterPackage);
  }
  git(cwd, "add", ".");
  git(cwd, "commit", "--quiet", "-m", "base");
  const before = git(cwd, "rev-parse", "HEAD");

  if (afterPackage === null) {
    git(cwd, "rm", "--quiet", "package.json");
  } else if (options.packageSymlink) {
    rmSync(join(cwd, "package.json"));
    symlinkSync("package-target.json", join(cwd, "package.json"));
  } else {
    writeFileSync(join(cwd, "package.json"), afterPackage);
    if (options.packageMode !== undefined)
      chmodSync(join(cwd, "package.json"), options.packageMode);
  }
  if (afterConfig === null) git(cwd, "rm", "--quiet", ".version-bump.json");
  else writeFileSync(join(cwd, ".version-bump.json"), afterConfig);
  for (const [path, content] of Object.entries(options.extraAfter ?? {})) {
    writeFileSync(join(cwd, path), content);
  }
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "-m", "release bump");

  if (options.topology === "two-commit") {
    git(cwd, "commit", "--quiet", "--allow-empty", "-m", "second commit");
  }
  if (options.topology === "merge") {
    git(cwd, "branch", "side", before);
    git(cwd, "checkout", "--quiet", "side");
    git(cwd, "commit", "--quiet", "--allow-empty", "-m", "side commit");
    git(cwd, "checkout", "--quiet", "main");
    git(cwd, "merge", "--quiet", "--no-ff", "side", "-m", "merge side");
  }
  const after = git(cwd, "rev-parse", "HEAD");
  const input: ClassificationInput = {
    cwd,
    eventName: "push",
    actor: BOT_LOGIN,
    actorId: BOT_ID,
    event: {
      ref: "refs/heads/main",
      before,
      after,
      forced: false,
      created: false,
      deleted: false,
      sender: { login: BOT_LOGIN, id: Number(BOT_ID), type: "Bot" },
    },
  };
  return { cwd, before, after, input };
}

function classify(t: test.TestContext, options?: FixtureOptions) {
  const current = fixture(t, options);
  return { current, result: classifyReleaseBump(current.input) };
}

void test("verified bot release bump skips tests", (t) => {
  const { result } = classify(t);
  assert.deepEqual(result, {
    skipTests: true,
    reason: "verified-release-bump",
  });
});

void test("formatting-only package changes and multi-digit increases skip tests", (t) => {
  const { result } = classify(t, {
    beforePackage:
      '{"name":"release-fixture","private":true,"version":"12.34.56"}',
    afterPackage:
      '{\n  "name": "release-fixture",\n  "private": true,\n  "version": "12.34.57"\n}\n',
  });
  assert.equal(result.skipTests, true);
});

void test("event and identity mismatches do not skip tests", (t) => {
  const { current } = classify(t);
  const invalid: Array<Partial<ClassificationInput>> = [
    { eventName: "pull_request" },
    { eventName: "workflow_dispatch" },
    { actor: "human" },
    { actorId: "0" },
    { actorId: "" },
    { event: null },
    {
      event: { ...(current.input.event as object), ref: "refs/heads/feature" },
    },
    {
      event: {
        ...(current.input.event as object),
        sender: { login: "human", id: Number(BOT_ID), type: "Bot" },
      },
    },
    {
      event: {
        ...(current.input.event as object),
        sender: { id: Number(BOT_ID), type: "Bot" },
      },
    },
    {
      event: {
        ...(current.input.event as object),
        sender: { login: BOT_LOGIN, id: 0, type: "Bot" },
      },
    },
    {
      event: {
        ...(current.input.event as object),
        sender: { login: BOT_LOGIN, type: "Bot" },
      },
    },
    {
      event: {
        ...(current.input.event as object),
        sender: { login: BOT_LOGIN, id: Number(BOT_ID), type: "User" },
      },
    },
    {
      event: {
        ...(current.input.event as object),
        sender: { login: BOT_LOGIN, id: Number(BOT_ID) },
      },
    },
  ];
  for (const change of invalid) {
    assert.equal(
      classifyReleaseBump({ ...current.input, ...change }).skipTests,
      false,
    );
  }
});

void test("push flags must all be explicitly false", (t) => {
  const { current } = classify(t);
  for (const flag of ["forced", "created", "deleted"] as const) {
    const event = {
      ...(current.input.event as Record<string, unknown>),
      [flag]: true,
    };
    assert.equal(
      classifyReleaseBump({ ...current.input, event }).skipTests,
      false,
    );
    delete event[flag];
    assert.equal(
      classifyReleaseBump({ ...current.input, event }).skipTests,
      false,
    );
  }
});

void test("invalid push revisions do not skip tests", (t) => {
  const { current } = classify(t);
  for (const [field, value] of [
    ["before", "0".repeat(40)],
    ["after", "1".repeat(39)],
    ["before", "not-a-sha"],
    ["before", undefined],
    ["after", undefined],
  ] as const) {
    const event = {
      ...(current.input.event as Record<string, unknown>),
      [field]: value,
    };
    assert.equal(
      classifyReleaseBump({ ...current.input, event }).skipTests,
      false,
    );
  }
});

for (const [name, options] of [
  ["a two-commit push", { topology: "two-commit" }],
  ["a merge commit", { topology: "merge" }],
  ["an additional changed file", { extraAfter: { "README.md": "changed\n" } }],
  ["a deleted package", { afterPackage: null }],
  [
    "a renamed package",
    {
      afterPackage: null,
      extraAfter: { "renamed-package.json": packageText("1.2.4") },
    },
  ],
  ["an executable package", { packageMode: 0o755 }],
  ["a symlink package", { packageSymlink: true }],
  [
    "an additional package field",
    { afterPackage: packageText("1.2.4", { description: "changed" }) },
  ],
  ["a missing bump config", { afterConfig: null }],
  ["an invalid base bump config", { beforeConfig: "{}" }],
  [
    "an expanded bump config",
    {
      afterConfig: JSON.stringify({
        files: [
          { path: "package.json", field: "version" },
          { path: "other", field: "version" },
        ],
      }),
    },
  ],
  [
    "a changed bump config",
    {
      afterConfig: JSON.stringify({
        files: [{ path: "package.json", field: "name" }],
      }),
    },
  ],
  ["a malformed bump config", { afterConfig: "{" }],
  ["malformed package json", { afterPackage: "{" }],
  ["non-object package json", { afterPackage: "[]" }],
  [
    "an equal version",
    {
      afterPackage:
        '{\n  "name": "release-fixture",\n  "private": true,\n  "version": "1.2.3"\n}\n',
    },
  ],
  ["a decreasing version", { afterPackage: packageText("1.2.2") }],
  ["a prerelease version", { afterPackage: packageText("1.2.4-beta.1") }],
  ["a leading-zero version", { afterPackage: packageText("01.2.4") }],
  ["an invalid version", { afterPackage: packageText("nope") }],
] as const) {
  void test(`unverified change: ${name} does not skip tests`, (t) => {
    const { result } = classify(t, options);
    assert.equal(result.skipTests, false);
  });
}

for (const [name, config] of [
  ["malformed", "{"],
  [
    "expanded",
    JSON.stringify({
      files: [
        { path: "package.json", field: "version" },
        { path: "other", field: "version" },
      ],
    }),
  ],
  [
    "wrong-field",
    JSON.stringify({ files: [{ path: "package.json", field: "name" }] }),
  ],
] as const) {
  void test(`unchanged ${name} bump config is rejected after package-only diff`, (t) => {
    const current = fixture(t, { beforeConfig: config });
    assert.equal(
      git(current.cwd, "diff", "--name-only", current.before, current.after),
      "package.json",
    );
    assert.deepEqual(classifyReleaseBump(current.input), {
      skipTests: false,
      reason: "unverified-change",
    });
  });
}

void test("a package symlink is rejected after a package-only diff", (t) => {
  const current = fixture(t, { packageSymlink: true });
  assert.equal(
    git(current.cwd, "diff", "--name-only", current.before, current.after),
    "package.json",
  );
  assert.deepEqual(classifyReleaseBump(current.input), {
    skipTests: false,
    reason: "unverified-change",
  });
});

void test("a checkout mismatch does not skip tests", (t) => {
  const { current } = classify(t);
  git(
    current.cwd,
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "advance checkout",
  );
  assert.equal(classifyReleaseBump(current.input).skipTests, false);
});

void test("the classifier reports an inspection failure for a missing commit", (t) => {
  const { current } = classify(t);
  const event = {
    ...(current.input.event as Record<string, unknown>),
    after: "a".repeat(40),
  };
  assert.deepEqual(classifyReleaseBump({ ...current.input, event }), {
    skipTests: false,
    reason: "inspection-failed",
  });
});

void test("the cli writes a verified true output and summary", (t) => {
  const current = fixture(t);
  const eventPath = join(current.cwd, "event.json");
  const outputPath = join(current.cwd, "output.txt");
  const summaryPath = join(current.cwd, "summary.txt");
  writeFileSync(eventPath, JSON.stringify(current.input.event));
  const invocation = execFileSync(process.execPath, [TOOL], {
    cwd: current.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: "push",
      GITHUB_ACTOR: BOT_LOGIN,
      GITHUB_ACTOR_ID: BOT_ID,
      GITHUB_OUTPUT: outputPath,
      GITHUB_STEP_SUMMARY: summaryPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(invocation, "");
  assert.equal(readFileSync(outputPath, "utf8"), "skip_tests=true\n");
  assert.match(readFileSync(summaryPath, "utf8"), /verified release bump/i);
});

void test("the cli writes false for a negative, malformed, and unreadable event", (t) => {
  for (const eventText of ["{", JSON.stringify({ ref: "refs/heads/main" })]) {
    const { cwd } = fixture(t);
    const eventPath = join(cwd, "event.json");
    const outputPath = join(cwd, "output.txt");
    const summaryPath = join(cwd, "summary.txt");
    writeFileSync(eventPath, eventText);
    execFileSync(process.execPath, [TOOL], {
      cwd,
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
      },
      stdio: "pipe",
    });
    assert.equal(readFileSync(outputPath, "utf8"), "skip_tests=false\n");
  }
  const { cwd } = fixture(t);
  const outputPath = join(cwd, "output.txt");
  const summaryPath = join(cwd, "summary.txt");
  const unreadable = join(cwd, "event-directory");
  mkdirSync(unreadable);
  execFileSync(process.execPath, [TOOL], {
    cwd,
    env: {
      ...process.env,
      GITHUB_EVENT_PATH: unreadable,
      GITHUB_OUTPUT: outputPath,
      GITHUB_STEP_SUMMARY: summaryPath,
    },
    stdio: "pipe",
  });
  assert.equal(readFileSync(outputPath, "utf8"), "skip_tests=false\n");
});

void test("the cli fails with fixed diagnostics when output or summary cannot be written", (t) => {
  const current = fixture(t);
  const eventPath = join(current.cwd, "event.json");
  writeFileSync(eventPath, JSON.stringify(current.input.event));
  for (const [name, outputIsDirectory] of [
    ["output", true],
    ["summary", false],
  ] as const) {
    const outputPath = join(current.cwd, `${name}-output`);
    const summaryPath = join(current.cwd, `${name}-summary`);
    mkdirSync(outputIsDirectory ? outputPath : summaryPath);
    const child = spawnSync(process.execPath, [TOOL], {
      cwd: current.cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_EVENT_NAME: "push",
        GITHUB_ACTOR: BOT_LOGIN,
        GITHUB_ACTOR_ID: BOT_ID,
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
      },
    });
    assert.equal(child.status, 1);
    assert.equal(
      child.stderr,
      `release-bump classifier: could not write GITHUB_${outputIsDirectory ? "OUTPUT" : "STEP_SUMMARY"}\n`,
    );
  }
});

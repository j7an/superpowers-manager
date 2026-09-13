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

  if (options.topology === "merge") {
    git(cwd, "branch", "side", before);
    git(cwd, "checkout", "--quiet", "side");
  }

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

function runCli(
  cwd: string,
  event: unknown,
  options: Partial<
    Pick<ClassificationInput, "eventName" | "actor" | "actorId">
  > = {},
) {
  const scratch = mkdtempSync(join(cwd, ".release-bump-cli-"));
  const eventPath = join(scratch, "event.json");
  const outputPath = join(scratch, "output.txt");
  const summaryPath = join(scratch, "summary.txt");
  writeFileSync(eventPath, JSON.stringify(event));
  const child = spawnSync(process.execPath, [TOOL], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: options.eventName ?? "push",
      GITHUB_ACTOR: options.actor ?? BOT_LOGIN,
      GITHUB_ACTOR_ID: options.actorId ?? BOT_ID,
      GITHUB_OUTPUT: outputPath,
      GITHUB_STEP_SUMMARY: summaryPath,
    },
  });
  return { child, outputPath, summaryPath };
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
  assert.deepEqual(result, {
    skipTests: true,
    reason: "verified-release-bump",
  });
});

void test("ordinary events keep ordinary CI", (t) => {
  const { current } = classify(t);
  for (const eventName of ["pull_request", "workflow_dispatch"]) {
    assert.deepEqual(classifyReleaseBump({ ...current.input, eventName }), {
      skipTests: false,
      reason: "ordinary-event",
    });
  }
});

void test("actor identity mismatches keep ordinary CI", (t) => {
  const { current } = classify(t);
  for (const patch of [{ actor: "human" }, { actorId: "0" }, { actorId: "" }]) {
    assert.deepEqual(classifyReleaseBump({ ...current.input, ...patch }), {
      skipTests: false,
      reason: "identity-mismatch",
    });
  }
});

void test("sender identity mismatches keep ordinary CI", (t) => {
  const { current } = classify(t);
  for (const sender of [
    { login: "human", id: Number(BOT_ID), type: "Bot" },
    { id: Number(BOT_ID), type: "Bot" },
    { login: BOT_LOGIN, id: 0, type: "Bot" },
    { login: BOT_LOGIN, type: "Bot" },
    { login: BOT_LOGIN, id: Number(BOT_ID), type: "User" },
    { login: BOT_LOGIN, id: Number(BOT_ID) },
  ]) {
    assert.deepEqual(
      classifyReleaseBump({
        ...current.input,
        event: { ...(current.input.event as object), sender },
      }),
      { skipTests: false, reason: "identity-mismatch" },
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
    assert.deepEqual(classifyReleaseBump({ ...current.input, event }), {
      skipTests: false,
      reason: "unverified-change",
    });
    delete event[flag];
    assert.deepEqual(classifyReleaseBump({ ...current.input, event }), {
      skipTests: false,
      reason: "unverified-change",
    });
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
    assert.deepEqual(classifyReleaseBump({ ...current.input, event }), {
      skipTests: false,
      reason: "unverified-change",
    });
  }
});

for (const [name, options, reason] of [
  ["a two-commit push", { topology: "two-commit" }, "unverified-change"],
  [
    "an additional changed file",
    { extraAfter: { "README.md": "changed\n" } },
    "unverified-change",
  ],
  ["a deleted package", { afterPackage: null }, "unverified-change"],
  [
    "a renamed package",
    {
      afterPackage: null,
      extraAfter: { "renamed-package.json": packageText("1.2.4") },
    },
    "unverified-change",
  ],
  ["an executable package", { packageMode: 0o755 }, "unverified-change"],
  ["a symlink package", { packageSymlink: true }, "unverified-change"],
  [
    "an additional package field",
    { afterPackage: packageText("1.2.4", { description: "changed" }) },
    "unverified-change",
  ],
  ["a missing bump config", { afterConfig: null }, "unverified-change"],
  ["an invalid base bump config", { beforeConfig: "{}" }, "unverified-change"],
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
    "unverified-change",
  ],
  [
    "a changed bump config",
    {
      afterConfig: JSON.stringify({
        files: [{ path: "package.json", field: "name" }],
      }),
    },
    "unverified-change",
  ],
  ["a malformed bump config", { afterConfig: "{" }, "unverified-change"],
  ["malformed package json", { afterPackage: "{" }, "unverified-change"],
  ["non-object package json", { afterPackage: "[]" }, "unverified-change"],
  [
    "an equal version",
    {
      afterPackage:
        '{\n  "name": "release-fixture",\n  "private": true,\n  "version": "1.2.3"\n}\n',
    },
    "unverified-change",
  ],
  [
    "a decreasing version",
    { afterPackage: packageText("1.2.2") },
    "unverified-change",
  ],
  [
    "a prerelease version",
    { afterPackage: packageText("1.2.4-beta.1") },
    "unverified-change",
  ],
  [
    "a leading-zero version",
    { afterPackage: packageText("01.2.4") },
    "unverified-change",
  ],
  [
    "an invalid version",
    { afterPackage: packageText("nope") },
    "unverified-change",
  ],
] as const) {
  void test(`unverified change: ${name} does not skip tests`, (t) => {
    const { result } = classify(t, options);
    assert.deepEqual(result, { skipTests: false, reason });
  });
}

void test("a merge commit is rejected after a package-only diff", (t) => {
  const current = fixture(t, { topology: "merge" });
  assert.equal(
    git(current.cwd, "rev-parse", `${current.after}^1`),
    current.before,
  );
  assert.equal(
    git(current.cwd, "rev-list", "--parents", "-n", "1", current.after).split(
      " ",
    ).length,
    3,
  );
  assert.equal(
    git(current.cwd, "diff", "--name-only", current.before, current.after),
    "package.json",
  );
  assert.deepEqual(classifyReleaseBump(current.input), {
    skipTests: false,
    reason: "unverified-change",
  });
});

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
  assert.deepEqual(classifyReleaseBump(current.input), {
    skipTests: false,
    reason: "unverified-change",
  });
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
  const { child, outputPath, summaryPath } = runCli(
    current.cwd,
    current.input.event,
  );
  assert.equal(child.status, 0);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "");
  assert.equal(readFileSync(outputPath, "utf8"), "skip_tests=true\n");
  assert.match(
    readFileSync(summaryPath, "utf8"),
    /^Release-bump test skip enabled: Release owns validation for this verified release bump\.\n$/,
  );
});

void test("the cli names the validation owner for every classification reason", (t) => {
  const current = fixture(t);
  for (const [name, eventName, actor, actorId, event, expected] of [
    [
      "ordinary event",
      "workflow_dispatch",
      BOT_LOGIN,
      BOT_ID,
      current.input.event,
      /Release-bump test skip disabled: normal CI owns validation because this is not a push event\.\n$/,
    ],
    [
      "identity mismatch",
      "push",
      "human",
      BOT_ID,
      current.input.event,
      /Release-bump test skip disabled: normal CI owns validation because the event identity is not the release bot\.\n$/,
    ],
    [
      "unverified change",
      "push",
      BOT_LOGIN,
      BOT_ID,
      {
        ...(current.input.event as Record<string, unknown>),
        ref: "refs/heads/release-test",
      },
      /Release-bump test skip disabled: normal CI owns validation because the pushed change is not a verified release bump\.\n$/,
    ],
    [
      "inspection failure",
      "push",
      BOT_LOGIN,
      BOT_ID,
      {
        ...(current.input.event as Record<string, unknown>),
        after: "a".repeat(40),
      },
      /Release-bump test skip disabled: normal CI owns validation because immutable Git inspection failed\.\n$/,
    ],
    [
      "verified release bump",
      "push",
      BOT_LOGIN,
      BOT_ID,
      current.input.event,
      /^Release-bump test skip enabled: Release owns validation/,
    ],
  ] as const) {
    const { child, outputPath, summaryPath } = runCli(current.cwd, event, {
      eventName,
      actor,
      actorId,
    });
    assert.equal(child.status, 0);
    assert.equal(
      readFileSync(outputPath, "utf8"),
      name === "verified release bump"
        ? "skip_tests=true\n"
        : "skip_tests=false\n",
    );
    assert.match(readFileSync(summaryPath, "utf8"), expected);
  }
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
        GITHUB_EVENT_NAME: "push",
        GITHUB_ACTOR: BOT_LOGIN,
        GITHUB_ACTOR_ID: BOT_ID,
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
      GITHUB_EVENT_NAME: "push",
      GITHUB_ACTOR: BOT_LOGIN,
      GITHUB_ACTOR_ID: BOT_ID,
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

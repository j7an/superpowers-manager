import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  inspectOpenCodePrepared,
  prepareOpenCodeCandidate,
  validateOpenCodePreparationBeforeFetch,
} from "../../../../src/harnesses/opencode/prepare.ts";
import { openCodePaths } from "../../../../src/harnesses/opencode/paths.ts";
import {
  commitFixture,
  nativeSelection,
} from "../../../lib/harnesses/pi/package-fixture.ts";
import { nativeOpenCodeFixture } from "../../../lib/harnesses/opencode/package-fixture.ts";

void test("prepares a verified OpenCode candidate", async (t) => {
  const root = nativeOpenCodeFixture(t),
    commit = commitFixture(root),
    candidate = join(root, "candidate");
  const result = await prepareOpenCodeCandidate(
    {
      upstreamRoot: root,
      workspaceRoot: root,
      candidateRoot: candidate,
      selection: nativeSelection(commit),
    },
    {
      root,
      env: { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config") },
    },
  );
  assert.equal(result.outcome.ok, true);
});

void test("preparing a replacement leaves an installed snapshot unchanged", async (t) => {
  const root = nativeOpenCodeFixture(t),
    first = commitFixture(root);
  const candidate = join(root, "candidate"),
    ctx = {
      root,
      env: { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config") },
    };
  await prepareOpenCodeCandidate(
    {
      upstreamRoot: root,
      workspaceRoot: root,
      candidateRoot: candidate,
      selection: nativeSelection(first),
    },
    ctx,
  );
  const installed = openCodePaths(ctx.env, process.cwd()).installedRoot;
  cpSync(candidate, installed, { recursive: true, verbatimSymlinks: true });
  const installedReceipt = readFileSync(
    join(installed, ".superpowers-manager.json"),
    "utf8",
  );
  const next = nativeOpenCodeFixture(t);
  writeFileSync(join(next, "replacement-marker"), "B\n");
  const second = commitFixture(next);
  assert.notEqual(first, second);
  const result = await prepareOpenCodeCandidate(
    {
      upstreamRoot: next,
      workspaceRoot: root,
      candidateRoot: join(root, "replacement"),
      selection: nativeSelection(second),
    },
    ctx,
  );
  assert.equal(result.outcome.ok, true);
  assert.equal(
    readFileSync(join(installed, ".superpowers-manager.json"), "utf8"),
    installedReceipt,
  );
  assert.throws(
    () => readFileSync(join(installed, "replacement-marker")),
    /ENOENT/,
  );
  assert.equal(
    readFileSync(join(root, "replacement", "replacement-marker"), "utf8"),
    "B\n",
  );
});

void test("prefetch validation rejects aliases and non-directory storage roots", async (t) => {
  for (const kind of [
    "alias",
    "regular-file",
    "config-parent-alias",
    "manager-parent-alias",
  ] as const)
    await t.test(kind, async (t) => {
      const root = nativeOpenCodeFixture(t);
      const env = {
        HOME: join(root, "home"),
        XDG_CONFIG_HOME: join(root, "config"),
      };
      const paths = openCodePaths(env, process.cwd());
      if (kind === "config-parent-alias") {
        const target = join(root, "outside-config");
        mkdirSync(target);
        mkdirSync(join(paths.configRoot, ".."), { recursive: true });
        symlinkSync(target, paths.configRoot, "dir");
      } else if (kind === "manager-parent-alias") {
        const target = join(root, "outside-manager");
        mkdirSync(target);
        mkdirSync(paths.configRoot, { recursive: true });
        symlinkSync(target, paths.managerRoot, "dir");
      } else {
        mkdirSync(paths.managerRoot, { recursive: true });
      }
      if (kind === "alias")
        symlinkSync(paths.installedRoot, paths.preparedRoot);
      else if (kind === "regular-file")
        writeFileSync(paths.recoveryRoot, "preserve\n");
      const result = await validateOpenCodePreparationBeforeFetch({
        root,
        env,
      });
      assert.equal(result.outcome.ok, false);
      if (result.outcome.ok) assert.fail("expected storage rejection");
      assert.match(
        result.outcome.error.message,
        /cannot validate OpenCode artifact storage/,
      );
    });
});

void test("a tampered receipt source cannot satisfy prepared inspection", async (t) => {
  const root = nativeOpenCodeFixture(t),
    commit = commitFixture(root);
  const ctx = {
    root,
    env: { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config") },
  };
  const candidate = join(root, "candidate");
  await prepareOpenCodeCandidate(
    {
      upstreamRoot: root,
      workspaceRoot: root,
      candidateRoot: candidate,
      selection: nativeSelection(commit),
    },
    ctx,
  );
  const receipt = JSON.parse(
    readFileSync(join(candidate, ".superpowers-manager.json"), "utf8"),
  );
  writeFileSync(
    join(candidate, ".superpowers-manager.json"),
    JSON.stringify({
      ...receipt,
      source: "https://example.invalid/superpowers",
    }),
  );
  const preparedRoot = join(
    root,
    "config/opencode/superpowers-manager/prepared",
  );
  cpSync(candidate, preparedRoot, { recursive: true, verbatimSymlinks: true });
  const inspected = await inspectOpenCodePrepared(nativeSelection(commit), ctx);
  assert.equal(inspected.outcome.ok, false);
});

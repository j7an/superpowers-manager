import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { beginDirectoryPublication } from "../../../../src/atomic.ts";
import {
  CLAUDE_CODE_MARKETPLACE_BYTES,
  installClaudeCode,
  removeClaudeCode,
} from "../../../../src/harnesses/claude-code/install.ts";
import { readClaudeCodeReceipt } from "../../../../src/harnesses/claude-code/prepare.ts";
import { inspectClaudeCodeInstalled } from "../../../../src/harnesses/claude-code/state.ts";
import {
  claudeCodeSandbox,
  prepareClaudeCodeArtifact,
  type ClaudeCodeSandbox,
} from "../../../lib/harnesses/claude-code/package-fixture.ts";
import {
  fakeClaude,
  mutationCalls,
  type FakeClaude,
} from "../../../lib/harnesses/claude-code/fake-claude.ts";

const ID = "superpowers@superpowers-manager";

function deps(fake: FakeClaude) {
  return { run: fake.run, beginPublication: beginDirectoryPublication };
}

function siblings(sandbox: ClaudeCodeSandbox): string[] {
  return existsSync(sandbox.paths.pluginsRoot)
    ? readdirSync(sandbox.paths.pluginsRoot).filter((n) => n.startsWith("."))
    : [];
}

async function install(
  sandbox: ClaudeCodeSandbox,
  fake: FakeClaude,
  artifact: Parameters<typeof installClaudeCode>[0],
) {
  const receipt = await installClaudeCode(artifact, sandbox.ctx, deps(fake));
  assert.equal(receipt.outcome.ok, true, receipt.outcome.error?.message);
  return receipt.outcome.result!.transaction!;
}

void test("first install publishes, registers, installs, and verifies current", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const fake = fakeClaude();
  const { artifact, selection } = await prepareClaudeCodeArtifact(t, sandbox);
  const transaction = await install(sandbox, fake, artifact);
  assert.deepEqual(mutationCalls(fake), [
    `plugin marketplace add ${sandbox.paths.marketplaceRoot}`,
    `plugin install ${ID} --scope user`,
  ]);
  assert.deepEqual(
    readFileSync(sandbox.paths.marketplaceManifest),
    CLAUDE_CODE_MARKETPLACE_BYTES,
  );
  assert.equal(
    (await readClaudeCodeReceipt(sandbox.paths.pluginRoot)).digest,
    artifact.identity,
  );
  assert.deepEqual((await transaction.finalize()).outcome.ok, true);
  assert.deepEqual(siblings(sandbox), []);
  const state = await inspectClaudeCodeInstalled(
    selection,
    sandbox.ctx,
    fake.run,
  );
  assert.equal(state.outcome.result?.kind, "current");
});

void test("update swaps the snapshot and refreshes only a stale listed version", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const fake = fakeClaude();
  const first = await prepareClaudeCodeArtifact(t, sandbox, "A");
  await (await install(sandbox, fake, first.artifact)).finalize();
  fake.calls.length = 0;
  const second = await prepareClaudeCodeArtifact(t, sandbox, "B");
  const transaction = await install(sandbox, fake, second.artifact);
  assert.deepEqual(mutationCalls(fake), [`plugin update ${ID} --scope user`]);
  await transaction.finalize();
  const state = await inspectClaudeCodeInstalled(
    second.selection,
    sandbox.ctx,
    fake.run,
  );
  assert.equal(state.outcome.result?.kind, "current");
});

void test("installing an unchanged snapshot does not refresh the native plugin", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const fake = fakeClaude();
  const { artifact } = await prepareClaudeCodeArtifact(t, sandbox);
  await (await install(sandbox, fake, artifact)).finalize();
  fake.calls.length = 0;
  await (await install(sandbox, fake, artifact)).finalize();
  assert.deepEqual(mutationCalls(fake), []);
});

void test("rolling back a first install removes the marketplace this invocation added", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const fake = fakeClaude();
  const { artifact } = await prepareClaudeCodeArtifact(t, sandbox);
  const transaction = await install(sandbox, fake, artifact);
  assert.equal((await transaction.rollback()).outcome.ok, true);
  assert.deepEqual(fake.marketplaces, []);
  assert.deepEqual(fake.plugins, []);
  assert.equal(existsSync(sandbox.paths.pluginRoot), false);
  assert.equal(existsSync(sandbox.paths.marketplaceRoot), false);
  assert.deepEqual(siblings(sandbox), []);
});

void test("rolling back an update restores the snapshot and reruns the version refresh", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const fake = fakeClaude();
  const first = await prepareClaudeCodeArtifact(t, sandbox, "A");
  await (await install(sandbox, fake, first.artifact)).finalize();
  const second = await prepareClaudeCodeArtifact(t, sandbox, "B");
  const transaction = await install(sandbox, fake, second.artifact);
  fake.calls.length = 0;
  assert.equal((await transaction.rollback()).outcome.ok, true);
  assert.deepEqual(mutationCalls(fake), [`plugin update ${ID} --scope user`]);
  assert.equal(
    (await readClaudeCodeReceipt(sandbox.paths.pluginRoot)).digest,
    first.artifact.identity,
  );
  assert.equal(fake.marketplaces.length, 1);
});

void test("a failed native install restores prior state and leaves no staging material", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const fake = fakeClaude();
  fake.failOn = "plugin install";
  const { artifact, selection } = await prepareClaudeCodeArtifact(t, sandbox);
  const result = await installClaudeCode(artifact, sandbox.ctx, deps(fake));
  assert.equal(result.outcome.ok, false);
  assert.match(
    result.outcome.error?.message ?? "",
    /claude plugin install .* did not complete \(exit status 1\)/,
  );
  assert.deepEqual(fake.marketplaces, []);
  assert.equal(existsSync(sandbox.paths.pluginRoot), false);
  assert.equal(existsSync(sandbox.paths.marketplaceRoot), false);
  assert.deepEqual(siblings(sandbox), []);
  const state = await inspectClaudeCodeInstalled(
    selection,
    sandbox.ctx,
    fake.run,
  );
  assert.equal(state.outcome.result?.kind, "absent");
});

void test("failed first install preserves a preexisting marketplace directory", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const fake = fakeClaude();
  fake.failOn = "plugin install";
  const { artifact } = await prepareClaudeCodeArtifact(t, sandbox);
  mkdirSync(sandbox.paths.marketplaceRoot);
  const sentinel = join(sandbox.paths.marketplaceRoot, "keep.txt");
  writeFileSync(sentinel, "existing content\n");
  const result = await installClaudeCode(artifact, sandbox.ctx, deps(fake));
  assert.equal(result.outcome.ok, false);
  assert.equal(readFileSync(sentinel, "utf8"), "existing content\n");
});

void test("install refuses a foreign marketplace before any mutation", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const fake = fakeClaude();
  fake.marketplaces.push({ name: "superpowers-manager", source: "github" });
  const { artifact } = await prepareClaudeCodeArtifact(t, sandbox);
  const result = await installClaudeCode(artifact, sandbox.ctx, deps(fake));
  assert.equal(result.outcome.ok, false);
  assert.match(
    result.outcome.error?.message ?? "",
    /foreign superpowers-manager/,
  );
  assert.deepEqual(mutationCalls(fake), []);
  assert.equal(existsSync(sandbox.paths.marketplaceRoot), false);
});

void test("install refuses an enabled competing Superpowers plugin before publication", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const fake = fakeClaude();
  fake.plugins.push({
    id: "superpowers@other",
    version: "1.0.0",
    scope: "user",
    enabled: true,
    installPath: join(sandbox.root, "other"),
  });
  const { artifact } = await prepareClaudeCodeArtifact(t, sandbox);
  const result = await installClaudeCode(artifact, sandbox.ctx, deps(fake));
  assert.equal(result.outcome.ok, false);
  assert.match(
    result.outcome.error?.message ?? "",
    /claude plugin disable superpowers@other/,
  );
  assert.deepEqual(mutationCalls(fake), []);
  assert.equal(existsSync(sandbox.paths.marketplaceRoot), false);
});

void test("install leaves a prior snapshot and leftover backup untouched", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const fake = fakeClaude();
  const first = await prepareClaudeCodeArtifact(t, sandbox, "A");
  await (await install(sandbox, fake, first.artifact)).finalize();
  const leftover = join(sandbox.paths.pluginsRoot, ".superpowers.bak.1.ab");
  mkdirSync(leftover);
  fake.calls.length = 0;
  const second = await prepareClaudeCodeArtifact(t, sandbox, "B");
  const result = await installClaudeCode(
    second.artifact,
    sandbox.ctx,
    deps(fake),
  );
  assert.equal(result.outcome.ok, false);
  assert.match(result.outcome.error?.message ?? "", /recovery required/);
  assert.deepEqual(mutationCalls(fake), []);
  assert.equal(existsSync(leftover), true);
  assert.equal(
    (await readClaudeCodeReceipt(sandbox.paths.pluginRoot)).digest,
    first.artifact.identity,
  );
});

void test("failed publication rollback reports and retains the prior backup", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const fake = fakeClaude();
  const first = await prepareClaudeCodeArtifact(t, sandbox, "A");
  await (await install(sandbox, fake, first.artifact)).finalize();
  const second = await prepareClaudeCodeArtifact(t, sandbox, "B");
  let renames = 0;
  const beginPublication: typeof beginDirectoryPublication = (
    candidate,
    live,
  ) =>
    beginDirectoryPublication(candidate, live, {
      hooks: {
        rename: async (from, to) => {
          renames += 1;
          if (renames > 1) throw new Error("forced publication failure");
          await rename(from, to);
        },
      },
    });
  fake.calls.length = 0;
  const result = await installClaudeCode(second.artifact, sandbox.ctx, {
    run: fake.run,
    beginPublication,
  });
  assert.equal(result.outcome.ok, false);
  assert.match(
    result.outcome.error?.message ?? "",
    /previous Claude Code state may not be restored/,
  );
  assert.match(result.outcome.error?.message ?? "", /\.superpowers\.bak\./);
  assert.equal(existsSync(sandbox.paths.pluginRoot), false);
  assert.equal(
    siblings(sandbox).some((name) => name.startsWith(".superpowers.bak.")),
    true,
  );
  assert.deepEqual(mutationCalls(fake), []);
});

void test("removal deregisters through the marketplace, verifies, then deletes owned storage", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const fake = fakeClaude();
  const { artifact } = await prepareClaudeCodeArtifact(t, sandbox);
  await (await install(sandbox, fake, artifact)).finalize();
  fake.calls.length = 0;
  const result = await removeClaudeCode(
    { registration: "owned", pluginInstalled: true, published: true },
    sandbox.ctx,
    deps(fake),
  );
  assert.equal(result.outcome.ok, true);
  assert.deepEqual(mutationCalls(fake), [
    "plugin marketplace remove superpowers-manager",
  ]);
  assert.equal(existsSync(sandbox.paths.marketplaceRoot), false);
  assert.equal(existsSync(sandbox.paths.preparedRoot), true);
});

void test("removal reports cleanup pending when owned storage cannot be deleted after verified deregistration", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const fake = fakeClaude();
  const { artifact } = await prepareClaudeCodeArtifact(t, sandbox);
  await (await install(sandbox, fake, artifact)).finalize();
  chmodSync(sandbox.paths.managerRoot, 0o555);
  let result: Awaited<ReturnType<typeof removeClaudeCode>>;
  try {
    result = await removeClaudeCode(
      { registration: "owned", pluginInstalled: true, published: true },
      sandbox.ctx,
      deps(fake),
    );
  } finally {
    chmodSync(sandbox.paths.managerRoot, 0o755);
  }
  assert.equal(result.outcome.ok, false);
  assert.equal(result.outcome.error?.code, "cleanup-pending");
  assert.match(result.outcome.error?.message ?? "", /cleanup pending at/);
  assert.deepEqual(fake.marketplaces, []);
});

void test("removal refuses while leftover publication material exists and preserves it", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const fake = fakeClaude();
  const { artifact } = await prepareClaudeCodeArtifact(t, sandbox);
  await (await install(sandbox, fake, artifact)).finalize();
  const leftover = join(sandbox.paths.pluginsRoot, ".superpowers.bak.1.ab");
  mkdirSync(leftover);
  fake.calls.length = 0;
  const result = await removeClaudeCode(
    { registration: "owned", pluginInstalled: true, published: true },
    sandbox.ctx,
    deps(fake),
  );
  assert.equal(result.outcome.ok, false);
  assert.equal(result.outcome.error?.code, "recovery-required");
  assert.deepEqual(fake.calls, []);
  assert.equal(existsSync(leftover), true);
  assert.equal(fake.marketplaces.length, 1);
});

void test("removal refuses when a previously owned marketplace becomes foreign", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const fake = fakeClaude();
  const { artifact } = await prepareClaudeCodeArtifact(t, sandbox);
  await (await install(sandbox, fake, artifact)).finalize();
  fake.marketplaces[0] = { name: "superpowers-manager", source: "github" };
  fake.calls.length = 0;
  const result = await removeClaudeCode(
    { registration: "owned", pluginInstalled: true, published: true },
    sandbox.ctx,
    deps(fake),
  );
  assert.equal(result.outcome.ok, false);
  assert.equal(result.outcome.error?.code, "foreign-marketplace");
  assert.deepEqual(mutationCalls(fake), []);
  assert.equal(existsSync(sandbox.paths.pluginRoot), true);
  assert.equal(fake.marketplaces[0]?.source, "github");
});

void test("removal refuses stale absent input when the marketplace is now owned", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const fake = fakeClaude();
  const { artifact } = await prepareClaudeCodeArtifact(t, sandbox);
  await (await install(sandbox, fake, artifact)).finalize();
  fake.calls.length = 0;
  const result = await removeClaudeCode(
    { registration: "absent", pluginInstalled: false, published: true },
    sandbox.ctx,
    deps(fake),
  );
  assert.equal(result.outcome.ok, false);
  assert.equal(result.outcome.error?.code, "stale-ownership");
  assert.deepEqual(mutationCalls(fake), []);
  assert.equal(existsSync(sandbox.paths.pluginRoot), true);
  assert.equal(fake.marketplaces.length, 1);
});

void test("removal refuses uninspectable native state before mutation", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const fake = fakeClaude();
  const { artifact } = await prepareClaudeCodeArtifact(t, sandbox);
  await (await install(sandbox, fake, artifact)).finalize();
  fake.calls.length = 0;
  fake.failOn = "plugin list --json";
  const result = await removeClaudeCode(
    { registration: "owned", pluginInstalled: true, published: true },
    sandbox.ctx,
    deps(fake),
  );
  assert.equal(result.outcome.ok, false);
  assert.deepEqual(mutationCalls(fake), []);
  assert.equal(existsSync(sandbox.paths.pluginRoot), true);
  assert.equal(fake.marketplaces.length, 1);
});

void test("removal of absent state issues no native mutation", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const fake = fakeClaude();
  const result = await removeClaudeCode(
    { registration: "absent", pluginInstalled: false, published: false },
    sandbox.ctx,
    deps(fake),
  );
  assert.equal(result.outcome.ok, true);
  assert.deepEqual(mutationCalls(fake), []);
});

void test("removal refuses a foreign marketplace", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const result = await removeClaudeCode(
    { registration: "foreign", pluginInstalled: false, published: false },
    sandbox.ctx,
    deps(fakeClaude()),
  );
  assert.equal(result.outcome.ok, false);
  assert.match(
    result.outcome.error?.message ?? "",
    /refusing to remove a foreign/,
  );
});

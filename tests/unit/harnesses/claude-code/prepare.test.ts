import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  ARTIFACT_RECEIPT,
  digestArtifactTree,
} from "../../../../src/artifact-tree.ts";
import {
  inspectClaudeCodePrepared,
  prepareClaudeCodeCandidate,
  readClaudeCodePrepared,
  readClaudeCodeReceipt,
} from "../../../../src/harnesses/claude-code/prepare.ts";
import { snapshotReceiptBinding } from "../../../../src/snapshot-package.ts";
import {
  commitFixture,
  nativeSelection,
} from "../../../lib/harnesses/pi/package-fixture.ts";
import {
  claudeCodeSandbox,
  nativeClaudeCodeFixture,
  prepareClaudeCodeArtifact,
} from "../../../lib/harnesses/claude-code/package-fixture.ts";
import { scratch } from "../../../lib/scratch.ts";

async function prepareFrom(t: test.TestContext, upstream: string) {
  const sandbox = claudeCodeSandbox(t);
  const commit = commitFixture(upstream);
  const candidate = join(sandbox.root, "candidate");
  const result = await prepareClaudeCodeCandidate(
    {
      upstreamRoot: upstream,
      workspaceRoot: sandbox.root,
      candidateRoot: candidate,
      selection: nativeSelection(commit),
    },
    sandbox.ctx,
  );
  return { result, candidate, commit };
}

void test("prepare rewrites only the manifest version, before the digest", async (t) => {
  const upstream = nativeClaudeCodeFixture(t);
  const original = readFileSync(
    join(upstream, ".claude-plugin/plugin.json"),
    "utf8",
  );
  const { result, candidate, commit } = await prepareFrom(t, upstream);
  assert.equal(result.outcome.ok, true);
  assert.equal(
    readFileSync(join(candidate, ".claude-plugin/plugin.json"), "utf8"),
    original.replace(
      '"6.4.1"',
      `"0.0.0-ref-future-ref+manager.${commit.slice(0, 7)}"`,
    ),
  );
  const receipt = await readClaudeCodeReceipt(candidate);
  assert.equal(receipt.harness, "claude-code");
  assert.equal(receipt.commit, commit);
  assert.equal(receipt.digest, await digestArtifactTree(candidate));
  assert.deepEqual(receipt.compatibility, {
    kind: "supported",
    generation: "claude-code-native-plugin-v1",
    reason: "native Claude Code plugin",
  });
});

for (const [name, mutate] of [
  [
    "missing manifest",
    (root: string) => rmSync(join(root, ".claude-plugin"), { recursive: true }),
  ],
  [
    "wrong plugin name",
    (root: string) =>
      writeFileSync(
        join(root, ".claude-plugin/plugin.json"),
        '{"name":"other","version":"6.4.1"}\n',
      ),
  ],
  [
    "non-semver version",
    (root: string) =>
      writeFileSync(
        join(root, ".claude-plugin/plugin.json"),
        '{"name":"superpowers","version":"latest"}\n',
      ),
  ],
  [
    "non-object hooks.json",
    (root: string) => writeFileSync(join(root, "hooks/hooks.json"), "[]\n"),
  ],
  [
    "missing bootstrap skill",
    (root: string) => rmSync(join(root, "skills"), { recursive: true }),
  ],
] as const) {
  void test(`prepare refuses an upstream with a ${name}`, async (t) => {
    const upstream = nativeClaudeCodeFixture(t);
    mutate(upstream);
    const { result } = await prepareFrom(t, upstream);
    assert.equal(result.outcome.ok, false);
    assert.equal(result.outcome.error?.code, "unsupported");
    assert.match(
      result.outcome.error?.message ?? "",
      /does not provide a native Claude Code plugin/,
    );
  });
}

void test("readPrepared returns the digest identity of a prepared artifact", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const { artifact } = await prepareClaudeCodeArtifact(t, sandbox);
  const read = await readClaudeCodePrepared(sandbox.ctx);
  assert.equal(read.outcome.ok, true);
  assert.equal(read.outcome.result?.identity, artifact.identity);
  assert.equal(
    artifact.identity,
    await digestArtifactTree(sandbox.paths.preparedRoot),
  );
});

void test("a same-commit ref change makes the prepared artifact need preparation", async (t) => {
  const sandbox = claudeCodeSandbox(t);
  const { selection } = await prepareClaudeCodeArtifact(t, sandbox);
  const same = await inspectClaudeCodePrepared(selection, sandbox.ctx);
  assert.equal(same.outcome.result?.kind, "current");
  const rawCommit = {
    ...selection,
    requestedRef: selection.desiredCommit,
    resolvedRef: selection.desiredCommit,
    resolutionKind: "raw-commit" as const,
  };
  const changed = await inspectClaudeCodePrepared(rawCommit, sandbox.ctx);
  assert.equal(changed.outcome.ok, true);
  assert.equal(changed.outcome.result?.kind, "needs-prepare");
});

void test("Claude Code receipts reject a generation on unsupported compatibility", async (t) => {
  const root = scratch(t, "spw-claude-code-receipt-");
  const identity = {
    schema: 1,
    manager: "superpowers-manager",
    harness: "claude-code",
    source: "https://github.com/obra/superpowers",
    commit: "1".repeat(40),
    digest: await digestArtifactTree(root),
  } as const;
  writeFileSync(
    join(root, ARTIFACT_RECEIPT),
    JSON.stringify({
      ...identity,
      binding: snapshotReceiptBinding(identity),
      compatibility: {
        kind: "unsupported",
        reason: "retired",
        generation: "extra",
      },
    }) + "\n",
  );
  await assert.rejects(
    readClaudeCodeReceipt(root),
    /invalid Claude Code artifact receipt/,
  );
});

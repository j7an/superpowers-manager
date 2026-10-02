import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  ARTIFACT_RECEIPT,
  digestArtifactTree,
} from "../../../../src/artifact-tree.ts";
import {
  inspectHermesPrepared,
  prepareHermesCandidate,
  readHermesPackageAssessment,
  readHermesPrepared,
  readHermesReceipt,
  validateHermesPreparationBeforeFetch,
} from "../../../../src/harnesses/hermes/prepare.ts";
import { snapshotReceiptBinding } from "../../../../src/snapshot-package.ts";
import {
  commitFixture,
  nativeSelection,
} from "../../../lib/harnesses/pi/package-fixture.ts";
import {
  hermesSandbox,
  nativeHermesFixture,
  prepareHermesArtifact,
} from "../../../lib/harnesses/hermes/package-fixture.ts";

async function prepareFrom(t: test.TestContext, upstream: string) {
  const sandbox = hermesSandbox(t);
  const commit = commitFixture(upstream);
  const candidate = join(sandbox.root, "candidate");
  const result = await prepareHermesCandidate(
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
void test("prepare publishes exactly the flattened Hermes plugin", async (t) => {
  const upstream = nativeHermesFixture(t);
  const original = readFileSync(
    join(upstream, ".hermes-plugin/plugin.yaml"),
    "utf8",
  );
  const { result, candidate, commit } = await prepareFrom(t, upstream);
  assert.equal(result.outcome.ok, true);
  assert.deepEqual(
    readdirSync(candidate).sort(),
    [
      ARTIFACT_RECEIPT,
      "LICENSE",
      "__init__.py",
      "__pycache__",
      "plugin.yaml",
      "skills",
    ].sort(),
  );
  assert.equal(lstatSync(join(candidate, "__pycache__")).isFile(), true);
  assert.equal(lstatSync(join(candidate, "__pycache__")).size, 0);
  assert.equal(readFileSync(join(candidate, "plugin.yaml"), "utf8"), original);
  const receipt = await readHermesReceipt(candidate);
  assert.equal(receipt.harness, "hermes");
  assert.equal(receipt.commit, commit);
  assert.equal(receipt.digest, await digestArtifactTree(candidate));
  assert.deepEqual(receipt.compatibility, {
    kind: "supported",
    generation: "hermes-flat-plugin-v1",
    reason: "native Hermes plugin",
  });
});
void test("a prepared tree whose __pycache__ is a directory is not supported", async (t) => {
  const sandbox = hermesSandbox(t);
  await prepareHermesArtifact(t, sandbox);
  rmSync(join(sandbox.paths.preparedRoot, "__pycache__"));
  mkdirSync(join(sandbox.paths.preparedRoot, "__pycache__"));
  await assert.rejects(
    readHermesPackageAssessment(sandbox.paths.preparedRoot),
    /Hermes artifact digest mismatch/,
  );
});
void test("prepare carries additional .hermes-plugin files to the root", async (t) => {
  const upstream = nativeHermesFixture(t);
  writeFileSync(
    join(upstream, ".hermes-plugin/extra.txt"),
    "additional native file\n",
  );
  const { result, candidate } = await prepareFrom(t, upstream);
  assert.equal(result.outcome.ok, true);
  assert.equal(
    readFileSync(join(candidate, "extra.txt"), "utf8"),
    "additional native file\n",
  );
});
for (const [name, target, collision] of [
  ["missing .hermes-plugin directory", ".hermes-plugin", false],
  ["missing manifest", ".hermes-plugin/plugin.yaml", false],
  ["missing __init__.py", ".hermes-plugin/__init__.py", false],
  [
    "missing hermes-tools.md",
    "skills/using-superpowers/references/hermes-tools.md",
    false,
  ],
  ["colliding skills", ".hermes-plugin/skills", true],
  ["colliding LICENSE", ".hermes-plugin/LICENSE", true],
] as const) {
  void test(`prepare refuses an upstream with a ${name}`, async (t) => {
    const upstream = nativeHermesFixture(t);
    if (collision) writeFileSync(join(upstream, target), "collision\n");
    else rmSync(join(upstream, target), { recursive: true });
    const { result } = await prepareFrom(t, upstream);
    assert.equal(result.outcome.ok, false);
    assert.equal(
      result.outcome.error?.code,
      collision ? "invalid-package" : "unsupported",
    );
    assert.match(
      result.outcome.error?.message ?? "",
      collision
        ? /^cannot prepare Hermes artifact: /
        : /^Hermes package does not provide a native Hermes plugin: /,
    );
  });
}
void test("readPrepared returns the digest identity of a prepared artifact", async (t) => {
  const sandbox = hermesSandbox(t);
  const { artifact } = await prepareHermesArtifact(t, sandbox);
  const read = await readHermesPrepared(sandbox.ctx);
  assert.equal(read.outcome.ok, true);
  assert.equal(read.outcome.result?.identity, artifact.identity);
  assert.equal(
    artifact.identity,
    await digestArtifactTree(sandbox.paths.preparedRoot),
  );
});
void test("inspectPrepared is current for the prepared selection", async (t) => {
  const sandbox = hermesSandbox(t);
  const { selection } = await prepareHermesArtifact(t, sandbox);
  const result = await inspectHermesPrepared(selection, sandbox.ctx);
  assert.equal(result.outcome.ok, true);
  assert.equal(result.outcome.result?.kind, "current");
});
void test("pre-fetch validation accepts safe missing storage", async (t) => {
  const sandbox = hermesSandbox(t);
  const result = await validateHermesPreparationBeforeFetch(sandbox.ctx);
  assert.equal(result.outcome.ok, true);
});

void test("assessment refuses a nonempty bytecode sentinel even with a matching receipt", async (t) => {
  const sandbox = hermesSandbox(t);
  await prepareHermesArtifact(t, sandbox);
  const root = sandbox.paths.preparedRoot;
  const receipt = await readHermesReceipt(root);
  writeFileSync(join(root, "__pycache__"), "bytecode");
  const identity = { ...receipt, digest: await digestArtifactTree(root) };
  writeFileSync(
    join(root, ARTIFACT_RECEIPT),
    JSON.stringify({ ...identity, binding: snapshotReceiptBinding(identity) }) +
      "\n",
  );
  const assessment = await readHermesPackageAssessment(root);
  assert.equal(assessment.compatibility.kind, "unsupported");
  assert.match(
    assessment.compatibility.reason,
    /^Hermes package does not provide a native Hermes plugin: /,
  );
});
void test("pre-fetch validation refuses a symlinked plugin root", async (t) => {
  const sandbox = hermesSandbox(t);
  mkdirSync(sandbox.paths.pluginsRoot, { recursive: true });
  const elsewhere = join(sandbox.root, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, sandbox.paths.pluginRoot);
  const result = await validateHermesPreparationBeforeFetch(sandbox.ctx);
  assert.equal(result.outcome.ok, false);
  assert.equal(result.outcome.error?.code, "invalid-package");
  assert.equal(
    result.outcome.error?.message,
    "cannot validate Hermes artifact storage",
  );
});

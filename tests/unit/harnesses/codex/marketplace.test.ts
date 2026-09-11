import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ARTIFACT_RECEIPT,
  digestArtifactTree,
  readArtifactObject,
} from "../../../../src/artifact-tree.ts";
import {
  readCodexMarketplace,
  stageCodexMarketplace,
} from "../../../../src/harnesses/codex/marketplace.ts";
import { readCodexAssessment } from "../../../../src/harnesses/codex/compatibility.ts";
import { writeQualifiedCodexFixture } from "../../../lib/harnesses/codex/prepared-fixture.ts";

async function fixture(t: import("node:test").TestContext) {
  const root = await mkdtemp(join(tmpdir(), "spw-marketplace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prepared = join(root, "prepared");
  const pkg = join(root, "package");
  await mkdir(join(pkg, ".agents/plugins"), { recursive: true });
  await copyFile(
    new URL("../../../../.agents/plugins/marketplace.json", import.meta.url),
    join(pkg, ".agents/plugins/marketplace.json"),
  );
  const artifact = await writeQualifiedCodexFixture(
    prepared,
    "1".repeat(40),
    "https://example.invalid/upstream",
  );
  return { root, prepared, pkg, artifact, candidate: join(root, "candidate") };
}

async function rewriteReceipt(root: string): Promise<void> {
  const receiptPath = join(root, ARTIFACT_RECEIPT);
  const receipt = await readArtifactObject(root, receiptPath);
  await writeFile(
    receiptPath,
    JSON.stringify({ ...receipt, digest: await digestArtifactTree(root) }) +
      "\n",
  );
}

void test("published candidate survives loss of preparation and package roots", async (t) => {
  const {
    prepared,
    pkg,
    artifact,
    candidate: candidateRoot,
  } = await fixture(t);
  const candidate = await stageCodexMarketplace(artifact, pkg, candidateRoot);
  await rm(pkg, { recursive: true });
  await rm(prepared, { recursive: true });
  const observed = await readCodexMarketplace(candidate.root);
  assert.ok(observed);
  assert.equal(observed.digest, candidate.digest);
  assert.equal(observed.artifact.commit, artifact.commit);
  assert.match(
    await readFile(
      join(observed.artifact.root, "skills/using-superpowers/SKILL.md"),
      "utf8",
    ),
    /Native fixture skill/,
  );
});

void test("reader rejects altered content and unexpected root files", async (t) => {
  const { pkg, artifact, candidate } = await fixture(t);
  await stageCodexMarketplace(artifact, pkg, candidate);
  await writeFile(join(candidate, "extra"), "unexpected\n");
  await assert.rejects(
    readCodexMarketplace(candidate),
    /cannot inspect owned Codex marketplace:/,
  );
});

void test("reader rejects changed durable plugin content", async (t) => {
  const { pkg, artifact, candidate } = await fixture(t);
  await stageCodexMarketplace(artifact, pkg, candidate);
  await writeFile(
    join(candidate, "plugins/superpowers/skills/using-superpowers/SKILL.md"),
    "changed\n",
  );
  await assert.rejects(
    readCodexMarketplace(candidate),
    /cannot inspect owned Codex marketplace:/,
  );
});

void test("reader rejects a marketplace source path outside the owned plugin", async (t) => {
  const { pkg, artifact, candidate } = await fixture(t);
  await stageCodexMarketplace(artifact, pkg, candidate);
  await writeFile(
    join(candidate, ".agents/plugins/marketplace.json"),
    JSON.stringify({
      name: "superpowers-manager",
      plugins: [
        { name: "superpowers", source: { source: "local", path: "../other" } },
      ],
    }) + "\n",
  );
  await rewriteReceipt(candidate);
  await assert.rejects(
    readCodexMarketplace(candidate),
    /cannot inspect owned Codex marketplace:/,
  );
});

void test("reader rejects plugin symlinks that escape its durable tree", async (t) => {
  const { root, pkg, artifact, candidate } = await fixture(t);
  await stageCodexMarketplace(artifact, pkg, candidate);
  await symlink(
    join(root, "outside"),
    join(candidate, "plugins/superpowers/escape"),
  );
  await assert.rejects(
    readCodexMarketplace(candidate),
    /cannot inspect owned Codex marketplace:/,
  );
});

void test("staging refuses an existing candidate without overwriting it", async (t) => {
  const { pkg, artifact, candidate } = await fixture(t);
  await mkdir(candidate);
  await writeFile(join(candidate, "keep"), "present\n");
  await assert.rejects(
    stageCodexMarketplace(artifact, pkg, candidate),
    /cannot stage owned Codex marketplace:/,
  );
  assert.equal(await readFile(join(candidate, "keep"), "utf8"), "present\n");
});

void test("staging rejects prepared bytes changed after assessment", async (t) => {
  const { prepared, pkg, artifact, candidate } = await fixture(t);
  await writeFile(
    join(prepared, "skills/using-superpowers/SKILL.md"),
    "changed\n",
  );
  await assert.rejects(
    stageCodexMarketplace(artifact, pkg, candidate),
    /cannot stage owned Codex marketplace:/,
  );
});

void test("staging preserves contained relative plugin links after source removal", async (t) => {
  const { prepared, pkg, candidate } = await fixture(t);
  await symlink("using-superpowers", join(prepared, "skills/fixture-link"));
  await rewriteReceipt(prepared);
  const artifact = await readCodexAssessment(prepared);
  await stageCodexMarketplace(artifact, pkg, candidate);
  await rm(prepared, { recursive: true });
  await rm(pkg, { recursive: true });
  assert.match(
    await readFile(
      join(candidate, "plugins/superpowers/skills/fixture-link/SKILL.md"),
      "utf8",
    ),
    /Native fixture skill/,
  );
});

void test("missing marketplace root has no owned snapshot", async (t) => {
  const { root } = await fixture(t);
  assert.equal(await readCodexMarketplace(join(root, "missing")), null);
});

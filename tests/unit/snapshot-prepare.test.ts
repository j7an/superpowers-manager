import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { digestArtifactTree } from "../../src/artifact-tree.ts";
import type { Compatibility } from "../../src/harness-compatibility.ts";
import { createSnapshotReceipts } from "../../src/snapshot-package.ts";
import { createSnapshotPreparation } from "../../src/snapshot-prepare.ts";
import {
  commitFixture,
  nativeSelection,
} from "../lib/harnesses/pi/package-fixture.ts";
import { scratch } from "../lib/scratch.ts";

const supported: Compatibility = {
  kind: "supported",
  generation: "fixture",
  reason: "fixture snapshot",
};

void test("layout runs after materialization and before assessment", async (t) => {
  const upstream = scratch(t, "spw-snapshot-upstream-");
  writeFileSync(join(upstream, "upstream.txt"), "committed fixture\n");
  const selection = nativeSelection(commitFixture(upstream));
  const workspace = scratch(t, "spw-snapshot-workspace-");
  const candidate = join(workspace, "candidate");
  let assessedLayout = false;
  const assessCompatibility = async (root: string) => {
    assessedLayout = existsSync(join(root, "laid-out"));
    return supported;
  };
  const receipts = createSnapshotReceipts({
    harness: "hermes",
    label: "Hermes",
    strictGeneration: true,
    assessCompatibility,
  });
  const preparation = createSnapshotPreparation({
    harness: "hermes",
    label: "Hermes",
    paths: () => ({ preparedRoot: candidate }),
    async layout(root) {
      assert.equal(
        readFileSync(join(root, "upstream.txt"), "utf8"),
        "committed fixture\n",
      );
      await writeFile(join(root, "laid-out"), "layout output\n");
    },
    assessCompatibility,
    readAssessment: receipts.readAssessment,
  });
  const result = await preparation.prepareCandidate(
    {
      upstreamRoot: upstream,
      workspaceRoot: workspace,
      candidateRoot: candidate,
      selection,
    },
    { root: workspace },
  );
  assert.equal(result.outcome.ok, true);
  assert.equal(assessedLayout, true);
  const receipt = await receipts.readReceipt(candidate);
  assert.equal(receipt.harness, "hermes");
  assert.equal(receipt.digest, await digestArtifactTree(candidate));
  rmSync(join(candidate, "laid-out"));
  assert.notEqual(receipt.digest, await digestArtifactTree(candidate));
});

void test("without layout, assessment sees the materialized tree unchanged", async (t) => {
  const upstream = scratch(t, "spw-snapshot-upstream-");
  writeFileSync(join(upstream, "upstream.txt"), "committed fixture\n");
  const selection = nativeSelection(commitFixture(upstream));
  writeFileSync(join(upstream, "uncommitted.txt"), "excluded\n");
  const workspace = scratch(t, "spw-snapshot-workspace-");
  const candidate = join(workspace, "candidate");
  let assessedEntries: string[] = [];
  let assessedContents = "";
  const assessCompatibility = async (root: string) => {
    assessedEntries = readdirSync(root);
    assessedContents = readFileSync(join(root, "upstream.txt"), "utf8");
    return supported;
  };
  const receipts = createSnapshotReceipts({
    harness: "pi",
    label: "Pi",
    strictGeneration: false,
    assessCompatibility,
  });
  const preparation = createSnapshotPreparation({
    harness: "pi",
    label: "Pi",
    paths: () => ({ preparedRoot: candidate }),
    assessCompatibility,
    readAssessment: receipts.readAssessment,
  });
  const result = await preparation.prepareCandidate(
    {
      upstreamRoot: upstream,
      workspaceRoot: workspace,
      candidateRoot: candidate,
      selection,
    },
    { root: workspace },
  );
  assert.equal(result.outcome.ok, true);
  assert.deepEqual(assessedEntries, ["upstream.txt"]);
  assert.equal(assessedContents, "committed fixture\n");
});

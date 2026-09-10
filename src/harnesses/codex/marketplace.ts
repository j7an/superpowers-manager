import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import {
  ARTIFACT_DIGEST_RE,
  ARTIFACT_RECEIPT,
  digestArtifactTree,
  readArtifactObject,
} from "../../artifact-tree.ts";
import { COMMIT_RE } from "../../domain/refs.ts";
import type { PreparedArtifact } from "../../harness.ts";
import {
  assertNoFollowType,
  assertSymlinkTargetContained,
  classifyPathNoFollow,
} from "../../safe-path.ts";
import { SafetyError } from "../../safety-error.ts";
import type { JsonValue } from "../../strict-json.ts";
import { readCodexAssessment } from "./compatibility.ts";

export interface MarketplaceSnapshot {
  readonly root: string;
  readonly dev: number;
  readonly ino: number;
  readonly digest: string;
  readonly artifact: PreparedArtifact;
}

const MARKETPLACE_PATH = ".agents/plugins/marketplace.json";
const PLUGIN_PATH = "plugins/superpowers";

function inspectionError(root: string, cause?: unknown): SafetyError {
  return new SafetyError(
    "codex-marketplace",
    `cannot inspect owned Codex marketplace: ${root}`,
    { cause },
  );
}

function validateMarketplace(value: Record<string, JsonValue>): void {
  const plugins = value.plugins;
  if (!Array.isArray(plugins) || plugins.length !== 1) {
    throw new Error("marketplace plugins");
  }
  const plugin = plugins[0];
  if (plugin === null || typeof plugin !== "object" || Array.isArray(plugin)) {
    throw new Error("marketplace plugin");
  }
  const source = plugin.source;
  if (
    plugin.name !== "superpowers" ||
    source === null ||
    typeof source !== "object" ||
    Array.isArray(source) ||
    source.source !== "local" ||
    source.path !== "./plugins/superpowers"
  ) {
    throw new Error("marketplace source");
  }
}

async function requireEntries(
  root: string,
  expected: readonly string[],
): Promise<void> {
  const actual = await readdir(root);
  if (
    actual.length !== expected.length ||
    actual.some((entry) => !expected.includes(entry))
  ) {
    throw new Error("tree entries");
  }
}

async function validatePluginLinks(root: string, relative = ""): Promise<void> {
  const directory = join(root, relative);
  for (const entry of await readdir(directory)) {
    const path = join(directory, entry);
    const kind = await classifyPathNoFollow(path);
    if (kind === "directory")
      await validatePluginLinks(root, join(relative, entry));
    else if (kind === "symlink") await assertSymlinkTargetContained(root, path);
    else if (kind !== "regular-file") throw new Error("plugin entry");
  }
}

async function readMarketplace(root: string): Promise<MarketplaceSnapshot> {
  try {
    await assertNoFollowType(root, ["directory"]);
    const before = await lstat(root);
    await requireEntries(root, [".agents", "plugins", ARTIFACT_RECEIPT]);
    await assertNoFollowType(join(root, ".agents"), ["directory"]);
    await assertNoFollowType(join(root, "plugins"), ["directory"]);
    await assertNoFollowType(join(root, ARTIFACT_RECEIPT), ["regular-file"]);
    await requireEntries(join(root, ".agents"), ["plugins"]);
    await requireEntries(join(root, ".agents", "plugins"), [
      "marketplace.json",
    ]);
    await requireEntries(join(root, "plugins"), ["superpowers"]);
    const pluginRoot = join(root, PLUGIN_PATH);
    await assertNoFollowType(pluginRoot, ["directory"]);
    await validatePluginLinks(pluginRoot);
    validateMarketplace(
      await readArtifactObject(root, join(root, MARKETPLACE_PATH)),
    );
    const receipt = await readArtifactObject(
      root,
      join(root, ARTIFACT_RECEIPT),
    );
    if (
      receipt.schema !== 1 ||
      receipt.manager !== "superpowers-manager" ||
      receipt.harness !== "codex" ||
      receipt.generation !== "codex-marketplace-v1" ||
      typeof receipt.digest !== "string" ||
      !ARTIFACT_DIGEST_RE.test(receipt.digest)
    ) {
      throw new Error("receipt");
    }
    const digest = await digestArtifactTree(root);
    if (digest !== receipt.digest) throw new Error("digest");
    const artifact = await readCodexAssessment(pluginRoot);
    if (!COMMIT_RE.test(artifact.commit)) throw new Error("assessment");
    const after = await lstat(root);
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error("root changed");
    }
    return {
      root,
      dev: before.dev,
      ino: before.ino,
      digest,
      artifact,
    };
  } catch (cause) {
    throw inspectionError(root, cause);
  }
}

export async function stageCodexMarketplace(
  artifact: PreparedArtifact,
  packageRoot: string,
  candidateRoot: string,
): Promise<MarketplaceSnapshot> {
  try {
    const assessed = await readCodexAssessment(artifact.root);
    if (assessed.commit !== artifact.commit) throw new Error("artifact commit");
    const sourceDigest = await digestArtifactTree(artifact.root);
    await assertNoFollowType(candidateRoot, ["missing"]);
    await mkdir(join(candidateRoot, ".agents", "plugins"), { recursive: true });
    await mkdir(join(candidateRoot, "plugins"), { recursive: true });
    await copyFile(
      join(packageRoot, MARKETPLACE_PATH),
      join(candidateRoot, MARKETPLACE_PATH),
      0,
    );
    await cp(artifact.root, join(candidateRoot, PLUGIN_PATH), {
      dereference: false,
      errorOnExist: true,
      force: false,
      recursive: true,
      verbatimSymlinks: true,
    });
    const copied = await readCodexAssessment(join(candidateRoot, PLUGIN_PATH));
    if (
      copied.commit !== artifact.commit ||
      (await digestArtifactTree(copied.root)) !== sourceDigest
    ) {
      throw new Error("copied artifact");
    }
    await validatePluginLinks(copied.root);
    validateMarketplace(
      await readArtifactObject(
        candidateRoot,
        join(candidateRoot, MARKETPLACE_PATH),
      ),
    );
    const receipt = {
      schema: 1,
      manager: "superpowers-manager",
      harness: "codex",
      generation: "codex-marketplace-v1",
      digest: await digestArtifactTree(candidateRoot),
    };
    await writeFile(
      join(candidateRoot, ARTIFACT_RECEIPT),
      JSON.stringify(receipt) + "\n",
      { flag: "wx" },
    );
    return await readMarketplace(candidateRoot);
  } catch (cause) {
    throw new SafetyError(
      "codex-marketplace",
      `cannot stage owned Codex marketplace: ${candidateRoot}`,
      { cause },
    );
  }
}

export async function readCodexMarketplace(
  root: string,
): Promise<MarketplaceSnapshot | null> {
  try {
    if ((await classifyPathNoFollow(root)) === "missing") return null;
  } catch (cause) {
    throw inspectionError(root, cause);
  }
  return await readMarketplace(root);
}

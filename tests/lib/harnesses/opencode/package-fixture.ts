import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { TestContext } from "node:test";
import type { EffectiveSelection } from "../../../../src/effective-selection.ts";
import type { AdapterContext } from "../../../../src/adapter-result.ts";
import { digestArtifactTree } from "../../../../src/artifact-tree.ts";
import {
  openCodeReceiptBinding,
  type OpenCodeReceipt,
} from "../../../../src/harnesses/opencode/package.ts";
import {
  openCodePaths,
  type OpenCodePaths,
} from "../../../../src/harnesses/opencode/paths.ts";

export function nativeOpenCodeFixture(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "spw-opencode-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [fixture, target] of [
    ["bootstrap.js.txt", ".opencode/plugins/superpowers.js"],
    ["package.json.txt", "package.json"],
    ["SKILL.md.txt", "skills/using-superpowers/SKILL.md"],
    ["LICENSE.txt", "LICENSE"],
  ]) {
    const destination = join(root, target);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(
      new URL(`../../../fixtures/opencode-native/${fixture}`, import.meta.url),
      destination,
    );
  }
  return root;
}

export function openCodeSelection(
  commit = "1".repeat(40),
  source = "https://github.com/obra/superpowers",
): EffectiveSelection {
  return {
    selectionOrigin: "package-default",
    selectionMode: "default",
    upstreamSourceOrigin: "package-default",
    effectiveSource: source,
    requestedRef: "future-ref",
    resolvedRef: "future-ref",
    desiredCommit: commit,
    resolutionKind: "ref",
    saved: {
      saved_mode: "none",
      saved_source: "",
      saved_requested_ref: "",
      saved_resolved_ref: "",
      saved_commit: "",
    },
  };
}

export interface OpenCodeSandbox {
  readonly root: string;
  readonly ctx: AdapterContext;
  readonly paths: OpenCodePaths;
  readonly env: NodeJS.ProcessEnv;
}

export function openCodeSandbox(t: TestContext): OpenCodeSandbox {
  const root = mkdtempSync(join(tmpdir(), "spw-opencode-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    OPENCODE_TEST_HOME: home,
    OPENCODE_TEST_MANAGED_CONFIG_DIR: join(root, "managed"),
  };
  mkdirSync(home, { recursive: true });
  return {
    root,
    env,
    ctx: { root, env },
    paths: openCodePaths(env, root),
  };
}

export async function writeOpenCodeArtifact(
  t: TestContext,
  root: string,
  selection = openCodeSelection(),
  compatibility: OpenCodeReceipt["compatibility"] = {
    kind: "supported",
    generation: "opencode-native-bootstrap-v1",
    reason: "fixture",
  },
): Promise<string> {
  cpSync(nativeOpenCodeFixture(t), root, { recursive: true });
  const digest = await digestArtifactTree(root);
  const identity = {
    schema: 1 as const,
    manager: "superpowers-manager" as const,
    harness: "opencode" as const,
    source: selection.effectiveSource,
    commit: selection.desiredCommit,
    digest,
  };
  writeFileSync(
    join(root, ".superpowers-manager.json"),
    JSON.stringify({
      ...identity,
      binding: openCodeReceiptBinding(identity),
      compatibility,
    }) + "\n",
  );
  return digest;
}

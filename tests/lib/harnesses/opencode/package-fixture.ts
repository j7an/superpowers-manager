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
import type { AdapterContext } from "../../../../src/adapter-result.ts";
import { digestArtifactTree } from "../../../../src/artifact-tree.ts";
import { snapshotReceiptBinding } from "../../../../src/snapshot-package.ts";
import type { OpenCodeReceipt } from "../../../../src/harnesses/opencode/package.ts";
import {
  openCodePaths,
  type OpenCodePaths,
} from "../../../../src/harnesses/opencode/paths.ts";
import { nativeSelection } from "../pi/package-fixture.ts";

interface NativeOpenCodeFixtureOptions {
  readonly bootstrap?: "6.3.0" | "6.4.1";
  readonly entrypoint?: boolean;
}

export function nativeOpenCodeFixture(
  t: TestContext,
  options: NativeOpenCodeFixtureOptions = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "spw-opencode-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [fixture, target] of [
    [
      options.bootstrap === "6.3.0"
        ? "opencode-native/bootstrap-6.3.0.js.txt"
        : "opencode-native/bootstrap.js.txt",
      ".opencode/plugins/superpowers.js",
    ],
    ...(options.entrypoint === false
      ? []
      : [["opencode-native/entrypoint.js.txt", "index.js"]]),
    ["pi-native/package.json.txt", "package.json"],
    ["pi-native/SKILL.md.txt", "skills/using-superpowers/SKILL.md"],
    ["pi-native/LICENSE.txt", "LICENSE"],
  ]) {
    const destination = join(root, target);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(
      new URL(`../../../fixtures/${fixture}`, import.meta.url),
      destination,
    );
  }
  return root;
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
  selection = nativeSelection(),
  compatibility: OpenCodeReceipt["compatibility"] = {
    kind: "supported",
    generation: "opencode-native-bootstrap-v1",
    reason: "fixture",
  },
  options: NativeOpenCodeFixtureOptions = {},
): Promise<string> {
  cpSync(nativeOpenCodeFixture(t, options), root, { recursive: true });
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
      binding: snapshotReceiptBinding(identity),
      compatibility,
    }) + "\n",
  );
  return digest;
}

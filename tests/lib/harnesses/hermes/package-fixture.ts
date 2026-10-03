import { scratch } from "../../scratch.ts";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import type { AdapterContext } from "../../../../src/adapter-result.ts";
import type { EffectiveSelection } from "../../../../src/effective-selection.ts";
import type { PreparedArtifact } from "../../../../src/harness.ts";
import {
  hermesPaths,
  type HermesPaths,
} from "../../../../src/harnesses/hermes/paths.ts";
import { prepareHermesCandidate } from "../../../../src/harnesses/hermes/prepare.ts";
import { commitFixture, nativeSelection } from "../pi/package-fixture.ts";

export function nativeHermesFixture(t: TestContext): string {
  const root = scratch(t, "spw-hermes-package-");
  for (const [fixture, target] of [
    ["hermes-native/plugin.yaml.txt", ".hermes-plugin/plugin.yaml"],
    ["hermes-native/__init__.py.txt", ".hermes-plugin/__init__.py"],
    [
      "hermes-native/hermes-tools.md.txt",
      "skills/using-superpowers/references/hermes-tools.md",
    ],
    ["pi-native/SKILL.md.txt", "skills/using-superpowers/SKILL.md"],
    ["pi-native/LICENSE.txt", "LICENSE"],
  ] as const) {
    const destination = join(root, target);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(
      new URL(`../../../fixtures/${fixture}`, import.meta.url),
      destination,
    );
  }
  for (const target of [
    ".claude-plugin/plugin.json",
    ".muse-plugin/plugin.json",
    "README.md",
  ]) {
    const destination = join(root, target);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, "inert discarded fixture\n");
  }
  return root;
}

export interface HermesSandbox {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly ctx: AdapterContext;
  readonly paths: HermesPaths;
}

export function hermesSandbox(t: TestContext): HermesSandbox {
  const root = scratch(t, "spw-hermes-state-");
  const env = {
    HOME: join(root, "home"),
    HERMES_HOME: join(root, "hermes"),
    HERMES_MANAGED_DIR: join(root, "managed"),
    TMPDIR: root,
  };
  mkdirSync(env.HOME, { recursive: true });
  mkdirSync(env.HERMES_MANAGED_DIR, { recursive: true });
  return { root, env, ctx: { root, env }, paths: hermesPaths(env, root) };
}

export async function prepareHermesArtifact(
  t: TestContext,
  sandbox: HermesSandbox,
  marker?: string,
): Promise<{ artifact: PreparedArtifact; selection: EffectiveSelection }> {
  const upstream = nativeHermesFixture(t);
  if (marker !== undefined)
    writeFileSync(join(upstream, ".hermes-plugin", "marker"), `${marker}\n`);
  const selection = nativeSelection(commitFixture(upstream));
  rmSync(sandbox.paths.preparedRoot, { recursive: true, force: true });
  mkdirSync(sandbox.paths.managerRoot, { recursive: true });
  const result = await prepareHermesCandidate(
    {
      upstreamRoot: upstream,
      workspaceRoot: sandbox.root,
      candidateRoot: sandbox.paths.preparedRoot,
      selection,
    },
    sandbox.ctx,
  );
  if (!result.outcome.ok) throw new Error("fixture preparation failed");
  return { artifact: result.outcome.result, selection };
}

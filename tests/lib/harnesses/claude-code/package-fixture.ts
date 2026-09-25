import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import type { AdapterContext } from "../../../../src/adapter-result.ts";
import type { EffectiveSelection } from "../../../../src/effective-selection.ts";
import type { PreparedArtifact } from "../../../../src/harness.ts";
import {
  claudeCodePaths,
  type ClaudeCodePaths,
} from "../../../../src/harnesses/claude-code/paths.ts";
import { prepareClaudeCodeCandidate } from "../../../../src/harnesses/claude-code/prepare.ts";
import { commitFixture, nativeSelection } from "../pi/package-fixture.ts";

export function nativeClaudeCodeFixture(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "spw-claude-code-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [fixture, target] of [
    ["claude-code-native/plugin.json.txt", ".claude-plugin/plugin.json"],
    ["claude-code-native/hooks.json.txt", "hooks/hooks.json"],
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
  return root;
}

export interface ClaudeCodeSandbox {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly ctx: AdapterContext;
  readonly paths: ClaudeCodePaths;
}

export function claudeCodeSandbox(t: TestContext): ClaudeCodeSandbox {
  const root = mkdtempSync(join(tmpdir(), "spw-claude-code-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    HOME: join(root, "home"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    TMPDIR: root,
  };
  mkdirSync(env.HOME, { recursive: true });
  return { root, env, ctx: { root, env }, paths: claudeCodePaths(env, root) };
}

export async function prepareClaudeCodeArtifact(
  t: TestContext,
  sandbox: ClaudeCodeSandbox,
  marker?: string,
): Promise<{ artifact: PreparedArtifact; selection: EffectiveSelection }> {
  const upstream = nativeClaudeCodeFixture(t);
  if (marker !== undefined)
    writeFileSync(join(upstream, "marker"), `${marker}\n`);
  const selection = nativeSelection(commitFixture(upstream));
  rmSync(sandbox.paths.preparedRoot, { recursive: true, force: true });
  mkdirSync(sandbox.paths.managerRoot, { recursive: true });
  const result = await prepareClaudeCodeCandidate(
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

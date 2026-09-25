import type {
  HarnessAdapter,
  HarnessCommand,
  ToolRequirement,
} from "../../harness.ts";
import { displayPath } from "../../validator.ts";
import { installClaudeCode, removeClaudeCode } from "./install.ts";
import { claudeCodePaths } from "./paths.ts";
import {
  claudeCodePreparationLocation,
  inspectClaudeCodePrepared,
  prepareClaudeCodeCandidate,
  readClaudeCodePrepared,
  validateClaudeCodePreparationBeforeFetch,
} from "./prepare.ts";
import { claudeCodePresentation } from "./presentation.ts";
import {
  inspectClaudeCodeControl,
  inspectClaudeCodeInstalled,
  inspectClaudeCodeOwnership,
  type ClaudeCodeRemovalInput,
} from "./state.ts";

function requirements(
  command: HarnessCommand,
  env: NodeJS.ProcessEnv,
): readonly ToolRequirement[] {
  if (
    command !== "probe" &&
    command !== "install" &&
    command !== "update" &&
    command !== "uninstall"
  )
    return [];
  const executable = env.SUPERPOWERS_CLAUDE_CODE || "claude";
  return [
    {
      name: "claude",
      executable,
      lookup: "explicit-path-or-path",
      missingMessage: `required command not found: ${displayPath(executable)} — install Claude Code or set SUPERPOWERS_CLAUDE_CODE`,
    },
  ];
}

export const claudeCodeHarness: HarnessAdapter<ClaudeCodeRemovalInput> = {
  preparationLocation: claudeCodePreparationLocation,
  mutationRoots: async (ctx) => [
    claudeCodePaths(ctx.env ?? {}, process.cwd()).configRoot,
  ],
  validatePreparationBeforeFetch: validateClaudeCodePreparationBeforeFetch,
  prepareCandidate: prepareClaudeCodeCandidate,
  inspectPrepared: inspectClaudeCodePrepared,
  readPrepared: readClaudeCodePrepared,
  inspectOwnership: (ctx) => inspectClaudeCodeOwnership(ctx),
  inspectUpdateControl: inspectClaudeCodeControl,
  inspectInstalled: (selection, ctx) =>
    inspectClaudeCodeInstalled(selection, ctx),
  install: (artifact, ctx) => installClaudeCode(artifact, ctx),
  remove: (input, ctx) => removeClaudeCode(input, ctx),
  requirements,
  presentation: claudeCodePresentation,
};

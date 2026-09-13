import type {
  HarnessAdapter,
  HarnessCommand,
  ToolRequirement,
} from "../../harness.ts";
import { installOpenCode, removeOpenCode } from "./install.ts";
import { assertOpenCodePreparationSeparate, openCodePaths } from "./paths.ts";
import {
  inspectOpenCodePrepared,
  openCodePreparationLocation,
  prepareOpenCodeCandidate,
  readOpenCodePrepared,
  validateOpenCodePreparationBeforeFetch,
} from "./prepare.ts";
import { openCodePresentation } from "./presentation.ts";
import {
  inspectOpenCodeControl,
  inspectOpenCodeInstalled,
  inspectOpenCodeOwnership,
  type OpenCodeRemovalInput,
} from "./state.ts";

function requirements(
  command: HarnessCommand,
  env: NodeJS.ProcessEnv,
): readonly ToolRequirement[] {
  if (command !== "install" && command !== "update" && command !== "uninstall")
    return [];
  const executable = env.SUPERPOWERS_OPENCODE || "opencode";
  return [
    {
      name: "opencode",
      executable,
      lookup: "explicit-path-or-path",
      missingMessage: `required command not found: ${executable} — install the OpenCode CLI or set SUPERPOWERS_OPENCODE`,
    },
  ];
}

export const openCodeHarness: HarnessAdapter<OpenCodeRemovalInput> = {
  preparationLocation: openCodePreparationLocation,
  mutationRoots: async (ctx) => {
    const paths = openCodePaths(ctx.env ?? {}, process.cwd());
    await assertOpenCodePreparationSeparate(paths);
    return [paths.configRoot];
  },
  validatePreparationBeforeFetch: validateOpenCodePreparationBeforeFetch,
  prepareCandidate: prepareOpenCodeCandidate,
  inspectPrepared: inspectOpenCodePrepared,
  readPrepared: readOpenCodePrepared,
  inspectOwnership: inspectOpenCodeOwnership,
  inspectUpdateControl: inspectOpenCodeControl,
  inspectInstalled: inspectOpenCodeInstalled,
  install: installOpenCode,
  remove: removeOpenCode,
  requirements,
  presentation: openCodePresentation,
};

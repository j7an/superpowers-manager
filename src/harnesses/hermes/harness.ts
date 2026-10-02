import type {
  HarnessAdapter,
  HarnessCommand,
  ToolRequirement,
} from "../../harness.ts";
import { displayPath } from "../../validator.ts";
import { installHermes, removeHermes } from "./install.ts";
import { hermesPaths } from "./paths.ts";
import {
  hermesPreparationLocation,
  inspectHermesPrepared,
  prepareHermesCandidate,
  readHermesPrepared,
  validateHermesPreparationBeforeFetch,
} from "./prepare.ts";
import { hermesPresentation } from "./presentation.ts";
import {
  inspectHermesControl,
  inspectHermesInstalled,
  inspectHermesOwnership,
  type HermesRemovalInput,
} from "./state.ts";

function requirements(
  command: HarnessCommand,
  env: NodeJS.ProcessEnv,
): readonly ToolRequirement[] {
  if (command !== "install" && command !== "update" && command !== "uninstall")
    return [];
  const executable = env.SUPERPOWERS_HERMES || "hermes";
  return [
    {
      name: "hermes",
      executable,
      lookup: "explicit-path-or-path",
      missingMessage: `required command not found: ${displayPath(executable)} — install Hermes Agent or set SUPERPOWERS_HERMES`,
    },
  ];
}

export const hermesHarness: HarnessAdapter<HermesRemovalInput> = {
  preparationLocation: hermesPreparationLocation,
  mutationRoots: async (ctx) => [
    hermesPaths(ctx.env ?? {}, process.cwd()).hermesHome,
  ],
  validatePreparationBeforeFetch: validateHermesPreparationBeforeFetch,
  prepareCandidate: prepareHermesCandidate,
  inspectPrepared: inspectHermesPrepared,
  readPrepared: readHermesPrepared,
  inspectOwnership: inspectHermesOwnership,
  inspectUpdateControl: inspectHermesControl,
  inspectInstalled: inspectHermesInstalled,
  install: installHermes,
  remove: removeHermes,
  requirements,
  presentation: hermesPresentation,
};

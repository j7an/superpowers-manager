import { successResult } from "./adapter-result.ts";
import type { HarnessAdapter } from "./harness.ts";
import { installPi, removePi } from "./pi-install.ts";
import { piPaths } from "./pi-paths.ts";
import {
  inspectPiPrepared,
  piPreparationLocation,
  preparePiCandidate,
  readPiPrepared,
} from "./pi-prepare.ts";
import { piPresentation } from "./pi-presentation.ts";
import {
  inspectPiControl,
  inspectPiInstalled,
  inspectPiOwnership,
  type PiRemovalInput,
} from "./pi-state.ts";

export const piHarness: HarnessAdapter<PiRemovalInput> = {
  preparationLocation: piPreparationLocation,
  mutationRoots: async (ctx) => [
    piPaths(ctx.env ?? {}, process.cwd()).agentDir,
  ],
  validatePreparationBeforeFetch: async () =>
    successResult("validate-pi-preparation", null, []),
  prepareCandidate: preparePiCandidate,
  inspectPrepared: inspectPiPrepared,
  readPrepared: readPiPrepared,
  inspectOwnership: inspectPiOwnership,
  inspectUpdateControl: inspectPiControl,
  inspectInstalled: inspectPiInstalled,
  install: installPi,
  remove: removePi,
  requirements(command, env) {
    if (
      command !== "install" &&
      command !== "update" &&
      command !== "uninstall"
    )
      return [];
    const executable = env.SUPERPOWERS_PI || "pi";
    return [
      {
        name: "pi",
        executable,
        lookup: "explicit-path-or-path",
        missingMessage: `required command not found: ${executable} — install the Pi CLI or set SUPERPOWERS_PI`,
      },
    ];
  },
  presentation: piPresentation,
};

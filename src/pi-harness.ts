import { failureResult, successResult } from "./adapter-result.ts";
import { classifyPathNoFollow } from "./safe-path.ts";
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
  async inspectUpdateControl(ctx) {
    const paths = piPaths(ctx.env ?? {}, process.cwd());
    try {
      if ((await classifyPathNoFollow(paths.recoveryRoot)) !== "missing") {
        const decision = {
          kind: "blocked" as const,
          output: {
            stdout: [],
            stderr: [
              `error: Pi recovery required; preserve material at ${paths.recoveryRoot} for manual resolution`,
            ],
          },
        };
        return successResult(
          "inspect-pi-control",
          {
            probeEligibility: decision,
            mutationEligibility: decision,
            presentationValue: `recovery required at ${paths.recoveryRoot}`,
            recoveryState: "required",
          },
          [],
        );
      }
    } catch {
      return failureResult(
        "inspect-pi-control",
        "invalid-state",
        `cannot inspect Pi recovery state at ${paths.recoveryRoot}`,
        [],
        [],
      );
    }
    return await inspectPiControl(ctx);
  },
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

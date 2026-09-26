import {
  successResult,
  type AdapterContext,
  type AdapterResult,
} from "../../adapter-result.ts";
import {
  codexInspectControl,
  codexInspectOwnership,
  codexInstall,
  type CodexRemovalInput,
} from "./adapter.ts";
import {
  codexPreparationLocation,
  inspectCodexPrepared,
  prepareCodexCandidate,
  readCodexPrepared,
  validateCodexPreparationBeforeFetch,
} from "./prepare.ts";
import { codexPresentation } from "./presentation.ts";
import type {
  Decision,
  HarnessAdapter,
  HarnessCommand,
  ToolRequirement,
  UpdateControlInspection,
} from "../../harness.ts";
import { codexHome, codexPaths } from "./paths.ts";
import {
  installCodexMarketplace,
  removeCodexMarketplace,
} from "./publication.ts";
import { readCodexRecovery } from "./recovery.ts";
import { inspectCodexInstallation } from "./state.ts";

function requirements(
  command: HarnessCommand,
  env: NodeJS.ProcessEnv,
): readonly ToolRequirement[] {
  if (
    command !== "probe" &&
    command !== "install" &&
    command !== "update" &&
    command !== "uninstall"
  ) {
    return [];
  }
  const executable = env.SUPERPOWERS_CODEX || "codex";
  return [
    {
      name: "codex",
      executable,
      lookup: "explicit-path-or-path",
      missingMessage: `required command not found: ${executable} — install the Codex CLI or set SUPERPOWERS_CODEX`,
    },
  ];
}

async function mutationRoots(ctx: AdapterContext): Promise<readonly string[]> {
  return [codexHome(ctx.env ?? {}, process.cwd())];
}

async function inspectCodexUpdateControl(
  ctx: AdapterContext,
): Promise<AdapterResult<UpdateControlInspection>> {
  const result = await codexInspectControl(ctx);
  if (!result.outcome.ok) return result;
  const paths = codexPaths(ctx.env ?? {}, process.cwd());
  let diagnostic: string | null = null;
  try {
    if ((await readCodexRecovery(paths)) !== null) {
      diagnostic = `Codex recovery required; preserve material at ${paths.recoveryRoot} for manual resolution`;
    }
  } catch {
    diagnostic = `cannot inspect Codex recovery state at ${paths.recoveryRoot}`;
  }
  if (diagnostic === null) return result;
  const decision: Decision = {
    kind: "blocked",
    output: { stdout: [], stderr: [`error: ${diagnostic}`] },
  };
  return successResult(
    result.outcome.operation,
    {
      probeEligibility: decision,
      mutationEligibility: decision,
      presentationValue: diagnostic,
      recoveryState: "required",
    },
    result.outcome.messages,
  );
}

export const codexHarness: HarnessAdapter<CodexRemovalInput> = {
  preparationLocation: codexPreparationLocation,
  mutationRoots,
  validatePreparationBeforeFetch: validateCodexPreparationBeforeFetch,
  prepareCandidate: prepareCodexCandidate,
  inspectPrepared: inspectCodexPrepared,
  readPrepared: readCodexPrepared,
  inspectOwnership: codexInspectOwnership,
  inspectUpdateControl: inspectCodexUpdateControl,
  inspectInstalled: inspectCodexInstallation,
  install: (artifact, ctx) =>
    installCodexMarketplace(artifact, ctx, codexInstall),
  remove: removeCodexMarketplace,
  requirements,
  get presentation() {
    return codexPresentation;
  },
};

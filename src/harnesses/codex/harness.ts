import {
  failureResult,
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

function preserveFailure<T>(result: AdapterResult): AdapterResult<T> {
  if (result.outcome.ok) {
    throw new Error("cannot preserve a successful adapter result as failure");
  }
  return { status: result.status, outcome: result.outcome };
}

export function rejectSuccessfulNonzeroStatus<T>(
  result: AdapterResult<T>,
  message: string,
): AdapterResult<T> {
  if (!result.outcome.ok || result.status === 0) return result;
  return failureResult(
    result.outcome.operation,
    "invalid-status",
    message,
    [],
    result.outcome.messages,
  );
}

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
  const result = rejectSuccessfulNonzeroStatus(
    await codexInspectControl(ctx),
    "adapter reported a failure status for inspect --view update-control",
  );
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
  install: async (artifact, ctx) =>
    installCodexMarketplace(artifact, ctx, async (root, context) => {
      const result = await codexInstall(root, context);
      return rejectSuccessfulNonzeroStatus(
        result,
        codexPresentation.callFailure("install", context).invalidStatus,
      );
    }),
  remove: async (input, ctx) => {
    const result = await removeCodexMarketplace(input, ctx);
    if (!result.outcome.ok) return preserveFailure(result);
    if (result.status !== 0) {
      return rejectSuccessfulNonzeroStatus(
        result,
        codexPresentation.callFailure("remove", ctx, input).invalidStatus,
      );
    }
    return successResult(
      result.outcome.operation,
      null,
      result.outcome.messages,
    );
  },
  requirements,
  get presentation() {
    return codexPresentation;
  },
};

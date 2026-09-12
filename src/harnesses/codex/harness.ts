import {
  failureResult,
  hasTerminalControl,
  successResult,
  type AdapterContext,
  type AdapterResult,
} from "../../adapter-result.ts";
import {
  codexInspect,
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
import { codexInstallReceipt, codexPresentation } from "./presentation.ts";
import type {
  Decision,
  HarnessAdapter,
  HarnessCommand,
  InstalledState,
  InstallReceipt,
  OwnershipInspection,
  ToolRequirement,
  UpdateControlInspection,
} from "../../harness.ts";
import {
  codexControlInspection,
  codexOwnershipInspection,
} from "./lifecycle.ts";
import { commitMatches } from "../../status.ts";
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

function malformed<T>(
  result: AdapterResult,
  message: string,
): AdapterResult<T> {
  return failureResult(
    result.outcome.operation,
    "malformed-result",
    message,
    [],
    result.outcome.messages,
  );
}

function invalidStatus<T>(
  result: AdapterResult,
  message: string,
): AdapterResult<T> {
  return failureResult(
    result.outcome.operation,
    "invalid-status",
    message,
    [],
    result.outcome.messages,
  );
}

function resultRecord(result: AdapterResult): Record<string, unknown> | null {
  const value = result.outcome.ok ? result.outcome.result : null;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(
  result: Record<string, unknown>,
  key: string,
): { readonly ok: true; readonly value: string } | { readonly ok: false } {
  const raw = result[key];
  if (raw === null || raw === undefined) return { ok: true, value: "" };
  if (typeof raw === "string") return { ok: true, value: raw };
  return { ok: false };
}

function resourceFlag(
  result: Record<string, unknown>,
  key: "plugin" | "marketplace",
): boolean | null {
  const resources = result.resources;
  const bag =
    typeof resources === "object" &&
    resources !== null &&
    !Array.isArray(resources)
      ? (resources as Record<string, unknown>)
      : {};
  const value = bag[key];
  return typeof value === "boolean" ? value : null;
}

function conflictDescriptions(
  result: Record<string, unknown>,
): readonly string[] | null {
  const raw = result.conflicts;
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const descriptions: string[] = [];
  for (const item of raw) {
    if (
      typeof item !== "string" ||
      item.length === 0 ||
      hasTerminalControl(item)
    ) {
      return null;
    }
    descriptions.push(item);
  }
  return descriptions;
}

export function normalizeCodexOwnership(
  result: AdapterResult,
): AdapterResult<OwnershipInspection<CodexRemovalInput>> {
  if (!result.outcome.ok) return preserveFailure(result);
  if (result.status !== 0) {
    return invalidStatus(
      result,
      "adapter reported a failure status for inspect --view ownership",
    );
  }

  const record = resultRecord(result);
  if (record === null) {
    return malformed(
      result,
      "adapter returned a non-object result for inspect --view ownership",
    );
  }

  const pluginPresent = resourceFlag(record, "plugin");
  if (pluginPresent === null) {
    return malformed(
      result,
      "expected a Boolean adapter result at resources.plugin",
    );
  }
  const marketplacePresent = resourceFlag(record, "marketplace");
  if (marketplacePresent === null) {
    return malformed(
      result,
      "expected a Boolean adapter result at resources.marketplace",
    );
  }
  const identity = stringField(record, "identity_state");
  if (!identity.ok) {
    return malformed(
      result,
      "adapter returned a non-string identity_state for inspect --view ownership",
    );
  }
  const identityState = identity.value;
  const conflicts = conflictDescriptions(record);
  if (conflicts === null) {
    return malformed(result, "expected an array of strings at conflicts");
  }
  return successResult(
    result.outcome.operation,
    codexOwnershipInspection(
      identityState,
      { pluginPresent, marketplacePresent },
      conflicts,
    ),
    result.outcome.messages,
  );
}

export function normalizeCodexControl(
  result: AdapterResult,
): AdapterResult<UpdateControlInspection> {
  if (!result.outcome.ok) return preserveFailure(result);
  if (result.status !== 0) {
    return invalidStatus(
      result,
      "adapter reported a failure status for inspect --view update-control",
    );
  }
  const record = resultRecord(result);
  if (record === null) {
    return malformed(
      result,
      "adapter returned a non-object result for inspect --view update-control",
    );
  }
  const control = stringField(record, "update_control");
  if (!control.ok) {
    return malformed(
      result,
      "adapter returned a non-string update_control for inspect --view update-control",
    );
  }
  return successResult(
    result.outcome.operation,
    codexControlInspection(control.value),
    result.outcome.messages,
  );
}

export function normalizeCodexInstalled(
  result: AdapterResult,
  desiredCommit: string,
): AdapterResult<InstalledState> {
  if (!result.outcome.ok) return preserveFailure(result);
  if (result.status !== 0) {
    return invalidStatus(
      result,
      "adapter reported a failure status for inspect --view fingerprint",
    );
  }
  const record = resultRecord(result);
  if (record === null) {
    return malformed(
      result,
      "adapter returned a non-object result for inspect --view fingerprint",
    );
  }
  const fingerprint = stringField(record, "fingerprint");
  if (!fingerprint.ok) {
    return malformed(
      result,
      "adapter returned a non-string fingerprint for inspect --view fingerprint",
    );
  }
  const observedIdentity = fingerprint.value;
  const installed: InstalledState =
    observedIdentity.length === 0
      ? { kind: "absent", observedIdentity: "" }
      : commitMatches(desiredCommit, observedIdentity)
        ? { kind: "current", observedIdentity }
        : { kind: "mismatch", observedIdentity };
  return successResult(
    result.outcome.operation,
    installed,
    result.outcome.messages,
  );
}

export function normalizeCodexInstall(
  result: AdapterResult,
): AdapterResult<InstallReceipt> {
  if (!result.outcome.ok) return preserveFailure(result);
  if (result.status !== 0) {
    return invalidStatus(
      result,
      "adapter reported a failure status for install",
    );
  }
  const record = resultRecord(result);
  if (record === null) {
    return malformed(
      result,
      "adapter returned a non-object result for install",
    );
  }
  const hints = record.verification_hints;
  const bag =
    typeof hints === "object" && hints !== null && !Array.isArray(hints)
      ? (hints as Record<string, unknown>)
      : {};
  return successResult(
    result.outcome.operation,
    codexInstallReceipt(bag.missing, bag.mismatch),
    result.outcome.messages,
  );
}

// The canonical payload normalizer has no context parameter. Keep the native
// call's defensive success/nonzero-status guard beside the concrete adapter,
// where the exact legacy diagnostic can still name ctx.root.
export function normalizeCodexInstallForContext(
  result: AdapterResult,
  ctx: AdapterContext,
): AdapterResult<InstallReceipt> {
  if (!result.outcome.ok) return preserveFailure(result);
  if (result.status !== 0) {
    return invalidStatus(
      result,
      codexPresentation.callFailure("install", ctx).invalidStatus,
    );
  }
  return normalizeCodexInstall(result);
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
  const normalized = normalizeCodexControl(
    await codexInspect("update-control", ctx),
  );
  if (!normalized.outcome.ok) return normalized;
  const paths = codexPaths(ctx.env ?? {}, process.cwd());
  let diagnostic: string | null = null;
  try {
    if ((await readCodexRecovery(paths)) !== null) {
      diagnostic = `Codex recovery required; preserve material at ${paths.recoveryRoot} for manual resolution`;
    }
  } catch {
    diagnostic = `cannot inspect Codex recovery state at ${paths.recoveryRoot}`;
  }
  if (diagnostic === null) return normalized;
  const decision: Decision = {
    kind: "blocked",
    output: { stdout: [], stderr: [`error: ${diagnostic}`] },
  };
  return successResult(
    normalized.outcome.operation,
    {
      probeEligibility: decision,
      mutationEligibility: decision,
      presentationValue: diagnostic,
      recoveryState: "required",
    },
    normalized.outcome.messages,
  );
}

export const codexHarness: HarnessAdapter<CodexRemovalInput> = {
  preparationLocation: codexPreparationLocation,
  mutationRoots,
  validatePreparationBeforeFetch: validateCodexPreparationBeforeFetch,
  prepareCandidate: prepareCodexCandidate,
  inspectPrepared: inspectCodexPrepared,
  readPrepared: readCodexPrepared,
  inspectOwnership: async (ctx) =>
    normalizeCodexOwnership(await codexInspect("ownership", ctx)),
  inspectUpdateControl: inspectCodexUpdateControl,
  inspectInstalled: inspectCodexInstallation,
  install: async (artifact, ctx) =>
    installCodexMarketplace(artifact, ctx, async (root, context) =>
      normalizeCodexInstallForContext(
        await codexInstall(root, context),
        context,
      ),
    ),
  remove: async (input, ctx) => {
    const result = await removeCodexMarketplace(input, ctx);
    if (!result.outcome.ok) return preserveFailure(result);
    if (result.status !== 0) {
      return invalidStatus(
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

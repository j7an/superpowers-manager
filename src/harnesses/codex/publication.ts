import { lstat, rm } from "node:fs/promises";

import {
  failureResult,
  successResult,
  type AdapterContext,
  type AdapterMessage,
  type AdapterResult,
} from "../../adapter-result.ts";
import {
  beginDirectoryPublication,
  type DirectoryPublication,
} from "../../atomic.ts";
import { digestArtifactTree } from "../../artifact-tree.ts";
import type { InstallReceipt, PreparedArtifact } from "../../harness.ts";
import { assertNoFollowType, classifyPathNoFollow } from "../../safe-path.ts";
import {
  codexInspect,
  codexInstallRefreshMode,
  codexRemove,
  codexReadNativeState,
  type CodexNativeState,
  type CodexRemovalInput,
} from "./adapter.ts";
import { readCodexAssessment } from "./compatibility.ts";
import {
  requireManagedUpdateControl,
  requireNoLegacyState,
} from "./lifecycle.ts";
import {
  readCodexMarketplace,
  stageCodexMarketplace,
  type MarketplaceSnapshot,
} from "./marketplace.ts";
import { assertCodexPreparationSeparate, codexPaths } from "./paths.ts";
import { codexPreparationLocation } from "./prepare.ts";
import {
  advanceCodexRecovery,
  beginCodexRecovery,
  finishCodexRecovery,
  readCodexRecovery,
  type FileIdentity,
  type PendingCodexPublication,
} from "./recovery.ts";
import { hasFilesystemAccessFailure, pathsEqual } from "./state.ts";

export interface CodexPublicationDependencies {
  readonly readNative: typeof codexReadNativeState;
  readonly inspectNative: typeof codexInspect;
  readonly beginPublication: typeof beginDirectoryPublication;
}

export interface CodexRemovalDependencies {
  readonly readNative: typeof codexReadNativeState;
  readonly removeNative: typeof codexRemove;
}

export type ActivateCodex = (
  root: string,
  ctx: AdapterContext,
) => Promise<AdapterResult<InstallReceipt>>;

const DEFAULTS: CodexPublicationDependencies = {
  readNative: codexReadNativeState,
  inspectNative: codexInspect,
  beginPublication: beginDirectoryPublication,
};

const REMOVAL_DEFAULTS: CodexRemovalDependencies = {
  readNative: codexReadNativeState,
  removeNative: codexRemove,
};

function fail<T>(
  code: string,
  message: string,
  messages: readonly AdapterMessage[],
): AdapterResult<T> {
  return failureResult("install-codex", code, message, [], messages);
}

function removalFailure(
  code: string,
  message: string,
  messages: readonly AdapterMessage[],
): AdapterResult<null> {
  return failureResult("uninstall-codex", code, message, [], messages);
}

function objectResult(result: AdapterResult): Record<string, unknown> {
  if (
    result.status !== 0 ||
    !result.outcome.ok ||
    result.outcome.result === null ||
    typeof result.outcome.result !== "object" ||
    Array.isArray(result.outcome.result)
  ) {
    throw new Error("Codex inspection failed");
  }
  return result.outcome.result as Record<string, unknown>;
}

function acceptedNative(
  result: AdapterResult<CodexNativeState>,
): CodexNativeState {
  if (result.status !== 0 || !result.outcome.ok) {
    throw new Error("Codex native observation failed");
  }
  const value = result.outcome.result;
  if (
    typeof value.marketplaceRoot !== "string" &&
    value.marketplaceRoot !== null
  ) {
    throw new Error("Codex native observation is malformed");
  }
  if (
    typeof value.pluginPresent !== "boolean" ||
    typeof value.pluginEnabled !== "boolean" ||
    (typeof value.activeVersion !== "string" && value.activeVersion !== null) ||
    (typeof value.activeRoot !== "string" && value.activeRoot !== null)
  ) {
    throw new Error("Codex native observation is malformed");
  }
  return value;
}

function requireOwnership(result: AdapterResult): void {
  const value = objectResult(result);
  if (
    typeof value.identity_state !== "string" ||
    requireNoLegacyState(value.identity_state).kind !== "ok" ||
    !Array.isArray(value.conflicts) ||
    value.conflicts.length !== 0
  ) {
    throw new Error("Codex ownership blocks publication");
  }
  const resources = value.resources;
  if (
    typeof resources !== "object" ||
    resources === null ||
    Array.isArray(resources) ||
    typeof (resources as Record<string, unknown>).plugin !== "boolean" ||
    typeof (resources as Record<string, unknown>).marketplace !== "boolean"
  ) {
    throw new Error("Codex ownership inspection is malformed");
  }
}

function requireControl(result: AdapterResult): void {
  const value = objectResult(result);
  if (
    typeof value.update_control !== "string" ||
    !requireManagedUpdateControl(value.update_control).ok
  ) {
    throw new Error("Codex update control blocks publication");
  }
}

function sameNative(left: CodexNativeState, right: CodexNativeState): boolean {
  return (
    left.marketplaceRoot === right.marketplaceRoot &&
    left.pluginPresent === right.pluginPresent &&
    left.pluginEnabled === right.pluginEnabled &&
    left.activeVersion === right.activeVersion &&
    left.activeRoot === right.activeRoot
  );
}

function sameIdentity(
  snapshot: MarketplaceSnapshot | null,
  identity: FileIdentity | null,
): boolean {
  return snapshot === null
    ? identity === null
    : identity !== null &&
        snapshot.dev === identity.dev &&
        snapshot.ino === identity.ino;
}

function sameMarketplace(
  left: MarketplaceSnapshot | null,
  right: MarketplaceSnapshot | null,
): boolean {
  return left === null
    ? right === null
    : right !== null &&
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.digest === right.digest;
}

function nativeAbsent(state: CodexNativeState): boolean {
  return (
    state.marketplaceRoot === null &&
    !state.pluginPresent &&
    !state.pluginEnabled &&
    state.activeVersion === null &&
    state.activeRoot === null
  );
}

function durableRegistrationMissing(
  state: CodexNativeState,
  marketplaceRoot: string,
  snapshot: MarketplaceSnapshot | null,
): boolean {
  return (
    snapshot === null &&
    state.marketplaceRoot !== null &&
    state.marketplaceRoot === marketplaceRoot
  );
}

async function sameCapturedMarketplace(
  root: string,
  captured: MarketplaceSnapshot,
): Promise<boolean> {
  try {
    return sameMarketplace(await readCodexMarketplace(root), captured);
  } catch {
    return false;
  }
}

export async function removeCodexMarketplace(
  _input: CodexRemovalInput,
  ctx: AdapterContext,
  dependencies: CodexRemovalDependencies = REMOVAL_DEFAULTS,
): Promise<AdapterResult<null>> {
  const messages: AdapterMessage[] = [];
  const paths = codexPaths(ctx.env ?? {}, process.cwd());
  let pending: PendingCodexPublication | undefined;
  let captured: MarketplaceSnapshot | null = null;
  let nativeAttempted = false;
  try {
    if ((await readCodexRecovery(paths)) !== null) {
      return removalFailure(
        "recovery-required",
        `Codex recovery is required before mutation; preserve material at ${paths.recoveryRoot}`,
        messages,
      );
    }
    const priorNative = await observeNative(ctx, dependencies, messages);
    captured = await readCodexMarketplace(paths.marketplaceRoot);
    if (
      durableRegistrationMissing(priorNative, paths.marketplaceRoot, captured)
    ) {
      return removalFailure(
        "removal-refused",
        `cannot remove Codex registration because owned marketplace content is missing at ${paths.marketplaceRoot}`,
        messages,
      );
    }
    if (captured !== null) {
      pending = await beginCodexRecovery(paths, {
        marketplaceRoot: paths.marketplaceRoot,
        priorNative,
        oldDigest: captured.digest,
        oldIdentity: { dev: captured.dev, ino: captured.ino },
      });
      await advanceCodexRecovery(pending, "removing");
    }

    const beforeRemoval = await observeNative(ctx, dependencies, messages);
    const marketplaceUnchanged =
      captured === null ||
      (await sameCapturedMarketplace(paths.marketplaceRoot, captured));
    if (!sameNative(beforeRemoval, priorNative) || !marketplaceUnchanged) {
      if (pending !== undefined && marketplaceUnchanged) {
        await finishCodexRecovery(pending);
      }
      return removalFailure(
        "removal-refused",
        "Codex native or durable marketplace state changed before removal",
        messages,
      );
    }

    const currentInput: CodexRemovalInput = {
      pluginPresent: beforeRemoval.pluginPresent,
      marketplacePresent: beforeRemoval.marketplaceRoot !== null,
    };
    nativeAttempted = true;
    let removed: AdapterResult;
    try {
      removed = await dependencies.removeNative(currentInput, ctx);
    } catch {
      removed = failureResult(
        "uninstall",
        "native-failed",
        "Codex native removal threw before returning a result",
        [],
        [],
      );
    }
    messages.push(...removed.outcome.messages);

    let afterRemoval: CodexNativeState;
    try {
      afterRemoval = await observeNative(ctx, dependencies, messages);
    } catch {
      return removalFailure(
        "recovery-required",
        pending === undefined
          ? "Codex deregistration could not be verified"
          : `Codex deregistration could not be verified; preserve the marketplace and recovery material at ${paths.marketplaceRoot} and ${paths.recoveryRoot}`,
        messages,
      );
    }
    if (removed.status !== 0 || !removed.outcome.ok) {
      if (pending === undefined && !removed.outcome.ok) {
        return failureResult(
          removed.outcome.operation,
          removed.outcome.error.code,
          removed.outcome.error.message,
          removed.outcome.error.hints,
          messages,
        );
      }
      return removalFailure(
        "native-failed",
        pending === undefined
          ? "Codex native removal failed"
          : `Codex native removal failed; preserve the marketplace and recovery material at ${paths.marketplaceRoot} and ${paths.recoveryRoot}`,
        messages,
      );
    }
    if (!nativeAbsent(afterRemoval)) {
      return removalFailure(
        "recovery-required",
        pending === undefined
          ? "Codex deregistration could not be verified"
          : `Codex deregistration could not be verified; preserve the marketplace and recovery material at ${paths.marketplaceRoot} and ${paths.recoveryRoot}`,
        messages,
      );
    }
    if (pending === undefined || captured === null) {
      return successResult("uninstall", null, messages);
    }

    await advanceCodexRecovery(pending, "deregistered");
    if (!(await sameCapturedMarketplace(paths.marketplaceRoot, captured))) {
      return removalFailure(
        "recovery-required",
        `Codex deregistered, but the durable marketplace changed; preserve recovery material at ${paths.recoveryRoot}`,
        messages,
      );
    }
    try {
      await rm(paths.marketplaceRoot, { recursive: true });
    } catch {
      if (await sameCapturedMarketplace(paths.marketplaceRoot, captured)) {
        try {
          await finishCodexRecovery(pending);
          return removalFailure(
            "cleanup-failed",
            `Codex deregistered, but the owned marketplace could not be removed at ${paths.marketplaceRoot}; retry uninstall to clean it`,
            messages,
          );
        } catch {
          // Fall through to the unresolved-recovery result below.
        }
      }
      return removalFailure(
        "recovery-required",
        `Codex deregistered, but durable cleanup could not be completed safely; preserve recovery material at ${paths.recoveryRoot}`,
        messages,
      );
    }
    await finishCodexRecovery(pending);
    return successResult("uninstall", null, messages);
  } catch {
    return removalFailure(
      pending !== undefined && nativeAttempted
        ? "recovery-required"
        : "removal-refused",
      pending !== undefined
        ? `Codex removal could not be completed safely; preserve the marketplace and recovery material at ${paths.marketplaceRoot} and ${paths.recoveryRoot}`
        : `cannot remove Codex marketplace; verify native and durable ownership at ${paths.marketplaceRoot}`,
      messages,
    );
  }
}

async function activeDigest(state: CodexNativeState): Promise<string | null> {
  if (!state.pluginPresent || state.activeRoot === null) return null;
  let kind;
  try {
    kind = await classifyPathNoFollow(state.activeRoot);
  } catch (cause) {
    throw new Error("cannot inspect prior active Codex plugin", { cause });
  }
  if (kind === "missing") return null;
  if (kind !== "directory") {
    throw new Error("cannot inspect prior active Codex plugin");
  }
  try {
    await readCodexAssessment(state.activeRoot);
    return await digestArtifactTree(state.activeRoot);
  } catch (cause) {
    if (hasFilesystemAccessFailure(cause)) {
      throw new Error("cannot inspect prior active Codex plugin", { cause });
    }
    return null;
  }
}

async function verifyPrepared(
  artifact: PreparedArtifact,
  expectedRoot: string,
): Promise<string> {
  if (artifact.root !== expectedRoot)
    throw new Error("unexpected Codex prepared root");
  const assessed = await readCodexAssessment(artifact.root);
  if (
    assessed.root !== artifact.root ||
    assessed.commit !== artifact.commit ||
    assessed.compatibility.kind !== "supported"
  ) {
    throw new Error("Codex prepared artifact changed");
  }
  return await digestArtifactTree(artifact.root);
}

async function observeNative(
  ctx: AdapterContext,
  dependencies: Pick<CodexPublicationDependencies, "readNative">,
  messages: AdapterMessage[],
): Promise<CodexNativeState> {
  const result = await dependencies.readNative(ctx);
  messages.push(...result.outcome.messages);
  return acceptedNative(result);
}

async function requireEligibility(
  ctx: AdapterContext,
  dependencies: CodexPublicationDependencies,
  messages: AdapterMessage[],
): Promise<void> {
  const ownership = await dependencies.inspectNative("ownership", ctx);
  messages.push(...ownership.outcome.messages);
  requireOwnership(ownership);
  const control = await dependencies.inspectNative("update-control", ctx);
  messages.push(...control.outcome.messages);
  requireControl(control);
}

async function verifyPrevious(
  pending: PendingCodexPublication,
  previous: MarketplaceSnapshot | null,
): Promise<void> {
  const current = await readCodexMarketplace(pending.paths.marketplaceRoot);
  if (!sameMarketplace(current, previous)) {
    throw new Error("previous Codex marketplace changed");
  }
}

async function cleanupBeforePublication(
  pending: PendingCodexPublication,
  previous: MarketplaceSnapshot | null,
  priorNative: CodexNativeState,
  ctx: AdapterContext,
  dependencies: CodexPublicationDependencies,
  messages: AdapterMessage[],
): Promise<boolean> {
  try {
    if (
      !sameNative(await observeNative(ctx, dependencies, messages), priorNative)
    ) {
      return false;
    }
    await verifyPrevious(pending, previous);
    if (
      (await assertNoFollowType(pending.backup, ["directory", "missing"])) !==
      "missing"
    ) {
      return false;
    }
    const stageKind = await assertNoFollowType(pending.stage, [
      "directory",
      "missing",
    ]);
    if (stageKind === "directory") {
      const staged = await readCodexMarketplace(pending.stage);
      if (
        staged === null ||
        !sameIdentity(staged, pending.record.stageIdentity) ||
        staged.digest !== pending.record.newDigest
      ) {
        return false;
      }
      await rm(pending.stage, { recursive: true });
    }
    await finishCodexRecovery(pending);
    return true;
  } catch {
    return false;
  }
}

async function nativeUnchangedAfterAttempt(
  prior: CodexNativeState,
  priorActiveDigest: string | null,
  current: CodexNativeState,
): Promise<boolean> {
  if (!sameNative(prior, current)) return false;
  if (!prior.pluginPresent) return true;
  if (prior.activeRoot === null || priorActiveDigest === null) return false;
  return (await activeDigest(current)) === priorActiveDigest;
}

async function rollbackPublication(
  pending: PendingCodexPublication,
  publication: DirectoryPublication,
  previous: MarketplaceSnapshot | null,
  priorNative: CodexNativeState,
  priorActiveDigest: string | null,
  activationAttempted: boolean,
  ctx: AdapterContext,
  dependencies: CodexPublicationDependencies,
): Promise<AdapterResult<null>> {
  if (pending.settled) {
    return fail(
      "already-settled",
      "Codex installation transaction has already been settled",
      [],
    );
  }
  const messages: AdapterMessage[] = [];
  try {
    const currentNative = await observeNative(ctx, dependencies, messages);
    if (
      activationAttempted &&
      !(await nativeUnchangedAfterAttempt(
        priorNative,
        priorActiveDigest,
        currentNative,
      ))
    ) {
      throw new Error("Codex native state may have changed");
    }
    if (!activationAttempted && !sameNative(currentNative, priorNative)) {
      throw new Error("Codex native state changed before activation");
    }
    const published = await readCodexMarketplace(pending.paths.marketplaceRoot);
    if (
      published === null ||
      !sameIdentity(published, pending.record.publishedIdentity) ||
      published.digest !== pending.record.newDigest
    ) {
      throw new Error("published Codex marketplace changed");
    }
    const backup = await readCodexMarketplace(pending.backup);
    if (!sameMarketplace(backup, previous)) {
      throw new Error("retained Codex marketplace changed");
    }
    await advanceCodexRecovery(pending, "rolling-back");
    await publication.rollback();
    await verifyPrevious(pending, previous);
    if (
      !sameNative(await observeNative(ctx, dependencies, messages), priorNative)
    ) {
      throw new Error("Codex native state changed during rollback");
    }
    await advanceCodexRecovery(pending, "restored");
    await finishCodexRecovery(pending);
    return successResult("rollback-codex", null, messages);
  } catch {
    return fail(
      "recovery-required",
      `Codex restoration could not be verified; preserve the marketplace and recovery material at ${pending.paths.recoveryRoot} and ${pending.backup}`,
      messages,
    );
  }
}

async function verifyActivated(
  pending: PendingCodexPublication,
  dependencies: CodexPublicationDependencies,
  ctx: AdapterContext,
  messages: AdapterMessage[],
): Promise<void> {
  const published = await readCodexMarketplace(pending.paths.marketplaceRoot);
  if (
    published === null ||
    !sameIdentity(published, pending.record.publishedIdentity) ||
    published.digest !== pending.record.newDigest
  ) {
    throw new Error("published Codex marketplace changed");
  }
  const native = await observeNative(ctx, dependencies, messages);
  if (
    native.marketplaceRoot === null ||
    !(await pathsEqual(
      native.marketplaceRoot,
      pending.paths.marketplaceRoot,
    )) ||
    !native.pluginPresent ||
    !native.pluginEnabled ||
    native.activeRoot === null
  ) {
    throw new Error("Codex activation changed");
  }
  const active = await readCodexAssessment(native.activeRoot);
  if (
    active.commit !== published.artifact.commit ||
    active.compatibility.kind !== "supported" ||
    (await digestArtifactTree(active.root)) !==
      (await digestArtifactTree(published.artifact.root))
  ) {
    throw new Error("active Codex plugin differs from publication");
  }
}

async function finalizePublication(
  pending: PendingCodexPublication,
  publication: DirectoryPublication,
  dependencies: CodexPublicationDependencies,
  ctx: AdapterContext,
): Promise<AdapterResult<null>> {
  if (pending.settled) {
    return fail(
      "already-settled",
      "Codex installation transaction has already been settled",
      [],
    );
  }
  const messages: AdapterMessage[] = [];
  let verified = false;
  let backupRemoved = false;
  try {
    await verifyActivated(pending, dependencies, ctx, messages);
    await advanceCodexRecovery(pending, "finalizing");
    verified = true;
    await publication.finalize();
    backupRemoved = true;
    await finishCodexRecovery(pending);
    return successResult("finalize-codex", null, messages);
  } catch {
    const detail = backupRemoved
      ? "activation was verified and backup cleanup completed, but journal retirement failed"
      : verified
        ? "activation was verified, but backup or journal cleanup failed"
        : "activation could not be verified";
    return fail(
      "recovery-required",
      `Codex ${detail}; preserve recovery material at ${pending.paths.recoveryRoot} and ${pending.backup}`,
      messages,
    );
  }
}

export async function installCodexMarketplace(
  artifact: PreparedArtifact,
  ctx: AdapterContext,
  activate: ActivateCodex,
  dependencies: CodexPublicationDependencies = DEFAULTS,
): Promise<AdapterResult<InstallReceipt>> {
  const messages: AdapterMessage[] = [];
  const effectiveEnv = { ...process.env, ...ctx.env };
  if (codexInstallRefreshMode(effectiveEnv) === null) {
    return fail(
      "invalid-arguments",
      `unsupported SUPERPOWERS_INSTALL_REFRESH_MODE: ${effectiveEnv.SUPERPOWERS_INSTALL_REFRESH_MODE}`,
      messages,
    );
  }
  const paths = codexPaths(ctx.env ?? {}, process.cwd());
  let pending: PendingCodexPublication | undefined;
  let publication: DirectoryPublication | undefined;
  let previous: MarketplaceSnapshot | null = null;
  let priorNative: CodexNativeState | undefined;
  let priorActiveDigest: string | null = null;
  let activationAttempted = false;
  try {
    const preparedRoot = codexPreparationLocation(ctx).destinationRoot;
    await assertCodexPreparationSeparate(preparedRoot, paths);
    if ((await readCodexRecovery(paths)) !== null) {
      return fail(
        "recovery-required",
        `Codex recovery is required before mutation; preserve material at ${paths.recoveryRoot}`,
        messages,
      );
    }
    const preparedDigest = await verifyPrepared(artifact, preparedRoot);
    previous = await readCodexMarketplace(paths.marketplaceRoot);
    priorNative = await observeNative(ctx, dependencies, messages);
    priorActiveDigest = await activeDigest(priorNative);
    await requireEligibility(ctx, dependencies, messages);
    pending = await beginCodexRecovery(paths, {
      marketplaceRoot: paths.marketplaceRoot,
      priorNative,
      oldDigest: previous?.digest ?? null,
      oldIdentity:
        previous === null ? null : { dev: previous.dev, ino: previous.ino },
    });
    const staged = await stageCodexMarketplace(
      artifact,
      ctx.root,
      pending.stage,
    );
    await advanceCodexRecovery(pending, "staging", {
      newDigest: staged.digest,
      stageIdentity: { dev: staged.dev, ino: staged.ino },
    });
    await advanceCodexRecovery(pending, "publishing");
    if ((await verifyPrepared(artifact, preparedRoot)) !== preparedDigest) {
      throw new Error("Codex prepared artifact changed");
    }
    await verifyPrevious(pending, previous);
    if (
      !sameNative(await observeNative(ctx, dependencies, messages), priorNative)
    ) {
      throw new Error("Codex native state changed");
    }
    publication = await dependencies.beginPublication(
      pending.stage,
      paths.marketplaceRoot,
      { backupPath: pending.backup },
    );
    if (
      publication.live !== paths.marketplaceRoot ||
      publication.backup !== (previous === null ? null : pending.backup)
    ) {
      throw new Error("Codex publication returned inconsistent paths");
    }
    const publishedStat = await lstat(paths.marketplaceRoot);
    await advanceCodexRecovery(pending, "published", {
      publishedIdentity: { dev: publishedStat.dev, ino: publishedStat.ino },
    });
    await advanceCodexRecovery(pending, "activating");
    activationAttempted = true;
    let activated: AdapterResult<InstallReceipt>;
    try {
      activated = await activate(paths.marketplaceRoot, ctx);
    } catch {
      activated = failureResult(
        "install",
        "native-failed",
        "Codex native activation threw before returning a receipt",
        [],
        [],
      );
    }
    messages.push(...activated.outcome.messages);
    if (activated.status !== 0 || !activated.outcome.ok) {
      const settled = await rollbackPublication(
        pending,
        publication,
        previous,
        priorNative,
        priorActiveDigest,
        true,
        ctx,
        dependencies,
      );
      messages.push(...settled.outcome.messages);
      if (settled.outcome.ok) {
        return fail(
          "activation-failed",
          "Codex activation failed; the previous marketplace and native state were restored",
          messages,
        );
      }
      return fail(
        "recovery-required",
        `Codex activation may have changed native state; preserve recovery material at ${paths.recoveryRoot} and ${pending.backup}`,
        messages,
      );
    }
    await advanceCodexRecovery(pending, "ready");
    const owned = pending;
    const retained = publication;
    let transactionSettled = false;
    const settleOnce = async (
      action: () => Promise<AdapterResult<null>>,
    ): Promise<AdapterResult<null>> => {
      if (transactionSettled) {
        return fail(
          "already-settled",
          "Codex installation transaction has already been settled",
          [],
        );
      }
      transactionSettled = true;
      return await action();
    };
    return successResult(
      activated.outcome.operation,
      {
        ...activated.outcome.result,
        transaction: {
          finalize: () =>
            settleOnce(() =>
              finalizePublication(owned, retained, dependencies, ctx),
            ),
          rollback: () =>
            settleOnce(() =>
              rollbackPublication(
                owned,
                retained,
                previous,
                priorNative!,
                priorActiveDigest,
                activationAttempted,
                ctx,
                dependencies,
              ),
            ),
        },
      },
      messages,
    );
  } catch {
    if (pending !== undefined && priorNative !== undefined) {
      let settled = false;
      if (publication === undefined) {
        settled = await cleanupBeforePublication(
          pending,
          previous,
          priorNative,
          ctx,
          dependencies,
          messages,
        );
      } else {
        const result = await rollbackPublication(
          pending,
          publication,
          previous,
          priorNative,
          priorActiveDigest,
          activationAttempted,
          ctx,
          dependencies,
        );
        messages.push(...result.outcome.messages);
        settled = result.outcome.ok;
      }
      if (settled) {
        return fail(
          "activation-refused",
          `cannot activate Codex artifact ${artifact.root}; previous state was preserved`,
          messages,
        );
      }
      return fail(
        "recovery-required",
        `Codex mutation requires manual recovery; preserve material at ${paths.recoveryRoot} and ${pending.backup}`,
        messages,
      );
    }
    let unresolved = false;
    try {
      unresolved = (await readCodexRecovery(paths)) !== null;
    } catch {
      unresolved = true;
    }
    return fail(
      unresolved ? "recovery-required" : "activation-refused",
      unresolved
        ? `Codex recovery is required before mutation; preserve material at ${paths.recoveryRoot}`
        : `cannot activate Codex artifact ${artifact.root}; verify prepared content, ownership, and native state`,
      messages,
    );
  }
}

import { randomBytes } from "node:crypto";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import {
  failureResult,
  successResult,
  type AdapterContext,
  type AdapterResult,
} from "../../adapter-result.ts";
import {
  beginDirectoryPublication,
  type DirectoryPublication,
} from "../../atomic.ts";
import type { InstallReceipt, PreparedArtifact } from "../../harness.ts";
import { digestArtifactTree } from "../../artifact-tree.ts";
import { normalizeSnapshotRuntimeVersion } from "../../harness-command-result.ts";
import { runPi } from "./native.ts";
import {
  readPiPackageAssessment,
  readPiReceipt,
  type PiReceipt,
} from "./package.ts";
import { piPaths, type PiPaths } from "./paths.ts";
import { readPiSettings, type PiPackageEntry } from "./settings.ts";
import {
  inspectPiControl,
  inspectPiOwnership,
  type PiRemovalInput,
} from "./state.ts";
import {
  assertNoFollowType,
  canonicalizeProspectivePath,
  classifyPathNoFollow,
} from "../../safe-path.ts";
import {
  createJournal,
  createSnapshotJournal,
  hasRecovery,
  identity,
  journalPath,
  publicationPaths,
  requireNoRecovery,
  type Identity,
} from "../../snapshot-journal.ts";

export interface PiInstallDependencies {
  readonly run: typeof runPi;
  readonly beginPublication: typeof beginDirectoryPublication;
}

const DEFAULTS: PiInstallDependencies = {
  run: runPi,
  beginPublication: beginDirectoryPublication,
};
type Phase =
  | "staging"
  | "publishing"
  | "published"
  | "registering"
  | "registered"
  | "ready"
  | "finalizing"
  | "rolling-back"
  | "restored"
  | "removing"
  | "deregistered";
interface Journal {
  readonly schema: 1;
  readonly token: string;
  readonly installedRoot: string;
  readonly oldArtifact: PiReceipt | null;
  readonly newArtifact: PiReceipt | null;
  readonly priorRegistration: PiPackageEntry | null;
  readonly priorCanonicalRegistration: string | null;
  readonly createdRegistration: PiPackageEntry | null;
  readonly phase: Phase;
}
interface Pending {
  readonly paths: PiPaths;
  readonly canonicalRoot: string;
  readonly recoveryIdentity: Identity;
  readonly backup: string;
  readonly stage: string;
  readonly ctx: AdapterContext;
  readonly deps: PiInstallDependencies;
  journal: Journal;
  journalIdentity: Identity;
  stageIdentity?: Identity;
  publishedIdentity?: Identity;
  settled: boolean;
}

function fail(code: string, message: string): AdapterResult<never> {
  return failureResult("pi-lifecycle", code, message, [], []);
}
function accepted<T>(result: AdapterResult<T>): T {
  if (result.status !== 0 || !result.outcome.ok)
    throw new Error("Pi operation did not succeed");
  return result.outcome.result;
}
function journalBytes(journal: Journal): Buffer {
  return Buffer.from(JSON.stringify(journal) + "\n");
}

async function validatePaths(paths: PiPaths): Promise<string> {
  await assertNoFollowType(paths.agentDir, ["directory", "missing"]);
  await assertNoFollowType(paths.managerRoot, ["directory", "missing"]);
  await assertNoFollowType(paths.installedRoot, ["directory", "missing"]);
  return await canonicalizeProspectivePath(paths.installedRoot);
}

const { requireIdentity, requireJournal, phase, retireJournal } =
  createSnapshotJournal<PiPaths, Journal>({
    label: "Pi",
    validatePaths,
    serialize: journalBytes,
    readCap: 64 * 1024,
  });

async function registration(paths: PiPaths): Promise<PiPackageEntry | null> {
  return (await readPiSettings(paths.settingsFile, paths.homeDir))
    .managerRegistration;
}
function sameRegistration(
  a: PiPackageEntry | null,
  b: PiPackageEntry | null,
): boolean {
  return a === null
    ? b === null
    : b !== null &&
        a.source === b.source &&
        a.resourceState === b.resourceState;
}
async function snapshot(root: string): Promise<PiReceipt | null> {
  if ((await assertNoFollowType(root, ["directory", "missing"])) === "missing")
    return null;
  const receipt = await readPiReceipt(root);
  if (receipt.digest !== (await digestArtifactTree(root)))
    throw new Error("Pi snapshot changed");
  return receipt;
}
function sameArtifact(a: PiReceipt | null, b: PiReceipt | null): boolean {
  return a === null
    ? b === null
    : b !== null &&
        a.binding === b.binding &&
        a.digest === b.digest &&
        a.commit === b.commit &&
        a.source === b.source;
}
async function requireActivationEligibility(
  ctx: AdapterContext,
): Promise<void> {
  const ownership = accepted(await inspectPiOwnership(ctx));
  const control = accepted(await inspectPiControl(ctx));
  if (
    ownership.installEligibility.kind !== "allowed" ||
    control.mutationEligibility.kind !== "allowed"
  )
    throw new Error("Pi ownership or control blocked");
}
async function requireSnapshot(
  root: string,
  expected: PiReceipt | null,
): Promise<void> {
  if (!sameArtifact(await snapshot(root), expected))
    throw new Error("Pi artifact changed");
}

async function beginJournal(
  paths: PiPaths,
  oldArtifact: PiReceipt | null,
  newArtifact: PiReceipt | null,
  priorRegistration: PiPackageEntry | null,
  ctx: AdapterContext,
  deps: PiInstallDependencies,
): Promise<Pending> {
  const canonicalRoot = await validatePaths(paths);
  await mkdir(paths.managerRoot, { recursive: true });
  await requireNoRecovery(paths);
  await mkdir(paths.recoveryRoot, { mode: 0o700 });
  const recoveryIdentity = await identity(paths.recoveryRoot);
  const token = randomBytes(16).toString("hex");
  const journal: Journal = {
    schema: 1,
    token,
    installedRoot: canonicalRoot,
    oldArtifact,
    newArtifact,
    priorRegistration,
    priorCanonicalRegistration:
      priorRegistration === null ? null : canonicalRoot,
    createdRegistration: null,
    phase: newArtifact === null ? "removing" : "staging",
  };
  // The first journal is durable before either a staging tree or backup exists.
  const journalIdentity = await createJournal(
    paths.recoveryRoot,
    journalBytes(journal),
  );
  return {
    paths,
    canonicalRoot,
    recoveryIdentity,
    ...publicationPaths(canonicalRoot, token),
    ctx,
    deps,
    journal,
    journalIdentity,
    settled: false,
  };
}

async function journalRetirementGuidance(p: Pending): Promise<string> {
  try {
    const kind = await classifyPathNoFollow(p.paths.recoveryRoot);
    if (kind === "missing")
      return `recovery directory ${p.paths.recoveryRoot} is absent; verify the installed state because no recovery journal remains`;
    if (kind !== "directory")
      return `recovery path ${p.paths.recoveryRoot} is no longer a directory; preserve it unchanged and inspect it manually`;
    let entries: string[];
    try {
      await requireIdentity(p.paths.recoveryRoot, p.recoveryIdentity);
      entries = await readdir(p.paths.recoveryRoot);
      await requireIdentity(p.paths.recoveryRoot, p.recoveryIdentity);
    } catch {
      return `recovery directory identity at ${p.paths.recoveryRoot} changed or could not be verified; preserve it unchanged and inspect it manually`;
    }
    if (entries.some((name) => name !== "transaction.json"))
      return `recovery directory ${p.paths.recoveryRoot} contains unexpected material; preserve it unchanged and inspect its contents manually`;
    if (entries.includes("transaction.json"))
      return `the Manager recovery journal remains at ${journalPath(p)} and no other recovery material was observed; verify the installed state and confirm the recovery directory still contains only that journal before retiring it`;
    return `the recovery journal is absent and ${p.paths.recoveryRoot} was observed as an empty directory; verify the installed state and confirm the directory is still empty before removing it`;
  } catch {
    return `recovery state at ${p.paths.recoveryRoot} could not be inspected; preserve that path unchanged and inspect it manually`;
  }
}

async function requirePublication(p: Pending): Promise<void> {
  await requireJournal(p);
  if (p.publishedIdentity === undefined)
    throw new Error("Pi publication missing");
  await requireIdentity(p.canonicalRoot, p.publishedIdentity);
  await requireSnapshot(p.canonicalRoot, p.journal.newArtifact);
  if (p.journal.oldArtifact !== null)
    await requireSnapshot(p.backup, p.journal.oldArtifact);
  else await assertNoFollowType(p.backup, ["missing"]);
}

async function finalizePiPublication(
  p: Pending,
  publication: DirectoryPublication,
): Promise<AdapterResult<null>> {
  if (p.settled)
    return fail(
      "already-settled",
      "Pi installation transaction has already been settled",
    );
  p.settled = true;
  let verified = false;
  let publicationCleanupCompleted = false;
  try {
    await requirePublication(p);
    const current = await registration(p.paths);
    const expectedRegistration =
      p.journal.priorRegistration ?? p.journal.createdRegistration;
    if (
      expectedRegistration === null ||
      !sameRegistration(current, expectedRegistration) ||
      current?.resourceState !== "enabled"
    )
      throw new Error("Pi registration changed");
    const assessed = await readPiPackageAssessment(p.canonicalRoot);
    if (
      assessed.compatibility.kind !== "supported" &&
      assessed.compatibility.kind !== "experimental"
    )
      throw new Error("Pi compatibility changed");
    await phase(p, "finalizing");
    verified = true;
    await publication.finalize();
    publicationCleanupCompleted = true;
    await retireJournal(p);
    return successResult("finalize-pi", null, []);
  } catch {
    if (publicationCleanupCompleted)
      return fail(
        "recovery-required",
        `Pi activation was verified and backup cleanup completed, but journal retirement failed; ${await journalRetirementGuidance(p)}`,
      );
    return fail(
      "recovery-required",
      `${verified ? "Pi activation was verified, but backup or journal cleanup failed" : "Pi activation could not be verified"}; preserve recovery material at ${p.paths.recoveryRoot} and ${p.backup} for manual resolution`,
    );
  }
}

async function rollbackPiPublication(
  p: Pending,
  publication: DirectoryPublication,
): Promise<AdapterResult<null>> {
  if (p.settled)
    return fail(
      "already-settled",
      "Pi installation transaction has already been settled",
    );
  p.settled = true;
  let retirementStarted = false;
  try {
    await requirePublication(p);
    const current = await registration(p.paths);
    if (p.journal.priorRegistration !== null) {
      if (!sameRegistration(current, p.journal.priorRegistration))
        throw new Error("prior Pi registration changed");
    } else if (
      !sameRegistration(current, p.journal.createdRegistration) ||
      (current !== null && current.resourceState !== "enabled")
    ) {
      throw new Error("new Pi registration changed");
    }
    await phase(p, "rolling-back");
    if (
      p.journal.priorRegistration === null &&
      p.journal.createdRegistration !== null
    ) {
      await p.deps
        .run(["remove", p.canonicalRoot, "--no-approve"], p.paths, p.ctx)
        .catch(() => undefined);
      if ((await registration(p.paths)) !== null)
        throw new Error("Pi deregistration unverified");
    }
    await requirePublication(p);
    await publication.rollback();
    await requireSnapshot(p.canonicalRoot, p.journal.oldArtifact);
    if (
      !sameRegistration(
        await registration(p.paths),
        p.journal.priorRegistration,
      )
    )
      throw new Error("Pi registration restoration unverified");
    await phase(p, "restored");
    retirementStarted = true;
    await retireJournal(p);
    return successResult("rollback-pi", null, []);
  } catch {
    if (retirementStarted)
      return fail(
        "recovery-required",
        `Pi restoration of the previous snapshot and registration was verified, but journal retirement failed; ${await journalRetirementGuidance(p)}`,
      );
    return fail(
      "recovery-required",
      `Pi restoration could not be verified; preserve the installed snapshot and recovery material at ${p.paths.recoveryRoot} and ${p.backup} for manual resolution`,
    );
  }
}

async function recoverBeforePublication(p: Pending): Promise<boolean> {
  try {
    await requireJournal(p);
    await requireSnapshot(p.canonicalRoot, p.journal.oldArtifact);
    await assertNoFollowType(p.backup, ["missing"]);
    if (
      !sameRegistration(
        await registration(p.paths),
        p.journal.priorRegistration,
      )
    )
      return false;
    if (
      (await assertNoFollowType(p.stage, ["directory", "missing"])) !==
      "missing"
    ) {
      if (p.stageIdentity === undefined) return false;
      await requireIdentity(p.stage, p.stageIdentity);
      await phase(p, "restored");
      await rm(p.stage, { recursive: true });
    }
    await retireJournal(p);
    return true;
  } catch {
    return false;
  }
}

export async function installPi(
  artifact: PreparedArtifact,
  ctx: AdapterContext,
  deps: PiInstallDependencies = DEFAULTS,
): Promise<AdapterResult<InstallReceipt>> {
  const paths = piPaths(ctx.env ?? {}, process.cwd());
  let pending: Pending | undefined;
  let publication: DirectoryPublication | undefined;
  try {
    await validatePaths(paths);
    await requireNoRecovery(paths);
    if (artifact.root !== paths.preparedRoot)
      throw new Error("unexpected Pi prepared root");
    const assessment = await readPiPackageAssessment(artifact.root);
    if (
      assessment.receipt.digest !== artifact.identity ||
      assessment.receipt.commit !== artifact.commit ||
      (assessment.compatibility.kind !== "supported" &&
        assessment.compatibility.kind !== "experimental")
    )
      throw new Error("Pi prepared artifact changed");
    await requireActivationEligibility(ctx);
    const previous = await snapshot(paths.installedRoot);
    const priorRegistration = await registration(paths);
    if (previous === null && priorRegistration !== null)
      throw new Error("unowned Pi registration");
    accepted(
      normalizeSnapshotRuntimeVersion(
        "Pi",
        await deps.run(["--version"], paths, ctx),
      ),
    );
    // Recheck after the native preflight, before claiming mutation ownership.
    await requireSnapshot(paths.installedRoot, previous);
    if (!sameRegistration(await registration(paths), priorRegistration))
      throw new Error("Pi registration changed");
    pending = await beginJournal(
      paths,
      previous,
      assessment.receipt,
      priorRegistration,
      ctx,
      deps,
    );
    await mkdir(pending.stage);
    pending.stageIdentity = await identity(pending.stage);
    await cp(artifact.root, pending.stage, {
      recursive: true,
      verbatimSymlinks: true,
      force: false,
    });
    const staged = await readPiPackageAssessment(pending.stage);
    if (
      !sameArtifact(staged.receipt, assessment.receipt) ||
      (staged.compatibility.kind !== "supported" &&
        staged.compatibility.kind !== "experimental")
    )
      throw new Error("Pi staged artifact changed");
    await phase(pending, "publishing");
    await requireIdentity(pending.stage, pending.stageIdentity);
    await requireActivationEligibility(ctx);
    await requireSnapshot(paths.installedRoot, previous);
    if (!sameRegistration(await registration(paths), priorRegistration))
      throw new Error("Pi registration changed");
    publication = await deps.beginPublication(
      pending.stage,
      pending.canonicalRoot,
      { backupPath: pending.backup },
    );
    pending.publishedIdentity = pending.stageIdentity;
    await phase(pending, "published");
    if (priorRegistration === null) {
      await phase(pending, "registering");
      if ((await registration(paths)) !== null)
        throw new Error("Pi registration changed");
      const result = await deps
        .run(["install", pending.canonicalRoot, "--no-approve"], paths, ctx)
        .catch(() => fail("native-failed", "Pi native installation failed"));
      // Even an unsuccessful command may have changed settings. Read them first.
      const registered = await registration(paths);
      if (registered === null || registered.resourceState !== "enabled")
        throw new Error("Pi activation unverified");
      await phase(pending, "registered", {
        createdRegistration: registered,
      });
      accepted(result);
    }
    await requirePublication(pending);
    const registered = await registration(paths);
    if (registered === null || registered.resourceState !== "enabled")
      throw new Error("Pi activation unverified");
    await phase(pending, "ready");
    const owned = pending;
    const published = publication;
    return successResult(
      "install-pi",
      {
        missingVerificationOutput: {
          stdout: [],
          stderr: [
            "error: installed Pi snapshot is not detectable after activation",
          ],
        },
        mismatchVerificationOutput: {
          stdout: [],
          stderr: [
            "error: installed Pi snapshot or registration does not match the prepared artifact",
          ],
        },
        transaction: {
          finalize: () => finalizePiPublication(owned, published),
          rollback: () => rollbackPiPublication(owned, published),
        },
      },
      [],
    );
  } catch {
    if (pending !== undefined) {
      const restored =
        publication === undefined
          ? await recoverBeforePublication(pending)
          : (await rollbackPiPublication(pending, publication)).outcome.ok;
      if (restored)
        return fail(
          "activation-failed",
          "Pi activation failed; the previous snapshot and registration were restored",
        );
    }
    if ((await hasRecovery(paths)) || pending !== undefined)
      return fail(
        "recovery-required",
        `Pi mutation requires manual recovery; preserve material at ${paths.recoveryRoot} and any installed snapshot or sibling backup`,
      );
    return fail(
      "activation-refused",
      `cannot activate Pi artifact ${artifact.root}; verify prepared content, runtime, ownership, and settings ${paths.settingsFile}`,
    );
  }
}

export async function removePi(
  input: PiRemovalInput,
  ctx: AdapterContext,
  deps: PiInstallDependencies = DEFAULTS,
): Promise<AdapterResult<null>> {
  const paths = piPaths(ctx.env ?? {}, process.cwd());
  let pending: Pending | undefined;
  let deregistered = false;
  try {
    await validatePaths(paths);
    await requireNoRecovery(paths);
    const current = accepted(await inspectPiOwnership(ctx)).removalInput;
    if (
      input.installedRoot !== paths.installedRoot ||
      input.registrationIdentity !== current.registrationIdentity ||
      input.receiptDigest !== current.receiptDigest
    )
      throw new Error("stale Pi removal input");
    const previous = await snapshot(paths.installedRoot);
    const registered = await registration(paths);
    if (previous === null) {
      if (registered !== null) throw new Error("unowned Pi registration");
      return successResult("remove-pi", null, []);
    }
    if (registered !== null)
      accepted(
        normalizeSnapshotRuntimeVersion(
          "Pi",
          await deps.run(["--version"], paths, ctx),
        ),
      );
    await requireSnapshot(paths.installedRoot, previous);
    if (!sameRegistration(await registration(paths), registered))
      throw new Error("Pi registration changed");
    pending = await beginJournal(paths, previous, null, registered, ctx, deps);
    const installedIdentity = await identity(paths.installedRoot);
    if (registered !== null) {
      const result = await deps
        .run(["remove", pending.canonicalRoot, "--no-approve"], paths, ctx)
        .catch(() => fail("native-failed", "Pi native removal failed"));
      const after = await registration(paths);
      if (after !== null) {
        if (sameRegistration(after, registered)) {
          await requireSnapshot(paths.installedRoot, previous);
          await retireJournal(pending);
          pending = undefined;
        }
        throw new Error("Pi deregistration unverified");
      }
      // Removal is established by settings, even if Pi reported a nonzero exit.
      deregistered = true;
      if (result.status !== 0 || !result.outcome.ok) {
        await phase(pending, "deregistered");
        return fail(
          "cleanup-required",
          `Pi registration was removed but its command failed; snapshot and recovery material remain at ${paths.installedRoot} and ${paths.recoveryRoot}`,
        );
      }
    }
    await phase(pending, "deregistered");
    await requireIdentity(paths.installedRoot, installedIdentity);
    await requireSnapshot(paths.installedRoot, previous);
    if ((await registration(paths)) !== null)
      throw new Error("Pi registration returned");
    await rm(paths.installedRoot, { recursive: true });
    await requireSnapshot(paths.installedRoot, null);
    await retireJournal(pending);
    return successResult("remove-pi", null, []);
  } catch {
    return fail(
      pending !== undefined || (await hasRecovery(paths))
        ? "recovery-required"
        : "removal-refused",
      deregistered
        ? `Pi registration was removed but snapshot cleanup failed; preserve recovery material at ${paths.recoveryRoot}`
        : `cannot verify Pi removal at ${paths.installedRoot}; preserve the snapshot and any recovery material at ${paths.recoveryRoot}`,
    );
  }
}

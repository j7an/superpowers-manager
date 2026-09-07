import { randomBytes } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  failureResult,
  successResult,
  type AdapterContext,
  type AdapterResult,
} from "./adapter-result.ts";
import {
  atomicWriteFile,
  beginDirectoryPublication,
  type DirectoryPublication,
} from "./atomic.ts";
import type { InstallReceipt, PreparedArtifact } from "./harness.ts";
import { normalizePiRuntimeVersion, runPi } from "./pi-native.ts";
import {
  digestPiTree,
  readPiPackageAssessment,
  readPiReceipt,
  type PiReceipt,
} from "./pi-package.ts";
import { piPaths, type PiPaths } from "./pi-paths.ts";
import {
  readPiSettings,
  resolveCanonicalPiLocalSource,
  type PiPackageEntry,
} from "./pi-settings.ts";
import {
  inspectPiControl,
  inspectPiOwnership,
  type PiRemovalInput,
} from "./pi-state.ts";
import {
  assertNoFollowType,
  canonicalizeProspectivePath,
  classifyPathNoFollow,
} from "./safe-path.ts";

export interface PiInstallDependencies {
  readonly run: typeof runPi;
  readonly beginPublication: typeof beginDirectoryPublication;
  readonly readSettings: typeof readPiSettings;
}

const DEFAULTS: PiInstallDependencies = {
  run: runPi,
  beginPublication: beginDirectoryPublication,
  readSettings: readPiSettings,
};
type Identity = { readonly dev: number; readonly ino: number };
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
function sameIdentity(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
async function identity(path: string): Promise<Identity> {
  await assertNoFollowType(path, ["directory"]);
  return await lstat(path);
}
async function requireIdentity(
  path: string,
  expected: Identity,
): Promise<void> {
  if (!sameIdentity(await identity(path), expected))
    throw new Error("Pi directory changed");
}
function journalPath(p: Pending): string {
  return join(p.paths.recoveryRoot, "transaction.json");
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

async function requireNoRecovery(paths: PiPaths): Promise<void> {
  await assertNoFollowType(paths.recoveryRoot, ["missing"]);
}

async function syncDirectoryStrict(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function hasRecovery(paths: PiPaths): Promise<boolean> {
  try {
    return (await classifyPathNoFollow(paths.recoveryRoot)) !== "missing";
  } catch {
    return true;
  }
}

async function registration(
  paths: PiPaths,
  deps: PiInstallDependencies,
): Promise<PiPackageEntry | null> {
  const settings = await deps.readSettings(paths.settingsFile, paths.homeDir);
  const canonicalRoot = await canonicalizeProspectivePath(paths.installedRoot);
  const matches: PiPackageEntry[] = [];
  for (const entry of settings.packages) {
    if (
      (await resolveCanonicalPiLocalSource(
        entry.source,
        paths.agentDir,
        paths.homeDir,
      )) === canonicalRoot
    ) {
      matches.push(entry);
    }
  }
  if (matches.length > 1) throw new Error("duplicate Pi registration");
  return matches[0] ?? null;
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
  if (receipt.digest !== (await digestPiTree(root)))
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

async function requireJournal(p: Pending): Promise<void> {
  if (
    (await validatePaths(p.paths)) !== p.canonicalRoot ||
    p.journal.installedRoot !== p.canonicalRoot ||
    !/^[a-f0-9]{32}$/u.test(p.journal.token)
  )
    throw new Error("Pi recovery root changed");
  await requireIdentity(p.paths.recoveryRoot, p.recoveryIdentity);
  const path = journalPath(p);
  await assertNoFollowType(path, ["regular-file"]);
  const stat = await lstat(path);
  if (
    !sameIdentity(stat, p.journalIdentity) ||
    stat.size > 64 * 1024 ||
    !(await readFile(path)).equals(journalBytes(p.journal))
  )
    throw new Error("Pi recovery journal changed");
  if (
    p.backup !==
      join(
        dirname(p.canonicalRoot),
        `.${basename(p.canonicalRoot)}.bak.${p.journal.token}`,
      ) ||
    p.stage !==
      join(
        dirname(p.canonicalRoot),
        `.${basename(p.canonicalRoot)}.stage.${p.journal.token}`,
      )
  )
    throw new Error("Pi recovery paths changed");
}
async function phase(
  p: Pending,
  next: Phase,
  changes: { readonly createdRegistration?: PiPackageEntry | null } = {},
): Promise<void> {
  await requireJournal(p);
  const journal = { ...p.journal, ...changes, phase: next };
  const bytes = journalBytes(journal);
  await atomicWriteFile(journalPath(p), bytes, {
    validate: async (temporary) => {
      if (!(await readFile(temporary)).equals(bytes))
        throw new Error("Pi journal write changed");
    },
  });
  await syncDirectoryStrict(p.paths.recoveryRoot);
  p.journal = journal;
  p.journalIdentity = await lstat(journalPath(p));
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
  const path = join(paths.recoveryRoot, "transaction.json");
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(journalBytes(journal));
    await handle.sync();
  } finally {
    await handle.close();
  }
  // The first journal is durable before either a staging tree or backup exists.
  await syncDirectoryStrict(paths.recoveryRoot);
  return {
    paths,
    canonicalRoot,
    recoveryIdentity,
    backup: join(
      dirname(canonicalRoot),
      `.${basename(canonicalRoot)}.bak.${token}`,
    ),
    stage: join(
      dirname(canonicalRoot),
      `.${basename(canonicalRoot)}.stage.${token}`,
    ),
    ctx,
    deps,
    journal,
    journalIdentity: await lstat(path),
    settled: false,
  };
}

async function retireJournal(p: Pending): Promise<void> {
  await requireJournal(p);
  if (
    (await readdir(p.paths.recoveryRoot)).some(
      (name) => name !== "transaction.json",
    )
  )
    throw new Error("unknown Pi recovery material");
  await unlink(journalPath(p));
  await requireIdentity(p.paths.recoveryRoot, p.recoveryIdentity);
  await rmdir(p.paths.recoveryRoot);
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
    const current = await registration(p.paths, p.deps);
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
    const current = await registration(p.paths, p.deps);
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
      if ((await registration(p.paths, p.deps)) !== null)
        throw new Error("Pi deregistration unverified");
    }
    await requirePublication(p);
    await publication.rollback();
    await requireSnapshot(p.canonicalRoot, p.journal.oldArtifact);
    if (
      !sameRegistration(
        await registration(p.paths, p.deps),
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
        await registration(p.paths, p.deps),
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
    const priorRegistration = await registration(paths, deps);
    if (previous === null && priorRegistration !== null)
      throw new Error("unowned Pi registration");
    accepted(
      normalizePiRuntimeVersion(await deps.run(["--version"], paths, ctx)),
    );
    // Recheck after the native preflight, before claiming mutation ownership.
    await requireSnapshot(paths.installedRoot, previous);
    if (!sameRegistration(await registration(paths, deps), priorRegistration))
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
    if (!sameRegistration(await registration(paths, deps), priorRegistration))
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
      if ((await registration(paths, deps)) !== null)
        throw new Error("Pi registration changed");
      const result = await deps
        .run(["install", pending.canonicalRoot, "--no-approve"], paths, ctx)
        .catch(() => fail("native-failed", "Pi native installation failed"));
      // Even an unsuccessful command may have changed settings. Read them first.
      const registered = await registration(paths, deps);
      if (registered === null || registered.resourceState !== "enabled")
        throw new Error("Pi activation unverified");
      await phase(pending, "registered", {
        createdRegistration: registered,
      });
      accepted(result);
    }
    await requirePublication(pending);
    const registered = await registration(paths, deps);
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
    const registered = await registration(paths, deps);
    if (previous === null) {
      if (registered !== null) throw new Error("unowned Pi registration");
      return successResult("remove-pi", null, []);
    }
    if (registered !== null)
      accepted(
        normalizePiRuntimeVersion(await deps.run(["--version"], paths, ctx)),
      );
    await requireSnapshot(paths.installedRoot, previous);
    if (!sameRegistration(await registration(paths, deps), registered))
      throw new Error("Pi registration changed");
    pending = await beginJournal(paths, previous, null, registered, ctx, deps);
    const installedIdentity = await identity(paths.installedRoot);
    if (registered !== null) {
      const result = await deps
        .run(["remove", pending.canonicalRoot, "--no-approve"], paths, ctx)
        .catch(() => fail("native-failed", "Pi native removal failed"));
      const after = await registration(paths, deps);
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
    if ((await registration(paths, deps)) !== null)
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

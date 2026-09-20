import { createHash, randomBytes } from "node:crypto";
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
import { findNodeAtLocation } from "jsonc-parser";

import {
  failureResult,
  successResult,
  type AdapterContext,
  type AdapterResult,
} from "../../adapter-result.ts";
import { digestArtifactTree } from "../../artifact-tree.ts";
import {
  atomicWriteFile,
  beginDirectoryPublication,
  type DirectoryPublication,
} from "../../atomic.ts";
import type { InstallReceipt, PreparedArtifact } from "../../harness.ts";
import {
  assertNoFollowType,
  canonicalizeProspectivePath,
  classifyPathNoFollow,
} from "../../safe-path.ts";
import {
  addObservedOpenCodeEntry,
  removeObservedOpenCodeEntry,
  type OpenCodeConfigKey,
} from "./config.ts";
import {
  inspectOpenCodeDiscovery,
  OPEN_CODE_PURE_MODE_INPUT,
  type OpenCodeDiscovery,
} from "./discovery.ts";
import { normalizeSnapshotRuntimeVersion } from "../../harness-command-result.ts";
import { runOpenCode } from "./native.ts";
import {
  readOpenCodePackageAssessment,
  readOpenCodeReceipt,
  type OpenCodeReceipt,
} from "./package.ts";
import {
  assertOpenCodePreparationSeparate,
  openCodePaths,
  type OpenCodePaths,
} from "./paths.ts";
import {
  inspectOpenCodeControl,
  inspectOpenCodeOwnership,
  type OpenCodeRemovalInput,
} from "./state.ts";
import { displayPath } from "../../validator.ts";

export interface OpenCodeInstallDependencies {
  readonly run: typeof runOpenCode;
  readonly beginPublication: typeof beginDirectoryPublication;
  readonly rm?: typeof rm;
}

const DEFAULTS: OpenCodeInstallDependencies = {
  run: runOpenCode,
  beginPublication: beginDirectoryPublication,
};

// V1 prints a bare semver ("1.18.31"); V2 prints "opencode v2.0.10".
const OPEN_CODE_VERSION_PREFIX = /^opencode\s+v/i;

type Identity = { readonly dev: number; readonly ino: number };
// The journal can contain data from two independently bounded 1 MiB receipts
// plus one bounded 1 MiB config. Six bytes of JSON output per input byte covers
// control escaping; counting the registration spec independently brings that
// conservative subtotal to 24 MiB. The remaining 8 MiB bounds the actual
// filesystem paths and fixed hashes/metadata without admitting an unbounded
// recovery record.
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
type SnapshotEvidence = Pick<
  OpenCodeReceipt,
  "binding" | "digest" | "commit" | "source"
>;
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
interface RegistrationRecord {
  readonly configPath: string;
  readonly configKey: OpenCodeConfigKey;
  readonly entryIndex: number;
  readonly spec: string;
  readonly optionsDigest: string;
  readonly observedBytesDigest: string;
  readonly observedDev: number;
  readonly observedIno: number;
  readonly observedMode: number;
  readonly rawEntry: string;
}
interface Journal {
  readonly schema: 1;
  readonly token: string;
  readonly phase: Phase;
  readonly installedRoot: string;
  readonly oldArtifact: SnapshotEvidence | null;
  readonly newArtifact: SnapshotEvidence | null;
  readonly priorRegistration: RegistrationRecord | null;
  readonly createdRegistration: RegistrationRecord | null;
}
interface Pending {
  readonly paths: OpenCodePaths;
  readonly canonicalRoot: string;
  readonly recoveryIdentity: Identity;
  readonly backup: string;
  readonly stage: string;
  readonly ctx: AdapterContext;
  journal: Journal;
  journalIdentity: Identity;
  stageIdentity?: Identity;
  publishedIdentity?: Identity;
  removalBackupIdentity?: Identity;
  settled: boolean;
}

type ManagedRegistration = OpenCodeDiscovery["managedEntries"][number];

function fail(code: string, message: string): AdapterResult<never> {
  return failureResult(
    "opencode-lifecycle",
    code,
    displayPath(message),
    [],
    [],
  );
}

function accepted<T>(result: AdapterResult<T>): T {
  if (result.status !== 0 || !result.outcome.ok)
    throw new Error("OpenCode operation did not succeed");
  return result.outcome.result;
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
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
    throw new Error("OpenCode directory changed");
}

function journalPath(pending: Pending): string {
  return join(pending.paths.recoveryRoot, "transaction.json");
}

function journalBytes(journal: Journal): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(journal)}\n`);
  if (bytes.length > MAX_JOURNAL_BYTES)
    throw new Error("OpenCode recovery journal exceeds its byte limit");
  return bytes;
}

async function validatePaths(paths: OpenCodePaths): Promise<string> {
  await assertOpenCodePreparationSeparate(paths);
  await assertNoFollowType(paths.configRoot, ["directory", "missing"]);
  await assertNoFollowType(paths.managerRoot, ["directory", "missing"]);
  await assertNoFollowType(paths.installedRoot, ["directory", "missing"]);
  return await canonicalizeProspectivePath(paths.installedRoot);
}

async function requireNoRecovery(paths: OpenCodePaths): Promise<void> {
  await assertNoFollowType(paths.recoveryRoot, ["missing"]);
}

async function hasRecovery(paths: OpenCodePaths): Promise<boolean> {
  try {
    return (await classifyPathNoFollow(paths.recoveryRoot)) !== "missing";
  } catch {
    return true;
  }
}

async function syncDirectoryStrict(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function artifactSame(
  left: SnapshotEvidence | null,
  right: SnapshotEvidence | null,
): boolean {
  return left === null
    ? right === null
    : right !== null &&
        left.binding === right.binding &&
        left.digest === right.digest &&
        left.commit === right.commit &&
        left.source === right.source;
}

function snapshotEvidence(
  receipt: OpenCodeReceipt | null,
): SnapshotEvidence | null {
  return receipt === null
    ? null
    : {
        binding: receipt.binding,
        digest: receipt.digest,
        commit: receipt.commit,
        source: receipt.source,
      };
}

async function snapshot(root: string): Promise<OpenCodeReceipt | null> {
  if ((await assertNoFollowType(root, ["directory", "missing"])) === "missing")
    return null;
  const receipt = await readOpenCodeReceipt(root);
  if (receipt.digest !== (await digestArtifactTree(root)))
    throw new Error("OpenCode snapshot changed");
  return receipt;
}

async function requireSnapshot(
  root: string,
  expected: SnapshotEvidence | null,
): Promise<void> {
  if (!artifactSame(await snapshot(root), expected))
    throw new Error("OpenCode artifact changed");
}

async function discovery(
  paths: OpenCodePaths,
  ctx: AdapterContext,
): Promise<OpenCodeDiscovery> {
  const observed = await inspectOpenCodeDiscovery(
    paths,
    ctx.env ?? {},
    process.cwd(),
  );
  if (observed.managedEntries.length > 1)
    throw new Error("ambiguous OpenCode Manager registration");
  return observed;
}

function registrationRecord(
  registration: ManagedRegistration | undefined,
): RegistrationRecord | null {
  if (registration === undefined) return null;
  const observation = registration.observation;
  const node = findNodeAtLocation(observation.document.root, [
    registration.entry.key,
    registration.entry.index,
  ]);
  if (node === undefined)
    throw new Error("OpenCode registration syntax changed");
  return {
    configPath: observation.document.path,
    configKey: registration.entry.key,
    entryIndex: registration.entry.index,
    spec: registration.entry.spec,
    optionsDigest: createHash("sha256")
      .update(JSON.stringify(registration.entry.options))
      .digest("hex"),
    observedBytesDigest: createHash("sha256")
      .update(observation.bytes)
      .digest("hex"),
    observedDev: observation.identity.dev,
    observedIno: observation.identity.ino,
    observedMode: observation.identity.mode,
    rawEntry: observation.document.text.slice(
      node.offset,
      node.offset + node.length,
    ),
  };
}

function sameRegistration(
  registration: ManagedRegistration | undefined,
  expected: RegistrationRecord | null,
): boolean {
  return expected === null
    ? registration === undefined
    : registration !== undefined &&
        registration.observation.document.path === expected.configPath &&
        registration.entry.key === expected.configKey &&
        registration.entry.spec === expected.spec &&
        createHash("sha256")
          .update(JSON.stringify(registration.entry.options))
          .digest("hex") === expected.optionsDigest;
}

function registrationInputSame(
  input: OpenCodeRemovalInput["registration"],
  current: OpenCodeRemovalInput["registration"],
): boolean {
  return input === null
    ? current === null
    : current !== null &&
        input.entryIndex === current.entryIndex &&
        input.spec === current.spec &&
        input.observation.document.path === current.observation.document.path &&
        input.observation.identity.dev === current.observation.identity.dev &&
        input.observation.identity.ino === current.observation.identity.ino &&
        input.observation.identity.mode === current.observation.identity.mode &&
        input.observation.bytes.equals(current.observation.bytes);
}

function requireSafeActivationDiscovery(observed: OpenCodeDiscovery): void {
  if (observed.conflicts.length > 0 || observed.blockedInputs.length > 0)
    throw new Error("OpenCode configuration changed");
}

async function requireStableActivationRegistration(
  paths: OpenCodePaths,
  ctx: AdapterContext,
  expected: RegistrationRecord | null,
): Promise<OpenCodeDiscovery> {
  const observed = await discovery(paths, ctx);
  requireSafeActivationDiscovery(observed);
  if (!sameRegistration(observed.managedEntries[0], expected))
    throw new Error("OpenCode registration changed");
  return observed;
}

function requireSafeRemovalDiscovery(observed: OpenCodeDiscovery): void {
  const unresolvedSkillInput = observed.blockedInputs.some(
    (input) => input !== OPEN_CODE_PURE_MODE_INPUT,
  );
  if (
    observed.registrationUncertain ||
    observed.ownedActivationAliases.length !== 0 ||
    unresolvedSkillInput
  )
    throw new Error("OpenCode registration removal is uncertain");
}

function requireNoOwnedActivation(observed: OpenCodeDiscovery): void {
  requireSafeRemovalDiscovery(observed);
  if (observed.managedEntries.length !== 0)
    throw new Error("OpenCode registration removal is uncertain");
}

async function requireActivationEligibility(
  ctx: AdapterContext,
): Promise<void> {
  const ownership = accepted(await inspectOpenCodeOwnership(ctx));
  const control = accepted(await inspectOpenCodeControl(ctx));
  if (
    ownership.installEligibility.kind !== "allowed" ||
    control.mutationEligibility.kind !== "allowed"
  )
    throw new Error("OpenCode ownership or control blocked");
}

async function requireJournal(pending: Pending): Promise<void> {
  if (
    (await validatePaths(pending.paths)) !== pending.canonicalRoot ||
    pending.journal.installedRoot !== pending.canonicalRoot ||
    !/^[a-f0-9]{32}$/u.test(pending.journal.token)
  )
    throw new Error("OpenCode recovery root changed");
  await requireIdentity(pending.paths.recoveryRoot, pending.recoveryIdentity);
  const path = journalPath(pending);
  await assertNoFollowType(path, ["regular-file"]);
  const observed = await lstat(path);
  if (
    !sameIdentity(observed, pending.journalIdentity) ||
    observed.size > MAX_JOURNAL_BYTES ||
    !(await readFile(path)).equals(journalBytes(pending.journal))
  )
    throw new Error("OpenCode recovery journal changed");
  if (
    pending.backup !==
      join(
        dirname(pending.canonicalRoot),
        `.${basename(pending.canonicalRoot)}.bak.${pending.journal.token}`,
      ) ||
    pending.stage !==
      join(
        dirname(pending.canonicalRoot),
        `.${basename(pending.canonicalRoot)}.stage.${pending.journal.token}`,
      )
  )
    throw new Error("OpenCode recovery paths changed");
}

async function phase(
  pending: Pending,
  next: Phase,
  changes: { readonly createdRegistration?: RegistrationRecord | null } = {},
): Promise<void> {
  await requireJournal(pending);
  const journal = { ...pending.journal, ...changes, phase: next };
  const bytes = journalBytes(journal);
  await atomicWriteFile(journalPath(pending), bytes, {
    validate: async (temporary) => {
      if (!(await readFile(temporary)).equals(bytes))
        throw new Error("OpenCode journal write changed");
    },
  });
  await syncDirectoryStrict(pending.paths.recoveryRoot);
  pending.journal = journal;
  pending.journalIdentity = await lstat(journalPath(pending));
}

async function beginJournal(
  paths: OpenCodePaths,
  oldArtifact: OpenCodeReceipt | null,
  newArtifact: OpenCodeReceipt | null,
  priorRegistration: RegistrationRecord | null,
  ctx: AdapterContext,
): Promise<Pending> {
  const canonicalRoot = await validatePaths(paths);
  await requireNoRecovery(paths);
  const token = randomBytes(16).toString("hex");
  const journal: Journal = {
    schema: 1,
    token,
    phase: newArtifact === null ? "removing" : "staging",
    installedRoot: canonicalRoot,
    oldArtifact: snapshotEvidence(oldArtifact),
    newArtifact: snapshotEvidence(newArtifact),
    priorRegistration,
    createdRegistration: null,
  };
  // Serialization and its byte bound are validated before this function
  // creates any Manager or recovery path.
  const bytes = journalBytes(journal);
  await mkdir(paths.managerRoot, { recursive: true });
  await mkdir(paths.recoveryRoot, { mode: 0o700 });
  const recoveryIdentity = await identity(paths.recoveryRoot);
  const path = join(paths.recoveryRoot, "transaction.json");
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
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
    journal,
    journalIdentity: await lstat(path),
    settled: false,
  };
}

async function retireJournal(pending: Pending): Promise<void> {
  await requireJournal(pending);
  if (
    (await readdir(pending.paths.recoveryRoot)).some(
      (name) => name !== "transaction.json",
    )
  )
    throw new Error("unknown OpenCode recovery material");
  await unlink(journalPath(pending));
  await requireIdentity(pending.paths.recoveryRoot, pending.recoveryIdentity);
  await rmdir(pending.paths.recoveryRoot);
}

async function recoveryGuidance(pending: Pending): Promise<string> {
  try {
    const kind = await classifyPathNoFollow(pending.paths.recoveryRoot);
    if (kind === "missing")
      return `recovery directory ${pending.paths.recoveryRoot} is absent; verify installed state before further mutation`;
    if (kind !== "directory")
      return `recovery path ${pending.paths.recoveryRoot} changed; preserve it for manual inspection`;
    await requireIdentity(pending.paths.recoveryRoot, pending.recoveryIdentity);
    const entries = await readdir(pending.paths.recoveryRoot);
    return entries.some((name) => name !== "transaction.json")
      ? `recovery directory ${pending.paths.recoveryRoot} contains unexpected material; preserve it for manual inspection`
      : `preserve the recovery journal at ${journalPath(pending)} for manual inspection`;
  } catch {
    return `preserve recovery state at ${pending.paths.recoveryRoot} for manual inspection`;
  }
}

async function requirePublication(pending: Pending): Promise<void> {
  await requireJournal(pending);
  if (pending.publishedIdentity === undefined)
    throw new Error("OpenCode publication missing");
  await requireIdentity(pending.canonicalRoot, pending.publishedIdentity);
  await requireSnapshot(pending.canonicalRoot, pending.journal.newArtifact);
  if (pending.journal.oldArtifact === null)
    await assertNoFollowType(pending.backup, ["missing"]);
  else await requireSnapshot(pending.backup, pending.journal.oldArtifact);
}

async function finalizeOpenCodePublication(
  pending: Pending,
  publication: DirectoryPublication,
): Promise<AdapterResult<null>> {
  if (pending.settled)
    return fail(
      "already-settled",
      "OpenCode installation transaction has already been settled",
    );
  pending.settled = true;
  let publicationCleanupCompleted = false;
  try {
    await requirePublication(pending);
    const expected =
      pending.journal.priorRegistration ?? pending.journal.createdRegistration;
    await requireStableActivationRegistration(
      pending.paths,
      pending.ctx,
      expected,
    );
    const assessment = await readOpenCodePackageAssessment(
      pending.canonicalRoot,
    );
    if (
      assessment.compatibility.kind !== "supported" &&
      assessment.compatibility.kind !== "experimental"
    )
      throw new Error("OpenCode compatibility changed");
    await phase(pending, "finalizing");
    await publication.finalize();
    publicationCleanupCompleted = true;
    await retireJournal(pending);
    return successResult("finalize-opencode", null, []);
  } catch {
    return fail(
      "recovery-required",
      publicationCleanupCompleted
        ? `OpenCode activation was verified and backup cleanup completed, but journal retirement failed; ${await recoveryGuidance(pending)}`
        : `OpenCode activation or cleanup could not be verified; preserve recovery material at ${pending.paths.recoveryRoot} and ${pending.backup}`,
    );
  }
}

async function rollbackOpenCodePublication(
  pending: Pending,
  publication: DirectoryPublication,
): Promise<AdapterResult<null>> {
  if (pending.settled)
    return fail(
      "already-settled",
      "OpenCode installation transaction has already been settled",
    );
  pending.settled = true;
  let restored = false;
  try {
    await requirePublication(pending);
    let observed = await discovery(pending.paths, pending.ctx);
    const expected =
      pending.journal.priorRegistration ?? pending.journal.createdRegistration;
    if (!sameRegistration(observed.managedEntries[0], expected))
      throw new Error("OpenCode registration changed");
    await phase(pending, "rolling-back");
    if (
      pending.journal.priorRegistration === null &&
      pending.journal.createdRegistration !== null
    ) {
      const current = observed.managedEntries[0];
      if (current === undefined)
        throw new Error("OpenCode created registration missing");
      await removeObservedOpenCodeEntry(
        current.observation,
        current.entry.key,
        current.entry.index,
      );
      observed = await discovery(pending.paths, pending.ctx);
      requireNoOwnedActivation(observed);
    }
    await requirePublication(pending);
    await publication.rollback();
    await requireSnapshot(pending.canonicalRoot, pending.journal.oldArtifact);
    const after = await discovery(pending.paths, pending.ctx);
    if (
      !sameRegistration(
        after.managedEntries[0],
        pending.journal.priorRegistration,
      )
    )
      throw new Error("OpenCode registration restoration unverified");
    if (pending.journal.priorRegistration === null)
      requireNoOwnedActivation(after);
    await phase(pending, "restored");
    restored = true;
    await retireJournal(pending);
    return successResult("rollback-opencode", null, []);
  } catch {
    return fail(
      "recovery-required",
      restored
        ? `OpenCode restoration was verified, but journal retirement failed; ${await recoveryGuidance(pending)}`
        : `OpenCode restoration could not be verified; preserve the installed snapshot and recovery material at ${pending.paths.recoveryRoot} and ${pending.backup}`,
    );
  }
}

async function recoverBeforePublication(pending: Pending): Promise<boolean> {
  try {
    await requireJournal(pending);
    await requireSnapshot(pending.canonicalRoot, pending.journal.oldArtifact);
    await assertNoFollowType(pending.backup, ["missing"]);
    const observed = await discovery(pending.paths, pending.ctx);
    if (
      !sameRegistration(
        observed.managedEntries[0],
        pending.journal.priorRegistration,
      )
    )
      return false;
    if (
      (await assertNoFollowType(pending.stage, ["directory", "missing"])) !==
      "missing"
    ) {
      if (pending.stageIdentity === undefined) return false;
      await requireIdentity(pending.stage, pending.stageIdentity);
      await phase(pending, "restored");
      await rm(pending.stage, { recursive: true });
    }
    await retireJournal(pending);
    return true;
  } catch {
    return false;
  }
}

export async function installOpenCode(
  artifact: PreparedArtifact,
  ctx: AdapterContext,
  deps: OpenCodeInstallDependencies = DEFAULTS,
): Promise<AdapterResult<InstallReceipt>> {
  const paths = openCodePaths(ctx.env ?? {}, process.cwd());
  let pending: Pending | undefined;
  let publication: DirectoryPublication | undefined;
  try {
    await validatePaths(paths);
    await requireNoRecovery(paths);
    if (artifact.root !== paths.preparedRoot)
      throw new Error("unexpected OpenCode prepared root");
    const assessment = await readOpenCodePackageAssessment(artifact.root);
    if (
      assessment.receipt.digest !== artifact.identity ||
      assessment.receipt.commit !== artifact.commit ||
      (assessment.compatibility.kind !== "supported" &&
        assessment.compatibility.kind !== "experimental")
    )
      throw new Error("OpenCode prepared artifact changed");
    await requireActivationEligibility(ctx);
    const previous = await snapshot(paths.installedRoot);
    let observed = await discovery(paths, ctx);
    requireSafeActivationDiscovery(observed);
    let priorRegistration = registrationRecord(observed.managedEntries[0]);
    if (previous === null && priorRegistration !== null)
      throw new Error("unowned OpenCode registration");
    const runtimeVersion = accepted(
      normalizeSnapshotRuntimeVersion(
        "OpenCode",
        await deps.run(["--version"], paths, ctx),
        OPEN_CODE_VERSION_PREFIX,
      ),
    );
    const major = Number.parseInt(runtimeVersion, 10);
    if (major !== 1 && major !== 2)
      return fail(
        "unsupported-runtime",
        `unsupported OpenCode major version ${major}`,
      );
    if (
      major === 2 &&
      assessment.compatibility.generation !== "opencode-native-bootstrap-v2"
    )
      return fail(
        "unsupported-artifact",
        "the selected upstream ref does not support OpenCode 2; select a ref that ships the V2 entrypoint",
      );
    await requireSnapshot(paths.installedRoot, previous);
    observed = await requireStableActivationRegistration(
      paths,
      ctx,
      priorRegistration,
    );
    priorRegistration = registrationRecord(observed.managedEntries[0]);
    pending = await beginJournal(
      paths,
      previous,
      assessment.receipt,
      priorRegistration,
      ctx,
    );
    await mkdir(pending.stage);
    pending.stageIdentity = await identity(pending.stage);
    await cp(artifact.root, pending.stage, {
      recursive: true,
      verbatimSymlinks: true,
      force: false,
    });
    const staged = await readOpenCodePackageAssessment(pending.stage);
    if (
      !artifactSame(staged.receipt, assessment.receipt) ||
      (staged.compatibility.kind !== "supported" &&
        staged.compatibility.kind !== "experimental")
    )
      throw new Error("OpenCode staged artifact changed");
    await phase(pending, "publishing");
    await requireIdentity(pending.stage, pending.stageIdentity);
    await requireSnapshot(paths.installedRoot, previous);
    observed = await requireStableActivationRegistration(
      paths,
      ctx,
      priorRegistration,
    );
    publication = await deps.beginPublication(
      pending.stage,
      pending.canonicalRoot,
      { backupPath: pending.backup },
    );
    pending.publishedIdentity = pending.stageIdentity;
    await phase(pending, "published");
    if (priorRegistration === null) {
      await phase(pending, "registering");
      observed = await requireStableActivationRegistration(paths, ctx, null);
      let native: Awaited<ReturnType<typeof runOpenCode>> | null = null;
      if (major === 1) {
        native = await deps
          .run(["plugin", pending.canonicalRoot, "--global"], paths, ctx)
          .catch(() =>
            fail("native-failed", "OpenCode native installation failed"),
          );
      } else {
        const jsonc = join(paths.configRoot, "opencode.jsonc");
        const json = join(paths.configRoot, "opencode.json");
        let target =
          observed.documents.find(
            (document) => document.document.path === jsonc,
          ) ??
          observed.documents.find(
            (document) => document.document.path === json,
          );
        if (target === undefined) {
          await atomicWriteFile(json, Buffer.from("{}\n"), {
            validate: async () => {
              await assertNoFollowType(paths.configRoot, ["directory"]);
              await assertNoFollowType(jsonc, ["missing"]);
              await assertNoFollowType(json, ["missing"]);
            },
          });
          observed = await requireStableActivationRegistration(
            paths,
            ctx,
            null,
          );
          target = observed.documents.find(
            (document) => document.document.path === json,
          );
        }
        if (target === undefined)
          throw new Error("no OpenCode configuration to register in");
        await addObservedOpenCodeEntry(
          target,
          "plugins",
          pending.canonicalRoot,
        );
      }
      observed = await discovery(paths, ctx);
      requireSafeActivationDiscovery(observed);
      const created = registrationRecord(observed.managedEntries[0]);
      if (created === null || created.spec !== pending.canonicalRoot)
        throw new Error("OpenCode activation unverified");
      await phase(pending, "registered", { createdRegistration: created });
      if (native !== null) accepted(native);
    }
    await requirePublication(pending);
    observed = await discovery(paths, ctx);
    requireSafeActivationDiscovery(observed);
    const expected = priorRegistration ?? pending.journal.createdRegistration;
    if (!sameRegistration(observed.managedEntries[0], expected))
      throw new Error("OpenCode activation unverified");
    await phase(pending, "ready");
    const owned = pending;
    const published = publication;
    return successResult(
      "install-opencode",
      {
        missingVerificationOutput: {
          stdout: [],
          stderr: [
            "error: installed OpenCode snapshot is not detectable after activation",
          ],
        },
        mismatchVerificationOutput: {
          stdout: [],
          stderr: [
            "error: installed OpenCode snapshot or registration does not match the prepared artifact",
          ],
        },
        transaction: {
          finalize: () => finalizeOpenCodePublication(owned, published),
          rollback: () => rollbackOpenCodePublication(owned, published),
        },
      },
      [],
    );
  } catch {
    if (pending !== undefined) {
      const restored =
        publication === undefined
          ? await recoverBeforePublication(pending)
          : (await rollbackOpenCodePublication(pending, publication)).outcome
              .ok;
      if (restored)
        return fail(
          "activation-failed",
          "OpenCode activation failed; the previous snapshot and registration were restored",
        );
    }
    if ((await hasRecovery(paths)) || pending !== undefined)
      return fail(
        "recovery-required",
        `OpenCode mutation requires manual recovery; preserve material at ${paths.recoveryRoot} and any installed snapshot or sibling backup`,
      );
    return fail(
      "activation-refused",
      `cannot activate OpenCode artifact ${artifact.root}; verify prepared content, runtime, ownership, and configuration under ${paths.configRoot}`,
    );
  }
}

export async function removeOpenCode(
  input: OpenCodeRemovalInput,
  ctx: AdapterContext,
  deps: OpenCodeInstallDependencies = DEFAULTS,
): Promise<AdapterResult<null>> {
  const paths = openCodePaths(ctx.env ?? {}, process.cwd());
  let pending: Pending | undefined;
  let deregistered = false;
  let backupVerified = false;
  let removalVerified = false;
  try {
    await validatePaths(paths);
    await requireNoRecovery(paths);
    const current = accepted(await inspectOpenCodeOwnership(ctx)).removalInput;
    if (
      input.installedRoot !== paths.installedRoot ||
      input.receiptDigest !== current.receiptDigest ||
      !registrationInputSame(input.registration, current.registration)
    )
      throw new Error("stale OpenCode removal input");
    const previous = await snapshot(paths.installedRoot);
    let observed = await discovery(paths, ctx);
    const registered = observed.managedEntries[0];
    if (previous === null) {
      if (registered !== undefined || observed.registrationUncertain)
        throw new Error("unverified OpenCode registration");
      return successResult("remove-opencode", null, []);
    }
    if (
      input.receiptDigest === null ||
      previous.digest !== input.receiptDigest ||
      !registrationInputSame(
        input.registration,
        registered === undefined
          ? null
          : {
              observation: registered.observation,
              entryIndex: registered.entry.index,
              spec: registered.entry.spec,
            },
      )
    )
      throw new Error("OpenCode ownership changed");
    requireSafeRemovalDiscovery(observed);
    pending = await beginJournal(
      paths,
      previous,
      null,
      registrationRecord(registered),
      ctx,
    );
    const installedIdentity = await identity(paths.installedRoot);
    await assertNoFollowType(pending.backup, ["missing"]);
    await cp(paths.installedRoot, pending.backup, {
      recursive: true,
      verbatimSymlinks: true,
      force: false,
      errorOnExist: true,
    });
    pending.removalBackupIdentity = await identity(pending.backup);
    await requireSnapshot(pending.backup, previous);
    backupVerified = true;
    observed = await discovery(paths, ctx);
    requireSafeRemovalDiscovery(observed);
    if (
      !sameRegistration(
        observed.managedEntries[0],
        pending.journal.priorRegistration,
      )
    )
      throw new Error("OpenCode registration changed");
    if (registered !== undefined) {
      await removeObservedOpenCodeEntry(
        registered.observation,
        registered.entry.key,
        registered.entry.index,
      );
      observed = await discovery(paths, ctx);
      requireNoOwnedActivation(observed);
      deregistered = true;
    } else {
      requireNoOwnedActivation(observed);
    }
    await phase(pending, "deregistered");
    await requireIdentity(paths.installedRoot, installedIdentity);
    await requireSnapshot(paths.installedRoot, previous);
    await requireIdentity(pending.backup, pending.removalBackupIdentity);
    await requireSnapshot(pending.backup, previous);
    observed = await discovery(paths, ctx);
    requireNoOwnedActivation(observed);
    await (deps.rm ?? rm)(paths.installedRoot, { recursive: true });
    await requireSnapshot(paths.installedRoot, null);
    const verification = accepted(await inspectOpenCodeOwnership(ctx));
    if (verification.removalVerification.kind !== "allowed")
      throw new Error("OpenCode desired removal state could not be verified");
    removalVerified = true;
    await requireIdentity(pending.backup, pending.removalBackupIdentity);
    await requireSnapshot(pending.backup, previous);
    await (deps.rm ?? rm)(pending.backup, { recursive: true });
    await requireSnapshot(pending.backup, null);
    await retireJournal(pending);
    return successResult("remove-opencode", null, []);
  } catch {
    let intactBackup = false;
    if (
      pending !== undefined &&
      backupVerified &&
      pending.removalBackupIdentity !== undefined
    ) {
      try {
        await requireIdentity(pending.backup, pending.removalBackupIdentity);
        await requireSnapshot(pending.backup, pending.journal.oldArtifact);
        intactBackup = true;
      } catch {
        // The controlled failure below never claims unverified recovery bytes.
      }
    }
    if (removalVerified)
      return fail(
        "cleanup-required",
        `OpenCode removal was verified, but backup or journal cleanup remains at ${paths.managerRoot}`,
      );
    return fail(
      pending !== undefined || (await hasRecovery(paths))
        ? "recovery-required"
        : "removal-refused",
      intactBackup
        ? `OpenCode removal did not complete; preserve the verified prior snapshot backup at ${pending!.backup} and recovery journal at ${paths.recoveryRoot}`
        : deregistered
          ? `OpenCode registration was removed but snapshot cleanup failed; preserve recovery material at ${paths.recoveryRoot}`
          : `cannot verify OpenCode removal at ${paths.installedRoot}; preserve the snapshot and any recovery material at ${paths.recoveryRoot}`,
    );
  }
}

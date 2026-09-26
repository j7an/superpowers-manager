import {
  lstat,
  open,
  readdir,
  readFile,
  rmdir,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { atomicWriteFile } from "./atomic.ts";
import { assertNoFollowType, classifyPathNoFollow } from "./safe-path.ts";

// The recovery-journal mechanics Pi and OpenCode share. Each harness keeps its
// own beginJournal (operation order and persisted key order differ), journal
// type, receipts, registration, messages and settlement.

export type Identity = { readonly dev: number; readonly ino: number };

interface RecoveryPaths {
  readonly recoveryRoot: string;
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function identity(path: string): Promise<Identity> {
  await assertNoFollowType(path, ["directory"]);
  return await lstat(path);
}

export function journalPath(pending: {
  readonly paths: RecoveryPaths;
}): string {
  return join(pending.paths.recoveryRoot, "transaction.json");
}

export async function requireNoRecovery(paths: RecoveryPaths): Promise<void> {
  await assertNoFollowType(paths.recoveryRoot, ["missing"]);
}

export async function hasRecovery(paths: RecoveryPaths): Promise<boolean> {
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

export function publicationPaths(
  canonicalRoot: string,
  token: string,
): { readonly backup: string; readonly stage: string } {
  return {
    backup: join(
      dirname(canonicalRoot),
      `.${basename(canonicalRoot)}.bak.${token}`,
    ),
    stage: join(
      dirname(canonicalRoot),
      `.${basename(canonicalRoot)}.stage.${token}`,
    ),
  };
}

// The first journal is durable before either a staging tree or backup exists.
export async function createJournal(
  recoveryRoot: string,
  bytes: Buffer,
): Promise<Identity> {
  const path = join(recoveryRoot, "transaction.json");
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectoryStrict(recoveryRoot);
  return await lstat(path);
}

interface JournalPending<P extends RecoveryPaths, J> {
  readonly paths: P;
  readonly canonicalRoot: string;
  readonly recoveryIdentity: Identity;
  readonly backup: string;
  readonly stage: string;
  journal: J;
  journalIdentity: Identity;
}

export function createSnapshotJournal<
  P extends RecoveryPaths,
  J extends {
    readonly token: string;
    readonly installedRoot: string;
    readonly phase: string;
  },
>(rules: {
  readonly label: "Pi" | "OpenCode";
  readonly validatePaths: (paths: P) => Promise<string>;
  readonly serialize: (journal: J) => Buffer;
  readonly readCap: number;
}) {
  const { label } = rules;

  async function requireIdentity(
    path: string,
    expected: Identity,
  ): Promise<void> {
    if (!sameIdentity(await identity(path), expected))
      throw new Error(`${label} directory changed`);
  }

  async function requireJournal(pending: JournalPending<P, J>): Promise<void> {
    if (
      (await rules.validatePaths(pending.paths)) !== pending.canonicalRoot ||
      pending.journal.installedRoot !== pending.canonicalRoot ||
      !/^[a-f0-9]{32}$/u.test(pending.journal.token)
    )
      throw new Error(`${label} recovery root changed`);
    await requireIdentity(pending.paths.recoveryRoot, pending.recoveryIdentity);
    const path = journalPath(pending);
    await assertNoFollowType(path, ["regular-file"]);
    const observed = await lstat(path);
    if (
      !sameIdentity(observed, pending.journalIdentity) ||
      observed.size > rules.readCap ||
      !(await readFile(path)).equals(rules.serialize(pending.journal))
    )
      throw new Error(`${label} recovery journal changed`);
    const expected = publicationPaths(
      pending.canonicalRoot,
      pending.journal.token,
    );
    if (pending.backup !== expected.backup || pending.stage !== expected.stage)
      throw new Error(`${label} recovery paths changed`);
  }

  async function phase(
    pending: JournalPending<P, J>,
    next: J["phase"],
    changes: Partial<Omit<J, "phase">> = {},
  ): Promise<void> {
    await requireJournal(pending);
    const journal: J = { ...pending.journal, ...changes, phase: next };
    const bytes = rules.serialize(journal);
    await atomicWriteFile(journalPath(pending), bytes, {
      validate: async (temporary) => {
        if (!(await readFile(temporary)).equals(bytes))
          throw new Error(`${label} journal write changed`);
      },
    });
    await syncDirectoryStrict(pending.paths.recoveryRoot);
    pending.journal = journal;
    pending.journalIdentity = await lstat(journalPath(pending));
  }

  async function retireJournal(pending: JournalPending<P, J>): Promise<void> {
    await requireJournal(pending);
    if (
      (await readdir(pending.paths.recoveryRoot)).some(
        (name) => name !== "transaction.json",
      )
    )
      throw new Error(`unknown ${label} recovery material`);
    await unlink(journalPath(pending));
    await requireIdentity(pending.paths.recoveryRoot, pending.recoveryIdentity);
    await rmdir(pending.paths.recoveryRoot);
  }

  return { requireIdentity, requireJournal, phase, retireJournal };
}

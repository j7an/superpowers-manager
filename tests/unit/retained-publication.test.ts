import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type AtomicErrorDetails,
  beginDirectoryPublication,
} from "../../src/atomic.ts";
import { SafetyError } from "../../src/safety-error.ts";
import { exactError } from "../lib/error-assertions.ts";

async function sandbox(t: import("node:test").TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "spw-publication-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function tree(path: string, marker: string) {
  await mkdir(path);
  await writeFile(join(path, "marker"), marker);
}

async function marker(path: string) {
  return readFile(join(path, "marker"), "utf8");
}

async function safetyFailure(
  operation: Promise<unknown>,
): Promise<SafetyError<AtomicErrorDetails>> {
  try {
    await operation;
    assert.fail("expected SafetyError");
  } catch (error) {
    assert.ok(error instanceof SafetyError);
    return error as SafetyError<AtomicErrorDetails>;
  }
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

void test("beginDirectoryPublication retains the previous tree until finalize", async (t) => {
  const parent = await sandbox(t);
  const live = join(parent, "live");
  const candidate = join(parent, "candidate");
  await tree(live, "before");
  await tree(candidate, "after");

  const publication = await beginDirectoryPublication(candidate, live);

  assert.equal(await marker(live), "after");
  assert.ok(publication.backup);
  assert.equal(await marker(publication.backup), "before");
  await publication.finalize();
  await assert.rejects(stat(publication.backup), { code: "ENOENT" });
  assert.equal(await marker(live), "after");
});

void test("rollback restores the previous tree after publication", async (t) => {
  const parent = await sandbox(t);
  const live = join(parent, "live");
  const candidate = join(parent, "candidate");
  await tree(live, "before");
  await tree(candidate, "after");

  const publication = await beginDirectoryPublication(candidate, live);
  const backup = publication.backup;
  assert.ok(backup);
  await publication.rollback();

  assert.equal(await marker(live), "before");
  await assert.rejects(stat(backup), { code: "ENOENT" });
});

void test("publication without a prior tree has no backup and rollback removes its tree", async (t) => {
  const parent = await sandbox(t);
  const live = join(parent, "live");
  const candidate = join(parent, "candidate");
  await tree(candidate, "after");

  const publication = await beginDirectoryPublication(candidate, live);
  assert.equal(publication.backup, null);
  assert.equal(await marker(live), "after");

  await publication.rollback();
  await assert.rejects(stat(live), { code: "ENOENT" });
});

void test("activation failure restores the prior tree before begin returns", async (t) => {
  const parent = await sandbox(t);
  const live = join(parent, "live");
  const candidate = join(parent, "candidate");
  await tree(live, "before");
  await tree(candidate, "after");
  let calls = 0;

  const error = await safetyFailure(
    beginDirectoryPublication(candidate, live, {
      hooks: {
        rename: async (from, to) => {
          calls += 1;
          if (calls === 2) throw new Error("activation failed");
          await rename(from, to);
        },
      },
    }),
  );

  assert.equal(
    error.message,
    "directory activation failed; previous tree restored",
  );
  assert.equal(error.details?.phase, "pre-replacement");
  assert.equal(await marker(live), "before");
  await assert.rejects(stat(candidate), { code: "ENOENT" });
});

void test("activation failure without a prior tree removes only the candidate", async (t) => {
  const parent = await sandbox(t);
  const live = join(parent, "live");
  const candidate = join(parent, "candidate");
  const foreign = join(parent, "foreign");
  await tree(candidate, "after");
  await tree(foreign, "keep");

  await assert.rejects(
    beginDirectoryPublication(candidate, live, {
      hooks: {
        rename: async () => {
          throw new Error("activation failed");
        },
      },
    }),
    exactError(SafetyError, "directory activation failed with no prior tree"),
  );

  await assert.rejects(stat(candidate), { code: "ENOENT" });
  assert.equal(await marker(foreign), "keep");
});

void test("rollback failure preserves the backup bytes", async (t) => {
  const parent = await sandbox(t);
  const live = join(parent, "live");
  const candidate = join(parent, "candidate");
  await tree(live, "before");
  await tree(candidate, "after");
  let calls = 0;
  const publication = await beginDirectoryPublication(candidate, live, {
    hooks: {
      rename: async (from, to) => {
        calls += 1;
        if (calls === 3) throw new Error("restore failed");
        await rename(from, to);
      },
    },
  });
  const backup = publication.backup;
  assert.ok(backup);

  const error = await safetyFailure(publication.rollback());

  assert.equal(error.details?.phase, "post-replacement");
  assert.match(
    error.message,
    new RegExp(
      `directory rollback failed; backup preserved at ${escapeRegex(backup)}`,
    ),
  );
  assert.equal(await marker(backup), "before");
  await assert.rejects(stat(live), { code: "ENOENT" });
});

void test("finalize cleanup failure leaves the published and backup bytes", async (t) => {
  const parent = await sandbox(t);
  const live = join(parent, "live");
  const candidate = join(parent, "candidate");
  await tree(live, "before");
  await tree(candidate, "after");
  const publication = await beginDirectoryPublication(candidate, live, {
    hooks: {
      rm: async () => {
        throw new Error("cleanup failed");
      },
    },
  });
  const backup = publication.backup;
  assert.ok(backup);

  const error = await safetyFailure(publication.finalize());

  assert.equal(error.details?.phase, "post-replacement");
  assert.match(
    error.message,
    /directory replacement succeeded but backup cleanup failed at/,
  );
  assert.match(error.message, new RegExp(escapeRegex(backup)));
  assert.equal(await marker(live), "after");
  assert.equal(await marker(backup), "before");
});

void test("publication settlement is single-use", async (t) => {
  const parent = await sandbox(t);
  const live = join(parent, "live");
  const candidate = join(parent, "candidate");
  await tree(live, "before");
  await tree(candidate, "after");
  const publication = await beginDirectoryPublication(candidate, live);

  await publication.finalize();
  await assert.rejects(
    publication.rollback(),
    exactError(SafetyError, "directory publication already settled"),
  );
  assert.equal(await marker(live), "after");
});

void test("rollback refuses to delete an unexpected replacement live tree", async (t) => {
  const parent = await sandbox(t);
  const live = join(parent, "live");
  const candidate = join(parent, "candidate");
  const displaced = join(parent, "displaced");
  const unexpected = join(parent, "unexpected");
  await tree(live, "before");
  await tree(candidate, "after");
  await tree(unexpected, "foreign");
  const publication = await beginDirectoryPublication(candidate, live);
  const backup = publication.backup;
  assert.ok(backup);
  await rename(live, displaced);
  await rename(unexpected, live);

  const error = await safetyFailure(publication.rollback());

  assert.equal(error.details?.phase, "post-replacement");
  assert.equal(
    error.message,
    `directory rollback refused because live tree changed unexpectedly at ${live}`,
  );
  assert.equal(await marker(live), "foreign");
  assert.equal(await marker(displaced), "after");
  assert.equal(await marker(backup), "before");
});

void test("a validated deterministic backup path is retained and used", async (t) => {
  const parent = await sandbox(t);
  const live = join(parent, "live");
  const candidate = join(parent, "candidate");
  const backupPath = join(parent, ".live.bak.operation-token");
  await tree(live, "before");
  await tree(candidate, "after");

  const publication = await beginDirectoryPublication(candidate, live, {
    backupPath,
  });

  assert.equal(publication.backup, backupPath);
  assert.equal(await marker(backupPath), "before");
  await publication.rollback();
  assert.equal(await marker(live), "before");
});

void test("invalid deterministic backup paths are rejected before mutation", async (t) => {
  const parent = await sandbox(t);

  for (const [name, kind] of [
    ["outside sibling scope", "outside"],
    ["wrong prefix", "wrong-prefix"],
    ["live collision", "live"],
    ["candidate collision", "candidate"],
    ["pre-existing directory", "directory"],
    ["pre-existing file", "file"],
    ["dangling link", "link"],
  ] as const) {
    await t.test(name, async () => {
      const caseRoot = await mkdtemp(join(parent, "case-"));
      const live = join(caseRoot, "live");
      const candidate = join(caseRoot, ".live.bak.candidate");
      await tree(live, "before");
      await tree(candidate, "after");
      const proposed =
        kind === "outside"
          ? join(caseRoot, "nested", ".live.bak.token")
          : kind === "wrong-prefix"
            ? join(caseRoot, ".other.bak.token")
            : kind === "live"
              ? live
              : kind === "candidate"
                ? candidate
                : join(caseRoot, `.live.bak.${kind}`);
      if (kind === "directory") await mkdir(proposed);
      if (kind === "file") await writeFile(proposed, "foreign");
      if (kind === "link") await symlink(join(caseRoot, "missing"), proposed);

      await assert.rejects(
        beginDirectoryPublication(candidate, live, { backupPath: proposed }),
        exactError(SafetyError, "directory replacement failed"),
      );

      assert.equal(await marker(live), "before");
      assert.equal(await marker(candidate), "after");
      if (["directory", "file", "link"].includes(kind)) {
        assert.ok(await lstat(proposed));
      }
    });
  }
});

import assert from "node:assert/strict";
import {
  cp,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  failureResult,
  successResult,
  type AdapterContext,
  type AdapterMessage,
  type AdapterResult,
} from "../../../../src/adapter-result.ts";
import { beginDirectoryPublication } from "../../../../src/atomic.ts";
import type {
  InstallReceipt,
  PreparedArtifact,
} from "../../../../src/harness.ts";
import type { CodexNativeState } from "../../../../src/harnesses/codex/adapter.ts";
import {
  readCodexMarketplace,
  stageCodexMarketplace,
} from "../../../../src/harnesses/codex/marketplace.ts";
import { codexPaths } from "../../../../src/harnesses/codex/paths.ts";
import {
  installCodexMarketplace,
  type CodexPublicationDependencies,
} from "../../../../src/harnesses/codex/publication.ts";
import { readCodexRecovery } from "../../../../src/harnesses/codex/recovery.ts";
import { writeQualifiedCodexFixture } from "../../../lib/harnesses/codex/prepared-fixture.ts";

const RECEIPT: InstallReceipt = {
  missingVerificationOutput: {
    stdout: [],
    stderr: ["missing installed plugin"],
  },
  mismatchVerificationOutput: {
    stdout: [],
    stderr: ["installed plugin mismatch"],
  },
};

function nativeState(
  changes: Partial<CodexNativeState> = {},
): CodexNativeState {
  return {
    marketplaceRoot: null,
    pluginPresent: false,
    pluginEnabled: false,
    activeVersion: null,
    activeRoot: null,
    ...changes,
  };
}

function nativeResult(
  state: CodexNativeState,
  messages: readonly AdapterMessage[] = [],
) {
  return successResult("native-state", state, messages);
}

function inspection(
  view: "ownership" | "update-control" | "fingerprint",
  message: string,
): AdapterResult {
  if (view === "ownership") {
    return successResult(
      "inspect",
      {
        view,
        identity_state: "manager",
        resources: { plugin: true, marketplace: true },
        conflicts: [],
      },
      [{ channel: "stderr", text: message }],
    );
  }
  if (view === "update-control") {
    return successResult("inspect", { view, update_control: "managed" }, [
      { channel: "stderr", text: message },
    ]);
  }
  return successResult("inspect", { view, fingerprint: null }, []);
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "spw-codex-publication-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = join(root, "package");
  const codexHome = join(root, "codex-home");
  await mkdir(join(pkg, ".agents/plugins"), { recursive: true });
  await cp(
    new URL("../../../../.agents/plugins/marketplace.json", import.meta.url),
    join(pkg, ".agents/plugins/marketplace.json"),
  );
  await mkdir(codexHome);
  const preparedRoot = join(codexHome, "superpowers-manager/prepared");
  const ctx: AdapterContext = {
    root: pkg,
    env: {
      CODEX_HOME: codexHome,
      SUPERPOWERS_PLUGIN_ROOT: preparedRoot,
    },
  };
  const paths = codexPaths(ctx.env ?? {}, process.cwd());
  const artifact = await writeQualifiedCodexFixture(
    preparedRoot,
    "2".repeat(40),
    "https://example.invalid/upstream",
  );
  let native = nativeState();
  const dependencies: CodexPublicationDependencies = {
    readNative: async () =>
      nativeResult(native, [{ channel: "stderr", text: "native" }]),
    inspectNative: async (view) => inspection(view, view),
    beginPublication: beginDirectoryPublication,
  };
  const activateCurrent = async (root: string) => {
    const activeRoot = join(
      codexHome,
      "plugins/cache/superpowers-manager/superpowers/fixture",
    );
    await mkdir(join(activeRoot, ".."), { recursive: true });
    await cp(paths.publishedPluginRoot, activeRoot, { recursive: true });
    native = nativeState({
      marketplaceRoot: root,
      pluginPresent: true,
      pluginEnabled: true,
      activeVersion: "fixture",
      activeRoot,
    });
    return successResult("install", RECEIPT, [
      { channel: "stdout", text: "activated" },
    ]);
  };
  return {
    root,
    pkg,
    codexHome,
    ctx,
    paths,
    artifact,
    dependencies,
    activateCurrent,
    getNative: () => native,
    setNative: (value: CodexNativeState) => {
      native = value;
    },
  };
}

function transaction(result: AdapterResult<InstallReceipt>) {
  assert.equal(result.outcome.ok, true, JSON.stringify(result));
  if (!result.outcome.ok) assert.fail("expected pending installation");
  assert.ok(result.outcome.result.transaction);
  return result.outcome.result.transaction;
}

async function seedMarketplace(
  artifact: PreparedArtifact,
  packageRoot: string,
  destination: string,
): Promise<void> {
  const candidate = `${destination}.seed`;
  await stageCodexMarketplace(artifact, packageRoot, candidate);
  await (await beginDirectoryPublication(candidate, destination)).finalize();
}

async function oldMarketplace(f: Awaited<ReturnType<typeof fixture>>) {
  const old = await writeQualifiedCodexFixture(
    join(f.root, "old-prepared"),
    "1".repeat(40),
    "https://example.invalid/upstream",
  );
  await seedMarketplace(old, f.pkg, f.paths.marketplaceRoot);
  return old;
}

void test("publication returns a pending transaction and preserves ordered native messages", async (t) => {
  const f = await fixture(t);
  const result = await installCodexMarketplace(
    f.artifact,
    f.ctx,
    f.activateCurrent,
    f.dependencies,
  );
  const tx = transaction(result);
  assert.ok(await readCodexMarketplace(f.paths.marketplaceRoot));
  assert.ok(await readCodexRecovery(f.paths));
  assert.deepEqual(
    result.outcome.ok ? result.outcome.messages.map((item) => item.text) : [],
    ["native", "ownership", "update-control", "native", "activated"],
  );
  assert.equal((await tx.finalize()).outcome.ok, true);
  assert.equal(await readCodexRecovery(f.paths), null);
});

void test("an update retains an independent old tree until finalize", async (t) => {
  const f = await fixture(t);
  const old = await oldMarketplace(f);
  const result = await installCodexMarketplace(
    f.artifact,
    f.ctx,
    f.activateCurrent,
    f.dependencies,
  );
  const tx = transaction(result);
  await rm(f.paths.preparedRoot, { recursive: true });
  const backups = (await readdir(f.paths.managerRoot)).filter((name) =>
    name.startsWith(".marketplace.bak."),
  );
  assert.equal(backups.length, 1);
  assert.equal(
    (await readCodexMarketplace(join(f.paths.managerRoot, backups[0]!)))
      ?.artifact.commit,
    old.commit,
  );
  assert.equal(
    (await readCodexMarketplace(f.paths.marketplaceRoot))?.artifact.commit,
    f.artifact.commit,
  );
  assert.equal((await tx.finalize()).outcome.ok, true);
  assert.deepEqual(
    (await readdir(f.paths.managerRoot)).filter((name) =>
      name.startsWith(".marketplace.bak."),
    ),
    [],
  );
});

void test("activation failure without mutation restores the old publication", async (t) => {
  const f = await fixture(t);
  const old = await oldMarketplace(f);
  const activeRoot = join(
    f.codexHome,
    "plugins/cache/superpowers-manager/superpowers/old",
  );
  await mkdir(join(activeRoot, ".."), { recursive: true });
  await cp(f.paths.publishedPluginRoot, activeRoot, { recursive: true });
  f.setNative(
    nativeState({
      marketplaceRoot: f.paths.marketplaceRoot,
      pluginPresent: true,
      pluginEnabled: true,
      activeVersion: "old",
      activeRoot,
    }),
  );
  const result = await installCodexMarketplace(
    f.artifact,
    f.ctx,
    async () =>
      failureResult("install", "native-failed", "controlled failure", [], []),
    f.dependencies,
  );
  assert.equal(result.outcome.ok, false);
  if (result.outcome.ok) assert.fail("expected failure");
  assert.equal(result.outcome.error.code, "activation-failed");
  assert.equal(
    (await readCodexMarketplace(f.paths.marketplaceRoot))?.artifact.commit,
    old.commit,
  );
  assert.equal(await readCodexRecovery(f.paths), null);
});

void test("activation failure after partial native mutation preserves recovery evidence", async (t) => {
  const f = await fixture(t);
  const result = await installCodexMarketplace(
    f.artifact,
    f.ctx,
    async (root) => {
      f.setNative(nativeState({ marketplaceRoot: root, pluginPresent: true }));
      return failureResult(
        "install",
        "native-failed",
        "controlled failure",
        [],
        [],
      );
    },
    f.dependencies,
  );
  assert.equal(result.outcome.ok, false);
  if (result.outcome.ok) assert.fail("expected failure");
  assert.equal(result.outcome.error.code, "recovery-required");
  assert.ok(await readCodexRecovery(f.paths));
  assert.ok(await readCodexMarketplace(f.paths.marketplaceRoot));
});

void test("verification rollback refuses a changed live identity", async (t) => {
  const f = await fixture(t);
  const result = await installCodexMarketplace(
    f.artifact,
    f.ctx,
    f.activateCurrent,
    f.dependencies,
  );
  const tx = transaction(result);
  const replacement = `${f.paths.marketplaceRoot}.replacement`;
  await cp(f.paths.marketplaceRoot, replacement, { recursive: true });
  await rm(f.paths.marketplaceRoot, { recursive: true });
  await cp(replacement, f.paths.marketplaceRoot, { recursive: true });
  const settled = await tx.rollback();
  assert.equal(settled.outcome.ok, false);
  if (settled.outcome.ok) assert.fail("expected recovery requirement");
  assert.equal(settled.outcome.error.code, "recovery-required");
  assert.ok(await readCodexRecovery(f.paths).catch(() => ({ changed: true })));
});

void test("a pre-existing derived backup blocks publication without deleting it", async (t) => {
  const f = await fixture(t);
  const dependencies: CodexPublicationDependencies = {
    ...f.dependencies,
    beginPublication: async (candidate, live, options) => {
      const backup = options?.backupPath;
      assert.ok(backup);
      await mkdir(backup);
      return await beginDirectoryPublication(candidate, live, options);
    },
  };
  const result = await installCodexMarketplace(
    f.artifact,
    f.ctx,
    f.activateCurrent,
    dependencies,
  );
  assert.equal(result.outcome.ok, false);
  if (result.outcome.ok) assert.fail("expected failure");
  assert.equal(result.outcome.error.code, "recovery-required");
  assert.equal(
    (await readdir(f.paths.managerRoot)).filter((name) =>
      name.startsWith(".marketplace.bak."),
    ).length,
    1,
  );
  await assert.rejects(
    readCodexRecovery(f.paths),
    /cannot inspect Codex recovery state:/,
  );
});

void test("an inconsistent derived backup path is rejected and retained", async (t) => {
  const f = await fixture(t);
  await oldMarketplace(f);
  const dependencies: CodexPublicationDependencies = {
    ...f.dependencies,
    beginPublication: async (candidate, live, options) => {
      assert.ok(options?.backupPath);
      return await beginDirectoryPublication(candidate, live, {
        backupPath: `${options.backupPath}.other`,
      });
    },
  };
  const result = await installCodexMarketplace(
    f.artifact,
    f.ctx,
    f.activateCurrent,
    dependencies,
  );
  assert.equal(result.outcome.ok, false);
  if (result.outcome.ok) assert.fail("expected recovery requirement");
  assert.equal(result.outcome.error.code, "recovery-required");
  assert.equal(
    (await readdir(f.paths.managerRoot)).some((name) =>
      name.endsWith(".other"),
    ),
    true,
  );
});

void test("caught activation throws never disclose their payload", async (t) => {
  const f = await fixture(t);
  const planted = "PLANTED-SECRET";
  const result = await installCodexMarketplace(
    f.artifact,
    f.ctx,
    async () => {
      throw new Error(planted);
    },
    f.dependencies,
  );
  assert.equal(result.outcome.ok, false);
  if (result.outcome.ok) assert.fail("expected failure");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(planted));
});

void test("artifact roots outside the resolved preparation location are refused before native access", async (t) => {
  const f = await fixture(t);
  let accessed = false;
  const dependencies: CodexPublicationDependencies = {
    ...f.dependencies,
    readNative: async () => {
      accessed = true;
      return nativeResult(nativeState());
    },
  };
  const result = await installCodexMarketplace(
    { ...f.artifact, root: join(f.root, "foreign") },
    f.ctx,
    f.activateCurrent,
    dependencies,
  );
  assert.equal(result.outcome.ok, false);
  assert.equal(accessed, false);
});

void test("failure before the first rename preserves the old tree and settles owned staging", async (t) => {
  const f = await fixture(t);
  const old = await oldMarketplace(f);
  const dependencies: CodexPublicationDependencies = {
    ...f.dependencies,
    beginPublication: (candidate, live, options) =>
      beginDirectoryPublication(candidate, live, {
        ...options,
        hooks: {
          rename: async () => {
            throw new Error("PLANTED-FIRST-RENAME");
          },
        },
      }),
  };
  const result = await installCodexMarketplace(
    f.artifact,
    f.ctx,
    f.activateCurrent,
    dependencies,
  );
  assert.equal(result.outcome.ok, false);
  if (result.outcome.ok) assert.fail("expected refusal");
  assert.equal(result.outcome.error.code, "activation-refused");
  assert.doesNotMatch(JSON.stringify(result), /PLANTED-FIRST-RENAME/);
  assert.equal(
    (await readCodexMarketplace(f.paths.marketplaceRoot))?.artifact.commit,
    old.commit,
  );
  assert.equal(await readCodexRecovery(f.paths), null);
});

void test("failure after the first rename restores the old tree and settles evidence", async (t) => {
  const f = await fixture(t);
  const old = await oldMarketplace(f);
  let calls = 0;
  const dependencies: CodexPublicationDependencies = {
    ...f.dependencies,
    beginPublication: (candidate, live, options) =>
      beginDirectoryPublication(candidate, live, {
        ...options,
        hooks: {
          rename: async (source, destination) => {
            calls += 1;
            if (calls === 2) throw new Error("PLANTED-SECOND-RENAME");
            await rename(source, destination);
          },
        },
      }),
  };
  const result = await installCodexMarketplace(
    f.artifact,
    f.ctx,
    f.activateCurrent,
    dependencies,
  );
  assert.equal(result.outcome.ok, false);
  if (result.outcome.ok) assert.fail("expected refusal");
  assert.equal(result.outcome.error.code, "activation-refused");
  assert.equal(
    (await readCodexMarketplace(f.paths.marketplaceRoot))?.artifact.commit,
    old.commit,
  );
  assert.equal(await readCodexRecovery(f.paths), null);
});

void test("failed restoration after the second rename preserves the identified backup and journal", async (t) => {
  const f = await fixture(t);
  const old = await oldMarketplace(f);
  let calls = 0;
  const dependencies: CodexPublicationDependencies = {
    ...f.dependencies,
    beginPublication: (candidate, live, options) =>
      beginDirectoryPublication(candidate, live, {
        ...options,
        hooks: {
          rename: async (source, destination) => {
            calls += 1;
            if (calls >= 2) throw new Error("PLANTED-RESTORE");
            await rename(source, destination);
          },
        },
      }),
  };
  const result = await installCodexMarketplace(
    f.artifact,
    f.ctx,
    f.activateCurrent,
    dependencies,
  );
  assert.equal(result.outcome.ok, false);
  if (result.outcome.ok) assert.fail("expected recovery requirement");
  assert.equal(result.outcome.error.code, "recovery-required");
  assert.doesNotMatch(JSON.stringify(result), /PLANTED-RESTORE/);
  const recovery = await readCodexRecovery(f.paths);
  assert.ok(recovery);
  assert.equal(recovery.phase, "publishing");
  assert.equal(
    (
      await readCodexMarketplace(
        join(f.paths.managerRoot, `.marketplace.bak.${recovery.token}`),
      )
    )?.artifact.commit,
    old.commit,
  );
});

void test("successful native activation followed by failed shared verification preserves evidence", async (t) => {
  const f = await fixture(t);
  const result = await installCodexMarketplace(
    f.artifact,
    f.ctx,
    f.activateCurrent,
    f.dependencies,
  );
  const settled = await transaction(result).rollback();
  assert.equal(settled.outcome.ok, false);
  if (settled.outcome.ok) assert.fail("expected recovery requirement");
  assert.equal(settled.outcome.error.code, "recovery-required");
  assert.ok(await readCodexRecovery(f.paths));
});

void test("changed backup identity blocks finalization and preserves the replacement", async (t) => {
  const f = await fixture(t);
  await oldMarketplace(f);
  const result = await installCodexMarketplace(
    f.artifact,
    f.ctx,
    f.activateCurrent,
    f.dependencies,
  );
  const tx = transaction(result);
  const recovery = await readCodexRecovery(f.paths);
  assert.ok(recovery);
  const backup = join(
    f.paths.managerRoot,
    `.marketplace.bak.${recovery.token}`,
  );
  const replacement = `${backup}.replacement`;
  await cp(backup, replacement, { recursive: true });
  await rm(backup, { recursive: true });
  await rename(replacement, backup);
  const settled = await tx.finalize();
  assert.equal(settled.outcome.ok, false);
  assert.ok(await readCodexMarketplace(backup));
});

void test("changed journal identity blocks finalization", async (t) => {
  const f = await fixture(t);
  const result = await installCodexMarketplace(
    f.artifact,
    f.ctx,
    f.activateCurrent,
    f.dependencies,
  );
  const tx = transaction(result);
  const journal = join(f.paths.recoveryRoot, "transaction.json");
  const replacement = join(f.paths.recoveryRoot, "replacement");
  await writeFile(replacement, await readFile(journal));
  await rename(replacement, journal);
  const settled = await tx.finalize();
  assert.equal(settled.outcome.ok, false);
  if (settled.outcome.ok) assert.fail("expected recovery requirement");
  assert.equal(settled.outcome.error.code, "recovery-required");
});

void test("final backup cleanup failure reports verified activation with retained recovery", async (t) => {
  const f = await fixture(t);
  await oldMarketplace(f);
  const dependencies: CodexPublicationDependencies = {
    ...f.dependencies,
    beginPublication: async (candidate, live, options) => {
      const publication = await beginDirectoryPublication(
        candidate,
        live,
        options,
      );
      return {
        ...publication,
        async finalize() {
          throw new Error("PLANTED-FINALIZE");
        },
      };
    },
  };
  const result = await installCodexMarketplace(
    f.artifact,
    f.ctx,
    f.activateCurrent,
    dependencies,
  );
  const tx = transaction(result);
  const settled = await tx.finalize();
  assert.equal(settled.outcome.ok, false);
  if (settled.outcome.ok) assert.fail("expected cleanup failure");
  assert.equal(settled.outcome.error.code, "recovery-required");
  assert.match(
    settled.outcome.error.message,
    /activation was verified, but backup or journal cleanup failed/,
  );
  assert.doesNotMatch(JSON.stringify(settled), /PLANTED-FINALIZE/);
  assert.ok(await readCodexRecovery(f.paths));
  const repeated = await tx.rollback();
  assert.equal(repeated.outcome.ok, false);
  if (repeated.outcome.ok) assert.fail("expected settled transaction");
  assert.equal(repeated.outcome.error.code, "already-settled");
});

void test("journal cleanup failure reports verified activation after backup removal", async (t) => {
  const f = await fixture(t);
  await oldMarketplace(f);
  const result = await installCodexMarketplace(
    f.artifact,
    f.ctx,
    f.activateCurrent,
    f.dependencies,
  );
  const recovery = await readCodexRecovery(f.paths);
  assert.ok(recovery);
  await writeFile(join(f.paths.recoveryRoot, "unknown"), "preserve\n");
  const settled = await transaction(result).finalize();
  assert.equal(settled.outcome.ok, false);
  if (settled.outcome.ok) assert.fail("expected cleanup failure");
  assert.equal(settled.outcome.error.code, "recovery-required");
  assert.match(
    settled.outcome.error.message,
    /activation was verified and backup cleanup completed, but journal retirement failed/,
  );
  assert.equal(
    (await readdir(f.paths.managerRoot)).some((name) =>
      name.startsWith(".marketplace.bak."),
    ),
    false,
  );
  assert.equal(
    await readFile(join(f.paths.recoveryRoot, "unknown"), "utf8"),
    "preserve\n",
  );
});

void test("inspectable damaged active content reaches activation but is not reverse-migrated", async (t) => {
  const f = await fixture(t);
  const damaged = join(
    f.codexHome,
    "plugins/cache/superpowers-manager/superpowers/damaged",
  );
  await mkdir(damaged, { recursive: true });
  await writeFile(join(damaged, "damaged"), "incomplete\n");
  f.setNative(
    nativeState({
      marketplaceRoot: f.pkg,
      pluginPresent: true,
      pluginEnabled: true,
      activeVersion: "damaged",
      activeRoot: damaged,
    }),
  );
  let called = false;
  const result = await installCodexMarketplace(
    f.artifact,
    f.ctx,
    async () => {
      called = true;
      return failureResult(
        "install",
        "native-failed",
        "controlled failure",
        [],
        [],
      );
    },
    f.dependencies,
  );
  assert.equal(called, true);
  assert.equal(result.outcome.ok, false);
  if (result.outcome.ok) assert.fail("expected recovery requirement");
  assert.equal(result.outcome.error.code, "recovery-required");
  assert.equal(
    await readFile(join(damaged, "damaged"), "utf8"),
    "incomplete\n",
  );
  assert.ok(await readCodexRecovery(f.paths));
});

void test("filesystem access denial blocks publication before activation", async (t) => {
  const f = await fixture(t);
  const denied = join(
    f.codexHome,
    "plugins/cache/superpowers-manager/superpowers/denied",
  );
  await mkdir(denied, { recursive: true });
  await chmod(denied, 0o000);
  t.after(() => chmod(denied, 0o700).catch(() => {}));
  f.setNative(
    nativeState({
      marketplaceRoot: f.pkg,
      pluginPresent: true,
      pluginEnabled: true,
      activeVersion: "denied",
      activeRoot: denied,
    }),
  );
  let called = false;
  const result = await installCodexMarketplace(
    f.artifact,
    f.ctx,
    async () => {
      called = true;
      return successResult("install", RECEIPT, []);
    },
    f.dependencies,
  );
  assert.equal(result.outcome.ok, false);
  assert.equal(called, false);
  assert.equal(await readCodexRecovery(f.paths), null);
});

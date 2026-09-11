import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CodexNativeState } from "../../../../src/harnesses/codex/adapter.ts";
import { digestArtifactTree } from "../../../../src/artifact-tree.ts";
import { codexPaths } from "../../../../src/harnesses/codex/paths.ts";
import {
  beginCodexRecovery,
  finishCodexRecovery,
  readCodexRecovery,
  verifyCodexRecovery,
} from "../../../../src/harnesses/codex/recovery.ts";

const ABSENT_NATIVE: CodexNativeState = {
  marketplaceRoot: null,
  pluginPresent: false,
  pluginEnabled: false,
  activeVersion: null,
  activeRoot: null,
};

async function fixture(t: test.TestContext) {
  const codexHome = await mkdtemp(join(tmpdir(), "spw-codex-recovery-"));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const paths = codexPaths({ CODEX_HOME: codexHome }, process.cwd());
  return { codexHome, paths };
}

void test("recovery journal is exclusively owned and strictly readable", async (t) => {
  const { paths } = await fixture(t);
  assert.equal(await readCodexRecovery(paths), null);
  assert.equal((await readdir(paths.codexHome)).length, 0);

  const pending = await beginCodexRecovery(paths, {
    operation: "install",
    marketplaceRoot: paths.marketplaceRoot,
    priorNative: ABSENT_NATIVE,
    oldDigest: null,
    oldIdentity: null,
  });
  assert.equal(pending.record.schema, 2);
  assert.equal(pending.record.operation, "install");
  assert.match(pending.record.token, /^[a-f0-9]{32}$/u);
  assert.equal(
    pending.stage,
    join(paths.managerRoot, `.stage-${pending.record.token}`),
  );
  assert.equal(
    pending.backup,
    join(paths.managerRoot, `.marketplace.bak.${pending.record.token}`),
  );
  assert.deepEqual(await readCodexRecovery(paths), pending.record);
  await assert.rejects(
    beginCodexRecovery(paths, {
      operation: "install",
      marketplaceRoot: paths.marketplaceRoot,
      priorNative: ABSENT_NATIVE,
      oldDigest: null,
      oldIdentity: null,
    }),
    /unresolved Codex recovery state/,
  );
});

void test("recovery journal bytes and identity remain stable while artifact layout changes", async (t) => {
  const { paths } = await fixture(t);
  await mkdir(paths.marketplaceRoot, { recursive: true });
  const old = await lstat(paths.marketplaceRoot);
  const pending = await beginCodexRecovery(paths, {
    operation: "install",
    marketplaceRoot: paths.marketplaceRoot,
    priorNative: ABSENT_NATIVE,
    oldDigest: await digestArtifactTree(paths.marketplaceRoot),
    oldIdentity: { dev: old.dev, ino: old.ino },
  });
  const journal = join(paths.recoveryRoot, "transaction.json");
  const beforeBytes = await readFile(journal);
  const before = await lstat(journal);

  await mkdir(pending.stage);
  const staged = await lstat(pending.stage);
  pending.newDigest = await digestArtifactTree(pending.stage);
  pending.stageIdentity = { dev: staged.dev, ino: staged.ino };
  await verifyCodexRecovery(pending);
  await rename(paths.marketplaceRoot, pending.backup);
  await rename(pending.stage, paths.marketplaceRoot);

  const after = await lstat(journal);
  assert.deepEqual(await readFile(journal), beforeBytes);
  assert.deepEqual(
    { dev: after.dev, ino: after.ino },
    { dev: before.dev, ino: before.ino },
  );
  assert.deepEqual(await readCodexRecovery(paths), pending.record);
});

void test("recovery reader rejects duplicate keys and exact-schema violations", async (t) => {
  const { paths } = await fixture(t);
  const pending = await beginCodexRecovery(paths, {
    operation: "install",
    marketplaceRoot: paths.marketplaceRoot,
    priorNative: ABSENT_NATIVE,
    oldDigest: null,
    oldIdentity: null,
  });
  const journal = join(paths.recoveryRoot, "transaction.json");
  const valid = await readFile(journal, "utf8");
  const malformed = [
    valid.replace('"schema":2', '"schema":2,"schema":2'),
    valid.replace('"schema":2', '"schema":1'),
    valid.replace('"operation":"install"', '"operation":"repair"'),
    valid.replace(pending.record.token, "not-a-token"),
    valid.replace(paths.marketplaceRoot, join(paths.codexHome, "foreign")),
    valid.replace(/\}\n$/u, ',"extra":true}\n'),
    `${JSON.stringify({
      schema: 1,
      token: pending.record.token,
      phase: "publishing",
      marketplaceRoot: paths.marketplaceRoot,
      priorNative: ABSENT_NATIVE,
      oldDigest: null,
      newDigest: null,
      oldIdentity: null,
      stageIdentity: null,
      publishedIdentity: null,
    })}\n`,
  ];
  for (const bytes of malformed) {
    await writeFile(journal, bytes);
    await assert.rejects(
      readCodexRecovery(paths),
      /cannot inspect Codex recovery state:/,
    );
  }
});

void test("recovery reader rejects unknown material and symlinked recovery paths", async (t) => {
  const first = await fixture(t);
  await beginCodexRecovery(first.paths, {
    operation: "install",
    marketplaceRoot: first.paths.marketplaceRoot,
    priorNative: ABSENT_NATIVE,
    oldDigest: null,
    oldIdentity: null,
  });
  await writeFile(join(first.paths.recoveryRoot, "unknown"), "keep\n");
  await assert.rejects(
    readCodexRecovery(first.paths),
    /cannot inspect Codex recovery state:/,
  );

  const second = await fixture(t);
  const foreign = join(second.codexHome, "foreign");
  await mkdir(foreign);
  await mkdir(second.paths.managerRoot);
  await symlink(foreign, second.paths.recoveryRoot);
  await assert.rejects(
    readCodexRecovery(second.paths),
    /cannot inspect Codex recovery state:/,
  );
});

void test("recovery reader rejects a symlinked marketplace root", async (t) => {
  const { codexHome, paths } = await fixture(t);
  await mkdir(paths.managerRoot);
  await symlink(join(codexHome, "foreign"), paths.marketplaceRoot);
  await assert.rejects(
    beginCodexRecovery(paths, {
      operation: "install",
      marketplaceRoot: paths.marketplaceRoot,
      priorNative: ABSENT_NATIVE,
      oldDigest: null,
      oldIdentity: null,
    }),
    /cannot begin Codex recovery journal/,
  );
});

void test("recovery reader rejects a symlinked journal without changing its target", async (t) => {
  const { paths } = await fixture(t);
  await beginCodexRecovery(paths, {
    operation: "install",
    marketplaceRoot: paths.marketplaceRoot,
    priorNative: ABSENT_NATIVE,
    oldDigest: null,
    oldIdentity: null,
  });
  const journal = join(paths.recoveryRoot, "transaction.json");
  const target = join(paths.codexHome, "foreign-journal");
  const bytes = "foreign journal bytes\n";
  await writeFile(target, bytes);
  await rm(journal);
  await symlink(target, journal);

  await assert.rejects(
    readCodexRecovery(paths),
    /cannot inspect Codex recovery state:/,
  );
  assert.equal(await readFile(target, "utf8"), bytes);
});

void test("recovery verification retains in-memory evidence and rejects changed journal identity", async (t) => {
  const { paths } = await fixture(t);
  const pending = await beginCodexRecovery(paths, {
    operation: "install",
    marketplaceRoot: paths.marketplaceRoot,
    priorNative: ABSENT_NATIVE,
    oldDigest: null,
    oldIdentity: null,
  });
  await mkdir(pending.stage);
  const stage = await lstat(pending.stage);
  const digest = await digestArtifactTree(pending.stage);
  pending.newDigest = digest;
  pending.stageIdentity = { dev: stage.dev, ino: stage.ino };
  await verifyCodexRecovery(pending);
  assert.equal((await readCodexRecovery(paths))?.operation, "install");

  const journal = join(paths.recoveryRoot, "transaction.json");
  const replacement = join(paths.recoveryRoot, "replacement");
  await writeFile(replacement, await readFile(journal));
  await rename(replacement, journal);
  await assert.rejects(
    verifyCodexRecovery(pending),
    /Codex recovery journal changed/,
  );
});

void test("recovery reader retains diagnostic evidence after marketplace content changes", async (t) => {
  const { paths } = await fixture(t);
  await mkdir(paths.marketplaceRoot, { recursive: true });
  await writeFile(join(paths.marketplaceRoot, "owned"), "before\n");
  const old = await lstat(paths.marketplaceRoot);
  const pending = await beginCodexRecovery(paths, {
    operation: "install",
    marketplaceRoot: paths.marketplaceRoot,
    priorNative: ABSENT_NATIVE,
    oldDigest: await digestArtifactTree(paths.marketplaceRoot),
    oldIdentity: { dev: old.dev, ino: old.ino },
  });
  await writeFile(join(paths.marketplaceRoot, "owned"), "after\n");
  assert.deepEqual(await readCodexRecovery(paths), pending.record);
});

void test("interrupted publishing is readable in a fresh process-style inspection", async (t) => {
  const { paths } = await fixture(t);
  await mkdir(paths.marketplaceRoot, { recursive: true });
  const old = await lstat(paths.marketplaceRoot);
  const pending = await beginCodexRecovery(paths, {
    operation: "install",
    marketplaceRoot: paths.marketplaceRoot,
    priorNative: ABSENT_NATIVE,
    oldDigest: await digestArtifactTree(paths.marketplaceRoot),
    oldIdentity: { dev: old.dev, ino: old.ino },
  });
  await mkdir(pending.stage);
  const stage = await lstat(pending.stage);
  const stageDigest = await digestArtifactTree(pending.stage);
  pending.newDigest = stageDigest;
  pending.stageIdentity = { dev: stage.dev, ino: stage.ino };
  await verifyCodexRecovery(pending);
  await rename(paths.marketplaceRoot, pending.backup);
  assert.equal((await readCodexRecovery(paths))?.operation, "install");
});

void test("interrupted durable cleanup remains readable after marketplace deletion", async (t) => {
  const { paths } = await fixture(t);
  await mkdir(paths.marketplaceRoot, { recursive: true });
  await writeFile(join(paths.marketplaceRoot, "owned"), "before\n");
  const old = await lstat(paths.marketplaceRoot);
  const pending = await beginCodexRecovery(paths, {
    operation: "uninstall",
    marketplaceRoot: paths.marketplaceRoot,
    priorNative: ABSENT_NATIVE,
    oldDigest: await digestArtifactTree(paths.marketplaceRoot),
    oldIdentity: { dev: old.dev, ino: old.ino },
  });
  await verifyCodexRecovery(pending);
  await rm(paths.marketplaceRoot, { recursive: true });

  assert.equal((await readCodexRecovery(paths))?.operation, "uninstall");
});

void test("finish removes only the captured journal and empty recovery directory", async (t) => {
  const { paths } = await fixture(t);
  const pending = await beginCodexRecovery(paths, {
    operation: "install",
    marketplaceRoot: paths.marketplaceRoot,
    priorNative: ABSENT_NATIVE,
    oldDigest: null,
    oldIdentity: null,
  });
  await finishCodexRecovery(pending);
  assert.equal(await readCodexRecovery(paths), null);
  await assert.rejects(
    finishCodexRecovery(pending),
    /Codex recovery journal is already settled/,
  );
});

void test("finish refuses unknown material without following or removing it", async (t) => {
  const { paths } = await fixture(t);
  const pending = await beginCodexRecovery(paths, {
    operation: "install",
    marketplaceRoot: paths.marketplaceRoot,
    priorNative: ABSENT_NATIVE,
    oldDigest: null,
    oldIdentity: null,
  });
  const outside = join(paths.codexHome, "outside");
  await writeFile(outside, "preserve\n");
  await symlink(outside, join(paths.recoveryRoot, "unknown"));
  await assert.rejects(
    finishCodexRecovery(pending),
    /unexpected Codex recovery material/,
  );
  assert.equal(await readFile(outside, "utf8"), "preserve\n");
  assert.deepEqual((await readdir(paths.recoveryRoot)).sort(), [
    "transaction.json",
    "unknown",
  ]);
});

void test("a killed publisher leaves immutable journals readable by a fresh process", async (t) => {
  for (const boundary of ["backup-renamed", "published"] as const) {
    await t.test(boundary, async (t) => {
      const { paths } = await fixture(t);
      const moduleUrl = new URL(
        "../../../../src/harnesses/codex/recovery.ts",
        import.meta.url,
      ).href;
      const script = `
        import { lstat, mkdir, rename } from "node:fs/promises";
        import { digestArtifactTree } from ${JSON.stringify(new URL("../../../../src/artifact-tree.ts", import.meta.url).href)};
        import { beginCodexRecovery, verifyCodexRecovery } from ${JSON.stringify(moduleUrl)};
        const paths = JSON.parse(process.argv[1]);
        const boundary = process.argv[2];
        await mkdir(paths.marketplaceRoot, { recursive: true });
        const old = await lstat(paths.marketplaceRoot);
        const pending = await beginCodexRecovery(paths, {
          operation: "install",
          marketplaceRoot: paths.marketplaceRoot,
          priorNative: ${JSON.stringify(ABSENT_NATIVE)},
          oldDigest: await digestArtifactTree(paths.marketplaceRoot),
          oldIdentity: { dev: old.dev, ino: old.ino },
        });
        await mkdir(pending.stage);
        const stage = await lstat(pending.stage);
        pending.newDigest = await digestArtifactTree(pending.stage);
        pending.stageIdentity = { dev: stage.dev, ino: stage.ino };
        await verifyCodexRecovery(pending);
        await rename(paths.marketplaceRoot, pending.backup);
        if (boundary === "published") {
          await rename(pending.stage, paths.marketplaceRoot);
          pending.publishedIdentity = { dev: stage.dev, ino: stage.ino };
          await verifyCodexRecovery(pending);
        }
        process.kill(process.pid, "SIGKILL");
      `;
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", script, JSON.stringify(paths), boundary],
        { stdio: "ignore" },
      );
      const [code, signal] = (await once(child, "exit")) as [
        number | null,
        NodeJS.Signals | null,
      ];
      assert.equal(code, null);
      assert.equal(signal, "SIGKILL");
      assert.equal((await readCodexRecovery(paths))?.operation, "install");
    });
  }
});

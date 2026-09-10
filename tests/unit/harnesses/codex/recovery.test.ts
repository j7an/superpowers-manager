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
  advanceCodexRecovery,
  beginCodexRecovery,
  finishCodexRecovery,
  readCodexRecovery,
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
    marketplaceRoot: paths.marketplaceRoot,
    priorNative: ABSENT_NATIVE,
    oldDigest: null,
    oldIdentity: null,
  });
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
      marketplaceRoot: paths.marketplaceRoot,
      priorNative: ABSENT_NATIVE,
      oldDigest: null,
      oldIdentity: null,
    }),
    /unresolved Codex recovery state/,
  );
});

void test("recovery reader rejects duplicate keys and exact-schema violations", async (t) => {
  const { paths } = await fixture(t);
  const pending = await beginCodexRecovery(paths, {
    marketplaceRoot: paths.marketplaceRoot,
    priorNative: ABSENT_NATIVE,
    oldDigest: null,
    oldIdentity: null,
  });
  const journal = join(paths.recoveryRoot, "transaction.json");
  const valid = await readFile(journal, "utf8");
  const malformed = [
    valid.replace('"schema":1', '"schema":1,"schema":1'),
    valid.replace('"schema":1', '"schema":2'),
    valid.replace(pending.record.token, "not-a-token"),
    valid.replace(paths.marketplaceRoot, join(paths.codexHome, "foreign")),
    valid.replace(/\}\n$/u, ',"extra":true}\n'),
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
      marketplaceRoot: paths.marketplaceRoot,
      priorNative: ABSENT_NATIVE,
      oldDigest: null,
      oldIdentity: null,
    }),
    /cannot begin Codex recovery journal/,
  );
});

void test("phase updates retain inspected evidence and reject changed journal identity", async (t) => {
  const { paths } = await fixture(t);
  const pending = await beginCodexRecovery(paths, {
    marketplaceRoot: paths.marketplaceRoot,
    priorNative: ABSENT_NATIVE,
    oldDigest: null,
    oldIdentity: null,
  });
  await mkdir(pending.stage);
  const stage = await lstat(pending.stage);
  const digest = await digestArtifactTree(pending.stage);
  await advanceCodexRecovery(pending, "staging", {
    newDigest: digest,
    stageIdentity: { dev: stage.dev, ino: stage.ino },
  });
  await advanceCodexRecovery(pending, "publishing");
  assert.equal((await readCodexRecovery(paths))?.phase, "publishing");

  const journal = join(paths.recoveryRoot, "transaction.json");
  const replacement = join(paths.recoveryRoot, "replacement");
  await writeFile(replacement, await readFile(journal));
  await rename(replacement, journal);
  await assert.rejects(
    advanceCodexRecovery(pending, "published", {
      publishedIdentity: { dev: stage.dev, ino: stage.ino },
    }),
    /Codex recovery journal changed/,
  );
});

void test("recovery reader rejects content changed behind a captured directory identity", async (t) => {
  const { paths } = await fixture(t);
  await mkdir(paths.marketplaceRoot, { recursive: true });
  await writeFile(join(paths.marketplaceRoot, "owned"), "before\n");
  const old = await lstat(paths.marketplaceRoot);
  await beginCodexRecovery(paths, {
    marketplaceRoot: paths.marketplaceRoot,
    priorNative: ABSENT_NATIVE,
    oldDigest: await digestArtifactTree(paths.marketplaceRoot),
    oldIdentity: { dev: old.dev, ino: old.ino },
  });
  await writeFile(join(paths.marketplaceRoot, "owned"), "after\n");
  await assert.rejects(
    readCodexRecovery(paths),
    /cannot inspect Codex recovery state:/,
  );
});

void test("interrupted publishing is readable in a fresh process-style inspection", async (t) => {
  const { paths } = await fixture(t);
  await mkdir(paths.marketplaceRoot, { recursive: true });
  const old = await lstat(paths.marketplaceRoot);
  const pending = await beginCodexRecovery(paths, {
    marketplaceRoot: paths.marketplaceRoot,
    priorNative: ABSENT_NATIVE,
    oldDigest: await digestArtifactTree(paths.marketplaceRoot),
    oldIdentity: { dev: old.dev, ino: old.ino },
  });
  await mkdir(pending.stage);
  const stage = await lstat(pending.stage);
  const stageDigest = await digestArtifactTree(pending.stage);
  await advanceCodexRecovery(pending, "staging", {
    newDigest: stageDigest,
    stageIdentity: { dev: stage.dev, ino: stage.ino },
  });
  await advanceCodexRecovery(pending, "publishing");
  await rename(paths.marketplaceRoot, pending.backup);
  assert.equal((await readCodexRecovery(paths))?.phase, "publishing");
});

void test("finish removes only the captured journal and empty recovery directory", async (t) => {
  const { paths } = await fixture(t);
  const pending = await beginCodexRecovery(paths, {
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

void test("a killed publisher leaves publishing and published journals readable by a fresh process", async (t) => {
  for (const phase of ["publishing", "published"] as const) {
    await t.test(phase, async (t) => {
      const { paths } = await fixture(t);
      const moduleUrl = new URL(
        "../../../../src/harnesses/codex/recovery.ts",
        import.meta.url,
      ).href;
      const script = `
        import { lstat, mkdir, rename } from "node:fs/promises";
        import { digestArtifactTree } from ${JSON.stringify(new URL("../../../../src/artifact-tree.ts", import.meta.url).href)};
        import { advanceCodexRecovery, beginCodexRecovery } from ${JSON.stringify(moduleUrl)};
        const paths = JSON.parse(process.argv[1]);
        const finalPhase = process.argv[2];
        await mkdir(paths.marketplaceRoot, { recursive: true });
        const old = await lstat(paths.marketplaceRoot);
        const pending = await beginCodexRecovery(paths, {
          marketplaceRoot: paths.marketplaceRoot,
          priorNative: ${JSON.stringify(ABSENT_NATIVE)},
          oldDigest: await digestArtifactTree(paths.marketplaceRoot),
          oldIdentity: { dev: old.dev, ino: old.ino },
        });
        await mkdir(pending.stage);
        const stage = await lstat(pending.stage);
        await advanceCodexRecovery(pending, "staging", {
          newDigest: await digestArtifactTree(pending.stage),
          stageIdentity: { dev: stage.dev, ino: stage.ino },
        });
        await advanceCodexRecovery(pending, "publishing");
        await rename(paths.marketplaceRoot, pending.backup);
        if (finalPhase === "published") {
          await rename(pending.stage, paths.marketplaceRoot);
          await advanceCodexRecovery(pending, "published", {
            publishedIdentity: { dev: stage.dev, ino: stage.ino },
          });
        }
        process.kill(process.pid, "SIGKILL");
      `;
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", script, JSON.stringify(paths), phase],
        { stdio: "ignore" },
      );
      const [code, signal] = (await once(child, "exit")) as [
        number | null,
        NodeJS.Signals | null,
      ];
      assert.equal(code, null);
      assert.equal(signal, "SIGKILL");
      assert.equal((await readCodexRecovery(paths))?.phase, phase);
    });
  }
});

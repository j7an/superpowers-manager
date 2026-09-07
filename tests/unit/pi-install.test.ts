import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import {
  successResult,
  failureResult,
  type AdapterContext,
  type AdapterResult,
} from "../../src/adapter-result.ts";
import { beginDirectoryPublication } from "../../src/atomic.ts";
import type { InstallReceipt, PreparedArtifact } from "../../src/harness.ts";
import {
  installPi,
  removePi,
  type PiInstallDependencies,
} from "../../src/pi-install.ts";
import { SUPPORTED_PI_RUNTIME_VERSION } from "../../src/pi-native.ts";
import {
  digestPiTree,
  piReceiptBinding,
  readPiPackageAssessment,
} from "../../src/pi-package.ts";
import { piPaths } from "../../src/pi-paths.ts";
import { readPiSettings } from "../../src/pi-settings.ts";
import { inspectPiOwnership } from "../../src/pi-state.ts";
import { nativeFixture, nativeSelection } from "../lib/pi-package-fixture.ts";

function value<T>(result: AdapterResult<T>): T {
  assert.equal(result.status, 0, JSON.stringify(result));
  if (!result.outcome.ok) assert.fail(JSON.stringify(result));
  return result.outcome.result;
}

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "spw-pi-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { HOME: root, PI_CODING_AGENT_DIR: join(root, "agent") };
  const ctx: AdapterContext = { root, env };
  const paths = piPaths(env, root);
  mkdirSync(paths.agentDir, { recursive: true });
  cpSync(nativeFixture(t), paths.preparedRoot, { recursive: true });
  const prepare = async (
    commit: string,
    text: string,
  ): Promise<PreparedArtifact> => {
    writeFileSync(join(paths.preparedRoot, "extra.txt"), text);
    const identity = {
      schema: 1,
      manager: "superpowers-manager",
      harness: "pi",
      source: nativeSelection().effectiveSource,
      commit,
      digest: await digestPiTree(paths.preparedRoot),
    } as const;
    writeFileSync(
      join(paths.preparedRoot, ".superpowers-manager.json"),
      JSON.stringify({
        ...identity,
        binding: piReceiptBinding(identity),
        compatibility: {
          kind: "supported",
          generation: "pi-native-bootstrap-v1",
          reason: "fixture",
        },
      }),
    );
    const { receipt, compatibility } = await readPiPackageAssessment(
      paths.preparedRoot,
    );
    return {
      root: paths.preparedRoot,
      commit,
      identity: receipt.digest,
      compatibility,
    };
  };
  const artifact = await prepare("1".repeat(40), "original");
  writeFileSync(
    paths.settingsFile,
    JSON.stringify({ packages: ["npm:unrelated"], theme: "light" }),
  );
  const calls: string[][] = [];
  const deps: PiInstallDependencies = {
    beginPublication: async (...args) => {
      calls.push(["publication"]);
      return beginDirectoryPublication(...args);
    },
    readSettings: readPiSettings,
    run: async (args) => {
      calls.push([...args]);
      if (args[0] === "--version")
        return successResult(
          "pi-command",
          { stdout: SUPPORTED_PI_RUNTIME_VERSION },
          [],
        );
      assert.deepEqual(args.slice(2), ["--no-approve"]);
      const settings = JSON.parse(readFileSync(paths.settingsFile, "utf8")) as {
        packages: string[];
        theme: string;
      };
      if (args[0] === "install")
        settings.packages.push(relative(paths.agentDir, args[1]!));
      else if (args[0] === "remove")
        settings.packages = settings.packages.filter(
          (entry) => resolve(paths.agentDir, entry) !== args[1],
        );
      else assert.fail("unexpected native command");
      writeFileSync(paths.settingsFile, JSON.stringify(settings));
      return successResult("pi-command", { stdout: "" }, []);
    },
  };
  return { root, ctx, paths, artifact, prepare, deps, calls };
}

function transaction(result: AdapterResult<InstallReceipt>) {
  const receipt = value(result);
  assert.ok(receipt.transaction);
  return receipt.transaction;
}

void test("Pi first installation retains a recovery journal until verified settlement", async (t) => {
  const f = await fixture(t);
  const result = await installPi(f.artifact, f.ctx, f.deps);
  assert.equal(
    result.outcome.ok,
    true,
    JSON.stringify({ result, calls: f.calls }),
  );
  const tx = transaction(result);
  assert.equal(
    readFileSync(join(f.paths.installedRoot, "extra.txt"), "utf8"),
    "original",
  );
  assert.equal(existsSync(f.paths.recoveryRoot), true);
  assert.equal((await readPiSettings(f.paths.settingsFile)).packages.length, 2);
  assert.equal(value(await tx.finalize()), null);
  assert.equal(existsSync(f.paths.recoveryRoot), false);
  assert.equal((await tx.rollback()).outcome.ok, false);
  assert.equal(existsSync(f.paths.installedRoot), true);
});

void test("Pi update retains the old snapshot and rollback restores only its publication", async (t) => {
  const f = await fixture(t);
  value(
    await transaction(await installPi(f.artifact, f.ctx, f.deps)).finalize(),
  );
  const next = await f.prepare("2".repeat(40), "updated");
  const tx = transaction(await installPi(next, f.ctx, f.deps));
  const backups = readdirSync(f.paths.managerRoot).filter((name) =>
    name.startsWith(".installed.bak."),
  );
  assert.equal(backups.length, 1);
  assert.equal(
    readFileSync(join(f.paths.managerRoot, backups[0]!, "extra.txt"), "utf8"),
    "original",
  );
  writeFileSync(
    f.paths.settingsFile,
    JSON.stringify({
      packages: ["superpowers-manager/installed", "npm:added"],
      theme: "changed",
    }),
  );
  value(await tx.rollback());
  assert.equal(
    readFileSync(join(f.paths.installedRoot, "extra.txt"), "utf8"),
    "original",
  );
  assert.equal(
    JSON.parse(readFileSync(f.paths.settingsFile, "utf8")).theme,
    "changed",
  );
  assert.equal(f.calls.filter((args) => args[0] === "install").length, 1);
});

void test("Pi update finalization retires only its backup and an old receipt cannot settle it", async (t) => {
  const f = await fixture(t);
  const old = transaction(await installPi(f.artifact, f.ctx, f.deps));
  value(await old.finalize());
  mkdirSync(join(f.paths.managerRoot, ".installed.bak.unrelated"));
  writeFileSync(
    join(f.paths.managerRoot, ".installed.bak.unrelated", "keep"),
    "foreign",
  );
  const tx = transaction(
    await installPi(await f.prepare("2".repeat(40), "updated"), f.ctx, f.deps),
  );
  const journal = readFileSync(
    join(f.paths.recoveryRoot, "transaction.json"),
    "utf8",
  );
  assert.equal((await old.rollback()).outcome.ok, false);
  assert.equal(
    readFileSync(join(f.paths.recoveryRoot, "transaction.json"), "utf8"),
    journal,
  );
  value(await tx.finalize());
  assert.equal(
    readFileSync(join(f.paths.installedRoot, "extra.txt"), "utf8"),
    "updated",
  );
  assert.deepEqual(
    readdirSync(f.paths.managerRoot).filter((name) =>
      name.startsWith(".installed.bak."),
    ),
    [".installed.bak.unrelated"],
  );
  assert.equal(
    readFileSync(
      join(f.paths.managerRoot, ".installed.bak.unrelated", "keep"),
      "utf8",
    ),
    "foreign",
  );
  assert.equal(existsSync(f.paths.recoveryRoot), false);
});

void test("Pi native failure after registration uses read-back and restores first installation", async (t) => {
  const f = await fixture(t);
  const result = await installPi(f.artifact, f.ctx, {
    ...f.deps,
    run: async (...args) => {
      const result = await f.deps.run(...args);
      return args[0][0] === "install"
        ? failureResult("pi-command", "failed", "Pi command failed", [], [])
        : result;
    },
  });
  assert.equal(result.outcome.ok, false);
  assert.equal(existsSync(f.paths.installedRoot), false);
  assert.deepEqual(
    (await readPiSettings(f.paths.settingsFile)).packages.map(
      (entry) => entry.source,
    ),
    ["npm:unrelated"],
  );
  assert.equal(existsSync(f.paths.recoveryRoot), false);
  assert.equal(f.calls.filter((args) => args[0] === "install").length, 1);
  assert.equal(f.calls.filter((args) => args[0] === "remove").length, 1);
});

void test("Pi activation rejects altered candidate, foreign snapshot, and unsupported runtime", async (t) => {
  for (const mode of ["candidate", "foreign", "runtime"] as const)
    await t.test(mode, async (t) => {
      const f = await fixture(t);
      if (mode === "candidate")
        writeFileSync(join(f.paths.preparedRoot, "extra.txt"), "tampered");
      if (mode === "foreign") {
        mkdirSync(f.paths.installedRoot);
        writeFileSync(join(f.paths.installedRoot, "foreign"), "keep");
      }
      const result = await installPi(
        f.artifact,
        f.ctx,
        mode === "runtime"
          ? {
              ...f.deps,
              run: async () =>
                successResult("pi-command", { stdout: "invalid" }, []),
            }
          : f.deps,
      );
      assert.equal(result.outcome.ok, false);
      assert.equal(
        f.calls.some((args) => args[0] === "install"),
        false,
      );
      assert.equal(existsSync(f.paths.recoveryRoot), false);
      if (mode === "foreign")
        assert.equal(
          readFileSync(join(f.paths.installedRoot, "foreign"), "utf8"),
          "keep",
        );
    });
});

void test("Pi settlement refuses changed published bytes, backup bytes, and journal replay", async (t) => {
  for (const mode of ["live", "backup", "journal"] as const)
    await t.test(mode, async (t) => {
      const f = await fixture(t);
      value(
        await transaction(
          await installPi(f.artifact, f.ctx, f.deps),
        ).finalize(),
      );
      const tx = transaction(
        await installPi(
          await f.prepare("2".repeat(40), "updated"),
          f.ctx,
          f.deps,
        ),
      );
      const backup = readdirSync(f.paths.managerRoot).find((name) =>
        name.startsWith(".installed.bak."),
      )!;
      if (mode === "live")
        writeFileSync(join(f.paths.installedRoot, "extra.txt"), "foreign");
      if (mode === "backup")
        writeFileSync(
          join(f.paths.managerRoot, backup, "extra.txt"),
          "foreign",
        );
      if (mode === "journal") {
        const journal = join(f.paths.recoveryRoot, "transaction.json");
        const data = JSON.parse(readFileSync(journal, "utf8"));
        data.token = "0".repeat(32);
        writeFileSync(journal, JSON.stringify(data));
      }
      assert.equal((await tx.finalize()).outcome.ok, false);
      assert.equal(existsSync(join(f.paths.managerRoot, backup)), true);
      assert.equal(existsSync(f.paths.recoveryRoot), true);
      assert.equal(
        (await installPi(f.artifact, f.ctx, f.deps)).outcome.ok,
        false,
      );
    });
});

void test("Pi uninstall verifies native deregistration before deleting owned bytes", async (t) => {
  const f = await fixture(t);
  value(
    await transaction(await installPi(f.artifact, f.ctx, f.deps)).finalize(),
  );
  const input = value(await inspectPiOwnership(f.ctx)).removalInput;
  assert.equal(input.registrationIdentity, "superpowers-manager/installed");
  const failed = await removePi(input, f.ctx, {
    ...f.deps,
    run: async (args, paths, ctx) =>
      args[0] === "remove"
        ? failureResult("pi-command", "failed", "Pi command failed", [], [])
        : f.deps.run(args, paths, ctx),
  });
  assert.equal(failed.outcome.ok, false);
  assert.equal(existsSync(f.paths.installedRoot), true);
  value(await removePi(input, f.ctx, f.deps));
  assert.deepEqual(
    f.calls.find((args) => args[0] === "remove"),
    ["remove", f.paths.installedRoot, "--no-approve"],
  );
  assert.equal(existsSync(f.paths.installedRoot), false);
  assert.equal(existsSync(f.paths.preparedRoot), true);
  assert.deepEqual(
    (await readPiSettings(f.paths.settingsFile)).packages.map(
      (entry) => entry.source,
    ),
    ["npm:unrelated"],
  );
});

void test("Pi stale removal input never authorizes replacement deletion", async (t) => {
  const f = await fixture(t);
  value(
    await transaction(await installPi(f.artifact, f.ctx, f.deps)).finalize(),
  );
  const input = value(await inspectPiOwnership(f.ctx)).removalInput;
  renameSync(f.paths.installedRoot, join(f.paths.managerRoot, "preserved"));
  mkdirSync(f.paths.installedRoot);
  writeFileSync(join(f.paths.installedRoot, "foreign"), "keep");
  assert.equal((await removePi(input, f.ctx, f.deps)).outcome.ok, false);
  assert.equal(
    readFileSync(join(f.paths.installedRoot, "foreign"), "utf8"),
    "keep",
  );
});

void test("Pi rechecks ownership after native preflight and refuses a new unmanaged resource", async (t) => {
  const f = await fixture(t);
  const result = await installPi(f.artifact, f.ctx, {
    ...f.deps,
    run: async (...args) => {
      const result = await f.deps.run(...args);
      if (args[0][0] === "--version") {
        mkdirSync(join(f.paths.agentDir, "extensions"));
        writeFileSync(
          join(f.paths.agentDir, "extensions", "superpowers.ts"),
          "foreign",
        );
      }
      return result;
    },
  });
  assert.equal(result.outcome.ok, false);
  assert.equal(existsSync(f.paths.installedRoot), false);
  assert.equal(
    readFileSync(
      join(f.paths.agentDir, "extensions", "superpowers.ts"),
      "utf8",
    ),
    "foreign",
  );
});

void test("Pi publication failures restore only a verifiable previous state", async (t) => {
  for (const mode of ["before", "activation", "restoration"] as const)
    await t.test(mode, async (t) => {
      const f = await fixture(t);
      value(
        await transaction(
          await installPi(f.artifact, f.ctx, f.deps),
        ).finalize(),
      );
      const next = await f.prepare("2".repeat(40), "updated");
      const result = await installPi(next, f.ctx, {
        ...f.deps,
        beginPublication: async (candidate, live, options) => {
          if (mode === "before")
            throw new Error("injected publication failure");
          return beginDirectoryPublication(candidate, live, {
            ...options,
            hooks: {
              rename: async (from, to) => {
                if (
                  from === candidate ||
                  (mode === "restoration" && to === live)
                )
                  throw new Error("injected rename failure");
                renameSync(from, to);
              },
            },
          });
        },
      });
      assert.equal(result.outcome.ok, false);
      if (mode === "restoration") {
        assert.equal(existsSync(f.paths.recoveryRoot), true);
        const backup = readdirSync(f.paths.managerRoot).find((name) =>
          name.startsWith(".installed.bak."),
        )!;
        assert.equal(
          readFileSync(join(f.paths.managerRoot, backup, "extra.txt"), "utf8"),
          "original",
        );
      } else {
        assert.equal(
          readFileSync(join(f.paths.installedRoot, "extra.txt"), "utf8"),
          "original",
        );
        assert.equal(existsSync(f.paths.recoveryRoot), false);
      }
    });
});

void test("Pi failed journal phase or unreadable native read-back retains recovery evidence", async (t) => {
  for (const mode of ["journal", "settings"] as const)
    await t.test(mode, async (t) => {
      const f = await fixture(t);
      const deps: PiInstallDependencies = {
        ...f.deps,
        beginPublication: async (...args) => {
          const publication = await f.deps.beginPublication(...args);
          if (mode === "journal")
            writeFileSync(
              join(f.paths.recoveryRoot, "transaction.json"),
              "changed",
            );
          return publication;
        },
        run: async (...args) => {
          const result = await f.deps.run(...args);
          if (mode === "settings" && args[0][0] === "install")
            writeFileSync(f.paths.settingsFile, "malformed");
          return result;
        },
      };
      const result = await installPi(f.artifact, f.ctx, deps);
      assert.equal(result.outcome.ok, false);
      assert.equal(existsSync(f.paths.installedRoot), true);
      assert.equal(existsSync(f.paths.recoveryRoot), true);
      const priorFiles = readdirSync(f.paths.managerRoot);
      const retry = await installPi(f.artifact, f.ctx, f.deps);
      assert.equal(retry.outcome.ok && "unexpected", false);
      if (!retry.outcome.ok)
        assert.equal(retry.outcome.error.code, "recovery-required");
      assert.deepEqual(readdirSync(f.paths.managerRoot), priorFiles);
    });
});

void test("Pi native success without registration never becomes a receipt", async (t) => {
  const f = await fixture(t);
  const result = await installPi(f.artifact, f.ctx, {
    ...f.deps,
    run: async (args, paths, ctx) =>
      args[0] === "install"
        ? successResult("pi-command", { stdout: "done" }, [])
        : f.deps.run(args, paths, ctx),
  });
  assert.equal(result.outcome.ok, false);
  assert.equal(existsSync(f.paths.installedRoot), false);
  assert.equal(existsSync(f.paths.recoveryRoot), false);
});

void test("Pi failed settlement preserves the journal and refuses another token", async (t) => {
  for (const mode of ["finalize", "rollback"] as const)
    await t.test(mode, async (t) => {
      const f = await fixture(t);
      value(
        await transaction(
          await installPi(f.artifact, f.ctx, f.deps),
        ).finalize(),
      );
      const next = await f.prepare("2".repeat(40), "updated");
      const tx = transaction(
        await installPi(next, f.ctx, {
          ...f.deps,
          beginPublication: async (...args) => {
            const publication = await beginDirectoryPublication(...args);
            return {
              ...publication,
              [mode]: async () => {
                throw new Error("injected settlement failure");
              },
            };
          },
        }),
      );
      const settlement = await tx[mode]();
      assert.equal(settlement.outcome.ok, false);
      if (mode === "finalize" && !settlement.outcome.ok)
        assert.match(
          settlement.outcome.error.message,
          /activation was verified.*cleanup failed/,
        );
      assert.equal(
        readFileSync(join(f.paths.installedRoot, "extra.txt"), "utf8"),
        "updated",
      );
      assert.equal(
        readdirSync(f.paths.managerRoot).filter((name) =>
          name.startsWith(".installed.bak."),
        ).length,
        1,
      );
      const journal = readFileSync(
        join(f.paths.recoveryRoot, "transaction.json"),
        "utf8",
      );
      assert.equal((await tx[mode]()).outcome.ok, false);
      assert.equal((await installPi(next, f.ctx, f.deps)).outcome.ok, false);
      assert.equal(
        readFileSync(join(f.paths.recoveryRoot, "transaction.json"), "utf8"),
        journal,
      );
    });
});

void test("Pi first-install rollback preserves a registration whose filters changed", async (t) => {
  const f = await fixture(t);
  const tx = transaction(await installPi(f.artifact, f.ctx, f.deps));
  writeFileSync(
    f.paths.settingsFile,
    JSON.stringify({
      packages: [{ source: f.paths.installedRoot, skills: [] }],
    }),
  );
  assert.equal((await tx.rollback()).outcome.ok, false);
  assert.equal(existsSync(f.paths.installedRoot), true);
  assert.equal(existsSync(f.paths.recoveryRoot), true);
});

void test("Pi rollback reads settings after a throwing native removal", async (t) => {
  const f = await fixture(t);
  const tx = transaction(
    await installPi(f.artifact, f.ctx, {
      ...f.deps,
      run: async (...args) => {
        const result = await f.deps.run(...args);
        if (args[0][0] === "remove")
          throw new Error("native removal interrupted after settings write");
        return result;
      },
    }),
  );
  value(await tx.rollback());
  assert.equal(existsSync(f.paths.installedRoot), false);
  assert.equal(existsSync(f.paths.recoveryRoot), false);
});

void test("Pi uninstall reports deregistration after a throwing native removal", async (t) => {
  const f = await fixture(t);
  value(
    await transaction(await installPi(f.artifact, f.ctx, f.deps)).finalize(),
  );
  const input = value(await inspectPiOwnership(f.ctx)).removalInput;
  const result = await removePi(input, f.ctx, {
    ...f.deps,
    run: async (...args) => {
      const result = await f.deps.run(...args);
      if (args[0][0] === "remove")
        throw new Error("native removal interrupted after settings write");
      return result;
    },
  });
  assert.equal(result.outcome.ok, false);
  if (!result.outcome.ok)
    assert.match(result.outcome.error.message, /registration was removed/);
  assert.equal(existsSync(f.paths.installedRoot), true);
  assert.equal(existsSync(f.paths.recoveryRoot), true);
});

void test("Pi uninstall distinguishes deregistration from unverifiable snapshot cleanup", async (t) => {
  const f = await fixture(t);
  value(
    await transaction(await installPi(f.artifact, f.ctx, f.deps)).finalize(),
  );
  const input = value(await inspectPiOwnership(f.ctx)).removalInput;
  const result = await removePi(input, f.ctx, {
    ...f.deps,
    run: async (...args) => {
      const result = await f.deps.run(...args);
      if (args[0][0] === "remove")
        writeFileSync(join(f.paths.installedRoot, "extra.txt"), "foreign");
      return result;
    },
  });
  assert.equal(result.outcome.ok, false);
  if (!result.outcome.ok)
    assert.match(
      result.outcome.error.message,
      /registration was removed.*cleanup failed/,
    );
  assert.equal(
    readFileSync(join(f.paths.installedRoot, "extra.txt"), "utf8"),
    "foreign",
  );
  assert.deepEqual(
    (await readPiSettings(f.paths.settingsFile)).packages.map(
      (entry) => entry.source,
    ),
    ["npm:unrelated"],
  );
  assert.equal(existsSync(f.paths.recoveryRoot), true);
});

void test("Pi interruption leaves a pre-publication journal that identifies the retained backup", async (t) => {
  const f = await fixture(t);
  value(
    await transaction(await installPi(f.artifact, f.ctx, f.deps)).finalize(),
  );
  const next = await f.prepare("2".repeat(40), "updated");
  const script = `
    import { installPi } from './src/pi-install.ts';
    import { beginDirectoryPublication } from './src/atomic.ts';
    import { readPiSettings } from './src/pi-settings.ts';
    import { successResult } from './src/adapter-result.ts';
    import { SUPPORTED_PI_RUNTIME_VERSION } from './src/pi-native.ts';
    const artifact = JSON.parse(process.env.TEST_ARTIFACT);
    const ctx = { root: process.env.TEST_ROOT, env: { HOME: process.env.TEST_ROOT, PI_CODING_AGENT_DIR: process.env.TEST_AGENT } };
    await installPi(artifact, ctx, {
      readSettings: readPiSettings,
      run: async (args) => { if(args[0] !== '--version') throw Error('unexpected native command'); return successResult('pi-command', {stdout: SUPPORTED_PI_RUNTIME_VERSION}, []); },
      beginPublication: async (...args) => {
        await beginDirectoryPublication(...args);
        process.send('phase-ready');
        await new Promise(() => {});
        throw Error('unreachable');
      },
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      TEST_ROOT: f.root,
      TEST_AGENT: f.paths.agentDir,
      TEST_ARTIFACT: JSON.stringify(next),
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  t.after(() => child.kill("SIGKILL"));
  let stderr = "";
  child.stderr!.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`child did not reach publication: ${stderr}`)),
      10000,
    );
    child.once("message", (message) => {
      clearTimeout(timer);
      assert.equal(message, "phase-ready");
      resolve();
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`child exited before publication: ${stderr}`));
    });
  });
  const closed = once(child, "close");
  child.kill("SIGKILL");
  await closed;
  const journal = JSON.parse(
    readFileSync(join(f.paths.recoveryRoot, "transaction.json"), "utf8"),
  );
  assert.equal(journal.phase, "publishing");
  assert.match(journal.token, /^[a-f0-9]{32}$/);
  assert.equal(
    readFileSync(
      join(f.paths.managerRoot, `.installed.bak.${journal.token}`, "extra.txt"),
      "utf8",
    ),
    "original",
  );
  assert.equal(
    readFileSync(join(f.paths.installedRoot, "extra.txt"), "utf8"),
    "updated",
  );
  const before = readdirSync(f.paths.managerRoot);
  const result = await installPi(next, f.ctx, f.deps);
  assert.equal(result.outcome.ok, false);
  if (!result.outcome.ok)
    assert.equal(result.outcome.error.code, "recovery-required");
  assert.deepEqual(readdirSync(f.paths.managerRoot), before);
});

void test("Pi mutations preserve unexpected recovery material before claiming a journal", async (t) => {
  const f = await fixture(t);
  writeFileSync(f.paths.recoveryRoot, "foreign recovery material");
  for (const result of [
    await installPi(f.artifact, f.ctx, f.deps),
    await removePi(
      {
        installedRoot: f.paths.installedRoot,
        receiptDigest: null,
        registrationIdentity: null,
      },
      f.ctx,
      f.deps,
    ),
  ]) {
    assert.equal(result.outcome.ok, false);
    if (!result.outcome.ok)
      assert.equal(result.outcome.error.code, "recovery-required");
  }
  assert.equal(
    readFileSync(f.paths.recoveryRoot, "utf8"),
    "foreign recovery material",
  );
  assert.equal(f.calls.length, 0);
});

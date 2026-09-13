import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm as removePath } from "node:fs/promises";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  failureResult,
  successResult,
  type AdapterResult,
} from "../../../../src/adapter-result.ts";
import { beginDirectoryPublication } from "../../../../src/atomic.ts";
import type {
  InstallReceipt,
  PreparedArtifact,
} from "../../../../src/harness.ts";
import {
  installOpenCode,
  removeOpenCode,
  type OpenCodeInstallDependencies,
} from "../../../../src/harnesses/opencode/install.ts";
import { readOpenCodeConfig } from "../../../../src/harnesses/opencode/config.ts";
import {
  readOpenCodePackageAssessment,
  readOpenCodeReceipt,
} from "../../../../src/harnesses/opencode/package.ts";
import { inspectOpenCodeOwnership } from "../../../../src/harnesses/opencode/state.ts";
import {
  openCodeSandbox,
  openCodeSelection,
  writeOpenCodeArtifact,
} from "../../../lib/harnesses/opencode/package-fixture.ts";

function value<T>(result: AdapterResult<T>): T {
  assert.equal(result.status, 0);
  if (!result.outcome.ok) assert.fail(result.outcome.error.message);
  return result.outcome.result;
}

function transaction(result: AdapterResult<InstallReceipt>) {
  const receipt = value(result);
  assert.ok(receipt.transaction);
  return receipt.transaction;
}

async function fixture(t: TestContext) {
  const state = openCodeSandbox(t);
  mkdirSync(state.paths.configRoot, { recursive: true });
  const configFile = join(state.paths.configRoot, "opencode.json");
  writeFileSync(
    configFile,
    JSON.stringify({ plugin: ["npm:unrelated"], theme: "light" }),
  );
  const selection = openCodeSelection();
  const digest = await writeOpenCodeArtifact(
    t,
    state.paths.preparedRoot,
    selection,
  );
  const artifact: PreparedArtifact = {
    root: state.paths.preparedRoot,
    commit: selection.desiredCommit,
    identity: digest,
    compatibility: {
      kind: "supported",
      generation: "opencode-native-bootstrap-v1",
      reason: "fixture",
    },
  };
  const calls: string[][] = [];
  const canonicalRoot = join(
    realpathSync(state.root),
    relative(state.root, state.paths.installedRoot),
  );
  const deps: OpenCodeInstallDependencies = {
    beginPublication: async (...args) => {
      calls.push(["publication"]);
      return beginDirectoryPublication(...args);
    },
    run: async (args) => {
      calls.push([...args]);
      if (args[0] === "--version")
        return successResult("opencode-command", { stdout: "99.2.3\n" }, []);
      assert.deepEqual(args, ["plugin", canonicalRoot, "--global"]);
      const config = JSON.parse(readFileSync(configFile, "utf8")) as {
        plugin: string[];
        theme: string;
      };
      config.plugin.push(args[1]!);
      writeFileSync(configFile, JSON.stringify(config));
      return successResult("opencode-command", { stdout: "" }, []);
    },
  };
  return {
    ...state,
    selection,
    artifact,
    configFile,
    calls,
    deps,
    canonicalRoot,
  };
}

void test("OpenCode first install journals publication until verified finalization", async (t) => {
  const f = await fixture(t);
  const result = await installOpenCode(f.artifact, f.ctx, f.deps);
  const tx = transaction(result);
  assert.equal(existsSync(f.paths.installedRoot), true);
  assert.equal(existsSync(f.paths.recoveryRoot), true);
  assert.deepEqual(f.calls, [
    ["--version"],
    ["publication"],
    ["plugin", f.canonicalRoot, "--global"],
  ]);
  assert.equal(value(await tx.finalize()), null);
  assert.equal(existsSync(f.paths.recoveryRoot), false);
  assert.equal((await tx.rollback()).outcome.ok, false);
});

void test("OpenCode stable registration updates by snapshot swap and can roll back", async (t) => {
  const f = await fixture(t);
  value(
    await transaction(
      await installOpenCode(f.artifact, f.ctx, f.deps),
    ).finalize(),
  );
  rmSync(f.paths.preparedRoot, { recursive: true });
  const nextSelection = openCodeSelection("2".repeat(40));
  const nextDigest = await writeOpenCodeArtifact(
    t,
    f.paths.preparedRoot,
    nextSelection,
  );
  const next = {
    ...f.artifact,
    commit: nextSelection.desiredCommit,
    identity: nextDigest,
  };
  const tx = transaction(await installOpenCode(next, f.ctx, f.deps));
  assert.equal(
    (await readOpenCodeReceipt(f.paths.installedRoot)).commit,
    "2".repeat(40),
  );
  const config = JSON.parse(readFileSync(f.configFile, "utf8")) as {
    plugin: string[];
    theme: string;
  };
  config.theme = "user-edit";
  config.plugin.push("npm:added");
  writeFileSync(f.configFile, JSON.stringify(config));
  value(await tx.rollback());
  assert.equal(
    (await readOpenCodeReceipt(f.paths.installedRoot)).commit,
    "1".repeat(40),
  );
  assert.equal(
    (JSON.parse(readFileSync(f.configFile, "utf8")) as { theme: string }).theme,
    "user-edit",
  );
  assert.equal(f.calls.filter((args) => args[0] === "plugin").length, 1);
});

void test("OpenCode rollback removes only its newly created current entry", async (t) => {
  const f = await fixture(t);
  const tx = transaction(await installOpenCode(f.artifact, f.ctx, f.deps));
  const config = JSON.parse(readFileSync(f.configFile, "utf8")) as {
    plugin: string[];
    theme: string;
  };
  config.theme = "edited-after-install";
  config.plugin.push("npm:added");
  writeFileSync(f.configFile, JSON.stringify(config));
  value(await tx.rollback());
  const restored = JSON.parse(readFileSync(f.configFile, "utf8")) as {
    plugin: string[];
    theme: string;
  };
  assert.deepEqual(restored.plugin, ["npm:unrelated", "npm:added"]);
  assert.equal(restored.theme, "edited-after-install");
  assert.equal(existsSync(f.paths.installedRoot), false);
  assert.equal(existsSync(f.paths.recoveryRoot), false);
  assert.equal((await tx.finalize()).outcome.ok, false);
});

void test("OpenCode settlement refuses a changed journal without deleting recovery", async (t) => {
  const f = await fixture(t);
  const tx = transaction(await installOpenCode(f.artifact, f.ctx, f.deps));
  const journal = join(f.paths.recoveryRoot, "transaction.json");
  writeFileSync(journal, '{"schema":1,"changed":true}\n');
  assert.equal((await tx.finalize()).outcome.ok, false);
  assert.equal(existsSync(journal), true);
  assert.equal(existsSync(f.paths.installedRoot), true);
  assert.equal((await tx.rollback()).outcome.ok, false);
});

void test("OpenCode observes native side effects before interpreting command status", async (t) => {
  for (const mutation of [
    "registered-failure",
    "no-registration",
    "wrong-origin",
  ] as const)
    await t.test(mutation, async (t) => {
      const f = await fixture(t);
      const result = await installOpenCode(f.artifact, f.ctx, {
        ...f.deps,
        run: async (args, paths, ctx) => {
          if (args[0] === "--version") return f.deps.run(args, paths, ctx);
          if (mutation === "registered-failure") {
            await f.deps.run(args, paths, ctx);
          } else if (mutation === "wrong-origin") {
            const explicit = join(f.root, "explicit.json");
            writeFileSync(
              explicit,
              JSON.stringify({ plugin: [paths.installedRoot] }),
            );
            f.ctx.env!.OPENCODE_CONFIG = explicit;
          }
          return mutation === "registered-failure"
            ? failureResult(
                "opencode-command",
                "failed",
                "native failed",
                [],
                [],
              )
            : successResult("opencode-command", { stdout: "" }, []);
        },
      });
      assert.equal(result.outcome.ok, false);
      if (mutation !== "wrong-origin") {
        assert.equal(existsSync(f.paths.installedRoot), false);
        assert.equal(existsSync(f.paths.recoveryRoot), false);
      } else {
        assert.equal(existsSync(f.paths.recoveryRoot), true);
      }
    });
});

void test("OpenCode rejects stage tampering and retains ambiguous prior-state recovery", async (t) => {
  for (const mutation of ["stage", "prior"] as const)
    await t.test(mutation, async (t) => {
      const f = await fixture(t);
      const result = await installOpenCode(f.artifact, f.ctx, {
        ...f.deps,
        beginPublication: async (candidate, live, options) => {
          if (mutation === "stage")
            writeFileSync(join(candidate, "package.json"), "{}\n");
          else {
            mkdirSync(live, { recursive: true });
            writeFileSync(join(live, "foreign"), "changed");
          }
          return beginDirectoryPublication(candidate, live, options);
        },
      });
      assert.equal(result.outcome.ok, false);
      assert.equal(existsSync(f.paths.recoveryRoot), true);
    });
});

void test("OpenCode removal revalidates input and removes only a proven owned registration", async (t) => {
  const f = await fixture(t);
  value(
    await transaction(
      await installOpenCode(f.artifact, f.ctx, f.deps),
    ).finalize(),
  );
  const ownership = value(await inspectOpenCodeOwnership(f.ctx));
  const changed = JSON.parse(readFileSync(f.configFile, "utf8")) as {
    plugin: string[];
    theme: string;
  };
  changed.plugin.unshift("npm:new-before-remove");
  writeFileSync(f.configFile, JSON.stringify(changed));
  assert.equal(
    (await removeOpenCode(ownership.removalInput, f.ctx, f.deps)).outcome.ok,
    false,
  );
  assert.equal(existsSync(f.paths.installedRoot), true);

  const fresh = value(await inspectOpenCodeOwnership(f.ctx));
  value(await removeOpenCode(fresh.removalInput, f.ctx, f.deps));
  const after = JSON.parse(readFileSync(f.configFile, "utf8")) as {
    plugin: string[];
    theme: string;
  };
  assert.deepEqual(after.plugin, ["npm:new-before-remove", "npm:unrelated"]);
  assert.equal(after.theme, "light");
  assert.equal(existsSync(f.paths.installedRoot), false);
});

void test("OpenCode removal retains recovery when another origin can activate the snapshot", async (t) => {
  const f = await fixture(t);
  value(
    await transaction(
      await installOpenCode(f.artifact, f.ctx, f.deps),
    ).finalize(),
  );
  const ownership = value(await inspectOpenCodeOwnership(f.ctx));
  const explicit = join(f.root, "explicit.json");
  writeFileSync(explicit, JSON.stringify({ plugin: [f.paths.installedRoot] }));
  f.ctx.env!.OPENCODE_CONFIG = explicit;
  const result = await removeOpenCode(ownership.removalInput, f.ctx, f.deps);
  assert.equal(result.outcome.ok, false);
  assert.equal(existsSync(f.paths.installedRoot), true);
  assert.equal(existsSync(f.paths.recoveryRoot), true);
  assert.deepEqual(
    (JSON.parse(readFileSync(f.configFile, "utf8")) as { plugin: string[] })
      .plugin,
    ["npm:unrelated"],
  );
});

void test("OpenCode removal does not use registration certainty as proof against an owned skill alias", async (t) => {
  const f = await fixture(t);
  value(
    await transaction(
      await installOpenCode(f.artifact, f.ctx, f.deps),
    ).finalize(),
  );
  const config = JSON.parse(readFileSync(f.configFile, "utf8")) as {
    plugin: string[];
    theme: string;
    skills?: { paths: string[] };
  };
  config.skills = { paths: [join(f.paths.installedRoot, "skills")] };
  writeFileSync(f.configFile, JSON.stringify(config));
  const ownership = value(await inspectOpenCodeOwnership(f.ctx));
  const result = await removeOpenCode(ownership.removalInput, f.ctx, f.deps);
  assert.equal(result.outcome.ok, false);
  assert.equal(existsSync(f.paths.installedRoot), true);
  assert.equal(existsSync(f.paths.recoveryRoot), true);
});

void test("OpenCode removal retains a snapshot while skill activation is unresolved", async (t) => {
  const f = await fixture(t);
  value(
    await transaction(
      await installOpenCode(f.artifact, f.ctx, f.deps),
    ).finalize(),
  );
  const config = JSON.parse(readFileSync(f.configFile, "utf8")) as {
    plugin: string[];
    theme: string;
    skills?: { urls: string[] };
  };
  config.skills = { urls: ["https://example.test/unknown-skill"] };
  writeFileSync(f.configFile, JSON.stringify(config));
  const ownership = value(await inspectOpenCodeOwnership(f.ctx));
  const result = await removeOpenCode(ownership.removalInput, f.ctx, f.deps);
  assert.equal(result.outcome.ok, false);
  assert.equal(existsSync(f.paths.installedRoot), true);
  assert.equal(existsSync(f.paths.recoveryRoot), true);
});

void test("OpenCode removal refuses retained recovery and registration without a snapshot", async (t) => {
  await t.test("retained recovery", async (t) => {
    const f = await fixture(t);
    value(
      await transaction(
        await installOpenCode(f.artifact, f.ctx, f.deps),
      ).finalize(),
    );
    const ownership = value(await inspectOpenCodeOwnership(f.ctx));
    mkdirSync(f.paths.recoveryRoot);
    const result = await removeOpenCode(ownership.removalInput, f.ctx, f.deps);
    assert.equal(result.outcome.ok, false);
    assert.equal(existsSync(f.paths.installedRoot), true);
  });

  await t.test("registration without snapshot", async (t) => {
    const f = await fixture(t);
    writeFileSync(
      f.configFile,
      JSON.stringify({ plugin: [f.paths.installedRoot], theme: "light" }),
    );
    const result = await removeOpenCode(
      {
        installedRoot: f.paths.installedRoot,
        registration: null,
        receiptDigest: null,
      },
      f.ctx,
      f.deps,
    );
    assert.equal(result.outcome.ok, false);
    assert.equal(existsSync(f.paths.installedRoot), false);
    assert.equal(existsSync(f.paths.recoveryRoot), false);
  });
});

void test("OpenCode removal no-op and cleanup failure are explicit", async (t) => {
  await t.test("both absent", async (t) => {
    const f = await fixture(t);
    rmSync(f.paths.preparedRoot, { recursive: true });
    const ownership = value(await inspectOpenCodeOwnership(f.ctx));
    value(await removeOpenCode(ownership.removalInput, f.ctx, f.deps));
    assert.equal(existsSync(f.paths.recoveryRoot), false);
  });

  await t.test("cleanup failure", async (t) => {
    const f = await fixture(t);
    value(
      await transaction(
        await installOpenCode(f.artifact, f.ctx, f.deps),
      ).finalize(),
    );
    const ownership = value(await inspectOpenCodeOwnership(f.ctx));
    const observer = spawn(
      process.execPath,
      [
        "-e",
        "const fs=require('node:fs');const [file,installed,manager]=process.argv.slice(1);const deadline=Date.now()+5000;process.stdout.write('ready\\n');function poll(){try{const value=JSON.parse(fs.readFileSync(file,'utf8'));if(!value.plugin.includes(installed)){fs.chmodSync(manager,0o500);process.exit(0)}}catch{}if(Date.now()>=deadline){process.stderr.write('observer deadline exceeded\\n');process.exit(2)}setTimeout(poll,5)}poll()",
        f.configFile,
        f.canonicalRoot,
        f.paths.managerRoot,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const exited = once(observer, "exit");
    const closed = once(observer, "close");
    let result: Awaited<ReturnType<typeof removeOpenCode>>;
    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        const timer = setTimeout(() => {
          cleanup();
          rejectReady(
            new Error("cleanup observer readiness deadline exceeded"),
          );
        }, 2_000);
        const onData = () => {
          cleanup();
          resolveReady();
        };
        const onExit = (status: number | null) => {
          cleanup();
          rejectReady(
            new Error(`cleanup observer exited before readiness: ${status}`),
          );
        };
        const cleanup = () => {
          clearTimeout(timer);
          observer.stdout!.off("data", onData);
          observer.off("exit", onExit);
        };
        observer.stdout!.once("data", onData);
        observer.once("exit", onExit);
      });
      result = await removeOpenCode(ownership.removalInput, f.ctx, f.deps);
      const [status] = await Promise.race([
        exited,
        delay(7_000, undefined, { ref: false }).then(() => {
          throw new Error("cleanup observer exit deadline exceeded");
        }),
      ]);
      assert.equal(status, 0);
    } finally {
      if (observer.exitCode === null && observer.signalCode === null)
        observer.kill("SIGKILL");
      const closedInTime = await Promise.race([
        closed.then(() => true),
        delay(2_000, false, { ref: false }),
      ]);
      chmodSync(f.paths.managerRoot, 0o700);
      assert.equal(closedInTime, true, "cleanup observer did not close");
    }
    assert.equal(result.outcome.ok, false);
    assert.equal(existsSync(f.paths.installedRoot), true);
    assert.equal(existsSync(f.paths.recoveryRoot), true);
    assert.deepEqual(
      (JSON.parse(readFileSync(f.configFile, "utf8")) as { plugin: string[] })
        .plugin,
      ["npm:unrelated"],
    );
  });
});

void test("OpenCode partial snapshot deletion retains a complete backup and exact tuple entry", async (t) => {
  const f = await fixture(t);
  value(
    await transaction(
      await installOpenCode(f.artifact, f.ctx, f.deps),
    ).finalize(),
  );
  const largeInteger = "9".repeat(360);
  const rawEntry = `[
      "${f.canonicalRoot}",
      {
        // exact tuple recovery evidence
        "limit": ${largeInteger},
        "label": "preserve exactly",
      },
    ]`;
  writeFileSync(
    f.configFile,
    `{
  "plugin": [
    "npm:unrelated",
    ${rawEntry}
  ],
  "theme": "light",
}\n`,
  );
  const ownership = value(await inspectOpenCodeOwnership(f.ctx));
  let injected = false;
  const result = await removeOpenCode(ownership.removalInput, f.ctx, {
    ...f.deps,
    rm: async (path, options) => {
      if (path === f.paths.installedRoot) {
        injected = true;
        await removePath(join(path, "skills"), {
          recursive: true,
          force: true,
        });
        throw new Error("injected original snapshot deletion failure");
      }
      await removePath(path, options);
    },
  });
  assert.equal(injected, true);
  assert.equal(result.outcome.ok, false);
  const backups = readdirSync(f.paths.managerRoot).filter((name) =>
    name.startsWith(".installed.bak."),
  );
  assert.equal(backups.length, 1);
  const backup = join(f.paths.managerRoot, backups[0]!);
  assert.equal(
    (await readOpenCodePackageAssessment(backup)).receipt.digest,
    ownership.removalInput.receiptDigest,
  );
  assert.equal(existsSync(join(f.paths.installedRoot, "skills")), false);
  const journal = JSON.parse(
    readFileSync(join(f.paths.recoveryRoot, "transaction.json"), "utf8"),
  ) as { priorRegistration: { rawEntry: string } };
  assert.equal(journal.priorRegistration.rawEntry, rawEntry);
  assert.deepEqual(
    (await readOpenCodeConfig(f.configFile))?.document.entries.map(
      (entry) => entry.spec,
    ),
    ["npm:unrelated"],
  );
});

void test("OpenCode reports verified removal separately when only backup cleanup remains", async (t) => {
  const f = await fixture(t);
  value(
    await transaction(
      await installOpenCode(f.artifact, f.ctx, f.deps),
    ).finalize(),
  );
  const ownership = value(await inspectOpenCodeOwnership(f.ctx));
  const result = await removeOpenCode(ownership.removalInput, f.ctx, {
    ...f.deps,
    rm: async (path, options) => {
      if (String(path).includes(".installed.bak."))
        throw new Error("injected backup cleanup failure");
      await removePath(path, options);
    },
  });
  assert.equal(result.outcome.ok, false);
  if (!result.outcome.ok) {
    assert.equal(result.outcome.error.code, "cleanup-required");
    assert.match(result.outcome.error.message, /removal was verified/);
  }
  assert.equal(existsSync(f.paths.installedRoot), false);
  assert.equal(existsSync(f.paths.recoveryRoot), true);
  assert.equal(
    readdirSync(f.paths.managerRoot).some((name) =>
      name.startsWith(".installed.bak."),
    ),
    true,
  );
});

void test("OpenCode journals a control-heavy bounded JSONC registration", async (t) => {
  const f = await fixture(t);
  value(
    await transaction(
      await installOpenCode(f.artifact, f.ctx, f.deps),
    ).finalize(),
  );
  const controls = "\u0001".repeat(700_000);
  writeFileSync(
    f.configFile,
    `{"plugin":[["${f.canonicalRoot}",{/*${controls}*/"enabled":true}]]}`,
  );
  const ownership = value(await inspectOpenCodeOwnership(f.ctx));
  const result = await removeOpenCode(ownership.removalInput, f.ctx, f.deps);
  assert.equal(result.outcome.ok, true);
  assert.equal(existsSync(f.paths.installedRoot), false);
  assert.equal(existsSync(f.paths.recoveryRoot), false);
});

void test("OpenCode journal serialization failure creates no recovery directory", async (t) => {
  const f = await fixture(t);
  value(
    await transaction(
      await installOpenCode(f.artifact, f.ctx, f.deps),
    ).finalize(),
  );
  const ownership = value(await inspectOpenCodeOwnership(f.ctx));
  const originalStringify = JSON.stringify;
  Object.defineProperty(JSON, "stringify", {
    configurable: true,
    value: ((value: unknown, ...args: unknown[]) => {
      if (
        value !== null &&
        typeof value === "object" &&
        "phase" in value &&
        "oldArtifact" in value
      )
        throw new Error("injected journal serialization failure");
      return (originalStringify as (...input: unknown[]) => string | undefined)(
        value,
        ...args,
      );
    }) as typeof JSON.stringify,
  });
  let result: Awaited<ReturnType<typeof removeOpenCode>>;
  try {
    result = await removeOpenCode(ownership.removalInput, f.ctx, f.deps);
  } finally {
    Object.defineProperty(JSON, "stringify", {
      configurable: true,
      value: originalStringify,
    });
  }
  assert.equal(result.outcome.ok, false);
  assert.equal(existsSync(f.paths.recoveryRoot), false);
  assert.deepEqual(readdirSync(f.paths.managerRoot).sort(), [
    "installed",
    "prepared",
  ]);
});

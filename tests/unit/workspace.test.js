// @ts-check
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/** @type {typeof import("../../src/workspace.js")} */
const { withWorkspace, workspaceRemovalFailure } = await import(
  new URL("../../dist/workspace.js", import.meta.url).href
);

/** @type {typeof import("../../src/adapter.js")} */
const { runAdapter } = await import(
  new URL("../../dist/adapter.js", import.meta.url).href
);

const PACKAGE_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const FAKE_CODEX = fileURLToPath(
  new URL("helpers/fake-codex.sh", import.meta.url),
);

/** @param {import("node:test").TestContext} t */
async function sandbox(t) {
  const directory = await mkdtemp(join(tmpdir(), "spw-workspace-"));
  t.after(async () => {
    // The failure child chmods its own parent to 0o500 to force a removal
    // failure; without restoring it first, this cleanup would itself fail. If
    // the chmod itself throws (e.g. the directory is already gone), the `rm`
    // below must still run rather than leak the temp tree.
    try {
      chmodSync(directory, 0o700);
    } catch {
      // Best-effort: `rm` below is the real cleanup and tolerates a missing
      // or already-writable directory either way.
    }
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

/**
 * Spawns a workspace-signal helper child, waits for it to announce
 * `expectedPaths` workspace paths over stdout, signals it, and resolves once
 * the child has closed.
 *
 * @param {string} script
 * @param {readonly string[]} args
 * @param {NodeJS.Signals} signal
 * @param {number} expectedPaths
 */
async function spawnSignalChild(script, args, signal, expectedPaths) {
  const child = spawn(process.execPath, [script, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const announcedPaths = await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const paths = stdout.split("\n").filter(Boolean);
      if (paths.length === expectedPaths) resolve(paths);
    });
    child.once("error", reject);
    child.once("exit", (code, childSignal) => {
      reject(new Error(`child exited early: ${code}/${childSignal}`));
    });
  });
  assert.equal(child.kill(signal), true);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, childSignal) => {
      resolve({ code, signal: childSignal });
    });
  });
  return { announcedPaths, result, stdout, stderr };
}

/**
 * @param {string} parent
 * @param {NodeJS.Signals} signal
 */
async function signalChild(parent, signal) {
  return spawnSignalChild(
    "tests/unit/helpers/workspace-signal-child.js",
    [parent],
    signal,
    3,
  );
}

/**
 * @param {string} parent
 */
async function signalFailureChild(parent) {
  return spawnSignalChild(
    "tests/unit/helpers/workspace-signal-failure-child.js",
    [parent],
    "SIGTERM",
    1,
  );
}

void test("FS-CLEANUP-01 withWorkspace returns a value and removes its directory", async (t) => {
  const parent = await sandbox(t);
  /** @type {string | undefined} */
  let observed;
  const result = await withWorkspace(parent, "work-", async (workspace) => {
    observed = workspace;
    await writeFile(join(workspace, "marker"), "ok");
    return 42;
  });
  assert.equal(result, 42);
  if (observed === undefined) throw new Error("workspace was not observed");
  await assert.rejects(stat(observed), { code: "ENOENT" });
});

void test("FS-CLEANUP-01 withWorkspace cleans up after callback failure", async (t) => {
  const parent = await sandbox(t);
  /** @type {string | undefined} */
  let observed;
  const failure = new Error("callback failed");
  await assert.rejects(
    withWorkspace(parent, "work-", async (workspace) => {
      observed = workspace;
      throw failure;
    }),
    (error) => error === failure,
  );
  if (observed === undefined) throw new Error("workspace was not observed");
  await assert.rejects(stat(observed), { code: "ENOENT" });
});

void test("REF-CLEANUP-01 / REF-PIN-CLEANUP-01 signals clean only active workspaces", async (t) => {
  /** @type {NodeJS.Signals[]} */
  const signals = ["SIGHUP", "SIGINT", "SIGTERM"];
  for (const signal of signals) {
    await t.test(signal, async () => {
      const parent = await sandbox(t);
      const sibling = join(parent, "sibling");
      await writeFile(sibling, "keep");
      const { announcedPaths, result } = await signalChild(parent, signal);

      // D4: cleanup is synchronous, then the handler deregisters itself and
      // re-raises, so the process dies BY the signal. `$?` in a POSIX shell is
      // still 128+N; waitpid consumers now see WIFSIGNALED rather than a
      // normal exit numbered 143.
      assert.equal(result.signal, signal);
      assert.equal(result.code, null);
      for (const workspace of announcedPaths) {
        await assert.rejects(stat(workspace), { code: "ENOENT" });
      }
      assert.equal(await readFile(sibling, "utf8"), "keep");
    });
  }
});

void test("a signal-path cleanup failure reports through onCleanupFailure and stderr", async (t) => {
  // Permission checks do not apply to root, so the failure cannot be staged.
  if (process.getuid?.() === 0) {
    t.skip("cleanup cannot be made to fail as root");
    return;
  }
  const parent = await sandbox(t);
  const { announcedPaths, result, stdout, stderr } =
    await signalFailureChild(parent);
  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.code, null);
  const workspace = announcedPaths[0];
  if (workspace === undefined) throw new Error("workspace was not announced");
  // Exact membership, not a RegExp built from the path: `mkdtemp` output can
  // contain characters that are regex metacharacters (e.g. `.`), which would
  // make a pattern built from the path match more than the path.
  assert.ok(stdout.split("\n").includes(`reported:${workspace}`));
  // The caller's reporter (proven above) is not the observable failure path:
  // no result outcome is ever built before the process dies by the signal,
  // so a report that only reached a buffered adapter log would be lost. The
  // signal path also writes the hand-written diagnostic straight to stderr,
  // unconditionally, which is what a real caller can actually see.
  assert.ok(stderr.split("\n").includes(workspaceRemovalFailure(workspace)));
});

void test("withWorkspace preserves the callback error when cleanup fails", async (t) => {
  const parent = await sandbox(t);
  const failure = new Error("callback failed");
  const cleanupFailure = new Error("cleanup failed");
  await assert.rejects(
    withWorkspace(
      parent,
      "work-",
      async () => {
        throw failure;
      },
      {
        cleanup: async () => {
          throw cleanupFailure;
        },
      },
    ),
    (error) => error === failure,
  );
});

void test("withWorkspace can preserve a successful callback result when cleanup fails", async (t) => {
  const parent = await sandbox(t);
  const cleanupFailure = new Error("cleanup failed");
  /** @type {string[]} */
  const reported = [];
  const result = await withWorkspace(parent, "work-", async () => 42, {
    cleanup: async () => {
      throw cleanupFailure;
    },
    onCleanupFailure: (path) => reported.push(path),
  });
  assert.equal(result, 42);
  assert.equal(reported.length, 1);
  assert.ok(reported[0].startsWith(join(parent, "work-")));
});

void test("withWorkspace throws the cleanup failure when no reporter is supplied", async (t) => {
  const parent = await sandbox(t);
  const cleanupFailure = new Error("cleanup failed");
  await assert.rejects(
    withWorkspace(parent, "work-", async () => 42, {
      cleanup: async () => {
        throw cleanupFailure;
      },
    }),
    (error) => error === cleanupFailure,
  );
});

void test("withWorkspace preserves the callback error when a reported cleanup also fails", async (t) => {
  const parent = await sandbox(t);
  const callbackFailure = new Error("callback failed");
  const cleanupFailure = new Error("cleanup failed");
  await assert.rejects(
    withWorkspace(
      parent,
      "work-",
      async () => {
        throw callbackFailure;
      },
      {
        cleanup: async () => {
          throw cleanupFailure;
        },
        onCleanupFailure: () => {},
      },
    ),
    (error) => error === callbackFailure,
  );
});

// The capability tests above prove `onCleanupFailure` works. This one proves
// the adapter wires it: `src/adapter.ts` passes a reporter at every operation
// (five call sites;
// `grep -n "onCleanupFailure: reportOrphanedWorkspace" src/adapter.ts`),
// because a workspace it never wrote to failing to be removed must not discard
// an otherwise successful result — but must not vanish silently either. The
// fake Codex makes the temporary directory's parent read-only while it runs, so
// the adapter's own cleanup really fails; this is the only end-to-end cleanup
// failure in the repo.
void test("an adapter operation keeps its result when workspace cleanup fails", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "spw-adapter-cleanup-"));
  const temporary = join(base, "tmp");
  await mkdir(temporary);
  const log = join(base, "commands.log");
  await writeFile(log, "");
  const originalTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = temporary;
  t.after(async () => {
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
    await chmod(temporary, 0o700);
    await rm(base, { recursive: true, force: true });
  });

  const result = await runAdapter(
    ["uninstall", "--plugin-present", "true", "--marketplace-present", "false"],
    {
      root: PACKAGE_ROOT,
      env: {
        SUPERPOWERS_CODEX: FAKE_CODEX,
        FAKE_CODEX_LOG: log,
        FAKE_CODEX_LOCK_DIR: temporary,
      },
    },
  );

  // Read the orphan first: its path is what the report must name, so knowing it
  // here makes the message an exact equality rather than a pattern. This also
  // remains the guard against a vacuous pass — if the read-only parent had not
  // actually blocked removal there would be nothing left to find.
  const leftover = await readdir(temporary);
  assert.deepStrictEqual(leftover.length, 1, leftover.join(", "));
  assert.match(leftover[0] ?? "", /^superpowers-manager\.adapter-uninstall\./);

  assert.equal(result.outcome.ok, true, JSON.stringify(result.outcome));
  assert.deepStrictEqual(result.outcome.messages, [
    {
      channel: "stdout",
      text: "removed plugin superpowers@superpowers-manager",
    },
    { channel: "stdout", text: "marketplace not registered; skipping" },
    {
      channel: "stderr",
      text: `cannot remove workspace ${join(temporary, leftover[0] ?? "")}`,
    },
  ]);
});

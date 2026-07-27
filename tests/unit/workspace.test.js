// @ts-check
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/** @type {typeof import("../../src/workspace.js")} */
const { withWorkspace } = await import(
  new URL("../../dist/workspace.js", import.meta.url).href
);

/** @param {import("node:test").TestContext} t */
async function sandbox(t) {
  const directory = await mkdtemp(join(tmpdir(), "spw-workspace-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * @param {string} parent
 * @param {NodeJS.Signals} signal
 */
async function signalChild(parent, signal) {
  const child = spawn(
    process.execPath,
    ["tests/unit/helpers/workspace-signal-child.js", parent],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  const announcedPaths = await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const paths = output.split("\n").filter(Boolean);
      if (paths.length === 3) resolve(paths);
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
  return { announcedPaths, result };
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
  /** @type {[NodeJS.Signals, number][]} */
  const signals = [
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ];
  for (const [signal, status] of signals) {
    await t.test(signal, async () => {
      const parent = await sandbox(t);
      const sibling = join(parent, "sibling");
      await writeFile(sibling, "keep");
      const { announcedPaths, result } = await signalChild(parent, signal);

      assert.equal(result.code, status);
      assert.equal(result.signal, null);
      for (const workspace of announcedPaths) {
        await assert.rejects(stat(workspace), { code: "ENOENT" });
      }
      assert.equal(await readFile(sibling, "utf8"), "keep");
    });
  }
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

void test("withWorkspace surfaces a cleanup failure when the callback succeeds", async (t) => {
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

void test("withWorkspace can preserve a successful callback result when cleanup fails", async (t) => {
  const parent = await sandbox(t);
  const cleanupFailure = new Error("cleanup failed");
  const result = await withWorkspace(parent, "work-", async () => 42, {
    cleanup: async () => {
      throw cleanupFailure;
    },
    cleanupFailure: "ignore",
  });
  assert.equal(result, 42);
});

void test("withWorkspace preserves the callback error when ignored cleanup also fails", async (t) => {
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
        cleanupFailure: "ignore",
      },
    ),
    (error) => error === callbackFailure,
  );
});

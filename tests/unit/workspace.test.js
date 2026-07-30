// @ts-check
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
const { withWorkspace } = await import(
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

// The capability tests above prove `cleanupFailure: "ignore"` works. This one
// proves the adapter still passes it: `src/adapter.ts` opts every operation out
// of cleanup-failure propagation (five call sites, `:478` `:621` `:693` `:778`
// `:887`), because a workspace it never wrote to failing to be removed must not
// discard an otherwise successful result. The fake Codex makes the temporary
// directory's parent read-only while it runs, so the adapter's own cleanup
// really fails.
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

  assert.equal(result.envelope.ok, true, JSON.stringify(result.envelope));
  assert.deepStrictEqual(result.envelope.messages, [
    {
      channel: "stdout",
      text: "removed plugin superpowers@superpowers-manager",
    },
    { channel: "stdout", text: "marketplace not registered; skipping" },
  ]);
  // Guard against a vacuous pass: if the read-only parent had not actually
  // blocked removal there would be nothing left to find, and the assertions
  // above would say nothing about cleanup-failure adoption.
  const leftover = await readdir(temporary);
  assert.deepStrictEqual(leftover.length, 1, leftover.join(", "));
  assert.match(leftover[0] ?? "", /^superpowers-manager\.adapter-uninstall\./);
});

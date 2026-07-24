// @ts-check
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/** @type {typeof import("../../src/safety-error.js")} */
const { SafetyError } = await import("../../dist/safety-error.js");
/** @type {typeof import("../../src/atomic.js")} */
const { atomicReplaceDir, atomicWriteFile } = await import("../../dist/atomic.js");

/** @param {import("node:test").TestContext} t */
async function sandbox(t) {
  const directory = await mkdtemp(join(tmpdir(), "spw-atomic-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * @param {Promise<unknown>} operation
 * @returns {Promise<import("../../src/safety-error.js").SafetyError<import("../../src/atomic.js").AtomicErrorDetails>>}
 */
async function safetyFailure(operation) {
  try {
    await operation;
    assert.fail("expected SafetyError");
  } catch (error) {
    assert.ok(error instanceof SafetyError);
    return /** @type {import("../../src/safety-error.js").SafetyError<import("../../src/atomic.js").AtomicErrorDetails>} */ (error);
  }
}

/** @param {string} value */
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("FS-SELECTION-ATOMIC-01 validator rejection preserves target and removes only the owned temp", async (t) => {
  const directory = await sandbox(t);
  const target = join(directory, "selection.json");
  const foreign = join(directory, ".selection.json.tmp.foreign");
  await writeFile(target, "before");
  await writeFile(foreign, "keep");
  await assert.rejects(
    atomicWriteFile(target, Buffer.from("after"), {
      validate: async (temporary) => {
        assert.equal((await stat(temporary)).mode & 0o777, 0o600);
        throw new Error("invalid");
      },
    }),
    SafetyError,
  );
  assert.equal(await readFile(target, "utf8"), "before");
  assert.equal(await readFile(foreign, "utf8"), "keep");
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.startsWith(".selection.json.tmp.")),
    [".selection.json.tmp.foreign"],
  );
});

test("FS-SELECTION-ATOMIC-01 rename failure is pre-replacement and leaves prior bytes", async (t) => {
  const directory = await sandbox(t);
  const target = join(directory, "selection.json");
  await writeFile(target, "before");
  const error = await safetyFailure(
    atomicWriteFile(target, Buffer.from("after"), {
      validate: async () => {},
      hooks: { rename: async () => { throw Object.assign(new Error("rename"), { code: "EIO" }); } },
    }),
  );
  assert.ok(error.details);
  assert.equal(error.details.phase, "pre-replacement");
  assert.equal(await readFile(target, "utf8"), "before");
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.startsWith(".selection.json.tmp.")),
    [],
  );
});

test("FS-SELECTION-POST-REPLACE-01 post-replacement failure reports bytes that landed", async (t) => {
  const directory = await sandbox(t);
  const target = join(directory, "selection.json");
  const payload = Buffer.from("after");
  const error = await safetyFailure(
    atomicWriteFile(target, payload, {
      validate: async () => {},
      hooks: { afterReplace: async () => { throw new Error("uncertain completion"); } },
    }),
  );
  assert.ok(error.details);
  assert.equal(error.details.phase, "post-replacement");
  assert.ok(error.details.finalBytes);
  assert.deepEqual(Buffer.from(error.details.finalBytes), payload);
  assert.deepEqual(await readFile(target), payload);
});

test("FS-SELECTION-CONCURRENT-01 concurrent writers leave one complete payload", async (t) => {
  const directory = await sandbox(t);
  const target = join(directory, "selection.json");
  const payloads = [Buffer.from('{"mode":"pinned"}\\n'), Buffer.from('{"mode":"track-latest"}\\n')];
  await Promise.all(
    payloads.map((bytes) =>
      atomicWriteFile(target, bytes, { validate: async () => {} }),
    ),
  );
  const final = await readFile(target);
  assert.equal(payloads.some((payload) => payload.equals(final)), true);
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.startsWith(".selection.json.tmp.")),
    [],
  );
});

test("FS-ATOMIC-SWAP-01 EXDEV activation restores the prior tree", async (t) => {
  const parent = await sandbox(t);
  const live = join(parent, "live");
  const candidate = join(parent, "candidate");
  await mkdir(live);
  await mkdir(candidate);
  await writeFile(join(live, "marker"), "before");
  await writeFile(join(candidate, "marker"), "after");
  let calls = 0;
  const realRename = rename;
  await assert.rejects(
    atomicReplaceDir(candidate, live, {
      hooks: {
        rename: async (from, to) => {
          calls += 1;
          if (calls === 2) {
            throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
          }
          await realRename(from, to);
        },
      },
    }),
    SafetyError,
  );
  assert.equal(await readFile(join(live, "marker"), "utf8"), "before");
  await assert.rejects(stat(candidate), { code: "ENOENT" });
  assert.equal((await readdir(parent)).some((name) => name.includes(".bak.")), false);
});

test("FS-ATOMIC-SWAP-01 rollback failure preserves and reports the backup", async (t) => {
  const parent = await sandbox(t);
  const live = join(parent, "live");
  const candidate = join(parent, "candidate");
  await mkdir(live);
  await mkdir(candidate);
  await writeFile(join(live, "marker"), "before");
  let calls = 0;
  const realRename = rename;
  const error = await safetyFailure(
    atomicReplaceDir(candidate, live, {
      hooks: {
        rename: async (from, to) => {
          calls += 1;
          if (calls >= 2) throw new Error(`rename ${calls} failed`);
          await realRename(from, to);
        },
      },
    }),
  );
  const backup = (await readdir(parent)).find((name) => name.includes(".bak."));
  assert.ok(backup);
  assert.match(error.message, new RegExp(escapeRegex(backup)));
  assert.equal(await readFile(join(parent, backup, "marker"), "utf8"), "before");
});

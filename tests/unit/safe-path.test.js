// @ts-check
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

/** @type {typeof import("../../src/safety-error.js")} */
const { SafetyError } = await import("../../dist/safety-error.js");
/** @type {typeof import("../../src/safe-path.js")} */
const paths = await import("../../dist/safe-path.js");

/** @param {import("node:test").TestContext} t */
async function sandbox(t) {
  const base = await mkdtemp(join(tmpdir(), "spw-safe-path-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "root");
  await mkdir(root);
  return { base, root };
}

test("FS-HOOK-CONTAINMENT-01 existing containment rejects lexical and resolved escapes", async (t) => {
  const { base, root } = await sandbox(t);
  const file = join(root, "file");
  await writeFile(file, "ok");
  assert.equal(await paths.assertExistingContained(root, file), resolve(file));
  await assert.rejects(
    paths.assertExistingContained(root, join(base, "outside")),
    SafetyError,
  );
  const outside = join(base, "outside");
  await mkdir(outside);
  await symlink(outside, join(root, "escape"), "dir");
  await writeFile(join(outside, "file"), "no");
  await assert.rejects(
    paths.assertExistingContained(root, join(root, "escape", "file")),
    SafetyError,
  );
});

test("FS-HOOK-CONTAINMENT-01 prospective containment resolves the nearest existing ancestor", async (t) => {
  const { base, root } = await sandbox(t);
  assert.equal(
    await paths.assertProspectiveContained(root, join(root, "new", "file")),
    resolve(root, "new", "file"),
  );
  const outside = join(base, "outside");
  await mkdir(outside);
  await symlink(outside, join(root, "escape"), "dir");
  await assert.rejects(
    paths.assertProspectiveContained(root, join(root, "escape", "new")),
    SafetyError,
  );
});

test("SEL-READER-PATHS-01 no-follow classification distinguishes path types", async (t) => {
  const { root } = await sandbox(t);
  const file = join(root, "file");
  const directory = join(root, "directory");
  const link = join(root, "link");
  const fifo = join(root, "fifo");
  await writeFile(file, "ok");
  await mkdir(directory);
  await symlink(file, link);
  execFileSync("mkfifo", [fifo]);
  assert.equal(await paths.classifyPathNoFollow(file), "regular-file");
  assert.equal(await paths.classifyPathNoFollow(directory), "directory");
  assert.equal(await paths.classifyPathNoFollow(link), "symlink");
  assert.equal(await paths.classifyPathNoFollow(fifo), "other");
  assert.equal(await paths.classifyPathNoFollow(join(root, "missing")), "missing");
  await assert.rejects(
    paths.assertNoFollowType(link, ["regular-file"]),
    SafetyError,
  );
});

test("FS-SELECTION-TYPES-01 / SEL-READER-PARENT-01 designated parent", async (t) => {
  const { root } = await sandbox(t);
  const realParent = join(root, "real-parent");
  const linkedParent = join(root, "linked-parent");
  await mkdir(realParent);
  await symlink(realParent, linkedParent, "dir");
  const absent = join(linkedParent, "selection.json");
  await assert.doesNotReject(paths.assertProspectiveContained(root, absent));
  await assert.rejects(paths.assertDesignatedParentDirectory(absent), SafetyError);
  await writeFile(join(realParent, "selection.json"), "{}");
  await assert.rejects(paths.assertDesignatedParentDirectory(absent), SafetyError);
});

test("FS-SYMLINK-01 symlink targets must remain contained", async (t) => {
  const { base, root } = await sandbox(t);
  const inside = join(root, "inside");
  const outside = join(base, "outside");
  await writeFile(inside, "ok");
  await writeFile(outside, "no");
  await symlink(inside, join(root, "inside-link"));
  await symlink(outside, join(root, "outside-link"));
  await symlink(join(root, "missing"), join(root, "broken-link"));
  await assert.doesNotReject(
    paths.assertSymlinkTargetContained(root, join(root, "inside-link")),
  );
  await assert.rejects(
    paths.assertSymlinkTargetContained(root, join(root, "outside-link")),
    SafetyError,
  );
  await assert.rejects(
    paths.assertSymlinkTargetContained(root, join(root, "broken-link")),
    SafetyError,
  );
});

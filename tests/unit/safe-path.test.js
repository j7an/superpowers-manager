// @ts-check
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

/** @type {typeof import("../../src/safety-error.js")} */
const { SafetyError } = await import(
  new URL("../../dist/safety-error.js", import.meta.url).href
);
/** @type {typeof import("../../src/safe-path.js")} */
const paths = await import(
  new URL("../../dist/safe-path.js", import.meta.url).href
);

/** @param {import("node:test").TestContext} t */
async function sandbox(t) {
  const base = await mkdtemp(join(tmpdir(), "spw-safe-path-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "root");
  await mkdir(root);
  return { base, root };
}

void test("FS-HOOK-CONTAINMENT-01 existing containment rejects lexical and resolved escapes", async (t) => {
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

void test("FS-HOOK-CONTAINMENT-01 prospective containment resolves the nearest existing ancestor", async (t) => {
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
  await symlink(
    join(base, "missing-outside"),
    join(root, "broken-escape"),
    "dir",
  );
  await assert.rejects(
    paths.assertProspectiveContained(root, join(root, "broken-escape", "new")),
    SafetyError,
  );
  await symlink(
    join(root, "missing-inside"),
    join(root, "broken-contained"),
    "dir",
  );
  await assert.doesNotReject(
    paths.assertProspectiveContained(
      root,
      join(root, "broken-contained", "new"),
    ),
  );
});

void test("FS-HOOK-CONTAINMENT-01 prospective containment resolves relative broken links from their real parent", async (t) => {
  const { base, root } = await sandbox(t);
  const linkedDirectory = join(base, "linked-directory");
  await mkdir(linkedDirectory);
  await symlink(linkedDirectory, join(root, "directory-link"), "dir");
  await symlink("../outside", join(linkedDirectory, "broken-link"), "dir");
  await assert.rejects(
    paths.assertProspectiveContained(
      root,
      join(root, "directory-link", "broken-link", "new"),
    ),
    SafetyError,
  );
});

void test("FS-HOOK-CONTAINMENT-01 prospective containment rejects a repeating broken symlink", async (t) => {
  const { root } = await sandbox(t);
  const link = join(root, "a");
  await symlink("missing/../a", link);
  const script = [
    `import { assertProspectiveContained } from ${JSON.stringify(new URL("../../dist/safe-path.js", import.meta.url).href)};`,
    `try { await assertProspectiveContained(${JSON.stringify(root)}, ${JSON.stringify(link)}); process.stdout.write("resolved\\n"); } catch (cause) { process.stdout.write(cause?.name + "\\n"); }`,
  ].join("\n");
  /** @type {string} */
  let output;
  try {
    output = execFileSync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      {
        encoding: "utf8",
        timeout: 1_000,
      },
    );
  } catch (cause) {
    const signal =
      typeof cause === "object" &&
      cause !== null &&
      "signal" in cause &&
      typeof cause.signal === "string"
        ? cause.signal
        : undefined;
    const detail =
      signal ?? (cause instanceof Error ? cause.message : String(cause));
    assert.fail(
      `prospective symlink resolution did not exit before bounded cleanup: ${detail}`,
    );
  }
  assert.equal(output, "SafetyError\n");
});

void test("SEL-READER-PATHS-01 no-follow classification distinguishes path types", async (t) => {
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
  assert.equal(
    await paths.classifyPathNoFollow(join(root, "missing")),
    "missing",
  );
  await assert.rejects(
    paths.assertNoFollowType(link, ["regular-file"]),
    SafetyError,
  );
});

void test("FS-SELECTION-TYPES-01 / SEL-READER-PARENT-01 designated parent", async (t) => {
  const { root } = await sandbox(t);
  const realParent = join(root, "real-parent");
  const linkedParent = join(root, "linked-parent");
  await mkdir(realParent);
  await symlink(realParent, linkedParent, "dir");
  const absent = join(linkedParent, "selection.json");
  await assert.doesNotReject(paths.assertProspectiveContained(root, absent));
  await assert.rejects(
    paths.assertDesignatedParentDirectory(absent),
    SafetyError,
  );
  await writeFile(join(realParent, "selection.json"), "{}");
  await assert.rejects(
    paths.assertDesignatedParentDirectory(absent),
    SafetyError,
  );
});

void test("FS-SYMLINK-01 symlink targets must remain contained", async (t) => {
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

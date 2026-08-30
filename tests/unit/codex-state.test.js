// @ts-check
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exactError } from "../lib/error-assertions.js";

/** @type {typeof import("../../src/safety-error.js")} */
const { SafetyError } = await import(
  new URL("../../dist/safety-error.js", import.meta.url).href
);

/** @type {typeof import("../../src/codex-state.js")} */
const {
  codexMetadataCommit,
  installedCommitFromRoot,
  installedRootForVersion,
  manifestShortSha,
  pathsEqual,
} = await import(new URL("../../dist/codex-state.js", import.meta.url).href);

/** @param {import("node:test").TestContext} t */
async function sandbox(t) {
  const directory = await mkdtemp(join(tmpdir(), "spw-codex-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** @param {number} depth */
const nested = (depth) => "[".repeat(depth) + "0" + "]".repeat(depth);

void test("PROV-READER-CODEX-COMMIT-01 installed metadata complete matrix", async (t) => {
  const root = await sandbox(t);
  const file = join(root, "metadata.json");
  const full = "0123456789abcdef0123456789abcdef01234567";

  for (const commit of [full, "d884ae0"]) {
    await writeFile(file, JSON.stringify({ commit }));
    assert.equal(await codexMetadataCommit(file), commit);
  }
  await writeFile(file, `{"commit":"first","commit":"${full}"}`);
  assert.equal(await codexMetadataCommit(file), full);
  await writeFile(file, `{"commit":"${full}","padding":${nested(255)}}`);
  assert.equal(await codexMetadataCommit(file), full);
  await writeFile(
    file,
    `{"commit":"${full}","padding":"${"x".repeat(1_048_577)}"}`,
  );
  assert.equal(await codexMetadataCommit(file), full);

  for (const [text, message] of [
    ["{", `cannot read installed Codex JSON ${file}`],
    ["[]", `invalid installed Codex JSON ${file}`],
    ["{}", `invalid installed Codex commit in ${file}`],
    ['{"commit":7}', `invalid installed Codex JSON ${file}`],
    ['{"commit":"d884ae04"}', `invalid installed Codex commit in ${file}`],
    [
      `{"commit":"${full}","padding":NaN}`,
      `cannot read installed Codex JSON ${file}`,
    ],
    [
      `{"commit":"${full}","padding":${nested(256)}}`,
      `cannot read installed Codex JSON ${file}`,
    ],
  ]) {
    await writeFile(file, text);
    await assert.rejects(
      codexMetadataCommit(file),
      exactError(SafetyError, message),
      text,
    );
  }
});

void test("MANIFEST-READER-INSTALLED-01 installed manifest complete matrix", async (t) => {
  const root = await sandbox(t);
  const file = join(root, "plugin.json");
  for (const [version, expected] of [
    ["6.0.3+manager.896224c", "896224c"],
    ["6.1.0-beta.1+manager.abc1234", "abc1234"],
    ["0.0.0-main+manager.def5678", "def5678"],
    ["0.0.0-ref-feature-foo+manager.fedcba9", "fedcba9"],
    ["0.0.0-ref-042+manager.0123abc", "0123abc"],
    ["0.0.0+manager.896224c", "896224c"],
    ["arbitrary+manager.release.d884ae0", "d884ae0"],
    ["arbitrary.release.d884ae0", ""],
    ["d884ae0", ""],
    ["0.0.0+manager.template", ""],
    ["6.0.3+manager.abcxyz1", ""],
  ]) {
    await writeFile(file, JSON.stringify({ name: "superpowers", version }));
    assert.equal(await manifestShortSha(file), expected, version);
  }
  await writeFile(file, '{"version":"bad","version":"6.1.1+manager.d884ae0"}');
  assert.equal(await manifestShortSha(file), "d884ae0");
  await writeFile(
    file,
    `{"version":"6.1.1+manager.d884ae0","padding":${nested(255)}}`,
  );
  assert.equal(await manifestShortSha(file), "d884ae0");
  await writeFile(
    file,
    `{"version":"6.1.1+manager.d884ae0","padding":"${"x".repeat(1_048_577)}"}`,
  );
  assert.equal(await manifestShortSha(file), "d884ae0");
  for (const [text, message] of [
    ["{", `cannot read installed Codex JSON ${file}`],
    ["[]", `invalid installed Codex JSON ${file}`],
    ['{"version":NaN}', `cannot read installed Codex JSON ${file}`],
    [
      `{"version":"6.1.1+manager.d884ae0","padding":${nested(256)}}`,
      `cannot read installed Codex JSON ${file}`,
    ],
  ]) {
    await writeFile(file, text);
    await assert.rejects(
      manifestShortSha(file),
      exactError(SafetyError, message),
      text,
    );
  }
});

void test("installed state helpers preserve path and fallback rules", async (t) => {
  const root = await sandbox(t);
  assert.equal(
    installedRootForVersion(
      root,
      "superpowers-manager",
      "superpowers",
      "1.2.3",
    ),
    join(
      root,
      "plugins",
      "cache",
      "superpowers-manager",
      "superpowers",
      "1.2.3",
    ),
  );
  const active = join(root, "active");
  await mkdir(join(active, ".codex-plugin"), { recursive: true });
  await writeFile(
    join(active, ".codex-plugin", "plugin.json"),
    '{"version":"1.0.0+manager.d884ae0"}',
  );
  assert.equal(await installedCommitFromRoot(active), "d884ae0");
  await writeFile(
    join(active, ".superpowers-upstream.json"),
    '{"commit":"0123456789abcdef0123456789abcdef01234567"}',
  );
  assert.equal(
    await installedCommitFromRoot(active),
    "0123456789abcdef0123456789abcdef01234567",
  );

  const real = join(root, "real");
  const link = join(root, "link");
  await mkdir(real);
  await symlink(real, link);
  assert.equal(await pathsEqual(real, link), true);
  assert.equal(await pathsEqual(real, root), false);
  assert.equal(await pathsEqual("/no/such/a", "/no/such/a"), true);
  assert.equal(await pathsEqual("/no/such/a", "/no/such/b"), false);
});

// @ts-check
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

/** @type {typeof import("../../src/provenance.js")} */
const {
  readGeneratedCommitLenient,
  readCodexBuildSource,
  readStrictProvenanceField,
  serializeProvenance,
  writeProvenance,
  generatedMetadataPath,
  generatedCommitOrEmpty,
} = await import(new URL("../../dist/provenance.js", import.meta.url).href);
/** @type {typeof import("../../src/safety-error.js")} */
const { SafetyError } = await import(
  new URL("../../dist/safety-error.js", import.meta.url).href
);

const commit = "0123456789abcdef0123456789abcdef01234567";
const mixedCommit = "0123456789ABCDEF0123456789abcdef01234567";

/** @param {import("node:test").TestContext} t */
async function sandbox(t) {
  const directory = await mkdtemp(join(tmpdir(), "spw-provenance-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** @param {number} depth */
const nested = (depth) => "[".repeat(depth) + "0" + "]".repeat(depth);

void test("PROV-READER-CODEX-SOURCE-01 Codex build source reader preserves its accepting profile", async (t) => {
  const directory = await sandbox(t);
  const file = join(directory, "provenance.json");
  await writeFile(
    file,
    '{"padding":Infinity,"source":"https://example.invalid/repo"}',
  );
  assert.equal(
    await readCodexBuildSource(file),
    "https://example.invalid/repo",
  );
  await writeFile(file, '{"source":"first","source":"last"}');
  assert.equal(await readCodexBuildSource(file), "last");
  for (const text of ["{", "[]", "{}", '{"source":7}', '{"source":""}']) {
    await writeFile(file, text);
    await assert.rejects(readCodexBuildSource(file), SafetyError, text);
  }
});

void test("PROV-READER-STRICT-01 reads fields under the strict provenance profile", async (t) => {
  const directory = await sandbox(t);
  const file = join(directory, "provenance.json");

  await writeFile(
    file,
    '{"commit":"first","commit":"last","nested":{"field":42}}',
  );
  assert.equal(await readStrictProvenanceField(file, "commit"), "last");
  assert.equal(await readStrictProvenanceField(file, "nested.field"), 42);
  assert.equal(await readStrictProvenanceField(file, "missing"), undefined);
  assert.equal(
    await readStrictProvenanceField(file, "nested.field.extra"),
    undefined,
  );

  await writeFile(file, `{"padding":${nested(255)}}`);
  assert.equal(
    Array.isArray(await readStrictProvenanceField(file, "padding")),
    true,
  );
  await writeFile(file, `{"padding":${nested(256)}}`);
  await assert.rejects(readStrictProvenanceField(file, "padding"), SafetyError);

  for (const text of ["[]", "null", "NaN", "Infinity", "{"]) {
    await writeFile(file, text);
    await assert.rejects(
      readStrictProvenanceField(file, "commit"),
      SafetyError,
      text,
    );
  }

  await writeFile(file, Uint8Array.from([0xc3, 0x28]));
  await assert.rejects(readStrictProvenanceField(file, "commit"), SafetyError);
  await writeFile(
    file,
    Uint8Array.from([
      0xef, 0xbb, 0xbf, 0x7b, 0x22, 0x63, 0x6f, 0x6d, 0x6d, 0x69, 0x74, 0x22,
      0x3a, 0x22, 0x61, 0x62, 0x63, 0x22, 0x7d,
    ]),
  );
  await assert.rejects(readStrictProvenanceField(file, "commit"), SafetyError);

  await writeFile(
    file,
    `{"commit":"${commit}","padding":"${"x".repeat(1024 * 1024)}"}`,
  );
  assert.equal(await readStrictProvenanceField(file, "commit"), commit);
});

void test("PROV-READER-LENIENT-01 returns only an acceptable generated commit", async (t) => {
  const directory = await sandbox(t);
  const file = join(directory, "provenance.json");

  await writeFile(file, `{"commit":"${commit}"}`);
  assert.equal(await readGeneratedCommitLenient(file), commit);
  await writeFile(file, `{"commit":"${mixedCommit}"}`);
  assert.equal(await readGeneratedCommitLenient(file), mixedCommit);
  await writeFile(file, `{"commit":"first","commit":"${commit}"}`);
  assert.equal(await readGeneratedCommitLenient(file), commit);

  for (const value of [
    '{"commit":"0123456"}',
    '{"commit":42}',
    "[]",
    "NaN",
    "Infinity",
    "-Infinity",
    "{",
  ]) {
    await writeFile(file, value);
    assert.equal(await readGeneratedCommitLenient(file), "", value);
  }
  await writeFile(file, Uint8Array.from([0xc3, 0x28]));
  assert.equal(await readGeneratedCommitLenient(file), "");
  await writeFile(
    file,
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(`{"commit":"${commit}"}`),
    ]),
  );
  assert.equal(await readGeneratedCommitLenient(file), "");
  await writeFile(file, `{"padding":${nested(20_000)}}`);
  assert.equal(await readGeneratedCommitLenient(file), "");
  assert.equal(
    await readGeneratedCommitLenient(join(directory, "missing.json")),
    "",
  );
});

/** @type {import("../../src/provenance.js").ProvenanceRecord} */
const tagRecord = {
  source: "https://example.invalid/superpowers.git",
  requested_ref: "latest-release",
  resolved_ref: "v6.1.1",
  commit: "d884ae04edebef577e82ff7c4e143debd0bbec99",
  upstream_manifest_version: "6.1.1",
};

/** @type {import("../../src/provenance.js").ProvenanceRecord} */
const commitRecord = {
  source: "https://example.invalid/superpowers.git",
  requested_ref: "d884ae04edebef577e82ff7c4e143debd0bbec99",
  resolved_ref: "d884ae04edebef577e82ff7c4e143debd0bbec99",
  commit: "d884ae04edebef577e82ff7c4e143debd0bbec99",
  upstream_manifest_version: "6.1.1",
};

/** @type {import("../../src/provenance.js").ProvenanceRecord} */
const unicodeRecord = {
  source: ['\u00e9\u4e2d\ud83d\ude00"', "\\", "\n\t\r\b\f\u0001\u007f/"].join(
    "",
  ),
  requested_ref: "requested",
  resolved_ref: "resolved",
  commit,
  upstream_manifest_version: "version",
};

void test("PROVENANCE-BYTES-01 writer matches Python bytes", async (t) => {
  const directory = await sandbox(t);
  /** @type {[string, import("../../src/provenance.js").ProvenanceRecord][]} */
  const fixtures = [
    ["tests/fixtures/baseline/provenance/valid-tag.json", tagRecord],
    ["tests/fixtures/baseline/provenance/valid-commit.json", commitRecord],
    ["tests/fixtures/unit/provenance/unicode-escaping.json", unicodeRecord],
  ];
  for (const [fixture, record] of fixtures) {
    const expected = await readFile(fixture);
    assert.deepEqual(
      Buffer.from(serializeProvenance(record), "utf8"),
      expected,
      fixture,
    );
    const filename = fixture.split("/").at(-1);
    if (filename === undefined) throw new Error("fixture has no filename");
    const output = join(directory, filename);
    await writeProvenance(output, record);
    assert.deepEqual(await readFile(output), expected, fixture);
  }
});

void test("generatedCommitOrEmpty reads the generated tree's provenance", async (t) => {
  const directory = await sandbox(t);
  const metadata = join(
    directory,
    "plugins",
    "superpowers",
    ".superpowers-upstream.json",
  );
  assert.equal(
    generatedMetadataPath(directory),
    metadata,
    "the metadata path must match src/provenance.ts's generatedMetadataPath",
  );

  // Absent tree: empty, not a throw. scripts/core/lifecycle.sh:33-37 relied on
  // the lenient reader so `probe` can report "needs prepare" instead of
  // aborting the remediation path.
  assert.equal(await generatedCommitOrEmpty(directory), "");

  await mkdir(dirname(metadata), { recursive: true });
  await writeFile(metadata, `{"commit":"${commit}"}`);
  assert.equal(await generatedCommitOrEmpty(directory), commit);

  await writeFile(metadata, "{");
  assert.equal(await generatedCommitOrEmpty(directory), "");
});

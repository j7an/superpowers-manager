// @ts-check
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { exactError } from "../lib/error-assertions.js";

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
  for (const [text, message] of [
    ["{", `cannot read Codex source from ${file}`],
    ["[]", `invalid Codex source in ${file}`],
    ["{}", `invalid Codex source in ${file}`],
    ['{"source":7}', `invalid Codex source in ${file}`],
    ['{"source":""}', `invalid Codex source in ${file}`],
  ]) {
    await writeFile(file, text);
    await assert.rejects(
      readCodexBuildSource(file),
      exactError(SafetyError, message),
      text,
    );
  }
  // Bytes: the matrix says NO byte cap, and until PR-3 the only assertion of
  // that was `git show 41c99390f51a0cbeb552ab0a0bff26fc1c5c07df:tests/test_adapter_protocol.sh:852-854::large` (a 1 MiB + 1 payload). Ported
  // here so the cell keeps a witness after the driver is deleted. Mirrors
  // `tests/unit/codex-state.test.js:48::"commit":"${full}","padding":"${"x".repeat(1_048_577)}"` for the sibling reader.
  await writeFile(
    file,
    `{"padding":"${"x".repeat(1_048_577)}","source":"https://example.invalid/repo"}`,
  );
  assert.equal(
    await readCodexBuildSource(file),
    "https://example.invalid/repo",
  );
  // Nesting: the cell is "no explicit depth cap; recursion failure rejects".
  // Only the first clause is pinned here. The second is a property of the V8
  // stack rather than of this source, so any fixed-depth rejection assertion
  // would encode the very cap this cell says does not exist: measured, the
  // same unmodified reader rejects at depth 20000 under --stack-size=984 and
  // accepts under --stack-size=8192, so such an assertion would report RED on
  // a correct product under one node invocation and GREEN under another.
  // 256, not 255: PROVENANCE_CODEX_SOURCE_PROFILE (`src/provenance.ts:31-34::export const PROVENANCE_CODEX_SOURCE_PROFILE`)
  // sets no maxDepth, and nested(255) reaches container depth 256, which a
  // `maxDepth: 256` mutant still ACCEPTS -- `src/strict-json.ts:158::if (this.profile.maxDepth` rejects only on
  // `depth > maxDepth`. nested(256) reaches 257 and is the first depth that
  // mutant crosses. The pair is already pinned against the strict profile,
  // which does cap at 256, by PROV-READER-STRICT-01's nested(255)/nested(256)
  // assertions in this file.
  await writeFile(
    file,
    `{"padding":${nested(256)},"source":"https://example.invalid/repo"}`,
  );
  assert.equal(
    await readCodexBuildSource(file),
    "https://example.invalid/repo",
  );
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
  await assert.rejects(
    readStrictProvenanceField(file, "padding"),
    exactError(SafetyError, `cannot read strict provenance field from ${file}`),
  );

  for (const [text, message] of [
    ["[]", `provenance value must be an object: ${file}`],
    ["null", `provenance value must be an object: ${file}`],
    ["NaN", `cannot read strict provenance field from ${file}`],
    ["Infinity", `cannot read strict provenance field from ${file}`],
    ["{", `cannot read strict provenance field from ${file}`],
  ]) {
    await writeFile(file, text);
    await assert.rejects(
      readStrictProvenanceField(file, "commit"),
      exactError(SafetyError, message),
      text,
    );
  }

  await writeFile(file, Uint8Array.from([0xc3, 0x28]));
  await assert.rejects(
    readStrictProvenanceField(file, "commit"),
    exactError(SafetyError, `cannot read strict provenance field from ${file}`),
  );
  await writeFile(
    file,
    Uint8Array.from([
      0xef, 0xbb, 0xbf, 0x7b, 0x22, 0x63, 0x6f, 0x6d, 0x6d, 0x69, 0x74, 0x22,
      0x3a, 0x22, 0x61, 0x62, 0x63, 0x22, 0x7d,
    ]),
  );
  await assert.rejects(
    readStrictProvenanceField(file, "commit"),
    exactError(SafetyError, `cannot read strict provenance field from ${file}`),
  );

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

  // Absent tree: empty, not a throw. `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/lifecycle.sh:33-37::spw_generated_commit_or_empty` relied on
  // the lenient reader so `probe` can report "needs prepare" instead of
  // aborting the remediation path.
  assert.equal(await generatedCommitOrEmpty(directory), "");

  await mkdir(dirname(metadata), { recursive: true });
  await writeFile(metadata, `{"commit":"${commit}"}`);
  assert.equal(await generatedCommitOrEmpty(directory), commit);

  await writeFile(metadata, "{");
  assert.equal(await generatedCommitOrEmpty(directory), "");
});

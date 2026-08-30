// @ts-check
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exactError } from "../lib/error-assertions.js";

/** @type {typeof import("../../src/safety-error.js")} */
const { SafetyError } = await import(
  new URL("../../dist/safety-error.js", import.meta.url).href
);
/** @type {typeof import("../../src/selection.js")} */
const {
  displaySource,
  normalizePinnedArguments,
  normalizeSaved,
  serializeRecord,
  validateRecord,
  validateSource,
} = await import(new URL("../../dist/selection.js", import.meta.url).href);

/** @type {typeof import("../../src/selection-store.js")} */
const { readSelectionState, writeSelectionState } = await import(
  new URL("../../dist/selection-store.js", import.meta.url).href
);

const commit = "0123456789abcdef0123456789abcdef01234567";

/** @param {import("node:test").TestContext} t */
async function sandbox(t) {
  const directory = await mkdtemp(join(tmpdir(), "spw-selection-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * @param {Promise<unknown>} operation
 * @returns {Promise<import("../../src/safety-error.js").SafetyError>}
 */
async function selectionFailure(operation) {
  try {
    await operation;
    assert.fail("expected SafetyError");
  } catch (error) {
    assert.ok(error instanceof SafetyError);
    assert.equal(error.module, "selection");
    return error;
  }
}

void test("selection validation and normalization preserve the frozen record shapes", () => {
  const pinned = validateRecord({
    schema_version: 1,
    mode: "pinned",
    source: "https://example.invalid/repo",
    requested_ref: "v1.2.3",
    resolved_ref: "v1.2.3",
    commit,
  });
  assert.deepEqual(normalizeSaved(pinned), {
    saved_mode: "pinned",
    saved_source: "https://example.invalid/repo",
    saved_requested_ref: "v1.2.3",
    saved_resolved_ref: "v1.2.3",
    saved_commit: commit,
  });
  assert.deepEqual(normalizeSaved(null), {
    saved_mode: "none",
    saved_source: "",
    saved_requested_ref: "",
    saved_resolved_ref: "",
    saved_commit: "",
  });
  assert.deepEqual(
    normalizePinnedArguments({
      source: "https://example.invalid/repo",
      requestedRef: commit.toUpperCase(),
      resolvedRef: commit.toUpperCase(),
      commit: commit.toUpperCase(),
    }),
    {
      schema_version: 1,
      mode: "pinned",
      source: "https://example.invalid/repo",
      requested_ref: commit,
      resolved_ref: commit,
      commit,
    },
  );
  assert.throws(
    () =>
      validateRecord({
        schema_version: 1,
        mode: "pinned",
        source: "https://example.invalid/repo",
        requested_ref: commit,
        resolved_ref: commit,
        commit: "89abcdef0123456789abcdef0123456789abcdef",
      }),
    /raw commit requested_ref, resolved_ref, and commit must be equal/,
  );
});

void test("validateSource matches the bounded CPython urlsplit verdict corpus", () => {
  const accepted = [
    "https://github.com/obra/superpowers",
    "http://example.invalid/repo",
    "ssh://git@github.com/obra/superpowers.git",
    "git@github.com:obra/superpowers.git",
    "/tmp/local upstream",
    "https://example.invalid/@repo",
    "ssh://[::1]/repo",
    "git://[v1.future]/repo",
    "git://[vabc.future]/repo",
    "ssh://[::1]:22[/repo",
    "ssh://user]@[::1/repo",
    "https://ﬀ.example/r",
  ];
  for (const source of accepted) {
    assert.equal(validateSource(source), source, source);
  }

  /** @type {Array<[string, RegExp]>} */
  const rejected = [
    ["https://user:password@example.invalid/repo", /must not include userinfo/],
    ["https://token@example.invalid/repo", /must not include userinfo/],
    ["http://@example.invalid/repo", /must not include userinfo/],
    ["ht\ttp://user@x", /must not include userinfo/],
    ["\u0001http://user@x", /must not include userinfo/],
    [" http://user@x", /must not include userinfo/],
    ["https://[invalid/repo", /source URL is malformed/],
    ["ssh://a[b]c/repo", /source URL is malformed/],
    ["git://user[x]@host/repo", /source URL is malformed/],
    ["git://[V1.future]/repo", /source URL is malformed/],
    ["git://[vZ.future]/repo", /source URL is malformed/],
    ["ssh://[::1]x/repo", /source URL is malformed/],
    ["ssh://[invalid]/repo", /source URL is malformed/],
    ["https://exa／mple.invalid/repo", /source URL is malformed/],
    ["https://ex＠ample/repo", /source URL is malformed/],
  ];
  for (const [source, message] of rejected) {
    assert.throws(() => validateSource(source), message, source);
  }
  for (const source of ["", "line\nbreak", "nul\0byte"]) {
    assert.throws(
      () => validateSource(source),
      exactError(SafetyError, "source must be a non-empty single-line string"),
      source,
    );
  }
});

void test("displaySource redacts sources that fail validation", () => {
  assert.equal(
    displaySource("https://github.com/obra/superpowers"),
    "https://github.com/obra/superpowers",
  );
  assert.equal(
    displaySource("https://user:password@example.invalid/repo"),
    "<redacted-source>",
  );
});

void test("selection serializer preserves Python-compatible bytes", () => {
  assert.equal(
    serializeRecord({
      schema_version: 1,
      mode: "track-latest",
      source: "https://example.invalid/café",
    }),
    '{\n  "schema_version": 1,\n  "mode": "track-latest",\n  "source": "https://example.invalid/caf\\u00e9"\n}\n',
  );
  assert.equal(
    serializeRecord({
      schema_version: 1,
      mode: "pinned",
      source: "https://example.invalid/repo",
      requested_ref: "v1.2.3",
      resolved_ref: "v1.2.3",
      commit,
    }),
    '{\n  "schema_version": 1,\n  "mode": "pinned",\n  "source": "https://example.invalid/repo",\n  "requested_ref": "v1.2.3",\n  "resolved_ref": "v1.2.3",\n  "commit": "0123456789abcdef0123456789abcdef01234567"\n}\n',
  );
});

void test("FS-SELECTION-ATOMIC-01 selection rename failure preserves prior state and foreign temporary", async (t) => {
  const directory = await sandbox(t);
  const target = join(directory, "selection.json");
  const foreign = join(directory, ".selection.json.tmp.foreign");
  const before = serializeRecord({
    schema_version: 1,
    mode: "track-latest",
    source: "https://example.invalid/before",
  });
  await writeFile(target, before, { mode: 0o600 });
  await writeFile(foreign, "keep");
  /** @type {number | undefined} */
  let temporaryMode;
  const error = await selectionFailure(
    writeSelectionState(
      target,
      {
        schema_version: 1,
        mode: "track-latest",
        source: "https://example.invalid/after",
      },
      {
        hooks: {
          rename: async (temporary, destination) => {
            assert.equal(destination, target);
            assert.ok(typeof temporary === "string");
            assert.ok(
              temporary.startsWith(join(directory, ".selection.json.tmp.")),
            );
            temporaryMode = (await stat(temporary)).mode & 0o777;
            throw Object.assign(new Error("rename failed"), { code: "EIO" });
          },
        },
      },
    ),
  );
  assert.equal(temporaryMode, 0o600);
  assert.match(error.message, /^cannot write selection state:/);
  assert.equal(await readFile(target, "utf8"), before);
  assert.equal(await readFile(foreign, "utf8"), "keep");
  assert.deepEqual(
    (await readdir(directory)).filter(
      (name) =>
        name.startsWith(".selection.json.tmp.") &&
        name !== ".selection.json.tmp.foreign",
    ),
    [],
  );
});

void test("FS-SELECTION-POST-REPLACE-01 selection write reports final landed mode", async (t) => {
  const directory = await sandbox(t);
  const target = join(directory, "selection.json");
  const error = await selectionFailure(
    writeSelectionState(
      target,
      {
        schema_version: 1,
        mode: "pinned",
        source: "https://example.invalid/repo",
        requested_ref: "v1.2.3",
        resolved_ref: "v1.2.3",
        commit,
      },
      {
        hooks: {
          afterReplace: async () => {
            throw new Error("completion uncertain");
          },
        },
      },
    ),
  );
  assert.match(
    error.message,
    /^cannot complete selection state write: .*; selection state is now pinned$/,
  );
  assert.equal((await readSelectionState(target))?.mode, "pinned");
});

void test("selection reader preserves frozen malformed-JSON and UTF-8 classifications", async (t) => {
  const directory = await sandbox(t);
  const target = join(directory, "selection.json");
  await writeFile(target, "{\n");
  const malformed = await selectionFailure(readSelectionState(target));
  assert.equal(
    malformed.message,
    `invalid JSON in ${target}: line 2 column 1: Expecting property name enclosed in double quotes`,
  );

  await writeFile(target, Uint8Array.from([0xc3, 0x28]));
  const invalidUtf8 = await selectionFailure(readSelectionState(target));
  assert.ok(
    invalidUtf8.message.startsWith(`cannot read selection state ${target}: `),
  );
});

void test("selection reader rejects non-integer schema number tokens", async (t) => {
  const directory = await sandbox(t);
  const target = join(directory, "selection.json");
  for (const version of ["1.0", "1e0"]) {
    await writeFile(
      target,
      `{"schema_version":${version},"mode":"track-latest","source":"https://example.invalid/repo"}`,
    );
    const error = await selectionFailure(readSelectionState(target));
    assert.match(error.message, /invalid JSON/);
  }
});

void test("pinned writes preserve directory, existing-state, then proposed-record validation order", async (t) => {
  const directory = await sandbox(t);
  const stateDirectory = join(directory, "config");
  const target = join(stateDirectory, "selection.json");
  /** @type {import("../../src/selection.js").PinnedSelectionRecord} */
  const invalidProposed = {
    schema_version: 1,
    mode: "pinned",
    source: "",
    requested_ref: "v1.2.3",
    resolved_ref: "v1.2.3",
    commit,
  };

  const proposedError = await selectionFailure(
    writeSelectionState(target, invalidProposed),
  );
  assert.match(
    proposedError.message,
    /source must be a non-empty single-line string/,
  );
  assert.equal((await stat(stateDirectory)).mode & 0o777, 0o700);

  await writeFile(target, "{\n");
  const existingError = await selectionFailure(
    writeSelectionState(target, invalidProposed),
  );
  assert.match(
    existingError.message,
    /Expecting property name enclosed in double quotes/,
  );
});

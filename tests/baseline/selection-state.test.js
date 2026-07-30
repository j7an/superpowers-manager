// @ts-check

// Migrated from tests/test_selection_state.py. The Python suite was a pure
// subprocess harness over dist/selection-state-cli.js, so every case here is a
// driver translation: same inputs, same expected diagnostics, same exit codes.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HELPER = fileURLToPath(
  new URL("../../dist/selection-state-cli.js", import.meta.url),
);
const BARRIER = fileURLToPath(
  new URL("./selection-write-barrier.js", import.meta.url),
);
const FIXTURES = fileURLToPath(
  new URL("../fixtures/baseline/selection/", import.meta.url),
);

const SOURCE = "https://github.com/obra/superpowers";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER_COMMIT = "89abcdef0123456789abcdef0123456789abcdef";
const PINNED = {
  schema_version: 1,
  mode: "pinned",
  source: SOURCE,
  requested_ref: "v6.1.1",
  resolved_ref: "v6.1.1",
  commit: COMMIT,
};
const TRACK_LATEST = {
  schema_version: 1,
  mode: "track-latest",
  source: SOURCE,
};
const NORMALIZED_ABSENT = {
  saved_mode: "none",
  saved_source: "",
  saved_requested_ref: "",
  saved_resolved_ref: "",
  saved_commit: "",
};

const BARRIER_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 5;

/** @typedef {{status: number, stdout: string, stderr: string}} HelperResult */

/**
 * @param {readonly string[]} argumentList
 * @returns {HelperResult}
 */
function runHelper(argumentList) {
  const result = spawnSync(process.execPath, [HELPER, ...argumentList], {
    encoding: "utf8",
  });
  if (result.error) assert.fail("could not start the selection state helper");
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/**
 * @param {readonly string[]} argumentList
 * @returns {Promise<HelperResult>}
 */
function runHelperAsync(argumentList) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HELPER, ...argumentList], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", () => {
      reject(new Error("could not start the selection state helper"));
    });
    child.on("close", (code) => {
      resolve({ status: code ?? 1, stdout, stderr });
    });
  });
}

/** @typedef {{base: string, statePath: string, output: string}} Fixture */

/**
 * @param {import("node:test").TestContext} t
 * @returns {Fixture}
 */
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "spw-selection-"));
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
  });
  return {
    base,
    statePath: join(base, "config", "selection.json"),
    output: join(base, "normalized.json"),
  };
}

/** @param {Fixture} state */
function ensureStateDirectory(state) {
  mkdirSync(dirname(state.statePath), { recursive: true, mode: 0o700 });
}

/** @param {string} name */
function fixtureText(name) {
  return readFileSync(join(FIXTURES, name), "utf8");
}

/**
 * @param {Fixture} state
 * @param {string} [path]
 * @returns {HelperResult}
 */
function readState(state, path) {
  return runHelper([
    "read",
    "--path",
    path ?? state.statePath,
    "--output",
    state.output,
  ]);
}

/**
 * @param {Fixture} state
 * @param {string} raw
 * @returns {HelperResult}
 */
function readRaw(state, raw) {
  ensureStateDirectory(state);
  writeFileSync(state.statePath, raw, "utf8");
  return readState(state);
}

/**
 * @param {Fixture} state
 * @param {unknown} record
 * @returns {Record<string, string>}
 */
function readRecord(state, record) {
  ensureStateDirectory(state);
  writeFileSync(state.statePath, `${JSON.stringify(record)}\n`, "utf8");
  const result = readState(state);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(readFileSync(state.output, "utf8"));
}

/** @param {HelperResult} result */
function assertControlledError(result) {
  const lines =
    result.stderr.length === 0
      ? []
      : result.stderr.replace(/\n$/, "").split("\n");
  assert.equal(lines.length, 1, result.stdout + result.stderr);
  assert.equal(lines[0].startsWith("error: "), true, result.stderr);
}

/**
 * @param {Fixture} state
 * @param {string} raw
 * @param {string} [fragment]
 */
function assertReadFails(state, raw, fragment) {
  const result = readRaw(state, raw);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, "");
  assertControlledError(result);
  if (fragment !== undefined) {
    assert.equal(result.stderr.includes(fragment), true, result.stderr);
  }
}

/** @param {string} source */
function assertSourceValid(source) {
  const result = runHelper(["validate-source", "--source", source]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
}

/** @param {string} source */
function assertSourceInvalid(source) {
  const result = runHelper(["validate-source", "--source", source]);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, "");
  assertControlledError(result);
}

/**
 * @param {Fixture} state
 * @param {{path?: string, source?: string, requestedRef?: string,
 *   resolvedRef?: string, commit?: string}} [overrides]
 * @returns {HelperResult}
 */
function writePinned(state, overrides = {}) {
  return runHelper([
    "write-pinned",
    "--path",
    overrides.path ?? state.statePath,
    "--source",
    overrides.source ?? SOURCE,
    "--requested-ref",
    overrides.requestedRef ?? "v6.1.1",
    "--resolved-ref",
    overrides.resolvedRef ?? "v6.1.1",
    "--commit",
    overrides.commit ?? COMMIT,
  ]);
}

/**
 * @param {Fixture} state
 * @param {{path?: string, source?: string}} [overrides]
 * @returns {HelperResult}
 */
function writeTrackLatest(state, overrides = {}) {
  return runHelper([
    "write-track-latest",
    "--path",
    overrides.path ?? state.statePath,
    "--source",
    overrides.source ?? SOURCE,
  ]);
}

/**
 * @param {unknown} actual
 * @param {readonly unknown[]} candidates
 * @returns {boolean}
 */
function deepEqualsAny(actual, candidates) {
  return candidates.some((candidate) => {
    try {
      assert.deepEqual(actual, candidate);
      return true;
    } catch {
      return false;
    }
  });
}

void test("SEL-SCHEMA-MODES-01 read normalizes absent, pinned, and track-latest state", (t) => {
  const state = fixture(t);
  const absent = join(state.base, "absent.json");
  const result = runHelper([
    "read",
    "--path",
    state.statePath,
    "--output",
    absent,
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(absent, "utf8")), NORMALIZED_ABSENT);
  const pinned = readRaw(state, fixtureText("pinned-tag.json"));
  assert.equal(pinned.status, 0, pinned.stdout + pinned.stderr);
  assert.equal(
    JSON.parse(readFileSync(state.output, "utf8")).saved_commit,
    PINNED.commit,
  );
  const latest = readRaw(state, fixtureText("track-latest.json"));
  assert.equal(latest.status, 0, latest.stdout + latest.stderr);
  assert.equal(
    JSON.parse(readFileSync(state.output, "utf8")).saved_mode,
    "track-latest",
  );
});

void test("SEL-SCHEMA-KEYS-01 read rejects unknown, missing, and inconsistent fields", (t) => {
  const state = fixture(t);
  for (const raw of [
    fixtureText("unknown-key.json"),
    JSON.stringify({ schema_version: 1, mode: "pinned", source: "x" }),
    JSON.stringify({ ...PINNED, resolved_ref: "v6.1.2" }),
    JSON.stringify({ ...PINNED, commit: PINNED.commit.toUpperCase() }),
    JSON.stringify({ ...TRACK_LATEST, schema_version: true }),
    fixtureText("wrong-schema-version.json"),
  ]) {
    assertReadFails(state, raw);
  }
});

void test("SEL-READER-DUPLICATES-01 read rejects duplicate JSON keys", (t) => {
  const state = fixture(t);
  assertReadFails(
    state,
    fixtureText("duplicate-key.json"),
    "duplicate JSON key: schema_version",
  );
});

void test("SEL-READER-CONSTANTS-01 read rejects non-object documents and non-standard constants", (t) => {
  const state = fixture(t);
  for (const raw of [
    fixtureText("wrong-top-level-type.json"),
    '"value"',
    "null",
    fixtureText("non-standard-constant.json"),
    "Infinity",
    "-Infinity",
  ]) {
    assertReadFails(state, raw);
  }
});

void test("SEL-READER-DEPTH-01 read enforces the exact JSON nesting boundary", (t) => {
  const state = fixture(t);
  const atLimit = `${"[".repeat(256)}0${"]".repeat(256)}`;
  assertReadFails(state, atLimit, "selection state must be a JSON object");
  assertReadFails(
    state,
    fixtureText("depth-257.json"),
    "JSON nesting exceeds limit",
  );
});

void test("SEL-READER-BYTES-01 read has no input byte limit", (t) => {
  const state = fixture(t);
  const raw = fixtureText("track-latest.json") + " ".repeat(1_048_576 + 1);
  const result = readRaw(state, raw);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(
    JSON.parse(readFileSync(state.output, "utf8")).saved_mode,
    "track-latest",
  );
});

// No behavior ID: this case restores no mapped ID and mints none. It guards the
// controlled-failure surface for a number too large to represent, which ID
// accounting cannot detect the loss of.
void test("read rejects an oversized integer as a controlled schema failure", (t) => {
  const state = fixture(t);
  const oversizedInteger = "9".repeat(5000);
  assertReadFails(state, `{"schema_version":${oversizedInteger}}`);
});

void test("SEL-SCHEMA-REFS-01 read rejects empty, multiline, and invalid ref strings", (t) => {
  const state = fixture(t);
  const prerelease = {
    ...PINNED,
    requested_ref: "v1.2.3-rc.1",
    resolved_ref: "v1.2.3-rc.1",
  };
  const accepted = readRaw(state, JSON.stringify(prerelease));
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  const invalidRecords = [
    { ...TRACK_LATEST, source: "" },
    { ...TRACK_LATEST, source: "local\npath" },
    { ...TRACK_LATEST, source: "local\0path" },
    { ...PINNED, requested_ref: "" },
    { ...PINNED, requested_ref: "v6.1.1\n", resolved_ref: "v6.1.1\n" },
    { ...PINNED, requested_ref: "v6.1.1\0", resolved_ref: "v6.1.1\0" },
    { ...PINNED, requested_ref: "6.1.1", resolved_ref: "6.1.1" },
    { ...PINNED, requested_ref: "v01.2.3", resolved_ref: "v01.2.3" },
    { ...PINNED, requested_ref: "v1.02.3", resolved_ref: "v1.02.3" },
    { ...PINNED, requested_ref: "v1.2.03", resolved_ref: "v1.2.03" },
    { ...PINNED, requested_ref: "v1.2.3-01", resolved_ref: "v1.2.3-01" },
    { ...PINNED, requested_ref: "v1.2.3+build", resolved_ref: "v1.2.3+build" },
    {
      ...PINNED,
      requested_ref: "latest-release",
      resolved_ref: "latest-release",
    },
  ];
  for (const record of invalidRecords) {
    assertReadFails(state, JSON.stringify(record));
  }
});

void test("SEL-SCHEMA-COMMIT-01 raw commit pins require cross-field equality", (t) => {
  const state = fixture(t);
  const raw = {
    ...PINNED,
    requested_ref: COMMIT,
    resolved_ref: COMMIT,
    commit: COMMIT,
  };
  assert.equal(readRecord(state, raw).saved_requested_ref, COMMIT);
  for (const field of ["requested_ref", "resolved_ref", "commit"]) {
    assertReadFails(state, JSON.stringify({ ...raw, [field]: OTHER_COMMIT }));
  }
  for (const invalidCommit of [
    COMMIT.slice(0, -1),
    COMMIT.toUpperCase(),
    `g${COMMIT.slice(1)}`,
  ]) {
    assertReadFails(
      state,
      JSON.stringify({
        ...raw,
        requested_ref: invalidCommit,
        resolved_ref: invalidCommit,
        commit: invalidCommit,
      }),
    );
  }
});

void test("SEL-SCHEMA-SOURCE-01 source validation rejects HTTP(S) userinfo only", () => {
  for (const source of [
    SOURCE,
    "http://example.invalid/repo",
    "ssh://git@github.com/obra/superpowers.git",
    "git@github.com:obra/superpowers.git",
    "/tmp/local upstream",
  ]) {
    assertSourceValid(source);
  }
  for (const source of [
    "https://user:password@example.invalid/repo",
    "https://token@example.invalid/repo",
    "http://user@example.invalid/repo",
    "https://[invalid/repo",
  ]) {
    assertSourceInvalid(source);
    const displayed = runHelper(["display-source", "--source", source]);
    assert.equal(displayed.status, 0, displayed.stderr);
    assert.equal(displayed.stdout, "<redacted-source>\n");
  }
  const displayed = runHelper(["display-source", "--source", SOURCE]);
  assert.equal(displayed.status, 0, displayed.stderr);
  assert.equal(displayed.stdout, `${SOURCE}\n`);
});

void test("SEL-READER-PATHS-01 read rejects symlink, directory, and FIFO paths", (t) => {
  const state = fixture(t);
  const parent = dirname(state.statePath);
  mkdirSync(parent, { mode: 0o700 });
  const real = join(parent, "real.json");
  writeFileSync(real, JSON.stringify(TRACK_LATEST), "utf8");
  const symlink = join(parent, "symlink.json");
  symlinkSync(real, symlink);
  const directory = join(parent, "directory.json");
  mkdirSync(directory);
  const fifo = join(parent, "fifo.json");
  execFileSync("mkfifo", [fifo]);
  for (const path of [symlink, directory, fifo]) {
    const result = readState(state, path);
    assert.notEqual(result.status, 0);
    assertControlledError(result);
  }
});

void test("SEL-READER-PARENT-01 read rejects absent state below a symlinked config directory", (t) => {
  const state = fixture(t);
  const realDirectory = join(state.base, "real-config");
  mkdirSync(realDirectory, { mode: 0o700 });
  const linkedDirectory = join(state.base, "linked-config");
  symlinkSync(realDirectory, linkedDirectory, "dir");
  const result = readState(state, join(linkedDirectory, "selection.json"));
  assert.notEqual(result.status, 0);
  assert.equal(
    result.stderr.includes("directory must not be a symlink"),
    true,
    result.stderr,
  );
  assertControlledError(result);
});

void test("SEL-BYTES-DIRECTORY-01 the writer creates a private directory and a canonical private file", (t) => {
  const state = fixture(t);
  const result = writePinned(state);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(statSync(dirname(state.statePath)).mode & 0o777, 0o700);
  assert.equal(statSync(state.statePath).mode & 0o777, 0o600);
  const expected = `${JSON.stringify(PINNED, null, 2)}\n`;
  assert.equal(readFileSync(state.statePath, "utf8"), expected);
});

void test("SEL-BYTES-DIRECTORY-PRESERVE-01 the writer preserves an existing directory mode", (t) => {
  const state = fixture(t);
  const parent = dirname(state.statePath);
  mkdirSync(parent, { mode: 0o750 });
  chmodSync(parent, 0o750);
  const result = writeTrackLatest(state);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(statSync(parent).mode & 0o777, 0o750);
  assert.equal(statSync(state.statePath).mode & 0o777, 0o600);
});

void test("SEL-SCHEMA-COMMIT-WRITE-01 the writer normalizes raw commit input to lowercase", (t) => {
  const state = fixture(t);
  const upper = COMMIT.toUpperCase();
  const result = writePinned(state, {
    requestedRef: upper,
    resolvedRef: upper,
    commit: upper,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(state.statePath, "utf8")), {
    ...PINNED,
    requested_ref: COMMIT,
    resolved_ref: COMMIT,
    commit: COMMIT,
  });
});

// No behavior ID: this case restores no mapped ID and mints none. It guards the
// rollback surface — a rejected write must leave the previous bytes intact —
// which ID accounting cannot detect the loss of.
void test("the atomic writer preserves valid state on failure", (t) => {
  const state = fixture(t);
  const first = writePinned(state);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const before = readFileSync(state.statePath);
  const result = writePinned(state, {
    source: "https://token@example.invalid/repo",
    requestedRef: "v6.1.2",
    resolvedRef: "v6.1.2",
    commit: OTHER_COMMIT,
  });
  assert.notEqual(result.status, 0);
  assert.deepEqual(readFileSync(state.statePath), before);
});

void test("FS-SELECTION-TYPES-01 the writer rejects unexpected state and parent path types", (t) => {
  const state = fixture(t);
  const parent = dirname(state.statePath);
  mkdirSync(parent, { mode: 0o700 });
  const target = join(parent, "target");
  writeFileSync(target, "target", "utf8");
  const symlink = join(parent, "selection-link.json");
  symlinkSync(target, symlink);
  const directory = join(parent, "selection-dir.json");
  mkdirSync(directory);
  const fifo = join(parent, "selection-fifo.json");
  execFileSync("mkfifo", [fifo]);
  const parentLink = join(state.base, "config-link");
  symlinkSync(parent, parentLink, "dir");
  for (const path of [
    symlink,
    directory,
    fifo,
    join(parentLink, "selection.json"),
  ]) {
    const result = writeTrackLatest(state, { path });
    assert.notEqual(result.status, 0);
    assertControlledError(result);
  }
});

/**
 * Blocks until the barrier child signals that it is paused inside the atomic
 * write's rename seam. Deterministic: the parent waits for the signal rather
 * than racing it, and fails closed on a deadline or an early child exit.
 *
 * @param {string} marker
 * @param {() => boolean} childExited
 */
async function waitForPause(marker, childExited) {
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;
  while (!existsSync(marker)) {
    if (childExited()) {
      assert.fail("the barrier writer exited before it paused");
    }
    if (Date.now() > deadline) {
      assert.fail("the barrier writer never paused");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

void test("FS-SELECTION-CONCURRENT-01 concurrent writers leave one complete valid record", async (t) => {
  const state = fixture(t);

  // Two concurrent writers must both succeed and leave exactly one of the two
  // complete records behind.
  const results = await Promise.all([
    runHelperAsync([
      "write-pinned",
      "--path",
      state.statePath,
      "--source",
      SOURCE,
      "--requested-ref",
      "v6.1.1",
      "--resolved-ref",
      "v6.1.1",
      "--commit",
      COMMIT,
    ]),
    runHelperAsync([
      "write-track-latest",
      "--path",
      state.statePath,
      "--source",
      SOURCE,
    ]),
  ]);
  for (const result of results) {
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  const final = JSON.parse(readFileSync(state.statePath, "utf8"));
  assert.equal(
    deepEqualsAny(final, [PINNED, TRACK_LATEST]),
    true,
    readFileSync(state.statePath, "utf8"),
  );
  const normalized = readRecord(state, final);
  assert.equal(
    ["pinned", "track-latest"].includes(normalized.saved_mode),
    true,
    normalized.saved_mode,
  );

  // Deterministic barrier. The child pauses inside the write's rename seam and
  // only resumes once this test releases it, so the read below is taken at a
  // known in-flight moment on every run. An atomic write can only expose the
  // previous complete record; a non-atomic write exposes its partial bytes.
  const initial = writePinned(state);
  assert.equal(initial.status, 0, initial.stdout + initial.stderr);
  const pausedMarker = join(state.base, "paused");
  const releaseMarker = join(state.base, "release");
  const child = spawn(
    process.execPath,
    [BARRIER, state.statePath, pausedMarker, releaseMarker, SOURCE],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let childStderr = "";
  let exited = false;
  child.stdout.resume();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    childStderr += String(chunk);
  });
  /** @type {Promise<number>} */
  const closed = new Promise((resolve) => {
    child.on("close", (code) => {
      exited = true;
      resolve(code ?? 1);
    });
  });
  // A failed assertion must not leave the paused writer behind. The scratch
  // tree is already gone by the time cleanup hooks run, so release the child
  // by signal rather than by marker.
  t.after(() => {
    if (!exited) child.kill("SIGKILL");
  });

  await waitForPause(pausedMarker, () => exited);
  const during = readState(state);
  writeFileSync(releaseMarker, "go", "utf8");
  assert.equal(await closed, 0, childStderr);

  assert.equal(during.status, 0, during.stdout + during.stderr);
  assert.equal(during.stderr, "");
  const observed = JSON.parse(readFileSync(state.output, "utf8"));
  assert.equal(
    ["pinned", "track-latest"].includes(observed.saved_mode),
    true,
    `a read during an in-flight write observed ${JSON.stringify(observed)}`,
  );
  assert.equal(observed.saved_mode, "pinned");

  const after = readState(state);
  assert.equal(after.status, 0, after.stdout + after.stderr);
  assert.equal(
    JSON.parse(readFileSync(state.output, "utf8")).saved_mode,
    "track-latest",
  );
});

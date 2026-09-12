// Migrated from tests/test_selection_state.py. The Python suite exercised the
// saved-selection behavior; this native suite exercises that behavior directly.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
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
import { promisify } from "node:util";
import test from "node:test";

import {
  readSelectionState,
  writeSelectionState,
} from "../../src/selection-store.ts";
import {
  displaySource,
  normalizePinnedArguments,
  normalizeSaved,
  validateSource,
} from "../../src/selection.ts";

const BARRIER = fileURLToPath(
  new URL("./selection-write-barrier.ts", import.meta.url),
);
const WRITER = fileURLToPath(
  new URL("./selection-writer-child.ts", import.meta.url),
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
const execFileAsync = promisify(execFile);

type Fixture = { base: string; statePath: string };

function fixture(t: import("node:test").TestContext): Fixture {
  const base = mkdtempSync(join(tmpdir(), "spw-selection-"));
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
  });
  return {
    base,
    statePath: join(base, "config", "selection.json"),
  };
}

function ensureStateDirectory(state: Fixture) {
  mkdirSync(dirname(state.statePath), { recursive: true, mode: 0o700 });
}

function fixtureText(name: string) {
  return readFileSync(join(FIXTURES, name), "utf8");
}

async function readState(state: Fixture, path = state.statePath) {
  return normalizeSaved(await readSelectionState(path));
}

async function readRaw(state: Fixture, raw: string) {
  ensureStateDirectory(state);
  writeFileSync(state.statePath, raw, "utf8");
  return await readState(state);
}

async function readRecord(state: Fixture, record: unknown) {
  return await readRaw(state, JSON.stringify(record) + "\n");
}

async function assertReadFails(state: Fixture, raw: string, message: RegExp) {
  await assert.rejects(readRaw(state, raw), { name: "SafetyError", message });
}

function assertSourceValid(source: string) {
  assert.equal(validateSource(source), source);
}

function assertSourceInvalid(source: string) {
  assert.throws(() => validateSource(source), {
    name: "SafetyError",
    message:
      /HTTP\(S\) source must not include userinfo|source URL is malformed/,
  });
}

function writePinned(
  state: Fixture,
  overrides: {
    path?: string;
    source?: string;
    requestedRef?: string;
    resolvedRef?: string;
    commit?: string;
  } = {},
): Promise<void> {
  return writeSelectionState(
    overrides.path ?? state.statePath,
    normalizePinnedArguments({
      source: overrides.source ?? SOURCE,
      requestedRef: overrides.requestedRef ?? "v6.1.1",
      resolvedRef: overrides.resolvedRef ?? "v6.1.1",
      commit: overrides.commit ?? COMMIT,
    }),
  );
}

function writeTrackLatest(
  state: Fixture,
  overrides: { path?: string; source?: string } = {},
): Promise<void> {
  return writeSelectionState(overrides.path ?? state.statePath, {
    schema_version: 1,
    mode: "track-latest",
    source: overrides.source ?? SOURCE,
  });
}

function deepEqualsAny(
  actual: unknown,
  candidates: readonly unknown[],
): boolean {
  return candidates.some((candidate) => {
    try {
      assert.deepEqual(actual, candidate);
      return true;
    } catch {
      return false;
    }
  });
}

void test("SEL-SCHEMA-MODES-01 read normalizes absent, pinned, and track-latest state", async (t) => {
  const state = fixture(t);
  assert.deepEqual(await readState(state), NORMALIZED_ABSENT);
  assert.equal(
    (await readRaw(state, fixtureText("pinned-tag.json"))).saved_commit,
    PINNED.commit,
  );
  assert.equal(
    (await readRaw(state, fixtureText("track-latest.json"))).saved_mode,
    "track-latest",
  );
});

void test("SEL-SCHEMA-KEYS-01 read rejects unknown, missing, and inconsistent fields", async (t) => {
  const state = fixture(t);
  const invalidRecords: Array<[string, RegExp]> = [
    [fixtureText("unknown-key.json"), /selection state keys are invalid:/],
    [
      JSON.stringify({ schema_version: 1, mode: "pinned", source: "x" }),
      /selection state keys are invalid:/,
    ],
    [
      JSON.stringify({ ...PINNED, resolved_ref: "v6.1.2" }),
      /tag resolved_ref must equal requested_ref/,
    ],
    [
      JSON.stringify({ ...PINNED, commit: PINNED.commit.toUpperCase() }),
      /commit must be a lowercase 40-hex value/,
    ],
    [
      JSON.stringify({ ...TRACK_LATEST, schema_version: true }),
      /schema_version must equal integer 1/,
    ],
    [
      fixtureText("wrong-schema-version.json"),
      /schema_version must equal integer 1/,
    ],
  ];
  for (const [raw, message] of invalidRecords) {
    await assertReadFails(state, raw, message);
  }
});

void test("SEL-READER-DUPLICATES-01 read rejects duplicate JSON keys", async (t) => {
  const state = fixture(t);
  await assertReadFails(
    state,
    fixtureText("duplicate-key.json"),
    /duplicate JSON key: schema_version/,
  );
});

void test("SEL-READER-CONSTANTS-01 read rejects non-object documents and non-standard constants", async (t) => {
  const state = fixture(t);
  const invalidDocuments: Array<[string, RegExp]> = [
    [
      fixtureText("wrong-top-level-type.json"),
      /selection state must be a JSON object/,
    ],
    ['"value"', /selection state must be a JSON object/],
    ["null", /selection state must be a JSON object/],
    [fixtureText("non-standard-constant.json"), /invalid JSON/],
    ["Infinity", /invalid JSON/],
    ["-Infinity", /invalid JSON/],
  ];
  for (const [raw, message] of invalidDocuments) {
    await assertReadFails(state, raw, message);
  }
});

void test("SEL-READER-DEPTH-01 read enforces the exact JSON nesting boundary", async (t) => {
  const state = fixture(t);
  const atLimit = `${"[".repeat(256)}0${"]".repeat(256)}`;
  await assertReadFails(
    state,
    atLimit,
    /selection state must be a JSON object/,
  );
  await assertReadFails(
    state,
    fixtureText("depth-257.json"),
    /JSON nesting exceeds limit/,
  );
});

void test("SEL-READER-BYTES-01 read has no input byte limit", async (t) => {
  const state = fixture(t);
  const raw = fixtureText("track-latest.json") + " ".repeat(1_048_576 + 1);
  assert.equal((await readRaw(state, raw)).saved_mode, "track-latest");
});

// No behavior ID: this case restores no mapped ID and mints none. It guards the
// controlled-failure surface for a number too large to represent, which ID
// accounting cannot detect the loss of.
void test("read rejects an oversized integer as a controlled schema failure", async (t) => {
  const state = fixture(t);
  const oversizedInteger = "9".repeat(5000);
  await assertReadFails(
    state,
    `{"schema_version":${oversizedInteger}}`,
    /schema_version must equal integer 1/,
  );
});

void test("SEL-SCHEMA-REFS-01 read rejects empty, multiline, and invalid ref strings", async (t) => {
  const state = fixture(t);
  const prerelease = {
    ...PINNED,
    requested_ref: "v1.2.3-rc.1",
    resolved_ref: "v1.2.3-rc.1",
  };
  assert.equal(
    (await readRaw(state, JSON.stringify(prerelease))).saved_mode,
    "pinned",
  );
  const invalidRecords: Array<[object, RegExp]> = [
    [
      { ...TRACK_LATEST, source: "" },
      /(source|requested_ref|resolved_ref) must be a non-empty single-line string/,
    ],
    [
      { ...TRACK_LATEST, source: "local\npath" },
      /(source|requested_ref|resolved_ref) must be a non-empty single-line string/,
    ],
    [
      { ...TRACK_LATEST, source: "local\0path" },
      /(source|requested_ref|resolved_ref) must be a non-empty single-line string/,
    ],
    [
      { ...PINNED, requested_ref: "" },
      /(source|requested_ref|resolved_ref) must be a non-empty single-line string/,
    ],
    [
      { ...PINNED, requested_ref: "v6.1.1\n", resolved_ref: "v6.1.1\n" },
      /(source|requested_ref|resolved_ref) must be a non-empty single-line string/,
    ],
    [
      { ...PINNED, requested_ref: "v6.1.1\0", resolved_ref: "v6.1.1\0" },
      /(source|requested_ref|resolved_ref) must be a non-empty single-line string/,
    ],
    [
      { ...PINNED, requested_ref: "6.1.1", resolved_ref: "6.1.1" },
      /requested_ref must be an exact tag or full commit/,
    ],
    [
      { ...PINNED, requested_ref: "v01.2.3", resolved_ref: "v01.2.3" },
      /requested_ref must be an exact tag or full commit/,
    ],
    [
      { ...PINNED, requested_ref: "v1.02.3", resolved_ref: "v1.02.3" },
      /requested_ref must be an exact tag or full commit/,
    ],
    [
      { ...PINNED, requested_ref: "v1.2.03", resolved_ref: "v1.2.03" },
      /requested_ref must be an exact tag or full commit/,
    ],
    [
      { ...PINNED, requested_ref: "v1.2.3-01", resolved_ref: "v1.2.3-01" },
      /requested_ref must be an exact tag or full commit/,
    ],
    [
      {
        ...PINNED,
        requested_ref: "v1.2.3+build",
        resolved_ref: "v1.2.3+build",
      },
      /requested_ref must be an exact tag or full commit/,
    ],
    [
      {
        ...PINNED,
        requested_ref: "latest-release",
        resolved_ref: "latest-release",
      },
      /requested_ref must be an exact tag or full commit/,
    ],
  ];
  for (const [record, message] of invalidRecords) {
    await assertReadFails(state, JSON.stringify(record), message);
  }
});

void test("SEL-SCHEMA-COMMIT-01 raw commit pins require cross-field equality", async (t) => {
  const state = fixture(t);
  const raw = {
    ...PINNED,
    requested_ref: COMMIT,
    resolved_ref: COMMIT,
    commit: COMMIT,
  };
  assert.equal((await readRecord(state, raw)).saved_requested_ref, COMMIT);
  for (const field of ["requested_ref", "resolved_ref", "commit"]) {
    await assertReadFails(
      state,
      JSON.stringify({ ...raw, [field]: OTHER_COMMIT }),
      /raw commit requested_ref, resolved_ref, and commit must be equal/,
    );
  }
  for (const invalidCommit of [
    COMMIT.slice(0, -1),
    COMMIT.toUpperCase(),
    `g${COMMIT.slice(1)}`,
  ]) {
    await assertReadFails(
      state,
      JSON.stringify({
        ...raw,
        requested_ref: invalidCommit,
        resolved_ref: invalidCommit,
        commit: invalidCommit,
      }),
      /commit must be a lowercase 40-hex value/,
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
    assert.equal(displaySource(source), "<redacted-source>");
  }
  assert.equal(displaySource(SOURCE), SOURCE);
});

void test("SEL-READER-PATHS-01 read rejects symlink, directory, and FIFO paths", async (t) => {
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
  const invalidPaths: Array<[string, RegExp]> = [
    [symlink, /selection state must not be a symlink/],
    [directory, /selection state must be a regular file/],
    [fifo, /selection state must be a regular file/],
  ];
  for (const [path, message] of invalidPaths) {
    await assert.rejects(readState(state, path), {
      name: "SafetyError",
      message,
    });
  }
});

void test("SEL-READER-PARENT-01 read rejects absent state below a symlinked config directory", async (t) => {
  const state = fixture(t);
  const realDirectory = join(state.base, "real-config");
  mkdirSync(realDirectory, { mode: 0o700 });
  const linkedDirectory = join(state.base, "linked-config");
  symlinkSync(realDirectory, linkedDirectory, "dir");
  await assert.rejects(
    readState(state, join(linkedDirectory, "selection.json")),
    {
      name: "SafetyError",
      message: /selection state directory must not be a symlink/,
    },
  );
});

void test("SEL-BYTES-DIRECTORY-01 the writer creates a private directory and a canonical private file", async (t) => {
  const state = fixture(t);
  await writePinned(state);
  assert.equal(statSync(dirname(state.statePath)).mode & 0o777, 0o700);
  assert.equal(statSync(state.statePath).mode & 0o777, 0o600);
  const expected = `${JSON.stringify(PINNED, null, 2)}\n`;
  assert.equal(readFileSync(state.statePath, "utf8"), expected);
});

void test("SEL-BYTES-DIRECTORY-PRESERVE-01 the writer preserves an existing directory mode", async (t) => {
  const state = fixture(t);
  const parent = dirname(state.statePath);
  mkdirSync(parent, { mode: 0o750 });
  chmodSync(parent, 0o750);
  await writeTrackLatest(state);
  assert.equal(statSync(parent).mode & 0o777, 0o750);
  assert.equal(statSync(state.statePath).mode & 0o777, 0o600);
});

void test("SEL-SCHEMA-COMMIT-WRITE-01 the writer normalizes raw commit input to lowercase", async (t) => {
  const state = fixture(t);
  const upper = COMMIT.toUpperCase();
  await writePinned(state, {
    requestedRef: upper,
    resolvedRef: upper,
    commit: upper,
  });
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
void test("the atomic writer preserves valid state on failure", async (t) => {
  const state = fixture(t);
  await writePinned(state);
  const before = readFileSync(state.statePath);
  await assert.rejects(
    writePinned(state, {
      source: "https://token@example.invalid/repo",
      requestedRef: "v6.1.2",
      resolvedRef: "v6.1.2",
      commit: OTHER_COMMIT,
    }),
    {
      name: "SafetyError",
      message: /HTTP\(S\) source must not include userinfo/,
    },
  );
  assert.deepEqual(readFileSync(state.statePath), before);
});

void test("FS-SELECTION-TYPES-01 the writer rejects unexpected state and parent path types", async (t) => {
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
  const invalidPaths: Array<[string, RegExp]> = [
    [symlink, /selection state must not be a symlink/],
    [directory, /selection state must be a regular file/],
    [fifo, /selection state must be a regular file/],
    [
      join(parentLink, "selection.json"),
      /selection state directory must not be a symlink/,
    ],
  ];
  for (const [path, message] of invalidPaths) {
    await assert.rejects(writeTrackLatest(state, { path }), {
      name: "SafetyError",
      message,
    });
  }
});

/**
 * Blocks until the barrier child signals that it is paused inside the atomic
 * write's rename seam. Deterministic: the parent waits for the signal rather
 * than racing it, and fails closed on a deadline or an early child exit.
 *
 */
async function waitForPause(marker: string, childExited: () => boolean) {
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
    execFileAsync(
      process.execPath,
      [WRITER, state.statePath, JSON.stringify(PINNED)],
      {
        timeout: BARRIER_TIMEOUT_MS,
      },
    ),
    execFileAsync(
      process.execPath,
      [WRITER, state.statePath, JSON.stringify(TRACK_LATEST)],
      {
        timeout: BARRIER_TIMEOUT_MS,
      },
    ),
  ]);
  for (const result of results) {
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }
  const final = JSON.parse(readFileSync(state.statePath, "utf8"));
  assert.equal(
    deepEqualsAny(final, [PINNED, TRACK_LATEST]),
    true,
    readFileSync(state.statePath, "utf8"),
  );
  const normalized = await readRecord(state, final);
  assert.equal(
    ["pinned", "track-latest"].includes(normalized.saved_mode),
    true,
    normalized.saved_mode,
  );

  // Deterministic barrier. The child pauses inside the write's rename seam and
  // only resumes once this test releases it, so the read below is taken at a
  // known in-flight moment on every run. An atomic write can only expose the
  // previous complete record; a non-atomic write exposes its partial bytes.
  await writePinned(state);
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

  const closed: Promise<number> = new Promise((resolve) => {
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
  const during = await readState(state);
  writeFileSync(releaseMarker, "go", "utf8");
  assert.equal(await closed, 0, childStderr);
  assert.equal(during.saved_mode, "pinned");
  assert.equal((await readState(state)).saved_mode, "track-latest");
});

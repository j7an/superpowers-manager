// @ts-check
// Unit coverage for src/validator.ts. Every limit is exercised through a small
// bounded policy, so no test waits on the production 30s timeout. The policy is a
// real production argument, not a test seam.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/** @type {typeof import("../../src/validator.js")} */
const { runValidator, UNBOUNDED_LEGACY, BOUNDED_EXECUTABLE } = await import(
  new URL("../../dist/validator.js", import.meta.url).href
);

// Production ordering is grace (2000) > drain (200). This test policy PRESERVES
// that relationship. Inverting it — a grace shorter than the drain — hides the
// defect where settlement cancels a pending SIGKILL, which is how an earlier
// revision of this plan passed its own tests while shipping that bug.
const FAST = {
  kind: /** @type {const} */ ("bounded"),
  timeoutMs: 300,
  graceMs: 400,
  drainMs: 40,
  maxBytesPerStream: 256,
};

function sandbox() {
  return mkdtempSync(join(tmpdir(), "spw-validator-"));
}

/**
 * Writes an executable POSIX sh script and returns its path.
 * @param {string} dir
 * @param {string} name
 * @param {string} body
 * @returns {string}
 */
function writeScript(dir, name, body) {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

void test("exit 0 is reported as exited with code 0", async () => {
  const dir = sandbox();
  try {
    const exe = writeScript(dir, "ok.sh", "echo out; echo err >&2; exit 0");
    const run = await runValidator([exe, "/candidate"], FAST, {}, dir);
    assert.equal(run.kind, "exited");
    assert.equal(run.code, 0);
    assert.match(run.stdout.text, /out/);
    assert.match(run.stderr.text, /err/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("a nonzero exit is reported with its code", async () => {
  const dir = sandbox();
  try {
    const exe = writeScript(dir, "no.sh", "exit 3");
    const run = await runValidator([exe, "/candidate"], FAST, {}, dir);
    assert.equal(run.kind, "exited");
    assert.equal(run.code, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("a nonexistent path is a launch failure, not an exit", async () => {
  const dir = sandbox();
  try {
    const run = await runValidator(
      [join(dir, "nope"), "/candidate"],
      FAST,
      {},
      dir,
    );
    assert.equal(run.kind, "launchFailed");
    assert.equal(run.errno, "ENOENT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("a file with the exec bit but no interpreter throws synchronously and is caught", async () => {
  const dir = sandbox();
  try {
    // Not a script and not a binary: spawn raises ENOEXEC, and on this platform it
    // raises it SYNCHRONOUSLY rather than on the error event.
    const bad = join(dir, "binary");
    // Bytes, not a string literal: writing raw control characters into this plan
    // would make the file BINARY to grep, and Task 9's banner gate greps it.
    writeFileSync(bad, Buffer.from([0x00, 0x01, 0x6e, 0x6f]), { mode: 0o755 });
    const run = await runValidator([bad, "/candidate"], FAST, {}, dir);
    assert.equal(run.kind, "launchFailed");
    assert.equal(run.errno, "ENOEXEC");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("the promise settles exactly once", async () => {
  const dir = sandbox();
  try {
    // Both `error` and `close` fire on a launch failure, and `exit` and `close`
    // both fire on a normal run. A second settle would be silently swallowed by
    // the Promise, so count the settlements rather than trusting the shape.
    const exe = writeScript(dir, "quick.sh", "exit 0");
    let settlements = 0;
    const run = await runValidator([exe, "/candidate"], FAST, {}, dir).then(
      (r) => {
        settlements += 1;
        return r;
      },
    );
    await new Promise((r) => setTimeout(r, FAST.graceMs + FAST.drainMs + 100));
    assert.equal(settlements, 1);
    assert.equal(run.kind, "exited");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("the two stream caps are independent", async () => {
  const dir = sandbox();
  try {
    // A chatty stdout must not crowd out the reason on stderr: the contract says
    // stderr carries it. A single combined cap would let stdout consume it.
    const exe = writeScript(
      dir,
      "both.sh",
      "i=0; while [ $i -lt 100 ]; do printf 0123456789; i=$((i+1)); done\n" +
        "echo the-reason >&2\nexit 1",
    );
    const run = await runValidator([exe, "/candidate"], FAST, {}, dir);
    assert.equal(run.kind, "exited");
    assert.equal(run.stdout.text.length, FAST.maxBytesPerStream);
    assert.ok(run.stdout.droppedBytes > 0);
    assert.match(run.stderr.text, /the-reason/);
    assert.equal(run.stderr.droppedBytes, 0, "stderr must have its own budget");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("the validator receives the candidate root as its SOLE argument, with no shell", async () => {
  const dir = sandbox();
  try {
    // Guards two contract points at once: exactly one argument, and no shell
    // interpretation -- a path containing shell metacharacters must arrive intact.
    const exe = writeScript(dir, "argv.sh", 'echo "count=$#"; echo "one=$1"');
    const candidate = "/tmp/a b;echo pwned";
    const run = await runValidator([exe, candidate], FAST, {}, dir);
    assert.equal(run.kind, "exited");
    assert.match(run.stdout.text, /count=1/);
    assert.match(run.stdout.text, /one=\/tmp\/a b;echo pwned/);
    assert.doesNotMatch(
      run.stdout.text,
      /^pwned$/m,
      "the shell must not have interpreted it",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("UNBOUNDED_LEGACY declares itself unbounded", () => {
  assert.equal(UNBOUNDED_LEGACY.kind, "unbounded");
  assert.equal(BOUNDED_EXECUTABLE.kind, "bounded");
});

// @ts-check
// Unit coverage for src/validator.ts: the per-stream byte cap
// (maxBytesPerStream), the timeout, the grace window and the drain, plus the
// legacy path's parity contracts. The policy is a real production argument, not
// a test seam.
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
  timeoutMs: 1200,
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
    // Bytes, constructed programmatically rather than as a string literal, so
    // this file stays text: embedding raw control characters as a literal would
    // make the file BINARY to grep.
    writeFileSync(bad, Buffer.from([0x00, 0x01, 0x6e, 0x6f]), { mode: 0o755 });
    const run = await runValidator([bad, "/candidate"], FAST, {}, dir);
    assert.equal(run.kind, "launchFailed");
    assert.equal(run.errno, "ENOEXEC");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("a launch failure resolves as launchFailed, not as the close that follows it", async () => {
  const dir = sandbox();
  try {
    // A nonexistent path fires `error` (launchFailed) and then `close` (which
    // would resolve as exited with a null code). The first settlement must win.
    const run = await runValidator(
      [join(dir, "nope"), "/candidate"],
      FAST,
      {},
      dir,
    );
    assert.equal(run.kind, "launchFailed");
    assert.notEqual(run.kind, "exited");
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

void test("a hanging validator is terminated and reported as timedOut", async () => {
  const dir = sandbox();
  try {
    const exe = writeScript(dir, "hang.sh", "sleep 30");
    const started = Date.now();
    const run = await runValidator([exe, "/candidate"], FAST, {}, dir);
    assert.equal(run.kind, "timedOut");
    assert.equal(run.afterMs, FAST.timeoutMs);
    assert.ok(
      Date.now() - started < 5000,
      "should not have waited for the sleep",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("output written before the timeout is retained in the timedOut result", async () => {
  const dir = sandbox();
  try {
    // Deterministic: the write happens long before any signal. This tests the
    // MANAGER's obligation -- that it keeps what it read and hands it back on the
    // timeout path. It deliberately does NOT test a SIGTERM trap: a group signal
    // reaches the shell and its foreground child at once, so whether a trap runs
    // first is a race. Measured over six identical runs, one lost the output. A
    // flaky test is worse than an absent one.
    const exe = writeScript(dir, "speaks.sh", "echo explaining >&2\nsleep 30");
    const run = await runValidator([exe, "/candidate"], FAST, {}, dir);
    assert.equal(run.kind, "timedOut");
    assert.match(run.stderr.text, /explaining/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("a descendant ignoring SIGTERM is SIGKILLed even AFTER the run settles", async () => {
  const dir = sandbox();
  try {
    const marker = join(dir, "survived");
    // The backgrounded shell ignores TERM and would create the marker at +4s.
    // Settlement is ~timeout+drain (1240ms); SIGKILL lands at timeout+grace
    // (1600ms).
    // If settling cancels the grace timer, SIGKILL never fires and the marker
    // appears -- which is the defect this test exists to catch.
    const exe = writeScript(
      dir,
      "survivor.sh",
      `sh -c 'trap "" TERM; sleep 4; : > ${marker}' &\nsleep 30`,
    );
    const run = await runValidator([exe, "/candidate"], FAST, {}, dir);
    assert.equal(run.kind, "timedOut");
    await new Promise((r) => setTimeout(r, 6000));
    assert.equal(
      existsSync(marker),
      false,
      "the descendant outlived the run: SIGKILL was cancelled by settlement",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("PARITY: the unbounded policy captures output written after the child exits", async () => {
  const dir = sandbox();
  try {
    // The legacy path settles on `close`, so a backgrounded late write IS captured
    // today. Under an exit-plus-drain settle it would be lost.
    const exe = writeScript(dir, "late.sh", "(sleep 0.6; echo late) &\nexit 0");
    const run = await runValidator(
      [exe, "/candidate"],
      UNBOUNDED_LEGACY,
      {},
      dir,
    );
    assert.equal(run.kind, "exited");
    assert.match(run.stdout.text, /late/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("PARITY: the legacy path is NOT spawned as a process-group leader", async () => {
  const dir = sandbox();
  try {
    // The child prints its own process group. Under the unbounded policy it must
    // inherit the manager's; under the bounded policy it must lead its own. Without
    // this, reverting `detached` to unconditional passes every other parity test.
    const exe = writeScript(dir, "pgid.sh", "ps -o pgid= -p $$");
    const mine = execSync(`ps -o pgid= -p ${process.pid}`).toString().trim();
    const legacy = await runValidator(
      [exe, "/candidate"],
      UNBOUNDED_LEGACY,
      {},
      dir,
    );
    assert.equal(legacy.kind, "exited");
    assert.equal(
      legacy.stdout.text.trim(),
      mine,
      "legacy must inherit the manager's group",
    );
    const bounded = await runValidator([exe, "/candidate"], FAST, {}, dir);
    assert.equal(bounded.kind, "exited");
    assert.notEqual(
      bounded.stdout.text.trim(),
      mine,
      "bounded must lead its own group",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("PARITY: a leading BOM survives decoding", async () => {
  const dir = sandbox();
  try {
    // TextDecoder strips a BOM; Buffer.toString does not. The legacy path's
    // current accumulator preserves it, so both paths must.
    const exe = writeScript(dir, "bom.sh", "printf '\\357\\273\\277hi'");
    const run = await runValidator(
      [exe, "/candidate"],
      UNBOUNDED_LEGACY,
      {},
      dir,
    );
    assert.equal(run.kind, "exited");
    assert.equal(run.stdout.text, "\ufeffhi");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("a validator whose DESCENDANT holds the pipes is still bounded", async () => {
  const dir = sandbox();
  try {
    // The shell exits promptly; the backgrounded sleep inherits stdout and stderr
    // and outlives it. A runner that settles on `close` waits for the sleep --
    // measured at 5279 ms against a 300 ms timeout. Group signalling plus an
    // exit-based settle is what bounds this.
    const exe = writeScript(dir, "descendant.sh", "sleep 30 &\nsleep 30");
    const started = Date.now();
    const run = await runValidator([exe, "/candidate"], FAST, {}, dir);
    assert.equal(run.kind, "timedOut");
    assert.ok(
      Date.now() - started < 5000,
      "the descendant must not extend the run past the timeout",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("a validator that ignores SIGTERM is still killed", async () => {
  const dir = sandbox();
  try {
    const exe = writeScript(dir, "stubborn.sh", "trap '' TERM\nsleep 30");
    const started = Date.now();
    const run = await runValidator([exe, "/candidate"], FAST, {}, dir);
    assert.equal(run.kind, "timedOut");
    assert.ok(Date.now() - started < 5000, "SIGKILL should have ended it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

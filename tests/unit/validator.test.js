// @ts-check
// Unit coverage for src/validator.ts: the per-stream byte cap
// (maxBytesPerStream), the timeout and the SIGTERM/SIGKILL escalation it drives,
// the exit-inside-the-drain-window race, and the legacy path's parity contracts.
// `drainMs` itself is exercised only through settlement timing -- no case here
// would go red if drain handling alone changed. The policy is a real production
// argument, not a test seam.
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

// Three bounded policies, named for the PATH each one selects rather than for how
// fast it is. Production ordering is grace (2000) > drain (200); every policy here
// preserves grace > drain, which the policy-invariant case asserts mechanically.
// Inverting it hides the defect where settlement cancels a pending SIGKILL.
//
// Why the split: a case that is not testing the timeout must not race a deadline.
// Under `node --test`'s file-level parallelism it would be racing the SCHEDULER,
// not the validator -- measured, a trivial `echo; exit 0` reached 1656 ms
// spawn-to-settle under full-suite load against a 1200 ms timeout, and reported
// `timedOut`. Success-path cases therefore get production's patient 30 s.

// For cases whose validator NEVER exits (`sleep 30`). A load spike can delay when
// the timeout fires but cannot change the verdict, so a short timeout is safe here
// and only here. Settlement is timeout+grace+drain = 1640 ms; measured 1648-1657 ms
// across six full-suite runs, against the 5000 ms elapsed bounds those cases assert.
const TIMES_OUT = {
  kind: /** @type {const} */ ("bounded"),
  timeoutMs: 1200,
  graceMs: 400,
  drainMs: 40,
  maxBytesPerStream: 256,
};

// For every other bounded case: the validator is expected to EXIT, so the timeout
// must never be the thing it races. Production's 30 s against a measured worst
// spawn-to-settle of 1656 ms is ~18x. It carries the small byte cap too, so a case
// needing the cap does not have to fall back to a short timeout to get it.
const SUCCEEDS = {
  kind: /** @type {const} */ ("bounded"),
  timeoutMs: 30_000,
  graceMs: 400,
  drainMs: 40,
  maxBytesPerStream: 256,
};

// For the exit-inside-the-drain-window race ONLY. The window is
// [timeoutMs - drainMs, timeoutMs) = [5000, 9000).
//
// Two properties, both structural rather than tuned:
//   * FLOOR -- the validator's own `sleep 6` guarantees it cannot exit before
//     6000 ms, which is above the window floor of 5000 ms at ANY host speed. That
//     is what keeps the vacuous mode (exiting before the window, where nothing is
//     queued and the test passes proving nothing) unreachable.
//   * CEILING -- it must still exit before timeoutMs, i.e. exec + 6000 < 9000, so
//     exec has 3000 ms of room. Measured exec under full-suite load: 248-620 ms
//     (spawn-to-exit of a `sleep 0.5` script, 8 samples, minus the sleep).
// The two together require drainMs > worst-case exec; 4000 ms is ~6x the measured
// worst and ~2x the worst inferred from the reviewer's 1656 ms observation.
const DRAIN_RACE = {
  kind: /** @type {const} */ ("bounded"),
  timeoutMs: 9_000,
  graceMs: 5_000,
  drainMs: 4_000,
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
    const run = await runValidator([exe, "/candidate"], SUCCEEDS, {}, dir);
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
    const run = await runValidator([exe, "/candidate"], SUCCEEDS, {}, dir);
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
      SUCCEEDS,
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
    const run = await runValidator([bad, "/candidate"], SUCCEEDS, {}, dir);
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
      SUCCEEDS,
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
    const run = await runValidator([exe, "/candidate"], SUCCEEDS, {}, dir);
    assert.equal(run.kind, "exited");
    assert.equal(run.stdout.text.length, SUCCEEDS.maxBytesPerStream);
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
    const run = await runValidator([exe, candidate], SUCCEEDS, {}, dir);
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

void test("a hanging validator is reported as timedOut inside the bound", async () => {
  const dir = sandbox();
  try {
    const exe = writeScript(dir, "hang.sh", "sleep 30");
    const started = Date.now();
    const run = await runValidator([exe, "/candidate"], TIMES_OUT, {}, dir);
    assert.equal(run.kind, "timedOut");
    assert.equal(run.afterMs, TIMES_OUT.timeoutMs);
    // Settlement is timeout+grace+drain = 1640 ms; measured 1648-1657 ms across six
    // full-suite runs, so this bound keeps ~3.3 s of margin.
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
    const run = await runValidator([exe, "/candidate"], TIMES_OUT, {}, dir);
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
    // SIGKILL lands at timeout+grace (1600ms) and settlement follows it at
    // timeout+grace+drain (1640ms) -- measured 1648-1657ms, because the timedOut
    // settle is nested inside the SIGKILL callback. Settlement is therefore AFTER
    // the kill, not before it.
    // The HISTORICAL DEFECT SHAPE this case guards against is the opposite
    // ordering: a revision that settled first and let settlement cancel a pending
    // SIGKILL. Under that shape SIGKILL never fires and the marker appears.
    const exe = writeScript(
      dir,
      "survivor.sh",
      `sh -c 'trap "" TERM; sleep 4; : > ${marker}' &\nsleep 30`,
    );
    const run = await runValidator([exe, "/candidate"], TIMES_OUT, {}, dir);
    assert.equal(run.kind, "timedOut");
    // Settlement is 1640 ms, so this checks at ~9.6 s. The marker would be written
    // at exec+4000 ms; exec measured 248-620 ms under full-suite load, leaving
    // ~5 s of margin before the check, so an unusually slow exec cannot make the
    // check fire too early and pass vacuously.
    await new Promise((r) => setTimeout(r, 8000));
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
    const bounded = await runValidator([exe, "/candidate"], SUCCEEDS, {}, dir);
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

void test("a validator whose DESCENDANT holds the pipes still settles inside the bound", async () => {
  const dir = sandbox();
  try {
    // The shell exits promptly; the backgrounded sleep inherits stdout and stderr
    // and outlives it. A runner that settles on `close` waits for the sleep --
    // measured at 5279 ms against a 300 ms timeout. What bounds it HERE is the
    // timeout timer's own settlement, which fires whether or not any signal is
    // delivered; the exit-based settle is not on this path at all. This case
    // measures the bound and NOT termination -- `survivor.sh` and `stubborn.sh`
    // are the cases that carry a termination oracle.
    const exe = writeScript(dir, "descendant.sh", "sleep 30 &\nsleep 30");
    const started = Date.now();
    const run = await runValidator([exe, "/candidate"], TIMES_OUT, {}, dir);
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
    // A real termination oracle. `kind === "timedOut"` and the elapsed bound are
    // both produced by the settle alone and stay green with every signal
    // suppressed, so neither measures a kill. The child ignores TERM -- and so
    // does its `sleep`, because an ignored disposition survives exec -- leaving
    // SIGKILL (at timeout+grace = 1600ms) as the only thing that can end it
    // before the marker is written at ~4s.
    const marker = join(dir, "outlived");
    const exe = writeScript(
      dir,
      "stubborn.sh",
      `trap '' TERM\nsleep 4\n: > ${marker}`,
    );
    const started = Date.now();
    const run = await runValidator([exe, "/candidate"], TIMES_OUT, {}, dir);
    assert.equal(run.kind, "timedOut");
    assert.ok(Date.now() - started < 5000, "SIGKILL should have ended it");
    // Same margin reasoning as the survivor case: checks at ~9.6 s against a marker
    // that would be written at exec+4000 ms.
    await new Promise((r) => setTimeout(r, 8000));
    assert.equal(
      existsSync(marker),
      false,
      "the validator outlived the run: SIGKILL never ended it",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("a validator exiting inside the drain window is never signalled", async () => {
  const dir = sandbox();
  try {
    // The race: a child exiting inside [timeoutMs - drainMs, timeoutMs) already
    // has its drain settle QUEUED when the timeout comes due. If the exit handler
    // does not clear the timeout timer, the timeout still fires, SIGTERMs the
    // group of a validator that had already exited cleanly, and leaves the SIGKILL
    // escalation pending behind a settle that reports "exited".
    // `run.kind` cannot see this -- the buggy path reports "exited" too. The
    // oracle is whether SIGTERM was DELIVERED, so the descendant CATCHES it and
    // records the fact. Marker present means the bug is back.
    //
    // The `sleep 6` is the protection, not a timing guess: it is a hard FLOOR that
    // puts the exit above the window floor (timeoutMs - drainMs = 5000 ms) on any
    // host, however fast. Exec latency only pushes the exit later, and the ceiling
    // (timeoutMs = 9000 ms) leaves 3000 ms for it against a measured 248-620 ms.
    // The descendant sleeps 12 s so it is certainly still alive at 9000 ms to catch
    // the SIGTERM the buggy path would send.
    const marker = join(dir, "was-signalled");
    const exe = writeScript(
      dir,
      "quick.sh",
      `sh -c 'trap ": > ${marker}" TERM; sleep 12' &\nsleep 6\nexit 0`,
    );
    const run = await runValidator([exe, "/candidate"], DRAIN_RACE, {}, dir);
    assert.equal(run.kind, "exited");
    assert.equal(run.code, 0);
    // Settlement is exit+drain, about 10.3-10.7 s, already past the 9000 ms at
    // which the buggy path would have signalled; this only adds margin.
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(
      existsSync(marker),
      false,
      "SIGTERM reached a validator that had already exited cleanly",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("every bounded policy this file uses keeps graceMs > drainMs", () => {
  // Load-bearing, not cosmetic. A grace shorter than the drain lets settlement
  // precede the SIGKILL, which is precisely the historical defect `survivor.sh`
  // exists to catch -- and `survivor.sh` would then catch nothing. Asserted
  // mechanically because prose does not go red.
  for (const [name, policy] of Object.entries({
    TIMES_OUT,
    SUCCEEDS,
    DRAIN_RACE,
    BOUNDED_EXECUTABLE,
  })) {
    // Live, not a type-narrowing formality: BOUNDED_EXECUTABLE is declared as the
    // ValidatorPolicy union, so this fails if a policy here ever stops being
    // bounded -- and only then does the comparison below become unreachable.
    assert.ok(policy.kind === "bounded", `${name} must be a bounded policy`);
    assert.ok(
      policy.graceMs > policy.drainMs,
      `${name}: graceMs (${policy.graceMs}) must exceed drainMs (${policy.drainMs})`,
    );
  }
});

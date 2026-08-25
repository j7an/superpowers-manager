// @ts-check
// Unit coverage for src/validator.ts: the per-stream byte cap
// (maxBytesPerStream), the timeout and the SIGTERM/SIGKILL escalation it drives,
// the exit-inside-the-drain-window race, and the legacy path's parity contracts.
// `drainMs` itself is exercised only through settlement timing -- no case here
// would go red if drain handling alone changed. The policy is a real production
// argument, not a test seam.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/** @type {typeof import("../../src/validator.js")} */
const {
  runValidator,
  UNBOUNDED_LEGACY,
  BOUNDED_EXECUTABLE,
  resolveValidator,
  displayPath,
  launchFailureMessage,
  bothConfigured,
  configurationErrors,
} = await import(new URL("../../dist/validator.js", import.meta.url).href);

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

// For the one timeout case whose assertion depends on the child having RUN rather
// than on the settle: it asserts stderr CONTENT, so the child must reach its `echo`
// before the deadline or the assertion sees ''. TIMES_OUT's 1200 ms is chosen for
// promptness, which is the wrong property here -- and it is not a margin that can be
// tuned, because the case failed at 300 ms and again at 1200 ms in the same way.
//
// The value is free, because the validator prints and THEN sleeps 30 s: any timeout
// well below 30 s still takes the timeout path, so this one can be chosen purely for
// reliability. Measured time from spawn to first stderr byte for this exact script,
// 12 samples under full-suite load: 166-330 ms. One excursion past 1200 ms was
// observed in an acceptance run, so the tail is known to exceed the samples; 10 s is
// ~30x the measured worst and >8x that observed excursion, while settling at
// timeout+grace+drain = 10.44 s leaves 19.5 s of headroom below the 30 s sleep.
const RUNS_THEN_TIMES_OUT = {
  kind: /** @type {const} */ ("bounded"),
  timeoutMs: 10_000,
  graceMs: 400,
  drainMs: 40,
  maxBytesPerStream: 256,
};

// For the two cases that carry a TERMINATION oracle. Their assertion is negative --
// a survival marker must be ABSENT -- so a child killed before it installed its trap
// satisfies them while proving nothing, and `kind`, `afterMs`, duration, output and
// message are all identical between a genuine run and a vacuous one. Measured at the
// old 1200 ms deadline, protection-installed time reached 1150.5 ms for the survivor
// shape: 49.5 ms of margin, 4.1% of the budget, and 6/10 vacuous on a cold tree.
//
// Sized against the EXCURSION, not the clean samples -- the lesson of the stderr
// case, whose identical quantity hit 2619 ms on a cold run. In-suite samples of
// protection-installed time on this host: survivor 172-331 ms, stubborn 167-360 ms
// (14 each). 15 s is ~45x that measured worst and ~5.7x the 2619 ms cold excursion.
// The value is free in the same way F1's was: the validator sleeps 30 s, so any
// timeout well below that still takes the timeout path.
const TRAPS_THEN_TIMES_OUT = {
  kind: /** @type {const} */ ("bounded"),
  timeoutMs: 15_000,
  graceMs: 400,
  drainMs: 40,
  maxBytesPerStream: 256,
};

// For every other bounded case: the validator is expected to EXIT, so the timeout
// must never be the thing it races. Production's 30 s leaves 28.7 s of headroom
// over the worst spawn-to-exit measured under full-suite load (1345 ms; the samples
// are recorded beside the DRAIN_RACE case). Stated in absolute terms deliberately: the
// 1656 ms figure that motivated this split is a timeout-path settle DURATION
// (1200 + 400 + 40), not an exec measurement, so quoting a multiple against it
// would repeat the category slip that produced the short timeout in the first
// place. It carries the small byte cap too, so a case needing the cap does not
// have to fall back to a short timeout to get it.
const SUCCEEDS = {
  kind: /** @type {const} */ ("bounded"),
  timeoutMs: 30_000,
  graceMs: 400,
  drainMs: 40,
  maxBytesPerStream: 256,
};

// For the exit-inside-the-drain-window race ONLY. The window is
// [timeoutMs - drainMs, timeoutMs) = [800, 4000).
//
// Two properties, both structural rather than tuned:
//   * FLOOR -- the validator's own `sleep 1` guarantees it cannot exit before
//     1000 ms, which is above the window floor of 800 ms at ANY host speed. POSIX
//     `sleep` sleeps AT LEAST its argument and exec latency only pushes the exit
//     later, so this is an inequality between two constants, not a race. It is what
//     keeps the vacuous mode -- exiting BELOW the window, where no drain settle is
//     queued when the timeout comes due and the case passes proving nothing --
//     unreachable on any host.
//   * CEILING -- it must still exit before timeoutMs, i.e. exec + 1000 < 4000, so
//     exec has 3000 ms of room. THIS IS THE BINDING CONSTRAINT: the floor is exact
//     arithmetic, so the ceiling is the only relation a slow host can break, and it
//     breaks it visibly (`kind` becomes "timedOut") rather than vacuously.
// Measured exec under full-suite load: see the samples recorded beside the case
// itself. 3000 ms of ceiling room is ~8.7x the measured worst (345 ms), the same
// ratio that case states from the same samples. A worst-case exec of
// 2000 ms is ASSUMED, not measured -- no sample here approaches it; it is a
// deliberate safety factor over the measured range, and the ~1.5x it leaves is the
// margin this construction actually depends on.
const DRAIN_RACE = {
  kind: /** @type {const} */ ("bounded"),
  timeoutMs: 4_000,
  graceMs: 3_300,
  drainMs: 3_200,
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

void test("a file with the exec bit but no interpreter is rejected, and on darwin throws synchronously", async () => {
  const dir = sandbox();
  try {
    // Not a script and not a binary: spawn raises ENOEXEC. POSIX execvp falls
    // back to re-running the file with /bin/sh when execve returns ENOEXEC, so
    // the SAME file surfaces differently by platform: launchFailed/ENOEXEC on
    // darwin -- raised SYNCHRONOUSLY, not on the error event -- and a nonzero
    // `exited` on Linux, where /bin/sh interprets the bytes as a failing
    // script. Measured divergence: this test reds under Layer 4's Linux
    // container while Layers 1-3 on darwin cannot see it.
    const bad = join(dir, "binary");
    // Bytes, constructed programmatically rather than as a string literal, so
    // this file stays text: embedding raw control characters as a literal would
    // make the file BINARY to grep.
    writeFileSync(bad, Buffer.from([0x00, 0x01, 0x6e, 0x6f]), { mode: 0o755 });
    const run = await runValidator([bad, "/candidate"], SUCCEEDS, {}, dir);
    // Portable assertion, true on every platform: the file must be REJECTED,
    // whichever mechanism reports it -- never timedOut, and never a
    // zero-code exit.
    assert.notEqual(run.kind, "timedOut");
    if (run.kind === "exited") {
      assert.notEqual(run.code, 0);
    } else {
      assert.equal(run.kind, "launchFailed");
    }
    if (process.platform === "darwin") {
      // The synchronous ENOEXEC throw is load-bearing here: removing the
      // runner's synchronous try/catch reds exactly this assertion (confirmed
      // by mutation in Task 2 review). Only darwin's execvp raises ENOEXEC
      // synchronously for this file; Linux never reaches this branch.
      assert.equal(run.kind, "launchFailed");
      assert.equal(run.errno, "ENOEXEC");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("a file with the exec bit, no shebang, and a passing shell body is pinned per platform", async () => {
  const dir = sandbox();
  try {
    // Unlike the previous case, this file's contents ARE valid shell source
    // (`exit 0`) -- it just lacks the `#!` line that would tell execve which
    // interpreter to use. POSIX execvp falls back to re-running a file with
    // /bin/sh when execve returns ENOEXEC, so on Linux this file is executed
    // as shell source and its `exit 0` is a genuine, accepted success. On
    // darwin execve raises ENOEXEC synchronously and the file is rejected
    // outright, the same as the no-interpreter case above. This divergence is
    // a pinned contract, not an accident: if a future change makes the two
    // platforms agree, this assertion should go red and be revisited, not
    // silently pass either branch.
    const bad = join(dir, "no-shebang");
    writeFileSync(bad, "exit 0\n", { mode: 0o755 });
    const run = await runValidator([bad, "/candidate"], SUCCEEDS, {}, dir);
    if (process.platform === "linux") {
      assert.equal(run.kind, "exited");
      assert.equal(run.code, 0);
    } else if (process.platform === "darwin") {
      assert.equal(run.kind, "launchFailed");
    }
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

void test("output past the cap is truncated and the drop is counted", async () => {
  const dir = sandbox();
  try {
    // 1000 bytes of stdout against a 256-byte cap.
    const exe = writeScript(
      dir,
      "chatty.sh",
      "i=0; while [ $i -lt 100 ]; do printf 0123456789; i=$((i+1)); done",
    );
    const run = await runValidator([exe, "/candidate"], SUCCEEDS, {}, dir);
    assert.equal(run.kind, "exited");
    assert.equal(run.stdout.text.length, SUCCEEDS.maxBytesPerStream);
    assert.equal(run.stdout.droppedBytes, 1000 - SUCCEEDS.maxBytesPerStream);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("a validator far past the cap still exits cleanly, never blocking into a timeout", async () => {
  const dir = sandbox();
  try {
    // ~2 MB on EACH of stdout and stderr against a 256-byte cap and
    // SUCCEEDS's 30s timeout. If either reader stopped consuming past the
    // cap, that stream's OS pipe buffer would fill, the child would block
    // on its next write to it, and the run would sit until the 30s
    // deadline and settle as timedOut instead of exited. The two stream
    // handlers are separate, structurally identical lines
    // (src/validator.ts), so stdout draining is not evidence that stderr
    // does too -- both streams are flooded here so a regression on either
    // one is caught.
    const exe = writeScript(
      dir,
      "flood.sh",
      "i=0; while [ $i -lt 2000 ]; do printf '%01000d' 0; printf '%01000d' 0 >&2; i=$((i+1)); done; exit 0",
    );
    const run = await runValidator([exe, "/candidate"], SUCCEEDS, {}, dir);
    assert.equal(
      run.kind,
      "exited",
      "a drained flood must not become a timeout",
    );
    assert.equal(run.code, 0);
    assert.equal(run.stdout.text.length, SUCCEEDS.maxBytesPerStream);
    assert.ok(run.stdout.droppedBytes > 1_000_000);
    assert.equal(run.stderr.text.length, SUCCEEDS.maxBytesPerStream);
    assert.ok(run.stderr.droppedBytes > 1_000_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("the unbounded policy retains everything", async () => {
  const dir = sandbox();
  try {
    const exe = writeScript(
      dir,
      "some.sh",
      "i=0; while [ $i -lt 100 ]; do printf 0123456789; i=$((i+1)); done",
    );
    const run = await runValidator(
      [exe, "/candidate"],
      UNBOUNDED_LEGACY,
      {},
      dir,
    );
    assert.equal(run.kind, "exited");
    assert.equal(run.stdout.text.length, 1000);
    assert.equal(run.stdout.droppedBytes, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("the validator receives the candidate root as its SOLE argument, with no shell interpretation", async () => {
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
    const run = await runValidator(
      [exe, "/candidate"],
      RUNS_THEN_TIMES_OUT,
      {},
      dir,
    );
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
    // The backgrounded shell ignores TERM and would create the marker at
    // install+20000ms. SIGKILL lands at timeout+grace (15400ms) and settlement
    // follows it at timeout+grace+drain (15440ms), because the timedOut settle is
    // nested inside the SIGKILL callback. Settlement is therefore AFTER the kill,
    // not before it.
    // The HISTORICAL DEFECT SHAPE this case guards against is the opposite
    // ordering: a revision that settled first and let settlement cancel a pending
    // SIGKILL. Under that shape SIGKILL never fires and the marker appears.
    // `installed` is a POSITIVE CONTROL. The hazard this case had is on the SIGTERM
    // side, not the marker side: if the descendant has not installed its trap by the
    // time SIGTERM arrives at timeoutMs, it simply dies, the survival marker is never
    // written, and the negative assertion below passes having tested nothing. Nothing
    // about a vacuous run looks different from a genuine one. Asserting that the trap
    // WAS installed is what makes that failure loud. Descendant sleeps 20 s so it is
    // still alive at SIGKILL (timeout+grace = 15400 ms) with ~4.8 s of margin at the
    // fastest observed install.
    const installed = join(dir, "trap-installed");
    const exe = writeScript(
      dir,
      "survivor.sh",
      `sh -c 'trap "" TERM; : > ${installed}; sleep 20; : > ${marker}' &\nsleep 30`,
    );
    const run = await runValidator(
      [exe, "/candidate"],
      TRAPS_THEN_TIMES_OUT,
      {},
      dir,
    );
    assert.equal(run.kind, "timedOut");
    // Settlement is timeout+grace+drain = 15440 ms, so this checks at ~25.4 s. The
    // survival marker would be written at install+20000 ms, i.e. by ~22.6 s even at
    // the 2619 ms cold excursion, leaving ~2.8 s before the check.
    await new Promise((r) => setTimeout(r, 10000));
    assert.equal(
      existsSync(installed),
      true,
      "the descendant never installed its TERM trap: this case proved nothing",
    );
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
    // SIGKILL (at timeout+grace = 15400ms) as the only thing that can end it
    // before the marker is written at ~20s.
    const marker = join(dir, "outlived");
    // Positive control, same reasoning as the survivor case: a child SIGTERMed before
    // it reached its own `trap` line dies quietly, never writes the survival marker,
    // and passes the negative assertion having tested nothing.
    const installed = join(dir, "trap-installed");
    const exe = writeScript(
      dir,
      "stubborn.sh",
      `trap '' TERM\n: > ${installed}\nsleep 20\n: > ${marker}`,
    );
    const started = Date.now();
    const run = await runValidator(
      [exe, "/candidate"],
      TRAPS_THEN_TIMES_OUT,
      {},
      dir,
    );
    assert.equal(run.kind, "timedOut");
    assert.ok(Date.now() - started < 20_000, "SIGKILL should have ended it");
    // Settlement is 15440 ms; this checks at ~25.4 s against a survival marker that
    // would be written at install+20000 ms.
    await new Promise((r) => setTimeout(r, 10000));
    assert.equal(
      existsSync(installed),
      true,
      "the validator never installed its TERM trap: this case proved nothing",
    );
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
    // The `sleep 1` is the protection, not a timing guess: a hard FLOOR putting the
    // exit above the window floor (timeoutMs - drainMs = 800 ms) on any host,
    // however fast. Exec latency only pushes the exit later, and the ceiling
    // (timeoutMs = 4000 ms) leaves 3000 ms for it. Measured spawn-to-exit for this
    // exact script under full-suite load: 1260-1345 ms across 8
    // samples, i.e. an exec of 260-345 ms against that 3000 ms of room -- ~8.7x.
    // The descendant sleeps 8 s so it is certainly still alive at 4000 ms to catch
    // the SIGTERM the buggy path would send.
    const marker = join(dir, "was-signalled");
    const exe = writeScript(
      dir,
      "quick.sh",
      `sh -c 'trap ": > ${marker}" TERM; sleep 8' &\nsleep 1\nexit 0`,
    );
    const run = await runValidator([exe, "/candidate"], DRAIN_RACE, {}, dir);
    assert.equal(run.kind, "exited");
    assert.equal(run.code, 0);
    // Settlement is exit+drain, already past the 4000 ms at which the buggy path
    // would have signalled; this only adds margin.
    await new Promise((r) => setTimeout(r, 500));
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
    RUNS_THEN_TIMES_OUT,
    TRAPS_THEN_TIMES_OUT,
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

void test("a symlink is resolved and disclosed as one", async () => {
  const dir = sandbox();
  try {
    const real = writeScript(dir, "real.sh", "exit 0");
    const link = join(dir, "link");
    symlinkSync(real, link);
    const r = await resolveValidator(link);
    assert.equal(r.isSymlink, true);
    assert.equal(r.resolved, realpathSync(real));
    assert.equal(r.isDirectory, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("a directory is disclosed as one so EACCES can be disambiguated", async () => {
  const dir = sandbox();
  try {
    const r = await resolveValidator(dir);
    assert.equal(r.isDirectory, true);
    assert.equal(r.isSymlink, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("a printable non-ASCII path is displayed verbatim", () => {
  assert.equal(displayPath("/Users/josé/validator"), "/Users/josé/validator");
  assert.equal(displayPath("/検証/validator"), "/検証/validator");
});

void test("a path carrying control characters is escaped", () => {
  const shown = displayPath("/tmp/bad\nname");
  assert.ok(
    !shown.includes("\n"),
    "the newline must not reach the terminal raw",
  );
  assert.match(shown, /\\n/);
});

void test("each launch failure gets its own message", () => {
  const base = {
    configured: "/v",
    resolved: "/v",
    isSymlink: false,
    isDirectory: false,
    exists: false,
  };
  assert.equal(
    launchFailureMessage("ENOENT", base),
    "external plugin validator not found: /v",
  );
  assert.equal(
    launchFailureMessage("ENOENT", { ...base, exists: true }),
    "external plugin validator is present but its interpreter is missing: /v",
  );
  assert.equal(
    launchFailureMessage("EACCES", { ...base, isDirectory: true }),
    "external plugin validator is a directory: /v",
  );
  assert.equal(
    launchFailureMessage("EACCES", base),
    "external plugin validator is not executable: /v",
  );
  assert.equal(
    launchFailureMessage("ENOEXEC", base),
    "external plugin validator is not a runnable program: /v",
  );
  assert.equal(
    launchFailureMessage("EPERM", base),
    "cannot execute external plugin validator: /v (EPERM)",
  );
});

void test("both-set is detected with legacy emptiness semantics", () => {
  assert.equal(
    bothConfigured({
      SUPERPOWERS_VALIDATOR: "/a",
      SUPERPOWERS_VALIDATOR_EXECUTABLE: "/b",
    }),
    true,
  );
  assert.equal(bothConfigured({ SUPERPOWERS_VALIDATOR: "/a" }), false);
  assert.equal(
    bothConfigured({
      SUPERPOWERS_VALIDATOR: "",
      SUPERPOWERS_VALIDATOR_EXECUTABLE: "/b",
    }),
    false,
  );
  // Whitespace-only counts as set, exactly as the legacy path treats it. No trim.
  assert.equal(
    bothConfigured({
      SUPERPOWERS_VALIDATOR: " ",
      SUPERPOWERS_VALIDATOR_EXECUTABLE: "/b",
    }),
    true,
  );
  // The feature's own happy path: configuring ONLY the new variable must
  // never be mistaken for a contradiction, or the feature is DOA.
  assert.equal(
    bothConfigured({ SUPERPOWERS_VALIDATOR_EXECUTABLE: "/b" }),
    false,
  );
  // The null-configuration case. A default that silently means "skip" is a
  // fail-open gate.
  assert.equal(bothConfigured({}), false);
});

void test("the both-set error is scoped to the commands that run a validator", () => {
  const env = {
    SUPERPOWERS_VALIDATOR: "/a",
    SUPERPOWERS_VALIDATOR_EXECUTABLE: "/b",
  };
  for (const cmd of ["prepare", "install", "update"]) {
    assert.equal(configurationErrors(cmd, env).length, 1, `${cmd} must reject`);
    assert.match(configurationErrors(cmd, env)[0], /both set/);
  }
  for (const cmd of ["probe", "pin", "unpin", "track-latest", "uninstall"]) {
    assert.deepEqual(
      configurationErrors(cmd, env),
      [],
      `${cmd} must be unaffected`,
    );
  }
  // Neither the null-configuration case nor the executable-only happy path
  // may be reported as a contradiction, for any command that runs a
  // validator.
  for (const cmd of ["prepare", "install", "update"]) {
    assert.deepEqual(
      configurationErrors(cmd, {}),
      [],
      `${cmd} must accept no validator configured at all`,
    );
    assert.deepEqual(
      configurationErrors(cmd, { SUPERPOWERS_VALIDATOR_EXECUTABLE: "/b" }),
      [],
      `${cmd} must accept the executable configured alone`,
    );
  }
});

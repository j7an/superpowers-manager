import { spawn } from "node:child_process";

export type ValidatorPolicy =
  | { readonly kind: "unbounded" }
  | {
      readonly kind: "bounded";
      readonly timeoutMs: number;
      readonly graceMs: number;
      // How long to keep draining after the CHILD is gone. Part of the policy, not
      // a module constant, so a test policy preserves production's ordering:
      // grace MUST exceed drain, or a test cannot observe a SIGKILL that fires
      // after settlement.
      readonly drainMs: number;
      readonly maxBytesPerStream: number;
    };

// The legacy SUPERPOWERS_VALIDATOR path. Its behaviour is frozen by parity, so it
// carries no limits at all; see the spec's D2. Bounding it is PR 12's row.
export const UNBOUNDED_LEGACY: ValidatorPolicy = { kind: "unbounded" };

// SUPERPOWERS_VALIDATOR_EXECUTABLE. 30s is ~270x a measured realistic validator run
// (0.11s, dominated by interpreter startup); 64 KiB per stream clears a
// one-diagnostic-line-per-file report (30 KB on a real tree) with headroom.
export const BOUNDED_EXECUTABLE: ValidatorPolicy = {
  kind: "bounded",
  timeoutMs: 30_000,
  graceMs: 2_000,
  drainMs: 200,
  maxBytesPerStream: 64 * 1024,
};

export interface Captured {
  readonly text: string;
  readonly droppedBytes: number;
}

export type ValidatorRun =
  | {
      readonly kind: "exited";
      readonly code: number | null;
      readonly stdout: Captured;
      readonly stderr: Captured;
    }
  | {
      readonly kind: "timedOut";
      readonly afterMs: number;
      readonly stdout: Captured;
      readonly stderr: Captured;
    }
  | {
      readonly kind: "launchFailed";
      readonly errno: string;
      // Carried so the LEGACY path can rethrow exactly what it throws today.
      readonly cause: unknown;
    };

// Retains the first `limit` bytes and counts the rest. A null limit retains
// everything, which is the unbounded policy's contract. push() always consumes the
// whole chunk: ceasing to consume would block the child on a full pipe.
class Sink {
  private readonly chunks: Buffer[] = [];
  private kept = 0;
  private dropped = 0;

  constructor(private readonly limit: number | null) {}

  push(chunk: Buffer): void {
    if (this.limit === null) {
      this.chunks.push(chunk);
      return;
    }
    const room = this.limit - this.kept;
    if (room <= 0) {
      this.dropped += chunk.length;
      return;
    }
    const take = chunk.length <= room ? chunk : chunk.subarray(0, room);
    this.chunks.push(take);
    this.kept += take.length;
    this.dropped += chunk.length - take.length;
  }

  done(): Captured {
    // Buffer.toString, NOT TextDecoder: TextDecoder strips a leading BOM and the
    // legacy path's current string accumulator preserves it. Measured:
    // decode(<BOM>hi) is "hi" but toString("utf8") is "\ufeffhi". The legacy path
    // must be byte-identical, so BOTH paths use toString.
    return {
      text: Buffer.concat(this.chunks).toString("utf8"),
      droppedBytes: this.dropped,
    };
  }
}

// Signal the child's whole process group. Only meaningful for a child spawned
// under the BOUNDED policy: that spawn passes `detached: true`, so the child
// leads a group of its own and -pid reaches its descendants. The LEGACY path
// spawns without `detached`, so its child does not lead a group and this
// function is not for it. Wrapped because the group is already gone in the
// ordinary race between SIGTERM and SIGKILL.
function signalGroup(child: { pid?: number }, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    /* the group exited between the timer firing and this call */
  }
}

export function runValidator(
  argv: readonly [string, ...string[]],
  policy: ValidatorPolicy,
  env: NodeJS.ProcessEnv,
  workspace: string,
): Promise<ValidatorRun> {
  return new Promise((resolveRun) => {
    const [command, ...args] = argv;
    const limit = policy.kind === "bounded" ? policy.maxBytesPerStream : null;
    const out = new Sink(limit);
    const err = new Sink(limit);
    let settled = false;
    // Settlement and termination are independent BY CONSTRUCTION, which is why
    // there is no grace-timer handle to clear here: the timedOut settle is nested
    // inside the SIGKILL callback, so on the timeout path the promise cannot
    // resolve before the escalation has run. That nesting is the fix for an
    // earlier revision which settled first and left the SIGKILL on a cancellable
    // timer -- the historical shape the `survivor.sh` case in the unit suite
    // exists to catch. Only the timeout timer is cleared, and by the time settle
    // runs it has either already fired or is being cancelled by a clean exit.
    const settle = (run: ValidatorRun): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      resolveRun(run);
    };

    let timeoutTimer: NodeJS.Timeout | undefined;
    let timedOut = false;
    let lastCode: number | null = null;
    // No timer is unref'ed. The escalation must actually run, and an unref'ed timer
    // does not keep the event loop alive.

    // ENOEXEC is delivered as a SYNCHRONOUS throw, not on the error event, so a
    // handler-only implementation leaks it as an unhandled rejection.
    let child;
    try {
      child = spawn(command, args, {
        env: { ...process.env, ...env, TMPDIR: workspace },
        stdio: ["ignore", "pipe", "pipe"],
        // D4: under the BOUNDED policy only, the child leads its own process group
        // so a timeout can signal the GROUP -- signalling the process alone leaves
        // descendants holding the inherited pipes, and `close` then waits for them
        // (measured at 5279 ms against a 300 ms timeout). The LEGACY path must not
        // acquire group leadership: that changes process and session semantics for
        // a path whose whole contract is that it is unchanged.
        detached: policy.kind === "bounded",
      });
    } catch (cause) {
      settle({
        kind: "launchFailed",
        errno: (cause as NodeJS.ErrnoException).code ?? "UNKNOWN",
        cause,
      });
      return;
    }

    // No setEncoding: the cap counts BYTES, and a string accumulator would count
    // UTF-16 code units instead.
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    // Both error and close fire on a launch failure, so settle() is idempotent.
    child.on("error", (cause: NodeJS.ErrnoException) => {
      settle({ kind: "launchFailed", errno: cause.code ?? "UNKNOWN", cause });
    });
    child.on("close", (code) => {
      lastCode ??= code;
      // On the timeout path, settling here would resolve BEFORE SIGKILL and the
      // escalation would never complete. That path settles itself, after the kill.
      if (timedOut) return;
      settle({ kind: "exited", code, stdout: out.done(), stderr: err.done() });
    });

    // Settling on `close` alone is not a wall-clock bound: `close` fires only when
    // every writer has released the pipes, and a descendant that outlives the child
    // holds them. Settle on whichever comes first -- `close`, or the child's `exit`
    // plus a bounded drain for trailing output.
    child.on("exit", (code) => {
      // `exit` carries the status and fires as soon as the CHILD is gone; `close`
      // may lag it indefinitely. Capture the code here or a successful validator
      // whose descendant lingers would settle with a null code and be rejected.
      lastCode = code;
      // BOUNDED ONLY. The legacy path settles on `close`, exactly as it does today:
      // a validator that backgrounds `(sleep 0.6; echo late) &` has "late" captured
      // under `close` and lost under a 200 ms drain, and that output is captured
      // today.
      if (policy.kind !== "bounded") return;
      // The TIMEOUT path owns its own settlement, after the escalation has run.
      if (timedOut) return;
      // The drain settle below is now the one that will resolve this run, so the
      // timeout must not fire behind it. A child exiting inside
      // [timeoutMs - drainMs, timeoutMs) already has its drain settle queued when
      // the timeout comes due; without this the timeout would SIGTERM the group of
      // a validator that had ALREADY exited cleanly, then leave the SIGKILL
      // escalation pending behind a settle that reports `exited`. Race-free rather
      // than merely unlikely: either the timeout has fired, in which case
      // `timedOut` is true and we returned above, or it has not, and now it never
      // will. The bound is unchanged -- settlement is exitTime + drainMs and
      // exitTime < timeoutMs. Deliberately NOT paired with a `timedOut` re-check
      // inside the drain callback: with the timer cleared that check is
      // unreachable, and unfalsifiable defensive code is what this module keeps
      // being bitten by.
      clearTimeout(timeoutTimer);
      setTimeout(() => {
        settle({
          kind: "exited",
          code: lastCode,
          stdout: out.done(),
          stderr: err.done(),
        });
      }, policy.drainMs);
    });

    if (policy.kind === "bounded") {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        // Signal the GROUP, not the process: descendants hold the pipes. SIGTERM
        // first, because the contract promises stderr carries the reason, and
        // reading continues through the grace window so the child can print it.
        signalGroup(child, "SIGTERM");
        setTimeout(() => {
          signalGroup(child, "SIGKILL");
          // Settle ONLY after SIGKILL has been sent. An earlier revision settled
          // first and left the escalation on an unref'ed timer, which never fires
          // because the CLI exits as soon as its handler returns -- measured, the
          // manager exited at 146 ms and the descendant survived. The wall-clock
          // bound is therefore timeout + grace + drain, which is still a bound.
          setTimeout(() => {
            settle({
              kind: "timedOut",
              afterMs: policy.timeoutMs,
              stdout: out.done(),
              stderr: err.done(),
            });
          }, policy.drainMs);
        }, policy.graceMs);
      }, policy.timeoutMs);
    }
  });
}

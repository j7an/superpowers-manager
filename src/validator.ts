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

// Signal the child's whole process group. The child is spawned detached, so it
// leads a group of its own and -pid reaches its descendants. Wrapped because the
// group is already gone in the ordinary race between SIGTERM and SIGKILL.
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
    const settle = (run: ValidatorRun): void => {
      if (settled) return;
      settled = true;
      resolveRun(run);
    };

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
      settle({ kind: "exited", code, stdout: out.done(), stderr: err.done() });
    });
  });
}

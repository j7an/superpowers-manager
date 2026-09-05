// Suite-lifetime scratch registry implementing the termination contract
// src/workspace.ts owns for withWorkspace scope. NOT an import of that module:
// its coordinator is bounded by a single withWorkspace call, and these trees
// live for the whole suite. src/workspace.ts is the authority for the
// contract's shape; this is the same contract at a different lifetime.
//
// Carried row :2040: both fixtures registered cleanup on process.on("exit")
// only, so a signal during a suite left the scratch tree behind.

import { rmSync } from "node:fs";

const MANAGED_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"] as const;

const active: Set<string> = new Set();
let exiting = false;

const handlers: Map<string, () => void> = new Map();

/**
 * A cleanup failure must not be silent: src/workspace.ts's header (:15-18)
 * records that a fully-silent swallow "is the state PR 11.4 removed" from
 * the production path, and this mirrors that same policy at suite lifetime.
 * Names the path only — never the caught error — per AGENTS.md's
 * diagnostics convention: a free-form caught message is not a bounded,
 * validated token.
 *
 * Node documents pipe writes as asynchronous on some platforms (notably
 * macOS); a saturated pipe could drop this write. That applies here at
 * least as strongly as it does to src/workspace.ts's equivalent write
 * (:64-67), since this one runs inside a `process.on("exit")` listener as
 * well as a signal handler.
 *
 * The write itself is guarded: both call sites reach this from inside their
 * own try/catch over `rmSync`, but a throw from the write (e.g. EPIPE, if
 * the pipe's other end is already gone) must not escape either of
 * those — or, on the signal path, the remaining trees' cleanup,
 * deregistration, and the re-raise never run, exactly the hazard
 * src/workspace.ts's equivalent write guards against at :58-61.
 */
function reportRemovalFailure(path: string): void {
  try {
    process.stderr.write(`cannot remove scratch ${path}\n`);
  } catch {
    // See above: a reporting failure must not block cleanup/re-raise either.
  }
}

/**
 * Synchronous by contract. An `await` here would yield to the event loop with
 * the listeners still registered, and every signal arriving in that window
 * would be consumed and discarded — an uninterruptible test run, which is
 * worse than the leak this exists to prevent.
 */
function cleanupForSignal(signal: "SIGHUP" | "SIGINT" | "SIGTERM") {
  if (exiting) return;
  exiting = true;
  for (const path of active) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // A cleanup failure must not block the remaining trees or the
      // re-raise, but it must not be silent either — see
      // reportRemovalFailure above.
      reportRemovalFailure(path);
    }
  }
  active.clear();
  for (const [managed, handler] of handlers) process.off(managed, handler);
  handlers.clear();
  // Die BY the signal, so a supervisor sees an honest signalled status rather
  // than a normal exit numbered 143.
  process.kill(process.pid, signal);
}

export function registerScratch(path: string): void {
  // Once a signal has started tearing the suite down, `handlers` is cleared
  // and `exiting` never resets — this module is done for the life of the
  // process. Without this guard, a scratch created after that point would
  // find `handlers.size === 0` and re-register all three listeners while
  // `exiting` stays true forever, so every later signal would be consumed by
  // cleanupForSignal's own `if (exiting) return;` and never re-raised: the
  // exact "uninterruptible test run" the module header warns against.
  //
  // A consequence, and not a bug: a path registered after this point is
  // neither tracked nor ever removed by this module. That's fine — the
  // process is already on its way out by signal — but it does mean a
  // caller that manages to create a scratch tree after teardown has begun
  // is on its own for cleaning it up.
  if (exiting) return;
  active.add(path);
  if (handlers.size === 0) {
    for (const signal of MANAGED_SIGNALS) {
      const handler = () => {
        cleanupForSignal(signal);
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
  }
}

// The normal-exit path stays, because the signal path only covers signals.
process.on("exit", () => {
  for (const path of active) {
    // Per-path, like cleanupForSignal: a throwing rmSync (EACCES/EBUSY --
    // `force` only covers ENOENT) must not escape this listener as an
    // uncaught exception, and must not abandon every other fixture's tree
    // still left in this loop.
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      reportRemovalFailure(path);
    }
  }
  active.clear();
});

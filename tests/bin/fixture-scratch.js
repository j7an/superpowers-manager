// @ts-check
// Suite-lifetime scratch registry implementing the termination contract
// src/workspace.ts owns for withWorkspace scope. NOT an import of that module:
// its coordinator is bounded by a single withWorkspace call, and these trees
// live for the whole suite. src/workspace.ts is the authority for the
// contract's shape; this is the same contract at a different lifetime.
//
// Carried row :2040: both fixtures registered cleanup on process.on("exit")
// only, so a signal during a suite left the scratch tree behind.

import { rmSync } from "node:fs";

const MANAGED_SIGNALS = /** @type {const} */ (["SIGHUP", "SIGINT", "SIGTERM"]);

/** @type {Set<string>} */
const active = new Set();
let exiting = false;
/** @type {Map<string, () => void>} */
const handlers = new Map();

/**
 * Synchronous by contract. An `await` here would yield to the event loop with
 * the listeners still registered, and every signal arriving in that window
 * would be consumed and discarded — an uninterruptible test run, which is
 * worse than the leak this exists to prevent.
 * @param {"SIGHUP" | "SIGINT" | "SIGTERM"} signal
 */
function cleanupForSignal(signal) {
  if (exiting) return;
  exiting = true;
  for (const path of active) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // A cleanup failure must not block the remaining trees or the re-raise.
    }
  }
  active.clear();
  for (const [managed, handler] of handlers) process.off(managed, handler);
  handlers.clear();
  // Die BY the signal, so a supervisor sees an honest signalled status rather
  // than a normal exit numbered 143.
  process.kill(process.pid, signal);
}

/**
 * @param {string} path
 * @returns {void}
 */
export function registerScratch(path) {
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
    rmSync(path, { recursive: true, force: true });
  }
  active.clear();
});

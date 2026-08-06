import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { SafetyError } from "./safety-error.js";

const MANAGED_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"] as const;
type ManagedSignal = (typeof MANAGED_SIGNALS)[number];

// Each active workspace carries its caller's failure reporter, so the signal
// path reports through the same destination as the normal path. Previously the
// signal path called the module-private cleanup and swallowed the rejection in
// Promise.allSettled, so a signal-time failure was silent — suppression with no
// destination, which is the state PR 11.4 removed from the normal path.
const active = new Map<string, ((path: string) => void) | undefined>();
let exiting = false;
const handlers = new Map<ManagedSignal, () => void>();

// One phrasing for one condition. The adapter re-emits this for a suppressed
// failure, so a change here must not leave two wordings for the same event.
export function workspaceRemovalFailure(path: string): string {
  return `cannot remove workspace ${path}`;
}

async function cleanup(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (cause) {
    throw new SafetyError("workspace", workspaceRemovalFailure(path), {
      cause,
    });
  }
}

// Synchronous by contract. An `await` here would yield to the event loop with
// the listeners still registered, and every signal arriving during that window
// would be consumed and discarded — an uninterruptible process, which is worse
// than the leak the handler exists to prevent. Being synchronous means the
// handler cannot be re-entered, so the window does not exist.
function cleanupForSignal(signal: ManagedSignal): void {
  if (exiting) return;
  exiting = true;
  for (const [path, report] of active) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Same destination as the normal path. The diagnostic is hand-written and
      // names the workspace; the caught cause is not interpolated.
      if (report) report(path);
      else process.stderr.write(`${workspaceRemovalFailure(path)}\n`);
    }
  }
  active.clear();
  // Remove only the listeners this coordinator registered, then re-raise so the
  // default disposition terminates the process by the signal.
  for (const [managed, handler] of handlers) process.off(managed, handler);
  handlers.clear();
  process.kill(process.pid, signal);
}

function registerCoordinator(): void {
  if (handlers.size > 0) return;
  for (const signal of MANAGED_SIGNALS) {
    const handler = () => {
      cleanupForSignal(signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
}

function deregisterCoordinator(): void {
  if (active.size > 0) return;
  for (const [signal, handler] of handlers) process.off(signal, handler);
  handlers.clear();
}

export interface WorkspaceOptions {
  readonly cleanup?: (path: string) => Promise<void>;
  // Presence is the suppression signal: suppression cannot be requested
  // without saying where the report goes.
  // Must be synchronous: the call site below does not await it, so an async
  // implementation's rejection would become an unhandled rejection instead
  // of a visible failure.
  readonly onCleanupFailure?: (path: string) => void;
}

export async function withWorkspace<T>(
  parent: string,
  prefix: string,
  fn: (workspace: string) => T | Promise<T>,
  options: WorkspaceOptions = {},
): Promise<T> {
  const remove = options.cleanup ?? cleanup;
  let workspace: string;
  try {
    workspace = await mkdtemp(join(parent, prefix));
  } catch (cause) {
    throw new SafetyError("workspace", "cannot create workspace", { cause });
  }
  active.set(workspace, options.onCleanupFailure);
  registerCoordinator();
  try {
    let result!: T;
    let failed = false;
    let callbackError: unknown;
    try {
      result = await fn(workspace);
    } catch (error) {
      failed = true;
      callbackError = error;
    }
    try {
      await remove(workspace);
    } catch (cleanupError) {
      if (failed) throw callbackError;
      if (options.onCleanupFailure === undefined) throw cleanupError;
      options.onCleanupFailure(workspace);
    }
    if (failed) throw callbackError;
    return result;
  } finally {
    active.delete(workspace);
    deregisterCoordinator();
  }
}

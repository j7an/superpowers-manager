import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { SafetyError } from "./safety-error.ts";

const MANAGED_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"] as const;
type ManagedSignal = (typeof MANAGED_SIGNALS)[number];

// Workspaces the signal path must remove. A signal death never builds a
// result outcome (see src/adapter-result.ts), so the signal path writes its
// hand-written diagnostic straight to process.stderr; that write is the only
// report a caller can observe.
const active = new Set<string>();
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
  for (const path of active) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // The diagnostic is hand-written and names the workspace; the caught
      // cause is not interpolated. Guarded: if the write throws — plausibly
      // EPIPE after SIGHUP — the remaining workspaces' cleanup,
      // deregistration, and the re-raise below must still run. Node documents
      // pipe writes as asynchronous on some platforms (notably macOS); small
      // buffers like this one are written inline.
      try {
        process.stderr.write(`${workspaceRemovalFailure(path)}\n`);
      } catch {
        // See above: a reporting failure must not block cleanup/re-raise.
      }
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
  // Replaces the removal step; tests use it to stage a cleanup failure.
  readonly cleanup?: (path: string) => Promise<void>;
}

export interface ReportedWorkspace<T> {
  readonly value: T;
  // Non-null only when the callback succeeded and its workspace could not be
  // removed afterwards.
  readonly cleanupWarning: string | null;
}

async function runInWorkspace<T>(
  parent: string,
  prefix: string,
  fn: (workspace: string) => T | Promise<T>,
  options: WorkspaceOptions,
  reportCleanupFailure: boolean,
): Promise<ReportedWorkspace<T>> {
  const remove = options.cleanup ?? cleanup;
  let workspace: string;
  try {
    workspace = await mkdtemp(join(parent, prefix));
  } catch (cause) {
    throw new SafetyError("workspace", "cannot create workspace", { cause });
  }
  active.add(workspace);
  registerCoordinator();
  try {
    let value!: T;
    let failed = false;
    let callbackError: unknown;
    try {
      value = await fn(workspace);
    } catch (error) {
      failed = true;
      callbackError = error;
    }
    let cleanupWarning: string | null = null;
    try {
      await remove(workspace);
    } catch (cleanupError) {
      if (failed) throw callbackError;
      if (!reportCleanupFailure) throw cleanupError;
      cleanupWarning = workspaceRemovalFailure(workspace);
    }
    if (failed) throw callbackError;
    return { value, cleanupWarning };
  } finally {
    active.delete(workspace);
    deregisterCoordinator();
  }
}

export async function withWorkspace<T>(
  parent: string,
  prefix: string,
  fn: (workspace: string) => T | Promise<T>,
  options: WorkspaceOptions = {},
): Promise<T> {
  return (await runInWorkspace(parent, prefix, fn, options, false)).value;
}

// Like withWorkspace, except a cleanup failure after a SUCCESSFUL callback is
// returned as `cleanupWarning` instead of thrown, so the caller keeps the value
// it already computed and reports the leak itself. A callback throw still
// propagates, and a cleanup failure never masks it.
export function withWorkspaceReporting<T>(
  parent: string,
  prefix: string,
  fn: (workspace: string) => T | Promise<T>,
  options: WorkspaceOptions = {},
): Promise<ReportedWorkspace<T>> {
  return runInWorkspace(parent, prefix, fn, options, true);
}

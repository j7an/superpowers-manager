import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { SafetyError } from "./safety-error.js";

const active = new Set<string>();
const signalStatuses = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
} as const;
type ManagedSignal = keyof typeof signalStatuses;
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

async function cleanupForSignal(status: number): Promise<never> {
  if (exiting) await new Promise<never>(() => {});
  exiting = true;
  await Promise.allSettled([...active].map(cleanup));
  process.exit(status);
}

function registerCoordinator(): void {
  if (handlers.size > 0) return;
  for (const [signal, status] of Object.entries(signalStatuses) as [
    ManagedSignal,
    number,
  ][]) {
    const handler = () => {
      void cleanupForSignal(status);
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
  active.add(workspace);
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

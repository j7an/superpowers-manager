import { tmpdir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

import {
  AdapterMessageLog,
  failureResult,
  successResult,
  type AdapterChannel,
  type AdapterContext,
  type AdapterResult,
} from "./adapter-result.ts";
import { SEMVER_RE } from "./domain/refs.ts";
import type { PiPaths } from "./pi-paths.ts";
import {
  BOUNDED_EXECUTABLE,
  runValidator as runBoundedCommand,
  type Captured,
} from "./validator.ts";
import { withWorkspace } from "./workspace.ts";

export interface PiCommandOutput {
  readonly stdout: string;
}

function selectedExecutable(
  env: NodeJS.ProcessEnv,
  invocationCwd: string,
): string {
  const configured = env.SUPERPOWERS_PI || "pi";
  return configured.includes(sep) && !isAbsolute(configured)
    ? resolve(invocationCwd, configured)
    : configured;
}

function appendCaptured(
  log: AdapterMessageLog,
  channel: AdapterChannel,
  captured: Captured,
): void {
  log.appendBytes(channel, Buffer.from(captured.text));
  if (captured.droppedBytes > 0) {
    log.appendText(
      channel,
      `Pi ${channel} omitted ${captured.droppedBytes} bytes at the capture limit`,
    );
  }
}

export async function runPi(
  args: readonly string[],
  paths: PiPaths,
  ctx: AdapterContext,
  execute: typeof runBoundedCommand = runBoundedCommand,
): Promise<AdapterResult<PiCommandOutput>> {
  const operation = "pi-command";
  const env = ctx.env ?? {};
  const invocationCwd = process.cwd();
  const executable = selectedExecutable(env, invocationCwd);
  let entered = false;
  try {
    return await withWorkspace(
      env.TMPDIR ?? tmpdir(),
      "superpowers-manager.pi.",
      async (workspace) => {
        entered = true;
        const result = await execute(
          [executable, ...args],
          BOUNDED_EXECUTABLE,
          {
            ...env,
            HOME: paths.homeDir,
            PI_CODING_AGENT_DIR: paths.agentDir,
            PI_OFFLINE: "1",
            PI_SKIP_VERSION_CHECK: "1",
          },
          workspace,
          workspace,
        );
        if (result.kind === "launchFailed") {
          const errno = /^[A-Z][A-Z0-9_]*$/u.test(result.errno)
            ? result.errno
            : "UNKNOWN";
          return failureResult(
            operation,
            "launch-failed",
            `cannot launch configured Pi executable (${errno})`,
            [],
            [],
          );
        }

        const log = new AdapterMessageLog();
        if (result.kind === "timedOut") {
          appendCaptured(log, "stdout", result.stdout);
          appendCaptured(log, "stderr", result.stderr);
          return failureResult(
            operation,
            "timeout",
            `Pi command timed out after ${result.afterMs} ms`,
            [],
            log.snapshot(),
          );
        }
        if (result.code !== 0) {
          appendCaptured(log, "stdout", result.stdout);
          appendCaptured(log, "stderr", result.stderr);
          return failureResult(
            operation,
            "nonzero-exit",
            result.code === null
              ? "Pi command exited without a status"
              : `Pi command exited with status ${result.code}`,
            [],
            log.snapshot(),
          );
        }
        if (result.stdout.droppedBytes > 0 || result.stderr.droppedBytes > 0) {
          appendCaptured(log, "stdout", result.stdout);
          appendCaptured(log, "stderr", result.stderr);
          return failureResult(
            operation,
            "output-limit",
            "Pi command output exceeded the capture limit",
            [],
            log.snapshot(),
          );
        }
        appendCaptured(log, "stderr", result.stderr);
        return successResult(
          operation,
          { stdout: result.stdout.text },
          log.snapshot(),
        );
      },
    );
  } catch {
    return failureResult(
      operation,
      "workspace-failed",
      entered
        ? "cannot complete Pi command in its isolated workspace"
        : "cannot create an isolated Pi command workspace",
      [],
      [],
    );
  }
}

export function normalizePiRuntimeVersion(
  result: AdapterResult<PiCommandOutput>,
): AdapterResult<string> {
  if (!result.outcome.ok) {
    return { status: result.status, outcome: result.outcome };
  }
  if (result.status !== 0) {
    return failureResult(
      "pi-runtime",
      "invalid-status",
      "Pi runtime inspection returned a nonzero status",
      [],
      result.outcome.messages,
    );
  }
  const version = result.outcome.result.stdout.trim();
  if (!SEMVER_RE.test(version)) {
    return failureResult(
      "pi-runtime",
      "invalid-version",
      "Pi runtime inspection returned an invalid version response",
      [],
      result.outcome.messages,
    );
  }
  return successResult("pi-runtime", version, result.outcome.messages);
}

import {
  AdapterMessageLog,
  failureResult,
  successResult,
  type AdapterChannel,
  type AdapterResult,
} from "./adapter-result.ts";
import { SEMVER_RE } from "./domain/refs.ts";
import type { Captured, ValidatorRun } from "./validator.ts";

type Label = "Pi" | "OpenCode";

export interface NativeCommandOutput {
  readonly stdout: string;
}

function appendCaptured(
  log: AdapterMessageLog,
  label: Label,
  channel: AdapterChannel,
  captured: Captured,
): void {
  log.appendBytes(channel, Buffer.from(captured.text));
  if (captured.droppedBytes > 0)
    log.appendText(
      channel,
      `${label} ${channel} omitted ${captured.droppedBytes} bytes at the capture limit`,
    );
}

export function nativeCommandResult(
  label: Label,
  result: ValidatorRun,
): AdapterResult<NativeCommandOutput> {
  const operation = `${label.toLowerCase()}-command`;
  if (result.kind === "launchFailed") {
    const errno = /^[A-Z][A-Z0-9_]*$/u.test(result.errno)
      ? result.errno
      : "UNKNOWN";
    return failureResult(
      operation,
      "launch-failed",
      `cannot launch configured ${label} executable (${errno})`,
      [],
      [],
    );
  }
  const log = new AdapterMessageLog();
  if (result.kind === "timedOut") {
    appendCaptured(log, label, "stdout", result.stdout);
    appendCaptured(log, label, "stderr", result.stderr);
    return failureResult(
      operation,
      "timeout",
      `${label} command timed out after ${result.afterMs} ms`,
      [],
      log.snapshot(),
    );
  }
  if (result.code !== 0) {
    appendCaptured(log, label, "stdout", result.stdout);
    appendCaptured(log, label, "stderr", result.stderr);
    return failureResult(
      operation,
      "nonzero-exit",
      result.code === null
        ? `${label} command exited without a status`
        : `${label} command exited with status ${result.code}`,
      [],
      log.snapshot(),
    );
  }
  if (result.stdout.droppedBytes > 0 || result.stderr.droppedBytes > 0) {
    appendCaptured(log, label, "stdout", result.stdout);
    appendCaptured(log, label, "stderr", result.stderr);
    return failureResult(
      operation,
      "output-limit",
      `${label} command output exceeded the capture limit`,
      [],
      log.snapshot(),
    );
  }
  appendCaptured(log, label, "stderr", result.stderr);
  return successResult(
    operation,
    { stdout: result.stdout.text },
    log.snapshot(),
  );
}

export function normalizeSnapshotRuntimeVersion(
  label: Label,
  result: AdapterResult<NativeCommandOutput>,
  strip?: RegExp,
): AdapterResult<string> {
  if (!result.outcome.ok)
    return { status: result.status, outcome: result.outcome };
  const operation = `${label.toLowerCase()}-runtime`;
  if (result.status !== 0)
    return failureResult(
      operation,
      "invalid-status",
      `${label} runtime inspection returned a nonzero status`,
      [],
      result.outcome.messages,
    );
  const reported = result.outcome.result.stdout.trim();
  const version = strip === undefined ? reported : reported.replace(strip, "");
  if (!SEMVER_RE.test(version))
    return failureResult(
      operation,
      "invalid-version",
      `${label} runtime inspection returned an invalid version response`,
      [],
      result.outcome.messages,
    );
  return successResult(operation, version, result.outcome.messages);
}

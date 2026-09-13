import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { mkdir } from "node:fs/promises";

import {
  AdapterMessageLog,
  failureResult,
  successResult,
  type AdapterChannel,
  type AdapterContext,
  type AdapterResult,
} from "../../adapter-result.ts";
import { SEMVER_RE } from "../../domain/refs.ts";
import {
  BOUNDED_EXECUTABLE,
  runValidator as runBoundedCommand,
  type Captured,
} from "../../validator.ts";
import { withWorkspace } from "../../workspace.ts";
import type { OpenCodePaths } from "./paths.ts";

export interface OpenCodeCommandOutput {
  readonly stdout: string;
}

function selectedExecutable(
  env: NodeJS.ProcessEnv,
  invocationCwd: string,
): string {
  const configured = env.SUPERPOWERS_OPENCODE || "opencode";
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
  if (captured.droppedBytes > 0)
    log.appendText(
      channel,
      `OpenCode ${channel} omitted ${captured.droppedBytes} bytes at the capture limit`,
    );
}

export async function runOpenCode(
  args: readonly string[],
  paths: OpenCodePaths,
  ctx: AdapterContext,
  execute: typeof runBoundedCommand = runBoundedCommand,
): Promise<AdapterResult<OpenCodeCommandOutput>> {
  const operation = "opencode-command";
  const env = ctx.env ?? {};
  const executable = selectedExecutable(env, process.cwd());
  let entered = false;
  try {
    return await withWorkspace(
      env.TMPDIR ?? tmpdir(),
      "superpowers-manager.opencode.",
      async (workspace) => {
        entered = true;
        const home = resolve(workspace, "home");
        const data = resolve(workspace, "data");
        const cache = resolve(workspace, "cache");
        const state = resolve(workspace, "state");
        const temporary = resolve(workspace, "tmp");
        const managed = resolve(workspace, "managed");
        await Promise.all(
          [home, data, cache, state, temporary, managed].map((path) =>
            mkdir(path),
          ),
        );
        const result = await execute(
          [executable, ...args],
          BOUNDED_EXECUTABLE,
          {
            PATH: env.PATH,
            HOME: home,
            XDG_CONFIG_HOME: dirname(paths.configRoot),
            XDG_DATA_HOME: data,
            XDG_CACHE_HOME: cache,
            XDG_STATE_HOME: state,
            TMPDIR: temporary,
            OPENCODE_DISABLE_AUTOUPDATE: "1",
            OPENCODE_DISABLE_MODELS_FETCH: "1",
            OPENCODE_DISABLE_PROJECT_CONFIG: "1",
            OPENCODE_PURE: "1",
            OPENCODE_TEST_MANAGED_CONFIG_DIR: managed,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
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
            `cannot launch configured OpenCode executable (${errno})`,
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
            `OpenCode command timed out after ${result.afterMs} ms`,
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
              ? "OpenCode command exited without a status"
              : `OpenCode command exited with status ${result.code}`,
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
            "OpenCode command output exceeded the capture limit",
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
        ? "cannot complete OpenCode command in its isolated workspace"
        : "cannot create an isolated OpenCode command workspace",
      [],
      [],
    );
  }
}

export function normalizeOpenCodeRuntimeVersion(
  result: AdapterResult<OpenCodeCommandOutput>,
): AdapterResult<string> {
  if (!result.outcome.ok)
    return { status: result.status, outcome: result.outcome };
  if (result.status !== 0)
    return failureResult(
      "opencode-runtime",
      "invalid-status",
      "OpenCode runtime inspection returned a nonzero status",
      [],
      result.outcome.messages,
    );
  const version = result.outcome.result.stdout.trim();
  if (!SEMVER_RE.test(version))
    return failureResult(
      "opencode-runtime",
      "invalid-version",
      "OpenCode runtime inspection returned an invalid version response",
      [],
      result.outcome.messages,
    );
  return successResult("opencode-runtime", version, result.outcome.messages);
}

import {
  type AdapterContext,
  type AdapterResult,
} from "../../adapter-result.ts";
import {
  runIsolatedNative,
  type NativeCommandOutput,
} from "../../harness-command-result.ts";
import { SafetyError } from "../../safety-error.ts";
import { parseStrictJson, type JsonValue } from "../../strict-json.ts";
import {
  BOUNDED_EXECUTABLE,
  runValidator as runBoundedCommand,
} from "../../validator.ts";

export type RunClaude = (
  args: readonly string[],
  ctx: AdapterContext,
) => Promise<AdapterResult<NativeCommandOutput>>;

export interface ClaudeCodePlugin {
  readonly id: string;
  readonly version: string;
  readonly scope: string;
  readonly enabled: boolean;
  readonly installPath: string;
  readonly errorCount: number;
}

export interface ClaudeCodeMarketplace {
  readonly name: string;
  readonly source: string;
  readonly path: string | null;
}

export interface ClaudeCodeNativeState {
  readonly plugins: readonly ClaudeCodePlugin[];
  readonly marketplaces: readonly ClaudeCodeMarketplace[];
}

// Native list commands include the caller's project and local scope.
export async function runClaude(
  args: readonly string[],
  ctx: AdapterContext,
  execute: typeof runBoundedCommand = runBoundedCommand,
): Promise<AdapterResult<NativeCommandOutput>> {
  return await runIsolatedNative(
    "Claude Code",
    (ctx.env ?? {}).SUPERPOWERS_CLAUDE_CODE || "claude",
    ctx,
    async (executable, workspace, env, invocationCwd) =>
      await execute(
        [executable, ...args],
        BOUNDED_EXECUTABLE,
        { ...env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
        workspace,
        invocationCwd,
      ),
  );
}

function listEntries(
  stdout: string,
  subject: string,
): Record<string, JsonValue>[] {
  let value: JsonValue;
  try {
    value = parseStrictJson(stdout.trim(), {
      duplicateKeys: "reject",
      nonStandardConstants: "reject",
      maxDepth: 64,
    });
  } catch (cause) {
    throw new SafetyError("claude-code-native", `invalid ${subject}`, {
      cause,
    });
  }
  if (!Array.isArray(value))
    throw new SafetyError("claude-code-native", `invalid ${subject}`);
  return value.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      throw new SafetyError("claude-code-native", `invalid ${subject}`);
    return entry;
  });
}

export function parsePluginList(stdout: string): ClaudeCodePlugin[] {
  return listEntries(stdout, "Claude Code plugin list").map((entry) => {
    const { id, version, scope, enabled, installPath, errors } = entry;
    if (
      typeof id !== "string" ||
      typeof version !== "string" ||
      typeof scope !== "string" ||
      typeof enabled !== "boolean" ||
      typeof installPath !== "string" ||
      (errors !== undefined && !Array.isArray(errors))
    )
      throw new SafetyError(
        "claude-code-native",
        "invalid Claude Code plugin list",
      );
    return {
      id,
      version,
      scope,
      enabled,
      installPath,
      errorCount: errors === undefined ? 0 : errors.length,
    };
  });
}

export function parseMarketplaceList(stdout: string): ClaudeCodeMarketplace[] {
  return listEntries(stdout, "Claude Code marketplace list").map((entry) => {
    const { name, source, path } = entry;
    if (
      typeof name !== "string" ||
      typeof source !== "string" ||
      (path !== undefined && typeof path !== "string")
    )
      throw new SafetyError(
        "claude-code-native",
        "invalid Claude Code marketplace list",
      );
    return { name, source, path: path ?? null };
  });
}

export async function readClaudeCodeState(
  ctx: AdapterContext,
  run: RunClaude = runClaude,
): Promise<ClaudeCodeNativeState> {
  try {
    const plugins = await run(["plugin", "list", "--json"], ctx);
    const marketplaces = await run(
      ["plugin", "marketplace", "list", "--json"],
      ctx,
    );
    if (
      !plugins.outcome.ok ||
      plugins.status !== 0 ||
      !marketplaces.outcome.ok ||
      marketplaces.status !== 0
    )
      throw new Error("native command");
    return {
      plugins: parsePluginList(plugins.outcome.result.stdout),
      marketplaces: parseMarketplaceList(marketplaces.outcome.result.stdout),
    };
  } catch (cause) {
    throw new SafetyError(
      "claude-code-native",
      "cannot inspect Claude Code plugin state",
      { cause },
    );
  }
}

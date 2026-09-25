import type { HarnessCommand } from "./harness.ts";
import type { InvocationOptions, HarnessId } from "./harness-compatibility.ts";

export class UsageError extends Error {}

export function extractHarnessOptions(
  command: HarnessCommand,
  argv: readonly string[],
): { options: InvocationOptions; args: string[] } {
  let harness: HarnessId = "codex";
  let targeted = false;
  let allowExperimental = false;
  const args: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--harness" || token.startsWith("--harness=")) {
      if (
        command === "pin" ||
        command === "unpin" ||
        command === "track-latest"
      )
        throw new UsageError(
          "harness targeting is not available for shared selection commands",
        );
      if (targeted) throw new UsageError("duplicate option: --harness");
      targeted = true;
      const value =
        token === "--harness"
          ? argv[++index]
          : token.slice("--harness=".length);
      if (!value || value.startsWith("--"))
        throw new UsageError("option --harness requires a value");
      if (
        value !== "codex" &&
        value !== "pi" &&
        value !== "opencode" &&
        value !== "claude-code"
      )
        throw new UsageError(`unknown harness: ${value}`);
      harness = value;
    } else if (token === "--allow-experimental") {
      if (command !== "install" && command !== "update")
        throw new UsageError(
          "--allow-experimental is only available for install or update",
        );
      if (allowExperimental)
        throw new UsageError("duplicate option: --allow-experimental");
      allowExperimental = true;
    } else {
      args.push(token);
    }
  }
  return { options: { harness, allowExperimental }, args };
}

export function oneLine(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/[\r\n]+/g, " ");
}

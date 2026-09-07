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
      if (value !== "codex" && value !== "pi")
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

export function parseFlags(
  argv: readonly string[],
  names: readonly string[],
): Readonly<Record<string, string>> {
  const allowed = new Set(names);
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--"))
      throw new UsageError(`unexpected argument: ${token}`);
    const separator = token.indexOf("=");
    const name = separator === -1 ? token.slice(2) : token.slice(2, separator);
    if (!allowed.has(name)) throw new UsageError(`unknown option: --${name}`);
    const value =
      separator === -1 ? argv[index + 1] : token.slice(separator + 1);
    if (value === undefined || (separator === -1 && value.startsWith("--"))) {
      throw new UsageError(`option --${name} requires a value`);
    }
    result[name] = value;
    if (separator === -1) index += 1;
  }
  for (const name of names) {
    if (!Object.hasOwn(result, name)) {
      throw new UsageError(`required option is missing: --${name}`);
    }
  }
  return result;
}

export function oneLine(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/[\r\n]+/g, " ");
}

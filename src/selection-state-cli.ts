import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import {
  displaySource,
  normalizePinnedArguments,
  normalizeSaved,
  validateSource,
} from "./selection.js";
import { readSelectionState, writeSelectionState } from "./selection-store.js";

const COMMAND_FLAGS = {
  read: ["path", "output"],
  "write-pinned": ["path", "source", "requested-ref", "resolved-ref", "commit"],
  "write-track-latest": ["path", "source"],
  "validate-source": ["source"],
  "display-source": ["source"],
} as const;

type CommandName = keyof typeof COMMAND_FLAGS;

interface Command {
  readonly name: CommandName;
  readonly flags: Readonly<Record<string, string>>;
}

class UsageError extends Error {}

function parseFlags(
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

function parseCommand(argv: readonly string[]): Command {
  const [name, ...rest] = argv;
  if (name === undefined) throw new UsageError("a subcommand is required");
  if (!Object.hasOwn(COMMAND_FLAGS, name)) {
    throw new UsageError(`unknown subcommand: ${name}`);
  }
  const command = name as CommandName;
  return { name: command, flags: parseFlags(rest, COMMAND_FLAGS[command]) };
}

async function dispatch({ name, flags }: Command): Promise<void> {
  if (name === "read") {
    const normalized = normalizeSaved(await readSelectionState(flags.path));
    try {
      await writeFile(
        flags.output,
        `${JSON.stringify(normalized, null, 2)}\n`,
        "utf8",
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `cannot write normalized selection output ${flags.output}: ${message}`,
        { cause },
      );
    }
    return;
  }
  if (name === "write-pinned") {
    await writeSelectionState(
      flags.path,
      normalizePinnedArguments({
        source: flags.source,
        requestedRef: flags["requested-ref"],
        resolvedRef: flags["resolved-ref"],
        commit: flags.commit,
      }),
    );
    return;
  }
  if (name === "write-track-latest") {
    await writeSelectionState(flags.path, {
      schema_version: 1,
      mode: "track-latest",
      source: flags.source,
    });
    return;
  }
  if (name === "validate-source") {
    validateSource(flags.source);
    return;
  }
  if (name === "display-source") {
    process.stdout.write(`${displaySource(flags.source)}\n`);
    return;
  }
  const unreachable: never = name;
  throw new Error(`unhandled subcommand: ${String(unreachable)}`);
}

function oneLine(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/[\r\n]+/g, " ");
}

export async function runSelectionStateCli(
  argv: readonly string[],
): Promise<number> {
  let command: Command;
  try {
    command = parseCommand(argv);
  } catch (cause) {
    process.stderr.write(`usage: selection-state-cli <subcommand> [options]\n`);
    process.stderr.write(`error: ${oneLine(cause)}\n`);
    return 2;
  }
  try {
    await dispatch(command);
    return 0;
  } catch (cause) {
    process.stderr.write(`error: ${oneLine(cause)}\n`);
    return 1;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.filename === realpathSync(entry)) {
  process.exitCode = await runSelectionStateCli(process.argv.slice(2));
}

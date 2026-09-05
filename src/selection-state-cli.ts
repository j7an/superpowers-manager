import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import {
  displaySource,
  normalizePinnedArguments,
  normalizeSaved,
  validateSource,
} from "./selection.ts";
import { readSelectionState, writeSelectionState } from "./selection-store.ts";
import { oneLine, parseFlags, UsageError } from "./cli-arguments.ts";

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

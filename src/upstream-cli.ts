import { realpathSync } from "node:fs";
import { oneLine, parseFlags, UsageError } from "./cli-arguments.js";
import { COMMIT_INPUT_RE, TAG_RE } from "./domain/refs.js";
import {
  fetchExactCommit,
  gitSafeSource,
  resolveExactTag,
  resolveRef,
  verifyRawCommit,
} from "./upstream.js";
import { manifestVersionForRef } from "./upstream-version.js";
import type { ResolutionKind } from "./upstream-version.js";

const COMMAND_FLAGS = {
  "resolve-ref": ["source", "ref"],
  "resolve-exact-tag": ["source", "ref"],
  "verify-raw-commit": ["source", "commit", "workspace-parent"],
  "fetch-exact-commit": ["source", "commit", "repository", "workspace-parent"],
  "manifest-version": [
    "requested-ref",
    "resolution-kind",
    "resolved-ref",
    "commit",
  ],
  "pin-kind": ["ref"],
  "safe-source": ["source"],
} as const;

type CommandName = keyof typeof COMMAND_FLAGS;

interface Command {
  readonly name: CommandName;
  readonly flags: Readonly<Record<string, string>>;
}

const RESOLUTION_KINDS: readonly ResolutionKind[] = [
  "latest-release",
  "tag",
  "ref",
  "raw-commit",
];

function parseResolutionKind(value: string): ResolutionKind {
  const found = RESOLUTION_KINDS.find((kind) => kind === value);
  if (found === undefined) {
    throw new UsageError(`unknown resolution kind: ${value}`);
  }
  return found;
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
  if (name === "resolve-ref") {
    const resolution = await resolveRef(flags.source, flags.ref);
    process.stdout.write(
      `${resolution.kind} ${resolution.ref} ${resolution.commit}\n`,
    );
    return;
  }
  if (name === "resolve-exact-tag") {
    process.stdout.write(`${await resolveExactTag(flags.source, flags.ref)}\n`);
    return;
  }
  if (name === "verify-raw-commit") {
    const commit = await verifyRawCommit(
      flags.source,
      flags.commit,
      flags["workspace-parent"],
    );
    process.stdout.write(`${commit}\n`);
    return;
  }
  if (name === "fetch-exact-commit") {
    await fetchExactCommit(
      flags.source,
      flags.commit,
      flags.repository,
      flags["workspace-parent"],
    );
    return;
  }
  if (name === "manifest-version") {
    const version = manifestVersionForRef({
      requestedRef: flags["requested-ref"],
      resolutionKind: parseResolutionKind(flags["resolution-kind"]),
      resolvedRef: flags["resolved-ref"],
      commit: flags.commit,
    });
    process.stdout.write(`${version}\n`);
    return;
  }
  if (name === "pin-kind") {
    const kind = TAG_RE.test(flags.ref)
      ? "tag"
      : COMMIT_INPUT_RE.test(flags.ref)
        ? "raw-commit"
        : "none";
    process.stdout.write(`${kind}\n`);
    return;
  }
  if (name === "safe-source") {
    process.stdout.write(`${gitSafeSource(flags.source)}\n`);
    return;
  }
  const unreachable: never = name;
  throw new Error(`unhandled subcommand: ${String(unreachable)}`);
}

export async function runUpstreamCli(argv: readonly string[]): Promise<number> {
  let command: Command;
  try {
    command = parseCommand(argv);
  } catch (cause) {
    process.stderr.write(`usage: upstream-cli <subcommand> [options]\n`);
    process.stderr.write(`error: ${oneLine(cause)}\n`);
    return 2;
  }
  try {
    await dispatch(command);
    return 0;
  } catch (cause) {
    process.stderr.write(`error: ${oneLine(cause)}\n`);
    return cause instanceof UsageError ? 2 : 1;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.filename === realpathSync(entry)) {
  process.exitCode = await runUpstreamCli(process.argv.slice(2));
}

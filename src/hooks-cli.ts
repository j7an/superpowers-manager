import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { oneLine, parseFlags, UsageError } from "./cli-arguments.js";
import { classifyHooks, materializeHooks, readManifest } from "./hooks.js";
import type { HookPlan, ManifestSource } from "./hooks.js";

const FLAGS = [
  "manifest",
  "manifest-source",
  "upstream-root",
  "candidate-root",
] as const;

const MANIFEST_SOURCES: readonly ManifestSource[] = ["upstream", "fallback"];

function parseManifestSource(value: string): ManifestSource {
  const found = MANIFEST_SOURCES.find((source) => source === value);
  if (found === undefined) {
    throw new UsageError(`unknown manifest source: ${value}`);
  }
  return found;
}

export async function runHooksCli(argv: readonly string[]): Promise<number> {
  let flags: Readonly<Record<string, string>>;
  let manifestSource: ManifestSource;
  try {
    flags = parseFlags(argv, FLAGS);
    manifestSource = parseManifestSource(flags["manifest-source"]);
  } catch (cause) {
    process.stderr.write(
      "usage: hooks-cli --manifest M --manifest-source upstream|fallback --upstream-root U --candidate-root C\n",
    );
    process.stderr.write(`error: ${oneLine(cause)}\n`);
    return 2;
  }

  let plan: HookPlan;
  let sourceRoot: string;
  let candidateRoot: string;
  try {
    sourceRoot = await realpath(flags["upstream-root"]);
    candidateRoot = await realpath(flags["candidate-root"]);
    const manifest = await readManifest(flags.manifest);
    plan = await classifyHooks(manifest, manifestSource, sourceRoot);
  } catch (cause) {
    process.stderr.write(`hook classification failed: ${oneLine(cause)}\n`);
    return 1;
  }

  try {
    await materializeHooks(plan, sourceRoot, candidateRoot);
  } catch (cause) {
    process.stderr.write(`hook materialization failed: ${oneLine(cause)}\n`);
    return 1;
  }
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.filename === realpathSync(entry)) {
  process.exitCode = await runHooksCli(process.argv.slice(2));
}

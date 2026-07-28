import { realpathSync } from "node:fs";
import { oneLine, parseFlags, UsageError } from "./cli-arguments.js";
import {
  validateGeneratedPlugin,
  type GeneratedPluginValidationOptions,
} from "./generated-plugin.js";

const FLAGS = [
  "plugin-root",
  "source",
  "requested-ref",
  "resolved-ref",
  "commit",
  "manifest-version",
  "manifest-source",
  "upstream-manifest-version",
] as const;

// `argparse` accepts a lone `-` and a bare negative number as a split value;
// every other dash-leading split value is treated as an option and rejected.
const NEGATIVE_NUMBER_RE = /^-\d+$|^-\d*\.\d+$/;

/** True when `argparse` would accept `value` in `--flag value` form. */
export function isAcceptedSplitValue(value: string): boolean {
  if (!value.startsWith("-")) return true;
  return value === "-" || NEGATIVE_NUMBER_RE.test(value);
}

/**
 * Node replaces an undecodable argv byte with U+FFFD before any JavaScript
 * runs, so the original byte is unrecoverable. Rejecting at the boundary is
 * the only portable fail-closed option.
 */
export function hasReplacementCharacter(value: string): boolean {
  return value.includes("�");
}

/** Pre-scan argv for split-form values the dash rule rejects. */
function findRejectedSplitFlag(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--") || token.includes("=")) continue;
    const value = argv[index + 1];
    if (value === undefined) continue;
    if (!isAcceptedSplitValue(value)) return token;
    index += 1;
  }
  return undefined;
}

function parseOptions(
  argv: readonly string[],
): GeneratedPluginValidationOptions {
  const rejected = findRejectedSplitFlag(argv);
  if (rejected !== undefined) {
    throw new UsageError(`option ${rejected} rejects a dash-leading value`);
  }
  const flags = parseFlags(argv, FLAGS);
  if (hasReplacementCharacter(flags["plugin-root"]!)) {
    throw new UsageError(
      "option --plugin-root contains an undecodable character",
    );
  }
  const manifestSource = flags["manifest-source"]!;
  if (manifestSource !== "upstream" && manifestSource !== "fallback") {
    throw new UsageError(
      "option --manifest-source must be `upstream` or `fallback`",
    );
  }
  return {
    pluginRoot: flags["plugin-root"]!,
    source: flags.source!,
    requestedRef: flags["requested-ref"]!,
    resolvedRef: flags["resolved-ref"]!,
    commit: flags.commit!,
    manifestVersion: flags["manifest-version"]!,
    manifestSource,
    upstreamManifestVersion: flags["upstream-manifest-version"]!,
  };
}

export async function runValidateGeneratedPluginCli(
  argv: readonly string[],
): Promise<number> {
  let options: GeneratedPluginValidationOptions;
  try {
    options = parseOptions(argv);
  } catch (cause) {
    process.stderr.write(
      "usage: validate-generated-plugin-cli --plugin-root <path> --source <url> " +
        "--requested-ref <ref> --resolved-ref <ref> --commit <sha> " +
        "--manifest-version <version> --manifest-source <upstream|fallback> " +
        "--upstream-manifest-version <version>\n",
    );
    process.stderr.write(`error: ${oneLine(cause)}\n`);
    return 2;
  }
  let errors: readonly string[];
  try {
    errors = await validateGeneratedPlugin(options);
  } catch (cause) {
    // A rejection must never escape as a traceback-shaped crash.
    process.stderr.write(`error: ${oneLine(cause)}\n`);
    return 2;
  }
  if (errors.length > 0) {
    process.stderr.write("Generated plugin validation failed:\n");
    for (const error of errors) process.stderr.write(`- ${error}\n`);
    return 1;
  }
  process.stdout.write(
    `generated plugin validation passed: ${options.pluginRoot}\n`,
  );
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.filename === realpathSync(entry)) {
  process.exitCode = await runValidateGeneratedPluginCli(process.argv.slice(2));
}

import { join, resolve } from "node:path";

import {
  assertNoFollowType,
  canonicalizeProspectivePath,
  isContained,
} from "../../safe-path.ts";
import { SafetyError } from "../../safety-error.ts";

export interface CodexPaths {
  readonly codexHome: string;
  readonly managerRoot: string;
  readonly preparedRoot: string;
  readonly marketplaceRoot: string;
  readonly publishedPluginRoot: string;
  readonly recoveryRoot: string;
}

export function codexHome(env: NodeJS.ProcessEnv, cwd: string): string {
  const configured = env.CODEX_HOME;
  if (configured !== undefined && configured.length > 0) {
    return resolve(cwd, configured);
  }
  const home = env.HOME;
  if (home === undefined || home.length === 0) {
    throw new SafetyError(
      "codex-paths",
      "cannot determine Codex state root without HOME",
    );
  }
  return join(resolve(cwd, home), ".codex");
}

export function codexPaths(env: NodeJS.ProcessEnv, cwd: string): CodexPaths {
  const root = codexHome(env, cwd);
  const managerRoot = join(root, "superpowers-manager");
  const marketplaceRoot = join(managerRoot, "marketplace");

  return {
    codexHome: root,
    managerRoot,
    preparedRoot: join(managerRoot, "prepared"),
    marketplaceRoot,
    publishedPluginRoot: join(marketplaceRoot, "plugins", "superpowers"),
    recoveryRoot: join(managerRoot, "recovery"),
  };
}

function overlaps(a: string, b: string): boolean {
  return isContained(a, b) || isContained(b, a);
}

export type CodexPathFailureDetails =
  | { readonly kind: "overlap" }
  | {
      readonly kind: "inspection";
      readonly root: "preparation" | "marketplace" | "recovery";
      readonly path: string;
    };

class CodexPathError extends SafetyError<CodexPathFailureDetails> {
  constructor(
    message: string,
    details: CodexPathFailureDetails,
    cause?: unknown,
  ) {
    super("codex-paths", message, {
      details,
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

function separationError(): SafetyError<CodexPathFailureDetails> {
  return new CodexPathError(
    "preparation overlaps Codex published or recovery storage",
    { kind: "overlap" },
  );
}

async function inspectRoot(
  path: string,
  root: "preparation" | "marketplace" | "recovery",
): Promise<string> {
  try {
    await assertNoFollowType(path, ["directory", "missing"]);
    return await canonicalizeProspectivePath(path);
  } catch (cause) {
    throw new CodexPathError(
      `cannot inspect ${root} root: ${path}`,
      { kind: "inspection", root, path },
      cause,
    );
  }
}

export function codexPathFailureDetails(
  cause: unknown,
): CodexPathFailureDetails | null {
  return cause instanceof CodexPathError ? (cause.details ?? null) : null;
}

export async function assertCodexPreparationSeparate(
  preparedRoot: string,
  paths: CodexPaths,
): Promise<void> {
  const recovery = await inspectRoot(paths.recoveryRoot, "recovery");
  const marketplace = await inspectRoot(paths.marketplaceRoot, "marketplace");
  let prepared: string;
  try {
    prepared = await inspectRoot(preparedRoot, "preparation");
  } catch (cause) {
    const failure = codexPathFailureDetails(cause);
    if (failure?.kind !== "inspection" || failure.root !== "preparation") {
      throw cause;
    }
    try {
      const canonical = await canonicalizeProspectivePath(preparedRoot);
      if (overlaps(canonical, marketplace) || overlaps(canonical, recovery)) {
        throw separationError();
      }
    } catch (resolutionCause) {
      if (codexPathFailureDetails(resolutionCause)?.kind === "overlap") {
        throw resolutionCause;
      }
    }
    throw cause;
  }
  if (overlaps(prepared, marketplace) || overlaps(prepared, recovery)) {
    throw separationError();
  }
}

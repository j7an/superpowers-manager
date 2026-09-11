import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  assertNoFollowType,
  canonicalizeProspectivePath,
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
  const inside = (root: string, leaf: string): boolean => {
    const suffix = relative(root, leaf);
    return (
      suffix === "" ||
      (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`))
    );
  };
  return inside(a, b) || inside(b, a);
}

export type CodexPathFailureDetails =
  | { readonly kind: "overlap" }
  | {
      readonly kind: "inspection";
      readonly root: "preparation" | "marketplace" | "recovery";
      readonly path: string;
    };

function separationError(): SafetyError<CodexPathFailureDetails> {
  return new SafetyError<CodexPathFailureDetails>(
    "codex-paths",
    "preparation overlaps Codex published or recovery storage",
    { details: { kind: "overlap" } },
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
    throw new SafetyError<CodexPathFailureDetails>(
      "codex-paths",
      `cannot inspect ${root} root: ${path}`,
      { cause, details: { kind: "inspection", root, path } },
    );
  }
}

export function codexPathFailureDetails(
  cause: unknown,
): CodexPathFailureDetails | null {
  if (!(cause instanceof SafetyError) || cause.module !== "codex-paths") {
    return null;
  }
  const details: unknown = cause.details;
  if (details === null || typeof details !== "object" || !("kind" in details)) {
    return null;
  }
  if (details.kind === "overlap") return { kind: "overlap" };
  if (
    details.kind !== "inspection" ||
    !("root" in details) ||
    !("path" in details) ||
    (details.root !== "preparation" &&
      details.root !== "marketplace" &&
      details.root !== "recovery") ||
    typeof details.path !== "string"
  ) {
    return null;
  }
  return { kind: "inspection", root: details.root, path: details.path };
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

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

function separationError(cause?: unknown): SafetyError {
  return new SafetyError(
    "codex-paths",
    "preparation overlaps Codex published or recovery storage",
    { cause },
  );
}

export async function assertCodexPreparationSeparate(
  preparedRoot: string,
  paths: CodexPaths,
): Promise<void> {
  try {
    await Promise.all([
      assertNoFollowType(preparedRoot, ["directory", "missing"]),
      assertNoFollowType(paths.publishedPluginRoot, ["directory", "missing"]),
      assertNoFollowType(paths.recoveryRoot, ["directory", "missing"]),
    ]);
    const [prepared, published, recovery] = await Promise.all([
      canonicalizeProspectivePath(preparedRoot),
      canonicalizeProspectivePath(paths.publishedPluginRoot),
      canonicalizeProspectivePath(paths.recoveryRoot),
    ]);
    if (overlaps(prepared, published) || overlaps(prepared, recovery)) {
      throw separationError();
    }
  } catch (cause) {
    if (cause instanceof SafetyError && cause.module === "codex-paths") {
      throw cause;
    }
    throw separationError(cause);
  }
}

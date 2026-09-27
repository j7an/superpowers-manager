import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

export function resolvePackageNode(
  env: NodeJS.ProcessEnv,
  required: boolean,
  packageEngine: unknown,
): string | undefined {
  const binary = env.SPW_PACKAGE_NODE;
  if (binary === undefined) {
    if (!required) return undefined;
    throw new Error("SPW_PACKAGE_NODE is required");
  }
  if (!isAbsolute(binary)) {
    throw new Error("SPW_PACKAGE_NODE must be an absolute executable path");
  }
  const major =
    typeof packageEngine === "string"
      ? /^>=(\d+)$/.exec(packageEngine)?.[1]
      : undefined;
  if (major === undefined) {
    throw new Error(
      "package.json engines.node does not declare a supported package minimum",
    );
  }
  const expected = `${major}.0.0`;

  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 10000,
    });
  } catch {
    throw new Error("SPW_PACKAGE_NODE could not be verified");
  }
  if (result.error || result.signal || result.status !== 0) {
    throw new Error("SPW_PACKAGE_NODE could not be verified");
  }
  if (
    typeof result.stdout !== "string" ||
    result.stdout.trim() !== `v${expected}` ||
    result.stderr !== ""
  ) {
    throw new Error(
      "SPW_PACKAGE_NODE does not report the declared package minimum",
    );
  }
  return binary;
}

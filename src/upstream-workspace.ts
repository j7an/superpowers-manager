import { isAbsolute, join, resolve } from "node:path";

export function upstreamCacheRoot(
  root: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string {
  const configured =
    env.SUPERPOWERS_CACHE_DIR || join(root, ".cache", "upstream");
  const cacheParent = isAbsolute(configured)
    ? configured
    : resolve(cwd, configured);
  return join(cacheParent, "superpowers");
}

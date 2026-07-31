// @ts-check
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Digest every compiled source plus the compiler config. Imported by the
 * runner, the postbuild writer, and the tests — so it must stay free of
 * top-level side effects. Do not add a process.exit() or an existence check
 * to this file.
 * @param {string} root
 * @returns {string}
 */
export function computeBuildId(root) {
  const hash = createHash("sha256");
  const sources = readdirSync(join(root, "src"), { recursive: true })
    .map((name) => String(name))
    .filter((name) => name.endsWith(".ts"))
    .sort();
  for (const name of sources) {
    hash.update(name);
    hash.update(readFileSync(join(root, "src", name)));
  }
  hash.update(readFileSync(join(root, "tsconfig.json")));
  return `${hash.digest("hex")}\n`;
}
